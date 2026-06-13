import json
import uuid

from appwrite.exception import AppwriteException

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


def _id():
    return uuid.uuid4().hex


def _owned_row(table_id, row_id, user_id):
    row = database.get_row(table_id, row_id, allow_missing=True)
    if not row or str(row.get("user_id")) != str(user_id):
        raise AppwriteException("Row not found", 404)
    return row


def get_courses(user_id, filters=None):
    filters = filters or {}
    queries = [_query("equal", "user_id", [str(user_id)])]
    for key in ("term", "subject", "catalog", "crn", "source"):
        if filters.get(key) is not None:
            queries.append(_query("equal", key, [str(filters[key])]))
    queries.extend([
        _query("orderAsc", "term"),
        _query("orderAsc", "subject"),
        _query("orderAsc", "catalog"),
    ])
    return database.list_rows_all("user_courses", queries)


def create_course(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "added_at": (data or {}).get("added_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("user_courses", row_id=(data or {}).get("id") or _id(), data=payload)


def update_course(course_id, user_id, data):
    _owned_row("user_courses", course_id, user_id)
    return database.update_row("user_courses", course_id, {**(data or {}), "updated_at": _now()})


def delete_course(course_id, user_id):
    _owned_row("user_courses", course_id, user_id)
    database.delete_row("user_courses", course_id)


def get_seat_tracks(user_id=None, enabled=None):
    queries = []
    if user_id is not None:
        queries.append(_query("equal", "user_id", [str(user_id)]))
    if enabled is not None:
        queries.append(_query("equal", "enabled", [bool(enabled)]))
    queries.append(_query("orderDesc", "updated_at"))
    return database.list_rows_all("course_seat_tracks", queries)


def create_seat_track(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("course_seat_tracks", row_id=(data or {}).get("id") or _id(), data=payload)


def update_seat_track(track_id, user_id, data):
    _owned_row("course_seat_tracks", track_id, user_id)
    return database.update_row("course_seat_tracks", track_id, {**(data or {}), "updated_at": _now()})


def delete_seat_track(track_id, user_id):
    _owned_row("course_seat_tracks", track_id, user_id)
    database.delete_row("course_seat_tracks", track_id)
