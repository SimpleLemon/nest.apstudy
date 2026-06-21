import logging
import json
import uuid

from appwrite.exception import AppwriteException
from appwrite.query import Query

from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    get_row_safe,
    list_rows_all,
    update_row_safe,
)
from services.database import db_connection, utcnow_iso
from services.notes_preview import preview_text_from_content

logger = logging.getLogger(__name__)

NOTES_TABLE_ID = "notes"
FOLDERS_TABLE_ID = "note_folders"
ORDER_STEP = 1000


def _row_id(row):
    return row.get("$id") or row.get("id")


def _max_order(user_id, table_id):
    try:
        with db_connection() as conn:
            row = conn.execute(
                f'SELECT COALESCE(MAX("order"), 0) AS max_order FROM {table_id} WHERE user_id = ?',
                [str(user_id)],
            ).fetchone()
        return int(row["max_order"] or 0) if row else 0
    except Exception:
        logger.exception("Failed to read max order for %s", table_id)
        return 0


def _ensure_preview_text(note):
    preview = note.get("preview_text")
    if isinstance(preview, str) and preview.strip():
        return preview
    return preview_text_from_content(note.get("content") or "")


def list_notes_for_user(user_id):
    notes = list_rows_all(
        NOTES_TABLE_ID,
        queries=[
            Query.equal("user_id", [str(user_id)]),
            Query.order_asc("order"),
        ],
    )
    return notes


def list_folders_for_user(user_id):
    return list_rows_all(
        FOLDERS_TABLE_ID,
        queries=[
            Query.equal("user_id", [str(user_id)]),
            Query.order_asc("order"),
        ],
    )


def get_note_for_user(note_id, user_id):
    note = get_row_safe(NOTES_TABLE_ID, note_id, allow_missing=True)
    if not note or note.get("user_id") != str(user_id):
        return None
    return note


def get_folder_for_user(folder_id, user_id):
    folder = get_row_safe(FOLDERS_TABLE_ID, folder_id, allow_missing=True)
    if not folder or folder.get("user_id") != str(user_id):
        return None
    return folder


def note_list_payload(note):
    note_id = _row_id(note)
    return {
        "$id": note_id,
        "id": note_id,
        "folder_id": note.get("folder_id"),
        "title": note.get("title") or "Untitled",
        "preview_text": _ensure_preview_text(note),
        "order": note.get("order") or 0,
        "created_at": note.get("created_at"),
        "updated_at": note.get("updated_at"),
    }


def folder_payload(folder):
    folder_id = _row_id(folder)
    return {
        "$id": folder_id,
        "id": folder_id,
        "name": folder.get("name") or "Untitled Folder",
        "order": folder.get("order") or 0,
        "created_at": folder.get("created_at"),
    }


def create_note(user_id, *, title, content="", folder_id=None, now=None):
    timestamp = now or utcnow_iso()
    preview = preview_text_from_content(content)
    return create_row_safe(
        NOTES_TABLE_ID,
        row_id=str(uuid.uuid4()),
        data={
            "user_id": str(user_id),
            "folder_id": folder_id,
            "title": title,
            "content": content,
            "preview_text": preview,
            "order": _max_order(user_id, NOTES_TABLE_ID) + ORDER_STEP,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )


def update_note(note_id, updates):
    if "content" in updates:
        updates["preview_text"] = preview_text_from_content(updates.get("content") or "")
    return update_row_safe(NOTES_TABLE_ID, note_id, updates)


def delete_note(note_id):
    delete_row_safe(NOTES_TABLE_ID, note_id)


def create_folder(user_id, *, name, now=None):
    timestamp = now or utcnow_iso()
    return create_row_safe(
        FOLDERS_TABLE_ID,
        row_id=str(uuid.uuid4()),
        data={
            "user_id": str(user_id),
            "name": name,
            "order": _max_order(user_id, FOLDERS_TABLE_ID) + ORDER_STEP,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )


def update_folder(folder_id, updates):
    return update_row_safe(FOLDERS_TABLE_ID, folder_id, updates)


def delete_folder_and_notes(user_id, folder_id):
    notes = list_rows_all(
        NOTES_TABLE_ID,
        queries=[
            Query.equal("user_id", [str(user_id)]),
            Query.equal("folder_id", [folder_id]),
        ],
    )
    for note in notes:
        note_id = _row_id(note)
        if note_id:
            delete_row_safe(NOTES_TABLE_ID, note_id)
    delete_row_safe(FOLDERS_TABLE_ID, folder_id)


def backfill_preview_texts(batch_size=100, path=None):
    updated = 0
    try:
        with db_connection(path) as conn:
            while True:
                rows = conn.execute(
                    """
                    SELECT id, content, preview_text
                    FROM notes
                    WHERE preview_text IS NULL OR preview_text = ''
                    LIMIT ?
                    """,
                    [batch_size],
                ).fetchall()
                if not rows:
                    break
                for row in rows:
                    preview = preview_text_from_content(row["content"] or "")
                    conn.execute(
                        "UPDATE notes SET preview_text = ? WHERE id = ?",
                        [preview, row["id"]],
                    )
                    updated += 1
    except Exception:
        logger.exception("Failed to backfill note preview_text values")
        raise AppwriteException("Failed to backfill note previews")
    return updated
