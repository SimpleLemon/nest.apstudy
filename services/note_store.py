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


def get_notes(user_id, filters=None):
    filters = filters or {}
    queries = [_query("equal", "user_id", [str(user_id)])]
    if "folder_id" in filters:
        folder_id = filters.get("folder_id")
        queries.append(_query("isNull", "folder_id") if folder_id is None else _query("equal", "folder_id", [str(folder_id)]))
    if "is_archived" in filters:
        queries.append(_query("equal", "is_archived", [bool(filters["is_archived"])]))
    if "is_pinned" in filters:
        queries.append(_query("equal", "is_pinned", [bool(filters["is_pinned"])]))
    queries.append(_query("orderAsc", filters.get("order_by") or "order"))
    return database.list_rows_all("notes", queries)


def get_note(note_id, user_id):
    return _owned_row("notes", note_id, user_id)


def create_note(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("notes", row_id=(data or {}).get("id") or _id(), data=payload)


def update_note(note_id, user_id, data):
    _owned_row("notes", note_id, user_id)
    return database.update_row("notes", note_id, {**(data or {}), "updated_at": _now()})


def delete_note(note_id, user_id):
    _owned_row("notes", note_id, user_id)
    database.delete_row("notes", note_id)


def get_folders(user_id):
    return database.list_rows_all(
        "note_folders",
        [_query("equal", "user_id", [str(user_id)]), _query("orderAsc", "order")],
    )


def create_folder(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("note_folders", row_id=(data or {}).get("id") or _id(), data=payload)


def update_folder(folder_id, user_id, data):
    _owned_row("note_folders", folder_id, user_id)
    return database.update_row("note_folders", folder_id, {**(data or {}), "updated_at": _now()})


def delete_folder(folder_id, user_id):
    _owned_row("note_folders", folder_id, user_id)
    database.delete_row("note_folders", folder_id)
