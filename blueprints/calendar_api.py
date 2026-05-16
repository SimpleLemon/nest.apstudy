"""
blueprints/calendar_api.py

Per-user calendar data endpoints.
Fetches, caches, and serves Canvas iCal feed data.
Also provides a token-authenticated .ics subscription endpoint.
"""
import hashlib
import json
import logging
import uuid
from collections import Counter
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, Response
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    first_row,
    format_datetime,
    get_row_safe,
    list_rows_all,
    list_rows_safe,
    parse_datetime,
    update_row_safe,
)
from blueprints.settings import (
    _load_other_calendar_urls,
    _normalize_calendar_url,
    _normalize_canvas_calendar_url,
    _settings_defaults,
    _validate_other_calendar_urls,
)

calendar_bp = Blueprint("calendar", __name__)
logger = logging.getLogger(__name__)

CANVAS_SOURCE_ID = "canvas"
FEED_SOURCE_PREFIX = "feed:"
LOCAL_SOURCE_PREFIX = "local:"
DEFAULT_LOCAL_SOURCE_ID = f"{LOCAL_SOURCE_PREFIX}default"
DEFAULT_LOCAL_SOURCE_NAME = "Personal"
DEFAULT_CALENDAR_COLOR = "#6366f1"


def _canonical_feed_url(feed_url):
    return _normalize_calendar_url(feed_url) or (feed_url or "").strip()


def _raw_feed_url_hash(feed_url):
    return hashlib.sha256((feed_url or "").encode("utf-8")).hexdigest()


def _feed_url_hash(feed_url):
    return _raw_feed_url_hash(_canonical_feed_url(feed_url))


def _feed_source_id(feed_url):
    return f"{FEED_SOURCE_PREFIX}{_feed_url_hash(feed_url)}"


def _legacy_feed_source_id(feed_url):
    return f"{FEED_SOURCE_PREFIX}{_raw_feed_url_hash(feed_url)}"


def _normalize_display_name(value):
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:120]


def _normalize_source_label(value):
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().split())[:120]


def _url_fallback_label(feed_url):
    return "Subscribed Calendar"


def _source_id_for_feed_url(feed_url, settings=None):
    canvas_url = (settings or {}).get("canvas_ical_url") or ""
    if canvas_url and _normalize_calendar_url(feed_url) == _normalize_calendar_url(canvas_url):
        return CANVAS_SOURCE_ID
    return _feed_source_id(feed_url)


def _event_ref_for_cache_event(doc):
    feed_hash = doc.get("feed_url_hash") or _feed_url_hash(doc.get("feed_url") or "")
    event_uid = doc.get("event_uid") or ""
    if not feed_hash or not event_uid:
        return None
    uid_hash = hashlib.sha256(str(event_uid).encode("utf-8")).hexdigest()
    return f"feed:{feed_hash}:{uid_hash}"


def _event_ref_for_user_event(doc):
    row_id = doc.get("$id") or doc.get("id")
    return f"user:{row_id}" if row_id else None


def _normalize_color(value):
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        return None
    if len(value) == 7 and value.startswith("#"):
        hex_part = value[1:]
        if all(ch in "0123456789abcdefABCDEF" for ch in hex_part):
            return f"#{hex_part.lower()}"
    raise ValueError("Color must be a valid #RRGGBB value.")


def _normalize_calendar_id(value):
    calendar_id = str(value or "").strip()
    return calendar_id[:255] if calendar_id else DEFAULT_LOCAL_SOURCE_ID


def _serialize_datetime(dt_value, is_all_day=False):
    """
    Serialize a datetime for the API response.

    All-day events are serialized as date-only strings ("2026-04-24")
    WITHOUT a trailing Z, so the browser parses them as local calendar
    dates with no UTC conversion.

    Timed events are serialized as full ISO-8601 with trailing Z
    ("2026-04-24T20:00:00Z"), so the browser correctly converts from
    UTC to the user's local timezone.
    """
    if dt_value is None:
        return None

    if is_all_day:
        return dt_value.strftime("%Y-%m-%d")

    if dt_value.tzinfo is None:
        dt_value = dt_value.replace(tzinfo=timezone.utc)
    else:
        dt_value = dt_value.astimezone(timezone.utc)
    return dt_value.isoformat().replace("+00:00", "Z")


def _span_metadata(start_dt, end_dt, is_all_day=False):
    """
    Compute multi-day flags for calendar rendering metadata.

    For all-day events, iCal DTEND is exclusive: an event on April 24
    has DTSTART=20260424, DTEND=20260425. The span is the day difference.

    For timed events, span counts distinct calendar dates touched
    (start and end dates inclusive).
    """
    if not start_dt or not end_dt:
        return False, 1

    if end_dt <= start_dt:
        return False, 1

    start_date = start_dt.date() if hasattr(start_dt, "date") else start_dt
    end_date = end_dt.date() if hasattr(end_dt, "date") else end_dt

    if is_all_day:
        span_days = max(1, (end_date - start_date).days)
    else:
        span_days = max(1, (end_date - start_date).days + 1)

    return span_days > 1, span_days


def _serialize_event(doc, settings=None):
    """Serialize a calendar_cache row for API response."""
    is_all_day = bool(doc.get("is_all_day", False))
    event_start = parse_datetime(doc.get("event_start"))
    event_end = parse_datetime(doc.get("event_end"))
    fetched_at = parse_datetime(doc.get("fetched_at"))
    is_multi_day, span_days = _span_metadata(event_start, event_end, is_all_day)
    feed_url = doc.get("feed_url") or ""
    calendar_id = _source_id_for_feed_url(feed_url, settings) if feed_url else None
    event_ref = _event_ref_for_cache_event(doc)

    return {
        "uid": doc.get("event_uid"),
        "event_ref": event_ref,
        "source_type": "feed",
        "editable": True,
        "title": doc.get("event_title"),
        "start": _serialize_datetime(event_start, is_all_day),
        "end": _serialize_datetime(event_end, is_all_day),
        "type": doc.get("event_type"),
        "course": doc.get("course_name"),
        "description": doc.get("raw_description"),
        "fetched_at": fetched_at.isoformat() if fetched_at else None,
        "is_multi_day": is_multi_day,
        "span_days": span_days,
        "is_all_day": is_all_day,
        "calendar_id": calendar_id,
        "original_calendar_id": calendar_id,
    }


def _serialize_user_event(doc):
    """Serialize a user_events row for API response."""
    start = parse_datetime(doc.get("start"))
    end = parse_datetime(doc.get("end"))
    created_at = parse_datetime(doc.get("created_at"))
    updated_at = parse_datetime(doc.get("updated_at"))
    is_all_day = bool(doc.get("is_all_day", False))
    calendar_id = doc.get("calendar_id") or DEFAULT_LOCAL_SOURCE_ID
    return {
        "id": doc.get("$id"),
        "event_ref": _event_ref_for_user_event(doc),
        "source_type": "user",
        "editable": True,
        "title": doc.get("title"),
        "description": doc.get("description"),
        "start": _serialize_datetime(start, is_all_day),
        "end": _serialize_datetime(end, is_all_day),
        "is_all_day": is_all_day,
        "color": doc.get("color") or None,
        "calendar_id": calendar_id,
        "created_at": created_at.isoformat() if created_at else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def _coerce_utc(dt_value):
    if dt_value is None:
        return None
    if dt_value.tzinfo is None:
        return dt_value.replace(tzinfo=timezone.utc)
    return dt_value.astimezone(timezone.utc)


def _parse_range_param(value):
    if not value:
        return None
    parsed = parse_datetime(value)
    return _coerce_utc(parsed) if parsed else None


def _event_overlaps_range(start_value, end_value, range_start, range_end):
    if not range_start or not range_end:
        return True
    start_dt = _coerce_utc(parse_datetime(start_value))
    end_dt = _coerce_utc(parse_datetime(end_value)) or start_dt
    if not start_dt or not end_dt:
        return False
    return start_dt < range_end and end_dt > range_start


def _resolve_last_fetched(user_id):
    last_fetched = None
    feed_table = COLLECTIONS.get("calendar_feeds")
    latest_feed = None
    if feed_table:
        try:
            latest_feed = first_row(
                feed_table,
                [
                    Query.equal("user_id", [user_id]),
                    Query.order_desc("last_fetched"),
                ],
            )
        except AppwriteException:
            latest_feed = None

    if latest_feed and latest_feed.get("last_fetched"):
        parsed = parse_datetime(latest_feed.get("last_fetched"))
        if parsed:
            return parsed.isoformat()

    try:
        latest_event = first_row(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_desc("fetched_at"),
            ],
        )
    except AppwriteException:
        latest_event = None

    if latest_event and latest_event.get("fetched_at"):
        parsed = parse_datetime(latest_event.get("fetched_at"))
        if parsed:
            last_fetched = parsed.isoformat()
    return last_fetched


def _configured_feed_urls(settings):
    """Return all configured calendar feed URLs for a user."""
    if not settings:
        return []
    urls = []
    canvas_url = settings.get("canvas_ical_url")
    if canvas_url:
        urls.append(canvas_url.strip())
    other_urls = settings.get("other_ical_urls_json")
    if other_urls:
        try:
            extras = json.loads(other_urls)
            if isinstance(extras, list):
                for item in extras:
                    if isinstance(item, str) and item.strip():
                        urls.append(item.strip())
        except json.JSONDecodeError:
            pass
    return urls


def _load_calendar_feed_metadata(user_id):
    feed_table = COLLECTIONS.get("calendar_feeds")
    if not feed_table:
        return {}
    rows = list_rows_all(
        feed_table,
        [Query.equal("user_id", [str(user_id)])],
    )
    return {row.get("feed_url_hash"): row for row in rows if row.get("feed_url_hash")}


def _configured_feed_sources(settings, cache_events=None, preferences=None, feed_metadata=None):
    """Return editable feed source metadata for configured URLs."""
    if not settings:
        return []

    cache_events = cache_events or []
    preferences = preferences or []
    feed_metadata = feed_metadata or {}
    prefs_by_name = {
        pref.get("calendar_name"): pref
        for pref in preferences
        if pref.get("calendar_name")
    }
    labels_by_hash = {}
    for row in cache_events:
        feed_hash = row.get("feed_url_hash")
        label = row.get("course_name")
        if feed_hash and label:
            labels_by_hash.setdefault(feed_hash, Counter())[label] += 1

    sources = []
    canvas_url = (settings.get("canvas_ical_url") or "").strip()
    if canvas_url:
        sources.append({
            "id": CANVAS_SOURCE_ID,
            "kind": "canvas",
            "default_name": "Canvas",
            "url": canvas_url,
            "editable": True,
            "legacy_names": ["Canvas"],
        })

    other_urls = _load_other_calendar_urls(settings)
    for url in other_urls:
        feed_hash = _feed_url_hash(url)
        raw_feed_hash = _raw_feed_url_hash(url)
        label_counts = labels_by_hash.get(feed_hash)
        if not label_counts and raw_feed_hash != feed_hash:
            label_counts = labels_by_hash.get(raw_feed_hash)
        metadata = feed_metadata.get(feed_hash) or feed_metadata.get(raw_feed_hash) or {}
        metadata_name = _normalize_source_label(metadata.get("calendar_name"))
        default_name = metadata_name
        if label_counts:
            default_name = default_name or label_counts.most_common(1)[0][0]
        default_name = _normalize_source_label(default_name) or _url_fallback_label(url)
        legacy_source_id = _legacy_feed_source_id(url)
        legacy_names = [default_name]
        if legacy_source_id != _feed_source_id(url):
            legacy_names.append(legacy_source_id)
        sources.append({
            "id": _feed_source_id(url),
            "kind": "external",
            "default_name": default_name,
            "url": url,
            "editable": True,
            "legacy_names": legacy_names,
        })

    for source in sources:
        source_pref = prefs_by_name.get(source["id"])
        legacy_pref = next(
            (prefs_by_name.get(name) for name in source.get("legacy_names", []) if prefs_by_name.get(name)),
            None,
        )
        display_name = (
            (source_pref or {}).get("display_name")
            or (legacy_pref or {}).get("display_name")
            or ""
        )
        source["display_name"] = display_name

    return sources


def _load_local_calendar_sources(user_id):
    table_id = COLLECTIONS.get("user_calendar_sources")
    if not table_id:
        return []
    return list_rows_all(
        table_id,
        [Query.equal("user_id", [str(user_id)])],
    )


def _configured_local_sources(local_sources=None, preferences=None, created_events=None):
    local_sources = local_sources or []
    preferences = preferences or []
    created_events = created_events or []
    prefs_by_name = {
        pref.get("calendar_name"): pref
        for pref in preferences
        if pref.get("calendar_name")
    }
    rows_by_source = {
        row.get("source_id"): row
        for row in local_sources
        if row.get("source_id")
    }
    if any(not event.get("calendar_id") for event in created_events):
        rows_by_source.setdefault(
            DEFAULT_LOCAL_SOURCE_ID,
            {
                "source_id": DEFAULT_LOCAL_SOURCE_ID,
                "default_name": DEFAULT_LOCAL_SOURCE_NAME,
                "kind": "local",
            },
        )

    sources = []
    for source_id, row in rows_by_source.items():
        default_name = _normalize_source_label(row.get("default_name")) or DEFAULT_LOCAL_SOURCE_NAME
        pref = prefs_by_name.get(source_id) or {}
        sources.append({
            "id": source_id,
            "kind": row.get("kind") or "local",
            "default_name": default_name,
            "display_name": pref.get("display_name") or "",
            "url": "",
            "editable": True,
            "source_id": source_id,
            "legacy_names": [],
        })
    return sorted(sources, key=lambda item: (item.get("display_name") or item.get("default_name") or "").lower())


def _configured_calendar_sources(settings, cache_events=None, preferences=None, feed_metadata=None, local_sources=None, created_events=None):
    return _configured_feed_sources(settings, cache_events, preferences, feed_metadata) + _configured_local_sources(
        local_sources,
        preferences,
        created_events,
    )


def _ensure_user_settings(user_id):
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [str(user_id)])],
    )
    if settings:
        return settings
    return create_row_safe(
        COLLECTIONS["user_settings"],
        row_id=str(user_id),
        data=_settings_defaults(str(user_id)),
    )


def _ensure_local_calendar_source(user_id, source_id=DEFAULT_LOCAL_SOURCE_ID, display_name=DEFAULT_LOCAL_SOURCE_NAME):
    source_id = _normalize_calendar_id(source_id)
    if not source_id.startswith(LOCAL_SOURCE_PREFIX):
        return None
    table_id = COLLECTIONS.get("user_calendar_sources")
    if not table_id:
        return None
    existing = first_row(
        table_id,
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("source_id", [source_id]),
        ],
    )
    if existing:
        return existing
    now = format_datetime(datetime.utcnow())
    return create_row_safe(
        table_id,
        row_id=ID.unique(),
        data={
            "user_id": str(user_id),
            "source_id": source_id,
            "kind": "local",
            "default_name": _normalize_source_label(display_name) or DEFAULT_LOCAL_SOURCE_NAME,
            "created_at": now,
            "updated_at": now,
        },
    )


def _load_event_overrides(user_id):
    table_id = COLLECTIONS.get("user_event_overrides")
    if not table_id:
        return []
    return list_rows_all(
        table_id,
        [Query.equal("user_id", [str(user_id)])],
    )


def _apply_event_override(event, override):
    if not override:
        return event
    if bool(override.get("hidden", False)):
        return None
    result = dict(event)
    is_all_day = bool(override.get("is_all_day")) if override.get("is_all_day") is not None else bool(result.get("is_all_day"))
    if override.get("title") is not None:
        result["title"] = override.get("title")
    if override.get("description") is not None:
        result["description"] = override.get("description")
    if override.get("calendar_id"):
        result["calendar_id"] = override.get("calendar_id")
    if override.get("color") is not None:
        result["color"] = override.get("color") or None
    if override.get("is_all_day") is not None:
        result["is_all_day"] = is_all_day
    if override.get("start"):
        result["start"] = _serialize_datetime(parse_datetime(override.get("start")), is_all_day)
    if override.get("end"):
        result["end"] = _serialize_datetime(parse_datetime(override.get("end")), is_all_day)
    result["override_id"] = override.get("$id")
    result["has_override"] = True
    return result


def _api_event_overlaps_range(event, range_start, range_end):
    if not range_start or not range_end:
        return True
    return _event_overlaps_range(event.get("start"), event.get("end") or event.get("start"), range_start, range_end)


def _filter_configured_cache_events(cache_events, feed_urls):
    configured_hashes = set()
    for url in feed_urls:
        if not url:
            continue
        configured_hashes.add(_feed_url_hash(url))
        configured_hashes.add(_raw_feed_url_hash(url))
    return [
        event
        for event in cache_events
        if event.get("feed_url_hash") in configured_hashes
    ]


def _feed_needs_initial_fetch(feed_url, cache_events, feed_metadata):
    canonical_hash = _feed_url_hash(feed_url)
    raw_hash = _raw_feed_url_hash(feed_url)
    hashes = {canonical_hash, raw_hash}
    has_cache = any(event.get("feed_url_hash") in hashes for event in cache_events)
    metadata = feed_metadata.get(canonical_hash) or feed_metadata.get(raw_hash) or {}
    has_named_metadata = bool(_normalize_source_label(metadata.get("calendar_name")))
    return not has_named_metadata and not has_cache


def _initial_fetch_feed_urls(feed_urls, cache_events, feed_metadata):
    return [
        url
        for url in feed_urls
        if url and _feed_needs_initial_fetch(url, cache_events, feed_metadata)
    ]


def _refresh_initial_feed_cache(user_id, feed_urls, cache_events, feed_metadata):
    missing_urls = _initial_fetch_feed_urls(feed_urls, cache_events, feed_metadata)
    if not missing_urls:
        return False, None

    try:
        from services.feed_fetcher import fetch_and_cache_feeds

        fetch_and_cache_feeds(user_id, missing_urls)
        return True, None
    except Exception as exc:
        logger.exception(
            "Initial calendar feed fetch failed",
            extra={"user_id": user_id, "feed_count": len(missing_urls)},
        )
        return False, str(exc)


def _delete_cache_rows_for_feed(user_id, feed_url):
    feed_hashes = {_feed_url_hash(feed_url), _raw_feed_url_hash(feed_url)}
    seen_row_ids = set()
    for feed_hash in feed_hashes:
        rows = list_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [str(user_id)]),
                Query.equal("feed_url_hash", [feed_hash]),
            ],
        )
        for row in rows:
            row_id = row.get("$id") or row.get("id")
            if row_id and row_id not in seen_row_ids:
                seen_row_ids.add(row_id)
                delete_row_safe(COLLECTIONS["calendar_cache"], row_id)

    feed_table = COLLECTIONS.get("calendar_feeds")
    if feed_table:
        seen_feed_row_ids = set()
        for feed_hash in feed_hashes:
            feed_rows = list_rows_all(
                feed_table,
                [
                    Query.equal("user_id", [str(user_id)]),
                    Query.equal("feed_url_hash", [feed_hash]),
                ],
            )
            for row in feed_rows:
                row_id = row.get("$id") or row.get("id")
                if row_id and row_id not in seen_feed_row_ids:
                    seen_feed_row_ids.add(row_id)
                    delete_row_safe(feed_table, row_id)

def _load_calendar_preferences(user_id):
    return list_rows_all(
        COLLECTIONS["user_calendar_preferences"],
        [Query.equal("user_id", [str(user_id)])],
    )


def _upsert_calendar_preference(user_id, calendar_name, updates):
    pref = first_row(
        COLLECTIONS["user_calendar_preferences"],
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("calendar_name", [calendar_name]),
        ],
    )
    now = format_datetime(datetime.utcnow())
    payload = {"updated_at": now, **updates}
    if not pref:
        pref = create_row_safe(
            COLLECTIONS["user_calendar_preferences"],
            row_id=ID.unique(),
            data={
                "user_id": str(user_id),
                "calendar_name": calendar_name,
                "color_hex": updates.get("color_hex") or "#6366f1",
                "visible": bool(True if updates.get("visible") is None else updates.get("visible")),
                "created_at": now,
                **payload,
            },
        )
    else:
        pref = update_row_safe(
            COLLECTIONS["user_calendar_preferences"],
            pref.get("$id"),
            payload,
        )
    return pref


def _upsert_event_override(user_id, event_ref, updates):
    table_id = COLLECTIONS["user_event_overrides"]
    existing = first_row(
        table_id,
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("event_ref", [event_ref]),
        ],
    )
    now = format_datetime(datetime.utcnow())
    payload = {"updated_at": now, **updates}
    if not existing:
        return create_row_safe(
            table_id,
            row_id=ID.unique(),
            data={
                "user_id": str(user_id),
                "event_ref": event_ref,
                "hidden": False,
                "created_at": now,
                **payload,
            },
        )
    return update_row_safe(
        table_id,
        existing.get("$id"),
        payload,
    )


def _settings_payload_for_source_update(settings, source_id, next_url):
    if not settings:
        raise ValueError("No calendar settings found.")

    current_canvas_url = (settings.get("canvas_ical_url") or "").strip()
    other_urls = _load_other_calendar_urls(settings)

    if source_id == CANVAS_SOURCE_ID:
        normalized_canvas = _normalize_canvas_calendar_url(next_url)
        if not normalized_canvas:
            raise ValueError("Canvas calendar must use https://canvas.<school>.edu/feeds/calendar...")
        validated_other_urls = _validate_other_calendar_urls(other_urls, normalized_canvas)
        return {
            "old_url": current_canvas_url,
            "new_url": normalized_canvas,
            "new_source_id": CANVAS_SOURCE_ID,
            "settings_updates": {
                "canvas_ical_url": normalized_canvas,
                "other_ical_urls_json": json.dumps(validated_other_urls),
            },
        }

    if not source_id.startswith(FEED_SOURCE_PREFIX):
        raise ValueError("Only feed calendars can be edited.")

    match_index = None
    for index, url in enumerate(other_urls):
        if _feed_source_id(url) == source_id or _legacy_feed_source_id(url) == source_id:
            match_index = index
            break
    if match_index is None:
        raise ValueError("Calendar source was not found.")
    if not (next_url or "").strip():
        raise ValueError("Calendar URL is required.")

    candidate_urls = list(other_urls)
    candidate_urls[match_index] = (next_url or "").strip()
    validated_other_urls = _validate_other_calendar_urls(candidate_urls, current_canvas_url)
    new_url = validated_other_urls[match_index]
    return {
        "old_url": other_urls[match_index],
        "new_url": new_url,
        "new_source_id": _feed_source_id(new_url),
        "settings_updates": {
            "other_ical_urls_json": json.dumps(validated_other_urls),
        },
    }


@calendar_bp.route("/events")
@login_required
def get_events():
    """
    GET /api/calendar/events
    Returns cached calendar events for the authenticated user.
    """
    user_id = str(current_user.id)
    range_start = _parse_range_param(request.args.get("start"))
    range_end = _parse_range_param(request.args.get("end"))
    if bool(request.args.get("start")) ^ bool(request.args.get("end")):
        return jsonify({"error": "start and end are required together"}), 400
    if (request.args.get("start") and not range_start) or (
        request.args.get("end") and not range_end
    ):
        return jsonify({"error": "start and end must be valid ISO-8601"}), 400

    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
        feed_urls = _configured_feed_urls(settings)
        cache_events = list_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("event_start"),
            ],
        )
        created_events = list_rows_all(
            COLLECTIONS["user_events"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("start"),
            ],
        )
        preferences = _load_calendar_preferences(user_id)
        feed_metadata = _load_calendar_feed_metadata(user_id)
        local_sources = _load_local_calendar_sources(user_id)
        event_overrides = _load_event_overrides(user_id)
    except AppwriteException:
        logger.exception("Failed to load calendar events")
        return jsonify({"error": "Unable to load calendar events."}), 500

    refresh_error = None
    refreshed = False
    if feed_urls:
        refreshed, refresh_error = _refresh_initial_feed_cache(user_id, feed_urls, cache_events, feed_metadata)
    if refreshed:
        try:
            cache_events = list_rows_all(
                COLLECTIONS["calendar_cache"],
                [
                    Query.equal("user_id", [user_id]),
                    Query.order_asc("event_start"),
                ],
            )
            feed_metadata = _load_calendar_feed_metadata(user_id)
        except AppwriteException:
            logger.exception("Failed to reload calendar events after initial feed fetch")
            return jsonify({"error": "Unable to load calendar events."}), 500

    cache_events = _filter_configured_cache_events(cache_events, feed_urls)
    calendar_sources = _configured_calendar_sources(
        settings,
        cache_events,
        preferences,
        feed_metadata,
        local_sources,
        created_events,
    )
    overrides_by_ref = {
        override.get("event_ref"): override
        for override in event_overrides
        if override.get("event_ref")
    }

    serialized_cache_events = []
    for cache_event in cache_events:
        serialized_event = _serialize_event(cache_event, settings)
        serialized_event = _apply_event_override(
            serialized_event,
            overrides_by_ref.get(serialized_event.get("event_ref")),
        )
        if serialized_event:
            serialized_cache_events.append(serialized_event)
    serialized_created_events = [_serialize_user_event(e) for e in created_events]

    if range_start and range_end:
        serialized_cache_events = [
            e
            for e in serialized_cache_events
            if _api_event_overlaps_range(e, range_start, range_end)
        ]
        serialized_created_events = [
            e
            for e in serialized_created_events
            if _api_event_overlaps_range(e, range_start, range_end)
        ]

    serialized = serialized_cache_events + serialized_created_events

    return jsonify({
        "user_id": current_user.id,
        "count": len(serialized),
        "events": serialized,
        "feed_configured": bool(feed_urls),
        "calendar_sources": calendar_sources,
        "refresh_interval_minutes": settings.get("feed_refresh_minutes") if settings else None,
        "last_fetched": _resolve_last_fetched(user_id),
        "refresh_error": refresh_error,
    })


def _parse_iso_like(s):
    """Parse ISO-ish datetime or date strings into a naive UTC datetime for storage.

    Accepts date-only strings (YYYY-MM-DD) and full ISO strings that may end with Z.
    Returns a naive datetime in UTC for timed events, and local-midnight datetime for all-day.
    """
    if not s:
        return None

    s = str(s)
    # date-only -> treat as local midnight (all-day semantics)
    import re
    from datetime import datetime, timezone

    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        parts = s.split("-")
        return datetime(int(parts[0]), int(parts[1]), int(parts[2]), 0, 0, 0)

    # replace trailing Z with +00:00 for fromisoformat
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"

    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


@calendar_bp.route("/events", methods=["POST"])
@login_required
def create_event():
    """POST /api/calendar/events - create a user event"""
    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    description = data.get("description")
    start_raw = data.get("start_date") or data.get("start")
    end_raw = data.get("end_date") or data.get("end")
    all_day = bool(data.get("all_day", False))
    calendar_id = _normalize_calendar_id(data.get("calendar_id"))
    try:
        color = _normalize_color(data.get("color"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not title:
        return jsonify({"error": "title is required"}), 400

    start_dt = _parse_iso_like(start_raw)
    end_dt = _parse_iso_like(end_raw)

    if not start_dt or not end_dt:
        return jsonify({"error": "start_date and end_date must be valid ISO datetimes"}), 400

    if end_dt <= start_dt:
        return jsonify({"error": "end_date must be after start_date"}), 400

    try:
        _ensure_local_calendar_source(user_id=current_user.id, source_id=calendar_id)
        ev = create_row_safe(
            COLLECTIONS["user_events"],
            row_id=ID.unique(),
            data={
                "user_id": str(current_user.id),
                "title": title,
                "description": description,
                "start": format_datetime(start_dt),
                "end": format_datetime(end_dt),
                "is_all_day": all_day,
                "color": color,
                "calendar_id": calendar_id,
                "created_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to create user event")
        return jsonify({"error": "Unable to create event."}), 500

    return jsonify({"success": True, "event": _serialize_user_event(ev)})


@calendar_bp.route("/events/<event_id>", methods=["GET"])
@login_required
def get_single_event(event_id):
    try:
        ev = get_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "not found"}), 404
        logger.exception("Failed to load user event")
        return jsonify({"error": "Unable to load event."}), 500

    if ev.get("user_id") != str(current_user.id):
        return jsonify({"error": "not found"}), 404
    return jsonify({"event": _serialize_user_event(ev)})


@calendar_bp.route("/events/<event_id>", methods=["PUT"])
@login_required
def update_event(event_id):
    try:
        ev = get_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "not found"}), 404
        logger.exception("Failed to load user event")
        return jsonify({"error": "Unable to load event."}), 500

    if ev.get("user_id") != str(current_user.id):
        return jsonify({"error": "not found"}), 404

    data = request.get_json() or {}
    title = data.get("title")
    description = data.get("description")
    start_raw = data.get("start_date") or data.get("start")
    end_raw = data.get("end_date") or data.get("end")
    all_day = data.get("all_day")
    calendar_id = data.get("calendar_id")

    updates = {"updated_at": format_datetime(datetime.utcnow())}
    if title is not None:
        updates["title"] = title
    if description is not None:
        updates["description"] = description
    if start_raw is not None:
        parsed = _parse_iso_like(start_raw)
        if parsed:
            updates["start"] = format_datetime(parsed)
    if end_raw is not None:
        parsed = _parse_iso_like(end_raw)
        if parsed:
            updates["end"] = format_datetime(parsed)
    if all_day is not None:
        updates["is_all_day"] = bool(all_day)
    if "color" in data:
        try:
            updates["color"] = _normalize_color(data.get("color"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
    if calendar_id is not None:
        normalized_calendar_id = _normalize_calendar_id(calendar_id)
        _ensure_local_calendar_source(user_id=current_user.id, source_id=normalized_calendar_id)
        updates["calendar_id"] = normalized_calendar_id

    try:
        ev = update_row_safe(
            COLLECTIONS["user_events"],
            event_id,
            updates,
        )
    except AppwriteException:
        logger.exception("Failed to update user event")
        return jsonify({"error": "Unable to update event."}), 500

    return jsonify({"success": True, "event": _serialize_user_event(ev)})


@calendar_bp.route("/events/<event_id>", methods=["DELETE"])
@login_required
def delete_event(event_id):
    try:
        ev = get_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "not found"}), 404
        logger.exception("Failed to load user event")
        return jsonify({"error": "Unable to delete event."}), 500

    if ev.get("user_id") != str(current_user.id):
        return jsonify({"error": "not found"}), 404

    try:
        delete_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException:
        logger.exception("Failed to delete user event")
        return jsonify({"error": "Unable to delete event."}), 500

    return jsonify({"success": True})


@calendar_bp.route("/event-overrides", methods=["POST"])
@login_required
def upsert_event_override():
    """Create or update the authenticated user's override for an imported event."""
    data = request.get_json(silent=True) or {}
    event_ref = (data.get("event_ref") or "").strip()
    if not event_ref.startswith("feed:"):
        return jsonify({"error": "event_ref is required for an imported event."}), 400

    title = (data.get("title") or "").strip()
    start_raw = data.get("start_date") or data.get("start")
    end_raw = data.get("end_date") or data.get("end")
    all_day = bool(data.get("all_day", data.get("is_all_day", False)))
    calendar_id = _normalize_calendar_id(data.get("calendar_id"))

    if not title:
        return jsonify({"error": "title is required"}), 400

    start_dt = _parse_iso_like(start_raw)
    end_dt = _parse_iso_like(end_raw)
    if not start_dt or not end_dt:
        return jsonify({"error": "start_date and end_date must be valid ISO datetimes"}), 400
    if end_dt <= start_dt:
        return jsonify({"error": "end_date must be after start_date"}), 400

    try:
        color = _normalize_color(data.get("color"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        _ensure_local_calendar_source(current_user.id, calendar_id)
        override = _upsert_event_override(
            current_user.id,
            event_ref,
            {
                "title": title,
                "description": data.get("description") or "",
                "start": format_datetime(start_dt),
                "end": format_datetime(end_dt),
                "is_all_day": all_day,
                "calendar_id": calendar_id,
                "color": color,
                "hidden": False,
            },
        )
    except AppwriteException:
        logger.exception("Failed to save event override")
        return jsonify({"error": "Unable to save event override."}), 500

    return jsonify({"success": True, "override": override})


@calendar_bp.route("/event-overrides/hide", methods=["POST"])
@login_required
def hide_event_override():
    """Hide an imported event for the authenticated user without deleting the source feed event."""
    data = request.get_json(silent=True) or {}
    event_ref = (data.get("event_ref") or "").strip()
    if not event_ref.startswith("feed:"):
        return jsonify({"error": "event_ref is required for an imported event."}), 400

    try:
        override = _upsert_event_override(
            current_user.id,
            event_ref,
            {"hidden": True},
        )
    except AppwriteException:
        logger.exception("Failed to hide imported event")
        return jsonify({"error": "Unable to delete event."}), 500

    return jsonify({"success": True, "override": override})


@calendar_bp.route("/refresh", methods=["POST"])
@login_required
def refresh_feed():
    """
    POST /api/calendar/refresh
    Triggers an immediate re-fetch of all configured user calendar feeds.
    """
    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
        return jsonify({"error": "Unable to refresh calendar feeds."}), 500

    feed_urls = _configured_feed_urls(settings)

    if not feed_urls:
        return jsonify({
            "error": "No calendar feed URLs configured. Visit Settings to add one."
        }), 400

    from services.feed_fetcher import fetch_and_cache_feeds

    try:
        count = fetch_and_cache_feeds(user_id, feed_urls)
        update_row_safe(
            COLLECTIONS["user_settings"],
            settings.get("$id"),
            {"updated_at": format_datetime(datetime.utcnow())},
        )
        return jsonify({"status": "ok", "events_cached": count})
    except AppwriteException:
        logger.exception("Failed to update settings after refresh")
        return jsonify({"error": "Unable to refresh calendar feeds."}), 500
    except Exception as e:
        logger.exception(
            "Calendar refresh failed",
            extra={"user_id": user_id, "feed_count": len(feed_urls)},
        )
        return jsonify({"error": f"Feed fetch failed: {str(e)}"}), 500


@calendar_bp.route("/sources", methods=["POST"])
@login_required
def update_calendar_source():
    """
    POST /api/calendar/sources
    Updates an editable feed calendar source name and URL.
    """
    data = request.get_json(silent=True) or {}
    source_id = (data.get("source_id") or "").strip()
    next_display_name = _normalize_display_name(data.get("display_name"))
    next_url = (data.get("url") or "").strip()

    if not source_id:
        return jsonify({"error": "source_id is required"}), 400

    if source_id.startswith(LOCAL_SOURCE_PREFIX):
        user_id = str(current_user.id)
        try:
            source = _ensure_local_calendar_source(user_id, source_id, next_display_name or DEFAULT_LOCAL_SOURCE_NAME)
            if source and next_display_name:
                source = update_row_safe(
                    COLLECTIONS["user_calendar_sources"],
                    source.get("$id"),
                    {
                        "default_name": next_display_name,
                        "updated_at": format_datetime(datetime.utcnow()),
                    },
                )
            _upsert_calendar_preference(user_id, source_id, {"display_name": next_display_name})
            preferences = _load_calendar_preferences(user_id)
            local_sources = _load_local_calendar_sources(user_id)
        except AppwriteException:
            logger.exception("Failed to update local calendar source")
            return jsonify({"error": "Unable to update calendar source."}), 500
        sources = _configured_local_sources(local_sources, preferences)
        return jsonify({
            "status": "ok",
            "source": next((item for item in sources if item.get("id") == source_id), None),
            "refresh_required": False,
        })

    if not next_url:
        return jsonify({"error": "Calendar URL is required."}), 400

    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
        return jsonify({"error": "Unable to update calendar source."}), 500

    try:
        update_info = _settings_payload_for_source_update(settings, source_id, next_url)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    old_source_pref = None
    try:
        old_source_pref = first_row(
            COLLECTIONS["user_calendar_preferences"],
            [
                Query.equal("user_id", [user_id]),
                Query.equal("calendar_name", [source_id]),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar preference")
        return jsonify({"error": "Unable to update calendar source."}), 500

    old_url = update_info["old_url"]
    new_url = update_info["new_url"]
    new_source_id = update_info["new_source_id"]
    refresh_required = _normalize_calendar_url(old_url) != _normalize_calendar_url(new_url)
    settings_updates = {
        **update_info["settings_updates"],
        "updated_at": format_datetime(datetime.utcnow()),
    }

    try:
        settings = update_row_safe(
            COLLECTIONS["user_settings"],
            settings.get("$id"),
            settings_updates,
        )
        pref_updates = {"display_name": next_display_name}
        if old_source_pref:
            if old_source_pref.get("color_hex"):
                pref_updates["color_hex"] = old_source_pref.get("color_hex")
            if old_source_pref.get("visible") is not None:
                pref_updates["visible"] = bool(old_source_pref.get("visible"))
        _upsert_calendar_preference(user_id, new_source_id, pref_updates)
        if refresh_required and old_url:
            _delete_cache_rows_for_feed(user_id, old_url)

        cache_events = list_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("event_start"),
            ],
        )
        preferences = _load_calendar_preferences(user_id)
        feed_metadata = _load_calendar_feed_metadata(user_id)
    except AppwriteException:
        logger.exception("Failed to update calendar source")
        return jsonify({"error": "Unable to update calendar source."}), 500

    feed_urls = _configured_feed_urls(settings)
    cache_events = _filter_configured_cache_events(cache_events, feed_urls)
    sources = _configured_feed_sources(settings, cache_events, preferences, feed_metadata)
    source = next((item for item in sources if item.get("id") == new_source_id), None)

    return jsonify({
        "status": "ok",
        "source": source,
        "refresh_required": refresh_required,
    })


@calendar_bp.route("/sources/local", methods=["POST"])
@login_required
def create_local_calendar_source():
    data = request.get_json(silent=True) or {}
    display_name = _normalize_display_name(data.get("display_name")) or DEFAULT_LOCAL_SOURCE_NAME
    try:
        color_hex = _normalize_color(data.get("color_hex") or data.get("color")) or DEFAULT_CALENDAR_COLOR
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    user_id = str(current_user.id)
    source_id = f"{LOCAL_SOURCE_PREFIX}{uuid.uuid4().hex}"
    try:
        _ensure_local_calendar_source(user_id, source_id, display_name)
        _upsert_calendar_preference(
            user_id,
            source_id,
            {
                "display_name": display_name,
                "color_hex": color_hex,
                "visible": True,
            },
        )
        preferences = _load_calendar_preferences(user_id)
        local_sources = _load_local_calendar_sources(user_id)
    except AppwriteException:
        logger.exception("Failed to create local calendar source")
        return jsonify({"error": "Unable to create calendar."}), 500

    sources = _configured_local_sources(local_sources, preferences)
    return jsonify({
        "status": "ok",
        "source": next((item for item in sources if item.get("id") == source_id), None),
    })


@calendar_bp.route("/sources/url", methods=["POST"])
@login_required
def create_url_calendar_source():
    data = request.get_json(silent=True) or {}
    raw_url = (data.get("url") or "").strip()
    display_name = _normalize_display_name(data.get("display_name"))
    try:
        color_hex = _normalize_color(data.get("color_hex") or data.get("color")) if (data.get("color_hex") or data.get("color")) else None
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not raw_url:
        return jsonify({"error": "Calendar URL is required."}), 400

    user_id = str(current_user.id)
    try:
        settings = _ensure_user_settings(user_id)
        current_canvas_url = (settings.get("canvas_ical_url") or "").strip()
        other_urls = _load_other_calendar_urls(settings)
        validated_other_urls = _validate_other_calendar_urls(other_urls + [raw_url], current_canvas_url)
        new_url = validated_other_urls[-1]
        settings = update_row_safe(
            COLLECTIONS["user_settings"],
            settings.get("$id"),
            {
                "other_ical_urls_json": json.dumps(validated_other_urls),
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
        source_id = _feed_source_id(new_url)
        pref_updates = {"display_name": display_name, "visible": True}
        if color_hex:
            pref_updates["color_hex"] = color_hex
        _upsert_calendar_preference(user_id, source_id, pref_updates)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except AppwriteException:
        logger.exception("Failed to create URL calendar source")
        return jsonify({"error": "Unable to add calendar."}), 500

    refresh_error = None
    try:
        from services.feed_fetcher import fetch_and_cache_feeds

        fetch_and_cache_feeds(user_id, [new_url])
    except Exception as exc:
        logger.exception("Failed to fetch new URL calendar source", extra={"user_id": user_id})
        refresh_error = str(exc)

    try:
        cache_events = list_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("event_start"),
            ],
        )
        preferences = _load_calendar_preferences(user_id)
        feed_metadata = _load_calendar_feed_metadata(user_id)
    except AppwriteException:
        logger.exception("Failed to load new URL calendar source")
        return jsonify({"error": "Calendar was added, but source metadata could not be loaded."}), 500

    cache_events = _filter_configured_cache_events(cache_events, _configured_feed_urls(settings))
    sources = _configured_feed_sources(settings, cache_events, preferences, feed_metadata)
    return jsonify({
        "status": "ok",
        "source": next((item for item in sources if item.get("id") == source_id), None),
        "refresh_error": refresh_error,
    })


@calendar_bp.route("/status")
@login_required
def feed_status():
    """
    GET /api/calendar/status
    """
    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
        feed_urls = _configured_feed_urls(settings)

        count_response = list_rows_safe(
            COLLECTIONS["calendar_cache"],
            [Query.equal("user_id", [user_id]), Query.limit(1)],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar status")
        return jsonify({"error": "Unable to load calendar status."}), 500

    return jsonify({
        "feed_configured": bool(feed_urls),
        "configured_feed_count": len(feed_urls),
        "refresh_interval_minutes": settings.get("feed_refresh_minutes") if settings else None,
        "last_fetched": _resolve_last_fetched(user_id),
        "cached_event_count": count_response.get("total", 0),
    })


@calendar_bp.route("/preferences", methods=["GET"])
@login_required
def get_calendar_preferences():
    """
    GET /api/calendar/preferences
    """
    user_id = str(current_user.id)
    try:
        prefs = list_rows_all(
            COLLECTIONS["user_calendar_preferences"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar preferences")
        return jsonify({"error": "Unable to load calendar preferences."}), 500

    return jsonify({
        "preferences": [
            {
                "calendar_name": p.get("calendar_name"),
                "color_hex": p.get("color_hex"),
                "visible": p.get("visible"),
                "display_name": p.get("display_name") or "",
            }
            for p in prefs
        ]
    })


@calendar_bp.route("/preferences", methods=["POST"])
@login_required
def update_calendar_preferences():
    """
    POST /api/calendar/preferences
    """
    data = request.get_json() or {}
    calendar_name = data.get("calendar_name")
    color_hex = data.get("color_hex")
    visible = data.get("visible")
    display_name = data.get("display_name")

    if not calendar_name:
        return jsonify({"error": "calendar_name is required"}), 400

    user_id = str(current_user.id)
    updates = {}
    if color_hex:
        updates["color_hex"] = color_hex
    if visible is not None:
        updates["visible"] = bool(visible)
    if display_name is not None:
        updates["display_name"] = _normalize_display_name(display_name)

    try:
        pref = _upsert_calendar_preference(user_id, calendar_name, updates)
    except AppwriteException:
        logger.exception("Failed to update calendar preference")
        return jsonify({"error": "Unable to update preferences."}), 500

    return jsonify({
        "status": "ok",
        "calendar_name": calendar_name,
        "color_hex": pref.get("color_hex"),
        "visible": pref.get("visible"),
        "display_name": pref.get("display_name") or "",
    })


@calendar_bp.route("/feed.ics")
def ics_feed():
    """
    GET /api/calendar/feed.ics?token=USER_SPECIFIC_TOKEN
    """
    token = request.args.get("token")
    if not token:
        return Response("Missing token", status=401, mimetype="text/plain")

    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("ics_secret_token", [token])],
        )
    except AppwriteException:
        logger.exception("Failed to resolve calendar token")
        return Response("Feed lookup failed", status=500, mimetype="text/plain")
    if not settings:
        return Response("Invalid token", status=403, mimetype="text/plain")

    from services.ics_builder import build_ics_for_user

    try:
        ics_content = build_ics_for_user(settings.get("user_id"))
        return Response(
            ics_content,
            status=200,
            mimetype="text/calendar",
            headers={
                "Content-Disposition": "attachment; filename=nest_apstudy.ics",
            },
        )
    except Exception as e:
        return Response(
            f"Feed generation failed: {str(e)}",
            status=500,
            mimetype="text/plain",
        )
