"""Stable event identities and calendar preference value normalization."""

from services.calendar_urls import normalize_calendar_url as _normalize_calendar_url
from services.extension_contract import ExtensionContractError
import hashlib
from services.calendar_constants import (
    ALL_DAY_EVENT_REMINDERS,
    CANVAS_SOURCE_ID,
    DEFAULT_LOCAL_SOURCE_ID,
    FEED_SOURCE_PREFIX,
    TIMED_EVENT_REMINDERS,
)
from services.canvas_domain import (
    canvas_event_ref_for_item,
)


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
    if doc.get("canvas_event_ref"):
        return doc["canvas_event_ref"]
    if doc.get("canvas_source_id"):
        try:
            return canvas_event_ref_for_item(
                doc.get("canvas_source_id"),
                doc.get("canvas_account_key"),
                doc.get("canvas_context_id"),
                doc.get("canvas_calendar_id"),
                doc.get("canvas_item_type"),
                doc.get("canvas_item_id"),
                doc.get("canvas_occurrence_id"),
            )
        except (ExtensionContractError, TypeError, ValueError):
            return None
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


def _default_reminder_minutes(is_all_day):
    return -1 if is_all_day else 10


def _normalize_reminder_minutes(value, is_all_day):
    if value is None or value == "":
        return _default_reminder_minutes(is_all_day)
    try:
        reminder_minutes = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Choose a valid alert time.") from exc
    allowed = ALL_DAY_EVENT_REMINDERS if is_all_day else TIMED_EVENT_REMINDERS
    if reminder_minutes not in allowed:
        raise ValueError("Choose a valid alert time.")
    return reminder_minutes


def _serialized_reminder_minutes(doc, is_all_day):
    value = doc.get("reminder_minutes")
    return _default_reminder_minutes(is_all_day) if value is None else int(value)


def _calendar_preference_updates(payload):
    updates = {}
    if "color_hex" in payload and payload.get("color_hex") is not None:
        updates["color_hex"] = _normalize_color(payload.get("color_hex"))
    if "visible" in payload and payload.get("visible") is not None:
        updates["visible"] = bool(payload.get("visible"))
    if "display_name" in payload:
        updates["display_name"] = _normalize_display_name(payload.get("display_name"))
    return updates


def _calendar_preference_unchanged(pref, updates):
    if not pref:
        return False
    for key, value in updates.items():
        current = pref.get(key)
        if key == "display_name":
            current = current or ""
        if key == "color_hex" and isinstance(current, str):
            current = current.lower()
        if key == "visible" and current is not None:
            current = bool(current)
        if current != value:
            return False
    return True


def _normalize_calendar_id(value):
    calendar_id = str(value or "").strip()
    return calendar_id[:255] if calendar_id else DEFAULT_LOCAL_SOURCE_ID


def _canvas_truthy(value):
    """Interpret SQLite/Appwrite boolean values without treating ``"0"`` as true."""
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return bool(value)
