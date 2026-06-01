import json
from datetime import datetime, timezone

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query

from appwrite_client import COLLECTIONS
from appwrite_helpers import create_row_safe, first_row, format_datetime, update_row_safe


SPRING_COURSE_TRACKING_OPEN_KEY = "spring_course_tracking_open"


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
