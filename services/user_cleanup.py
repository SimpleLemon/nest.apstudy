"""Shared user-owned data deletion for settings and admin flows."""

import logging
import os
import shutil

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite.services.storage import Storage

from appwrite_client import COLLECTIONS, FILE_SHARE_BUCKET_ID, client as appwrite_client
from appwrite_helpers import delete_row_safe, list_rows_all
from services.calendar_store import delete_calendar_rows_by_user

logger = logging.getLogger(__name__)

_USER_OWNED_TABLES = (
    COLLECTIONS["user_settings"],
    COLLECTIONS["user_courses"],
    COLLECTIONS["course_seat_tracks"],
    COLLECTIONS["notes"],
    COLLECTIONS["note_folders"],
    COLLECTIONS["shared_files"],
    COLLECTIONS["file_folders"],
    COLLECTIONS.get("chat_messages", "chat_messages"),
    COLLECTIONS.get("chat_presence", "chat_presence"),
    COLLECTIONS.get("chat_read_states", "chat_read_states"),
)

_RELATION_TABLES = (
    (COLLECTIONS.get("chat_dm_threads", "chat_dm_threads"), ("participant_a", "participant_b")),
    (COLLECTIONS.get("chat_blocks", "chat_blocks"), ("blocker_id", "blocked_id")),
)


def _row_id(row):
    return row.get("$id") or row.get("id") if row else None


def _delete_shared_file_storage(file_row):
    storage_file_id = file_row.get("storage_file_id")
    if not storage_file_id:
        return
    bucket_id = file_row.get("storage_bucket_id") or FILE_SHARE_BUCKET_ID
    try:
        Storage(appwrite_client).delete_file(bucket_id, storage_file_id)
    except AppwriteException as exc:
        status = getattr(exc, "code", None) or getattr(exc, "response_code", None)
        if int(status or 0) != 404:
            logger.exception("Failed to delete shared file from storage")


def delete_user_data(user_id):
    """Delete local user-owned rows and upload artifacts. Returns error labels."""
    errors = []
    user_id = str(user_id)

    try:
        delete_calendar_rows_by_user(user_id)
    except AppwriteException:
        logger.exception("Failed to delete calendar rows for user %s", user_id)
        errors.append("calendar")

    for table_id in _USER_OWNED_TABLES:
        if not table_id:
            continue
        try:
            rows = list_rows_all(table_id, [Query.equal("user_id", [user_id])])
        except AppwriteException:
            logger.exception("Failed to list %s rows for deletion", table_id)
            errors.append(table_id)
            continue

        for row in rows:
            row_id = _row_id(row)
            if not row_id:
                continue
            if table_id == COLLECTIONS["shared_files"]:
                _delete_shared_file_storage(row)
            try:
                delete_row_safe(table_id, row_id)
            except AppwriteException:
                logger.exception("Failed to delete %s row %s", table_id, row_id)
                errors.append(f"{table_id}:{row_id}")

    for table_id, fields in _RELATION_TABLES:
        if not table_id:
            continue
        for field in fields:
            try:
                rows = list_rows_all(table_id, [Query.equal(field, [user_id])])
            except AppwriteException:
                logger.exception("Failed to list %s rows for deletion", table_id)
                errors.append(table_id)
                continue
            for row in rows:
                row_id = _row_id(row)
                if not row_id:
                    continue
                try:
                    delete_row_safe(table_id, row_id)
                except AppwriteException:
                    logger.exception("Failed to delete %s row %s", table_id, row_id)
                    errors.append(f"{table_id}:{row_id}")

    upload_root = os.path.abspath(os.path.join("uploads", "file_share", user_id))
    if os.path.isdir(upload_root):
        try:
            shutil.rmtree(upload_root)
        except OSError:
            logger.exception("Failed to remove upload directory %s", upload_root)
            errors.append("uploads")

    try:
        delete_row_safe(COLLECTIONS["users"], user_id)
    except AppwriteException:
        logger.exception("Failed to delete users profile row %s", user_id)
        errors.append("users")

    return errors
