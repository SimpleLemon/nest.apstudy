"""Event serialization, overrides, date spans, and range predicates."""

from appwrite.query import Query
from appwrite_helpers import format_datetime, parse_datetime
from datetime import timezone
from services.calendar_constants import (
    CANVAS_PROVIDER,
    DEFAULT_LOCAL_SOURCE_ID,
)
from services.calendar_identity import (
    _canvas_truthy,
    _default_reminder_minutes,
    _event_ref_for_cache_event,
    _event_ref_for_user_event,
    _serialized_reminder_minutes,
    _source_id_for_feed_url,
)


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
    if doc.get("canvas_source_id") or doc.get("canvas_event_ref"):
        return _serialize_canvas_event(doc, settings=settings)
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
        "reminder_minutes": _default_reminder_minutes(is_all_day),
        "calendar_id": calendar_id,
        "original_calendar_id": calendar_id,
    }


def _serialize_canvas_event(doc, settings=None, source=None, *, authenticated=False):
    """Serialize a sanitized extension-owned Canvas cache row."""
    source = source or {}
    is_all_day = bool(doc.get("is_all_day", False))
    event_start = parse_datetime(doc.get("event_start"))
    event_end = parse_datetime(doc.get("event_end"))
    fetched_at = parse_datetime(doc.get("fetched_at"))
    is_multi_day, span_days = _span_metadata(event_start, event_end, is_all_day)
    event_ref = _event_ref_for_cache_event(doc)
    source_id = doc.get("canvas_source_id") or source.get("source_id")
    account_key = doc.get("canvas_account_key") or source.get("account_key")
    source_label = source.get("label") or source.get("source_id") or source_id
    source_url = doc.get("canvas_source_url") or source.get("origin")
    original_calendar_id = doc.get("canvas_calendar_id")
    serialized = {
        "uid": doc.get("event_uid") or doc.get("canvas_source_item_key") or event_ref,
        "event_ref": event_ref,
        "source_type": "canvas",
        "provider": source.get("provider") or CANVAS_PROVIDER,
        "source_id": source_id,
        "source_label": source_label,
        "account_label": source_label,
        "editable": True,
        "title": doc.get("event_title"),
        "start": _serialize_datetime(event_start, is_all_day),
        "end": _serialize_datetime(event_end, is_all_day),
        "type": doc.get("event_type") or doc.get("canvas_item_type"),
        "course": doc.get("course_name"),
        "description": doc.get("raw_description"),
        "fetched_at": fetched_at.isoformat() if fetched_at else None,
        "is_multi_day": is_multi_day,
        "span_days": span_days,
        "is_all_day": is_all_day,
        "reminder_minutes": _default_reminder_minutes(is_all_day),
        "calendar_id": original_calendar_id,
        "original_calendar_id": original_calendar_id,
        "source_item_type": doc.get("canvas_item_type") or doc.get("event_type"),
        "source_item_key": doc.get("canvas_source_item_key"),
        "completion_status": doc.get("canvas_completion_status") or "incomplete",
        "completion_source": doc.get("canvas_completion_source") or "canvas",
        "has_override": False,
        "routing_degraded": False,
        "stale": _canvas_truthy(doc.get("canvas_stale", doc.get("stale", False))),
    }
    if authenticated:
        serialized["source_url"] = source_url
    return serialized


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
        "timezone": doc.get("timezone") or "UTC",
        "location": doc.get("location") or "",
        "start": _serialize_datetime(start, is_all_day),
        "end": _serialize_datetime(end, is_all_day),
        "is_all_day": is_all_day,
        "reminder_minutes": _serialized_reminder_minutes(doc, is_all_day),
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
    override_reminder = override.get("reminder_minutes")
    if override_reminder is not None or override.get("is_all_day") is not None:
        result["reminder_minutes"] = (
            int(override_reminder)
            if override_reminder is not None
            else _default_reminder_minutes(is_all_day)
        )
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


def _range_queries(user_id, start_key, end_key, order_key, range_start=None, range_end=None):
    queries = [Query.equal("user_id", [str(user_id)])]
    if range_end:
        queries.append(Query.less_than(start_key, format_datetime(range_end)))
    if range_start:
        queries.append(Query.greater_than(end_key, format_datetime(range_start)))
    queries.append(Query.order_asc(order_key))
    return queries
