import json
from datetime import datetime, timezone

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query

from appwrite_client import COLLECTIONS
from appwrite_helpers import create_row_safe, first_row, format_datetime, update_row_safe


SPRING_COURSE_TRACKING_OPEN_KEY = "spring_course_tracking_open"
COURSE_TRACKING_REFRESH_INTERVAL_KEY = "course_tracking_refresh_interval"
COURSE_TRACKING_REFRESH_INTERVAL_CHOICES = (5,)


def _now():
    return format_datetime(datetime.now(timezone.utc))


def get_config(key, default=None):
    try:
        row = first_row(
            COLLECTIONS.get("app_config", COLLECTIONS["chat_bridge_config"]),
            [Query.equal("config_key", [key])],
        )
    except Exception:
        return default
    if not row or not row.get("config_value"):
        return default
    try:
        return json.loads(row.get("config_value"))
    except (TypeError, json.JSONDecodeError):
        return default


def set_config(key, value):
    table_id = COLLECTIONS.get("app_config", COLLECTIONS["chat_bridge_config"])
    now = _now()
    payload = {
        "config_key": key,
        "config_value": json.dumps(value, separators=(",", ":"), default=str),
        "updated_at": now,
    }
    row = first_row(table_id, [Query.equal("config_key", [key])])
    if row:
        return update_row_safe(table_id, row.get("$id") or row.get("id"), payload)
    return create_row_safe(table_id, row_id=ID.unique(), data={**payload, "created_at": now})


def spring_course_tracking_open():
    config = get_config(SPRING_COURSE_TRACKING_OPEN_KEY, {})
    return bool((config or {}).get("enabled", False))


def set_spring_course_tracking_open(enabled):
    return set_config(
        SPRING_COURSE_TRACKING_OPEN_KEY,
        {"enabled": bool(enabled), "updated_at": _now()},
    )


def get_course_tracking_refresh_minutes(default=COURSE_TRACKING_REFRESH_INTERVAL_CHOICES[0]):
    config = get_config(COURSE_TRACKING_REFRESH_INTERVAL_KEY, default)
    try:
        minutes = int(config)
    except (TypeError, ValueError):
        minutes = default
    return minutes if minutes in COURSE_TRACKING_REFRESH_INTERVAL_CHOICES else default


def set_course_tracking_refresh_minutes(minutes):
    minutes = int(minutes)
    if minutes not in COURSE_TRACKING_REFRESH_INTERVAL_CHOICES:
        raise ValueError("Invalid course tracking refresh interval.")
    return set_config(COURSE_TRACKING_REFRESH_INTERVAL_KEY, minutes)
