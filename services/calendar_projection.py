"""Calendar row projection and authenticated loading with initial feed refresh."""

from collections import defaultdict, deque
from dataclasses import dataclass
import logging

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import first_row
from services.calendar_store import list_calendar_rows_all
from services.calendar_feed_sources import (
    _configured_feed_urls, _filter_configured_cache_events,
    _load_calendar_feed_metadata, _refresh_initial_feed_cache, _resolve_last_fetched,
)
from services.calendar_identity import _event_ref_for_cache_event
from services.calendar_serialization import (
    _api_event_overlaps_range, _apply_event_override, _parse_range_param,
    _range_queries, _serialize_event, _serialize_user_event,
)
from services.calendar_sources import (
    _append_task_calendar_source, _configured_calendar_sources,
    _load_calendar_preferences, _load_event_overrides,
    _load_local_calendar_sources, _task_calendar_payload,
)
from services.canvas_routing import _project_canvas_calendar_events

logger = logging.getLogger(__name__)


@dataclass
class CalendarProjection:
    events: list
    feed_rows: list
    canvas_events: list


def compose_calendar_events(
    user_id, settings, cache_rows, native_rows, preferences, overrides,
    range_start=None, range_end=None, *, cache_order="input",
    require_shares_ics=False, task_events=(), provider_events=(),
):
    """Translate loaded rows; callers choose order, sharing and added sources.

    This operation performs no feed refresh or provider read. The ordinary API
    preserves cache input order; dashboard and share consumers use feed_first.
    Task/provider events are already projected by their respective owner.
    """
    if cache_order not in {"input", "feed_first"}:
        raise ValueError("cache_order must be input or feed_first")
    overrides_by_ref = {
        row["event_ref"]: row for row in overrides if row.get("event_ref")
    }
    canvas_rows = [row for row in cache_rows if _is_canvas_row(row)]
    feed_rows = _filter_configured_cache_events(
        [row for row in cache_rows if not _is_canvas_row(row)],
        _configured_feed_urls(settings),
    )
    canvas_events = []
    if canvas_rows:
        canvas_events = _project_canvas_calendar_events(
            user_id, canvas_rows, overrides_by_ref, preferences=preferences,
            range_start=range_start, range_end=range_end,
            api_event_overlaps_range=_api_event_overlaps_range,
            require_shares_ics=require_shares_ics,
        )
    feed_events = []
    feed_by_key = defaultdict(deque)
    for row in feed_rows:
        event = _serialize_event(row, settings)
        event = _apply_event_override(event, overrides_by_ref.get(event.get("event_ref")))
        # Keep a queue position even for hidden rows sharing a cache identity.
        feed_by_key[_cache_key(row)].append(event)
        if event:
            feed_events.append(event)
    if cache_order == "feed_first":
        cache_events = feed_events + canvas_events
    else:
        canvas_by_ref = defaultdict(deque)
        for event in canvas_events:
            canvas_by_ref[event.get("event_ref")].append(event)
        cache_events = []
        for row in cache_rows:
            candidates = (canvas_by_ref[_event_ref_for_cache_event(row)]
                          if _is_canvas_row(row) else feed_by_key[_cache_key(row)])
            if candidates:
                event = candidates.popleft()
                if event:
                    cache_events.append(event)
    events = cache_events + [_serialize_user_event(row) for row in native_rows]
    if range_start and range_end:
        events = [event for event in events
                  if _api_event_overlaps_range(event, range_start, range_end)]
    return CalendarProjection(events + list(task_events) + list(provider_events), feed_rows, canvas_events)


def _is_canvas_row(row):
    return bool(row.get("canvas_source_id") or row.get("canvas_event_ref"))


def _cache_key(row):
    return row.get("$id") or row.get("id") or _event_ref_for_cache_event(row)


def load_serialized_calendar_events(
    user_id, settings, range_start=None, range_end=None, *, require_shares_ics=False,
):
    """Load cached feed/native/Canvas rows without task/provider or refresh work."""
    cache_rows = list_calendar_rows_all(
        COLLECTIONS["calendar_cache"],
        _range_queries(user_id, "event_start", "event_end", "event_start", range_start, range_end),
    )
    native_rows = list_calendar_rows_all(
        COLLECTIONS["user_events"],
        _range_queries(user_id, "start", "end", "start", range_start, range_end),
    )
    projection = compose_calendar_events(
        user_id, settings, cache_rows, native_rows,
        _load_calendar_preferences(user_id), _load_event_overrides(user_id),
        range_start, range_end, cache_order="feed_first", require_shares_ics=require_shares_ics,
    )
    return projection.events, projection.feed_rows, native_rows


_load_serialized_calendar_events = load_serialized_calendar_events


def load_calendar_events_for_share(user_id, settings, range_start=None, range_end=None):
    """Project only Canvas sources whose consent explicitly permits sharing."""
    return load_serialized_calendar_events(
        user_id, settings, range_start, range_end, require_shares_ics=True,
    )


def load_events_payload_with_initial_refresh(user_id, response_user_id=None, args=None):
    """Load owner API events, initializing missing feed caches over the network.

    Initial refresh can persist metadata/event diffs. A refresh failure returns
    cached content with refresh_error; storage read failures return HTTP 500.
    Task and external provider projections are included only in this API path.
    """
    args = args or {}
    response_user_id = user_id if response_user_id is None else response_user_id
    range_start = _parse_range_param(args.get("start"))
    range_end = _parse_range_param(args.get("end"))
    if bool(args.get("start")) ^ bool(args.get("end")):
        return {"error": "start and end are required together"}, 400
    if (args.get("start") and not range_start) or (args.get("end") and not range_end):
        return {"error": "start and end must be valid ISO-8601"}, 400
    try:
        settings = first_row(COLLECTIONS["user_settings"], [Query.equal("user_id", [user_id])])
        feed_urls = _configured_feed_urls(settings)
        cache_rows = _load_owner_rows(user_id, "calendar_cache", "event_start")
        native_rows = _load_owner_rows(user_id, "user_events", "start")
        preferences = _load_calendar_preferences(user_id)
        metadata = _load_calendar_feed_metadata(user_id)
        local_sources = _load_local_calendar_sources(user_id)
        overrides = _load_event_overrides(user_id)
    except AppwriteException:
        logger.exception("Failed to load calendar events")
        return {"error": "Unable to load calendar events."}, 500
    refreshed, refresh_error = False, None
    if feed_urls:
        refreshed, refresh_error = _refresh_initial_feed_cache(user_id, feed_urls, cache_rows, metadata)
    if refreshed:
        try:
            cache_rows = _load_owner_rows(user_id, "calendar_cache", "event_start")
            metadata = _load_calendar_feed_metadata(user_id)
        except AppwriteException:
            logger.exception("Failed to reload calendar events after initial feed fetch")
            return {"error": "Unable to load calendar events."}, 500
    try:
        task_events, task_source = _task_calendar_payload(user_id, preferences, range_start, range_end)
    except AppwriteException:
        logger.exception("Failed to load task calendar events")
        return {"error": "Unable to load calendar events."}, 500
    from services.external_calendar_service import project, capabilities
    provider_events, provider_sources = project(user_id, range_start, range_end)
    projection = compose_calendar_events(
        user_id, settings, cache_rows, native_rows, preferences, overrides,
        range_start, range_end, cache_order="input", task_events=task_events,
        provider_events=provider_events,
    )
    sources = _append_task_calendar_source(
        _configured_calendar_sources(settings, projection.feed_rows, preferences, metadata, local_sources, native_rows),
        task_source,
    ) + provider_sources
    return {
        "user_id": response_user_id, "count": len(projection.events),
        "capabilities": capabilities(), "events": projection.events,
        "feed_configured": bool(feed_urls), "calendar_sources": sources,
        "refresh_interval_minutes": settings.get("feed_refresh_minutes") if settings else None,
        "last_fetched": _resolve_last_fetched(user_id), "refresh_error": refresh_error,
    }, 200


def _load_owner_rows(user_id, collection, order_field):
    return list_calendar_rows_all(
        COLLECTIONS[collection], [Query.equal("user_id", [user_id]), Query.order_asc(order_field)],
    )
