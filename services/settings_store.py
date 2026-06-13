import json
import secrets

from services import database


def _query(method, attribute=None, values=None):
    payload = {"method": method}
    if attribute is not None:
        payload["attribute"] = attribute
    if values is not None:
        payload["values"] = values
    return json.dumps(payload)


def _now():
    return database.utcnow_iso()


def default_settings(user_id):
    now = _now()
    return {
        "user_id": str(user_id),
        "ics_secret_token": secrets.token_urlsafe(32),
        "feed_refresh_minutes": 15,
        "preferred_calendar_view": "week",
        "interface_theme": "obsidian-dark",
        "theme": "dark",
        "sidebar_default": "expanded",
        "email_notifications": True,
        "product_updates": True,
        "task_sound_enabled": True,
        "chat_sound_enabled": True,
        "language": "en",
        "timezone": "",
        "dashboard_layout_json": "[]",
        "dashboard_checklist_hidden_signature": "",
        "created_at": now,
        "updated_at": now,
    }


def get_settings(user_id, create_missing=False):
    row = database.first_row("user_settings", [_query("equal", "user_id", [str(user_id)])])
    if row or not create_missing:
        return row
    return create_settings(user_id, {})


def create_settings(user_id, data):
    payload = {**default_settings(user_id), **(data or {}), "user_id": str(user_id)}
    return database.create_row("user_settings", row_id=(data or {}).get("id") or str(user_id), data=payload)


def update_settings(user_id, data):
    row = get_settings(user_id, create_missing=True)
    return database.update_row(
        "user_settings",
        row.get("id") or row.get("$id"),
        {**(data or {}), "updated_at": _now()},
    )


def upsert_settings(user_id, data):
    row = get_settings(user_id)
    if row:
        return update_settings(user_id, data)
    return create_settings(user_id, data)
