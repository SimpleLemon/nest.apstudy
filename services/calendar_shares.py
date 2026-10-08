"""Calendar share scope policy, share metadata, and public payload sanitization."""

from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import first_row, format_datetime, get_row_safe, parse_datetime
from datetime import datetime, timedelta, timezone
from flask import url_for
from services.calendar_store import first_calendar_row
from services.row_utils import row_id as _row_id
from werkzeug.routing import BuildError
import json
import secrets
from services.calendar_constants import (
    CALENDAR_SHARE_CODE_CHARS,
    CALENDAR_SHARE_CODE_LENGTH,
    CALENDAR_SHARE_DATE_SCOPES,
    CALENDAR_SHARE_MAX_ROLLING_DAYS,
    CALENDAR_SHARE_MIN_ROLLING_DAYS,
    DEFAULT_CALENDAR_COLOR,
    SIMULATED_CALENDAR_NAME,
)
from services.calendar_feed_sources import (
    _configured_feed_urls,
    _load_calendar_feed_metadata,
)
from services.calendar_projection import (
    load_calendar_events_for_share,
)
from services.calendar_serialization import (
    _coerce_utc,
)
from services.calendar_sources import (
    _append_task_calendar_source,
    _configured_calendar_sources,
    _load_calendar_preferences,
    _load_local_calendar_sources,
    _task_calendar_payload,
)


def _calendar_shares_collection():
    return COLLECTIONS.get("calendar_shares", "calendar_shares")


def _share_url(share_code):
    if not share_code:
        return None
    try:
        return url_for("dashboard.public_calendar_share", share_code=share_code, _external=True)
    except (BuildError, RuntimeError):
        return f"/calendar/share/{share_code}"


def _generate_calendar_share_code(first_calendar_row_fn=None):
    first_calendar_row_fn = first_calendar_row_fn or first_calendar_row
    table_id = _calendar_shares_collection()
    while True:
        code = "".join(secrets.choice(CALENDAR_SHARE_CODE_CHARS) for _ in range(CALENDAR_SHARE_CODE_LENGTH))
        existing = first_calendar_row_fn(table_id, [Query.equal("share_code", [code])])
        if not existing:
            return code


def _parse_json_list(value):
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item or "").strip()]
    if not isinstance(value, str):
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item) for item in parsed if str(item or "").strip()]


def _normalize_share_calendar_ids(value):
    ids = []
    seen = set()
    for item in value or []:
        calendar_id = str(item or "").strip()
        if not calendar_id:
            continue
        if calendar_id == SIMULATED_CALENDAR_NAME:
            calendar_id = "simulated_courses"
        calendar_id = calendar_id[:255]
        if calendar_id in seen:
            continue
        seen.add(calendar_id)
        ids.append(calendar_id)
    return ids


def _parse_date_start(value):
    parsed = parse_datetime(value)
    if not parsed:
        return None
    parsed = _coerce_utc(parsed)
    return datetime(parsed.year, parsed.month, parsed.day, tzinfo=timezone.utc)


def _fixed_end_display_date(fixed_end):
    parsed = _coerce_utc(parse_datetime(fixed_end))
    if not parsed:
        return None
    display_dt = parsed - timedelta(days=1)
    return display_dt.date().isoformat()


def _normalize_calendar_share_payload(data, existing=None):
    data = data or {}
    existing = existing or {}
    include_all_raw = data.get("includeAllCalendars", data.get("include_all_calendars"))
    include_all = bool(include_all_raw) if include_all_raw is not None else bool(existing.get("include_all_calendars", True))

    calendar_ids_raw = data.get("calendarIds", data.get("calendar_ids"))
    if calendar_ids_raw is None:
        calendar_ids = _parse_json_list(existing.get("calendar_ids_json"))
    else:
        calendar_ids = _normalize_share_calendar_ids(calendar_ids_raw)
    if not include_all and not calendar_ids:
        raise ValueError("Choose at least one calendar to share.")

    date_scope = str(data.get("dateScope", data.get("date_scope", existing.get("date_scope") or "all"))).strip().lower()
    if date_scope not in CALENDAR_SHARE_DATE_SCOPES:
        raise ValueError("Invalid date scope.")

    fixed_start = None
    fixed_end = None
    rolling_days = None
    if date_scope == "fixed":
        fixed_start = _parse_date_start(data.get("fixedStart", data.get("fixed_start", existing.get("fixed_start"))))
        fixed_end_start = _parse_date_start(data.get("fixedEnd", data.get("fixed_end", _fixed_end_display_date(existing.get("fixed_end")))))
        if not fixed_start or not fixed_end_start:
            raise ValueError("Fixed date range requires a start and end date.")
        fixed_end = fixed_end_start + timedelta(days=1)
        if fixed_end <= fixed_start:
            raise ValueError("Fixed date range end must be after the start.")
    elif date_scope == "rolling":
        raw_days = data.get("rollingDays", data.get("rolling_days", existing.get("rolling_days")))
        try:
            rolling_days = int(raw_days)
        except (TypeError, ValueError):
            raise ValueError("Rolling window must be a number of days.")
        if rolling_days < CALENDAR_SHARE_MIN_ROLLING_DAYS or rolling_days > CALENDAR_SHARE_MAX_ROLLING_DAYS:
            raise ValueError(
                f"Rolling window must be between {CALENDAR_SHARE_MIN_ROLLING_DAYS} and {CALENDAR_SHARE_MAX_ROLLING_DAYS} days."
            )

    return {
        "include_all_calendars": include_all,
        "calendar_ids_json": json.dumps([] if include_all else calendar_ids),
        "date_scope": date_scope,
        "fixed_start": format_datetime(fixed_start) if fixed_start else None,
        "fixed_end": format_datetime(fixed_end) if fixed_end else None,
        "rolling_days": rolling_days,
    }


def _calendar_share_scope_label(share):
    scope = share.get("date_scope") or "all"
    if scope == "fixed":
        start = _coerce_utc(parse_datetime(share.get("fixed_start")))
        end_label = _fixed_end_display_date(share.get("fixed_end"))
        if start and end_label:
            return f"{start.date().isoformat()} to {end_label}"
        return "Fixed date range"
    if scope == "rolling":
        days = int(share.get("rolling_days") or 0)
        return f"Today through the next {days} day{'s' if days != 1 else ''}"
    return "All shared dates"


def _calendar_share_payload(share):
    fixed_start = _coerce_utc(parse_datetime(share.get("fixed_start")))
    def truthy(value):
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return bool(value)

    return {
        "id": _row_id(share),
        "shareCode": share.get("share_code"),
        "shareUrl": _share_url(share.get("share_code")),
        "isActive": bool(share.get("is_active", True)),
        "includeAllCalendars": bool(share.get("include_all_calendars", True)),
        "calendarIds": _parse_json_list(share.get("calendar_ids_json")),
        "dateScope": share.get("date_scope") or "all",
        "fixedStart": fixed_start.date().isoformat() if fixed_start else None,
        "fixedEnd": _fixed_end_display_date(share.get("fixed_end")),
        "rollingDays": share.get("rolling_days"),
        "scopeLabel": _calendar_share_scope_label(share),
        # ICS secrets and derived URLs are owner-GET-only.  These fields are
        # deliberately safe for collection, ordinary share, and public payloads.
        "icsConfigured": bool(share.get("ics_token")),
        "icsEnabled": truthy(share.get("ics_enabled")) and bool(share.get("ics_token")),
        "createdAt": share.get("created_at"),
        "updatedAt": share.get("updated_at"),
    }


def _calendar_share_scope_range(share, now=None):
    scope = share.get("date_scope") or "all"
    if scope == "fixed":
        return (
            _coerce_utc(parse_datetime(share.get("fixed_start"))),
            _coerce_utc(parse_datetime(share.get("fixed_end"))),
        )
    if scope == "rolling":
        now = _coerce_utc(now or datetime.now(timezone.utc))
        start = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
        days = int(share.get("rolling_days") or 0)
        return start, start + timedelta(days=days)
    return None, None


def _intersect_ranges(*ranges):
    starts = [start for start, _end in ranges if start]
    ends = [end for _start, end in ranges if end]
    start = max(starts) if starts else None
    end = min(ends) if ends else None
    if start and end and start >= end:
        return start, start
    return start, end


def _sanitize_public_event(event):
    event_ref = event.get("event_ref") or event.get("id") or event.get("uid")
    return {
        "uid": event_ref,
        "event_ref": event_ref,
        "source_type": event.get("source_type"),
        "editable": False,
        "title": event.get("title"),
        "start": event.get("start"),
        "end": event.get("end"),
        "type": event.get("type"),
        "course": event.get("course"),
        "description": event.get("description"),
        "is_multi_day": event.get("is_multi_day"),
        "span_days": event.get("span_days"),
        "is_all_day": event.get("is_all_day"),
        "calendar_id": event.get("calendar_id"),
        "color": event.get("color"),
        "task_id": event.get("task_id"),
        "occurrence_key": event.get("occurrence_key"),
        "priority": event.get("priority"),
        "completed": event.get("completed"),
    }


def _sanitize_public_sources(sources, share, preferences=None):
    allowed = set(_parse_json_list(share.get("calendar_ids_json")))
    include_all = bool(share.get("include_all_calendars", True))
    prefs_by_name = {
        pref.get("calendar_name"): pref
        for pref in (preferences or [])
        if pref.get("calendar_name")
    }
    public_sources = []
    for source in sources:
        source_id = source.get("id")
        if not include_all and source_id not in allowed:
            continue
        source_pref = prefs_by_name.get(source_id) or next(
            (prefs_by_name.get(name) for name in source.get("legacy_names", []) if prefs_by_name.get(name)),
            {},
        )
        public_sources.append({
            "id": source_id,
            "kind": source.get("kind") or "external",
            "default_name": source.get("default_name") or source.get("display_name") or source_id,
            "display_name": source.get("display_name") or "",
            "color_hex": source_pref.get("color_hex") or source.get("color_hex") or DEFAULT_CALENDAR_COLOR,
            "editable": False,
            "legacy_names": source.get("legacy_names") or [],
        })
    return public_sources


def _resolve_calendar_share_by_code(
    share_code,
    active_only=True,
    first_calendar_row_fn=None,
):
    first_calendar_row_fn = first_calendar_row_fn or first_calendar_row
    queries = [Query.equal("share_code", [share_code])]
    if active_only:
        queries.append(Query.equal("is_active", [True]))
    return first_calendar_row_fn(_calendar_shares_collection(), queries)


def _public_calendar_share_context(share):
    owner = get_row_safe(COLLECTIONS["users"], share.get("user_id"), allow_missing=True)
    owner_name = (owner or {}).get("name") or "APStudy User"
    return {
        "share_code": share.get("share_code"),
        "owner_name": owner_name,
        "scope_label": _calendar_share_scope_label(share),
    }


def _public_calendar_events_payload(
    share,
    requested_start=None,
    requested_end=None,
    dependencies=None,
):
    dependencies = dependencies or {}
    first_row_fn = dependencies.get("first_row", first_row)
    calendar_share_scope_range = dependencies.get(
        "calendar_share_scope_range",
        _calendar_share_scope_range,
    )
    intersect_ranges = dependencies.get("intersect_ranges", _intersect_ranges)
    calendar_share_payload = dependencies.get(
        "calendar_share_payload",
        _calendar_share_payload,
    )
    load_serialized_calendar_events = dependencies.get(
        "load_serialized_calendar_events_for_share",
        dependencies.get("load_serialized_calendar_events", load_calendar_events_for_share),
    )
    load_calendar_preferences = dependencies.get(
        "load_calendar_preferences",
        _load_calendar_preferences,
    )
    task_calendar_payload = dependencies.get(
        "task_calendar_payload",
        _task_calendar_payload,
    )
    parse_json_list = dependencies.get("parse_json_list", _parse_json_list)
    load_calendar_feed_metadata = dependencies.get(
        "load_calendar_feed_metadata",
        _load_calendar_feed_metadata,
    )
    load_local_calendar_sources = dependencies.get(
        "load_local_calendar_sources",
        _load_local_calendar_sources,
    )
    append_task_calendar_source = dependencies.get(
        "append_task_calendar_source",
        _append_task_calendar_source,
    )
    configured_calendar_sources = dependencies.get(
        "configured_calendar_sources",
        _configured_calendar_sources,
    )
    sanitize_public_event = dependencies.get(
        "sanitize_public_event",
        _sanitize_public_event,
    )
    configured_feed_urls = dependencies.get(
        "configured_feed_urls",
        _configured_feed_urls,
    )
    sanitize_public_sources = dependencies.get(
        "sanitize_public_sources",
        _sanitize_public_sources,
    )

    user_id = str(share.get("user_id"))
    settings = first_row_fn(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [user_id])],
    )
    share_start, share_end = calendar_share_scope_range(share)
    range_start, range_end = intersect_ranges(
        (requested_start, requested_end),
        (share_start, share_end),
    )
    if range_start and range_end and range_start >= range_end:
        return {
            "count": 0,
            "events": [],
            "feed_configured": False,
            "calendar_sources": [],
            "share": calendar_share_payload(share),
        }

    events, cache_events, created_events = load_serialized_calendar_events(
        user_id,
        settings,
        range_start,
        range_end,
    )
    preferences = load_calendar_preferences(user_id)
    task_events, task_source = task_calendar_payload(
        user_id,
        preferences,
        range_start,
        range_end,
    )
    events = events + task_events
    include_all = bool(share.get("include_all_calendars", True))
    allowed_calendars = set(parse_json_list(share.get("calendar_ids_json")))
    if not include_all:
        events = [
            event
            for event in events
            if (event.get("calendar_id") or event.get("course") or "Other") in allowed_calendars
        ]
    feed_metadata = load_calendar_feed_metadata(user_id)
    local_sources = load_local_calendar_sources(user_id)
    calendar_sources = append_task_calendar_source(
        configured_calendar_sources(
            settings,
            cache_events,
            preferences,
            feed_metadata,
            local_sources,
            created_events,
        ),
        task_source,
    )

    public_events = [sanitize_public_event(event) for event in events]
    return {
        "count": len(public_events),
        "events": public_events,
        "feed_configured": bool(configured_feed_urls(settings)),
        "calendar_sources": sanitize_public_sources(
            calendar_sources,
            share,
            preferences,
        ),
        "share": calendar_share_payload(share),
    }
