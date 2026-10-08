"""Keep shared-file source and target validation on the metadata writer."""

import uuid

from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime
from services import database, storage_rows
from services.entitlements import assert_account_storage_active
from services.file_share_store import _folders_collection, _is_descendant_folder, _normalize_folder_id
from services.storage_objects import StorageNotFound, StorageUnavailable, StorageValidationError, write_transaction
from services.time_utils import utcnow


def _active_account(conn, user_id):
    assert_account_storage_active(conn, user_id)
    if not conn.execute("SELECT 1 FROM users WHERE id = ?", [str(user_id)]).fetchone():
        raise StorageUnavailable("This account is unavailable for file changes.")


def _owned_row(conn, table_id, row_id, user_id):
    row = storage_rows.get_row(conn, table_id, row_id, allow_missing=True)
    if not row or str(row.get("user_id")) != str(user_id):
        raise StorageNotFound("File or folder was not found.")
    return row


def _target_folder(conn, folder_id, user_id):
    normalized = _normalize_folder_id(folder_id)
    if normalized:
        _owned_row(conn, _folders_collection(), normalized, user_id)
    return normalized


def _user_folders(conn, user_id):
    table = database._quote_identifier(_folders_collection())
    return [dict(row) for row in conn.execute(f"SELECT * FROM {table} WHERE user_id = ?", [str(user_id)])]


def _sibling_order(folders, parent_id):
    return max(
        (int(folder.get("order") or 0) for folder in folders if folder.get("parent_folder_id") == parent_id),
        default=0,
    ) + 1000


def create_folder_record(user_id, *, name, parent_folder_id, now=None):
    user_id = str(user_id)
    timestamp = now or format_datetime(utcnow())
    with write_transaction() as conn:
        _active_account(conn, user_id)
        parent_id = _target_folder(conn, parent_folder_id, user_id)
        return storage_rows.insert_row(conn, _folders_collection(), str(uuid.uuid4()), {
            "user_id": user_id,
            "name": name,
            "parent_folder_id": parent_id,
            "is_public": False,
            "share_code": None,
            "order": _sibling_order(_user_folders(conn, user_id), parent_id),
            "created_at": timestamp,
            "updated_at": timestamp,
        })


def update_folder_record(folder_id, user_id, updates):
    updates = dict(updates)
    with write_transaction() as conn:
        _active_account(conn, user_id)
        _owned_row(conn, _folders_collection(), folder_id, user_id)
        if "parent_folder_id" in updates:
            parent_id = _target_folder(conn, updates["parent_folder_id"], user_id)
            folders = _user_folders(conn, user_id)
            folders_by_id = {folder["id"]: folder for folder in folders}
            if _is_descendant_folder(folders_by_id, folder_id, parent_id):
                raise StorageValidationError("A folder cannot be moved inside itself.")
            updates["parent_folder_id"] = parent_id
            if "order" not in updates:
                updates["order"] = _sibling_order(folders, parent_id)
        return storage_rows.update_row(conn, _folders_collection(), folder_id, updates)


def update_file_record(file_id, user_id, updates):
    updates = dict(updates)
    with write_transaction() as conn:
        _active_account(conn, user_id)
        _owned_row(conn, COLLECTIONS["shared_files"], file_id, user_id)
        if "folder_id" in updates:
            updates["folder_id"] = _target_folder(conn, updates["folder_id"], user_id)
        return storage_rows.update_row(conn, COLLECTIONS["shared_files"], file_id, updates)
