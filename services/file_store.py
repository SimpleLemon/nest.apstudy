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


def get_files(user_id, filters=None):
    filters = filters or {}
    queries = [_query("equal", "user_id", [str(user_id)])]
    if "folder_id" in filters:
        folder_id = filters.get("folder_id")
        queries.append(_query("isNull", "folder_id") if folder_id is None else _query("equal", "folder_id", [str(folder_id)]))
    if "is_public" in filters:
        queries.append(_query("equal", "is_public", [bool(filters["is_public"])]))
    if filters.get("active_only"):
        queries.append(_query("greaterThan", "expires_at", [filters["active_only_at"] if filters.get("active_only_at") else _now()]))
    queries.append(_query("orderDesc", filters.get("order_by") or "created_at"))
    return database.list_rows_all("shared_files", queries)


def get_file(file_id, user_id=None):
    row = database.get_row("shared_files", file_id)
    if user_id is not None and str(row.get("user_id")) != str(user_id):
        raise AppwriteException("Row not found", 404)
    return row


def create_file(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("shared_files", row_id=(data or {}).get("id") or _id(), data=payload)


def update_file(file_id, user_id, data):
    _owned_row("shared_files", file_id, user_id)
    return database.update_row("shared_files", file_id, {**(data or {}), "updated_at": _now()})


def delete_file(file_id, user_id):
    _owned_row("shared_files", file_id, user_id)
    database.delete_row("shared_files", file_id)


def get_folders(user_id, parent_folder_id=None):
    queries = [_query("equal", "user_id", [str(user_id)])]
    queries.append(_query("isNull", "parent_folder_id") if parent_folder_id is None else _query("equal", "parent_folder_id", [str(parent_folder_id)]))
    queries.extend([_query("orderAsc", "order"), _query("orderAsc", "created_at")])
    return database.list_rows_all("file_folders", queries)


def create_folder(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("file_folders", row_id=(data or {}).get("id") or _id(), data=payload)


def update_folder(folder_id, user_id, data):
    _owned_row("file_folders", folder_id, user_id)
    return database.update_row("file_folders", folder_id, {**(data or {}), "updated_at": _now()})


def delete_folder(folder_id, user_id):
    _owned_row("file_folders", folder_id, user_id)
    database.delete_row("file_folders", folder_id)
