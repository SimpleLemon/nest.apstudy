"""Transaction-scoped metadata and authorization for chat attachments."""

from __future__ import annotations

from appwrite_client import COLLECTIONS
from services import database, storage_objects
from services.chat_attachment_validation import AttachmentError
from services.environment_config import runtime_environment_config
from services.storage_backend import chat_attachments_enabled
from services.storage_errors import StorageIntegrityError, StorageUnavailable
from services.storage_legacy_cleanup import enqueue_legacy_deletion
from services.universities import school_payload


NAMESPACE = "chat_attachments"
TABLE_ID = COLLECTIONS["chat_attachments"]


def attachment_row(conn, attachment_id):
    row = conn.execute(
        "SELECT * FROM chat_attachments WHERE id = ?", [str(attachment_id)]
    ).fetchone()
    return database._row_to_dict(TABLE_ID, row) if row else None


def attachment_rows(conn, field, value):
    if field not in {"message_id", "user_id"}:
        raise ValueError("Unsupported attachment lookup.")
    rows = conn.execute(
        f"SELECT * FROM chat_attachments WHERE {field} = ?", [str(value)]
    ).fetchall()
    return [database._row_to_dict(TABLE_ID, row) for row in rows]


def require_scope(conn, *, user_id, scope_type, scope_id):
    """Recheck current membership using the upload's metadata transaction."""
    user = conn.execute("SELECT school FROM users WHERE id = ?", [str(user_id)]).fetchone()
    if not user:
        raise AttachmentError("The attachment owner is unavailable.")
    if scope_type == "thread":
        row = conn.execute(
            "SELECT participant_a, participant_b FROM chat_dm_threads WHERE id = ?",
            [str(scope_id)],
        ).fetchone()
        allowed = row and str(user_id) in {row["participant_a"], row["participant_b"]}
    elif scope_type == "channel":
        row = conn.execute(
            "SELECT kind, school_key, approved FROM chat_channels WHERE id = ?", [str(scope_id)]
        ).fetchone()
        allowed = row and (
            row["kind"] == "discord"
            or (
                row["kind"] == "university"
                and bool(row["approved"])
                and row["school_key"] == school_payload(user["school"]).get("school_key")
            )
        )
    else:
        allowed = False
    if not allowed:
        raise AttachmentError("The attachment conversation is unavailable.")


def insert_attachment(conn, attachment_id, payload):
    columns = ["id", *payload]
    conn.execute(
        f"INSERT INTO chat_attachments ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)})",
        [attachment_id, *payload.values()],
    )
    return attachment_row(conn, attachment_id)


def activate_attachments(conn, ids, *, user_id, scope_type, scope_id, message_id, now):
    if not chat_attachments_enabled():
        raise AttachmentError("Chat attachments are disabled.")
    require_scope(conn, user_id=user_id, scope_type=scope_type, scope_id=scope_id)
    message = conn.execute(
        "SELECT user_id, channel_id, thread_id, deleted_at, delete_requested_at "
        "FROM chat_messages WHERE id = ?",
        [str(message_id)],
    ).fetchone()
    scope_field = "channel_id" if scope_type == "channel" else "thread_id"
    if (
        not message or str(message["user_id"] or "") != str(user_id)
        or str(message[scope_field] or "") != str(scope_id)
        or message["deleted_at"] or message["delete_requested_at"]
    ):
        raise AttachmentError("The attachment message is unavailable.")
    rows = []
    for attachment_id in ids:
        row = attachment_row(conn, attachment_id)
        if not row or row["status"] != "pending" or str(row["user_id"]) != str(user_id):
            raise AttachmentError("An attachment is unavailable or no longer pending.")
        if row["scope_type"] != scope_type or str(row["scope_id"]) != str(scope_id):
            raise AttachmentError("An attachment belongs to a different conversation.")
        if row.get("storage_backend") == "sqlite":
            for object_id in (row["storage_file_id"], row["preview_file_id"]):
                if object_id:
                    storage_objects.object_metadata(NAMESPACE, object_id, conn=conn)
        rows.append(row)
    for attachment_id in ids:
        conn.execute(
            "UPDATE chat_attachments SET message_id = ?, status = 'active', updated_at = ? WHERE id = ?",
            [str(message_id), now, attachment_id],
        )
    return rows


def delete_attachment_record(conn, row, *, account_user_id=None):
    """Remove both local copies and the fresh metadata row in one transaction."""
    attachment_id = str(row.get("$id") or row.get("id") or "")
    current = attachment_row(conn, attachment_id)
    if not current:
        return False
    if row.get("status") == "pending" and current["status"] != "pending":
        raise AttachmentError("The attachment is no longer pending.")
    for field in ("user_id", "scope_type", "scope_id", "storage_backend", "storage_bucket_id", "storage_file_id", "preview_file_id"):
        if field in row and str(row[field] or "") != str(current[field] or ""):
            raise AttachmentError("The attachment changed before it could be deleted.")
    if current["status"] == "pending" and account_user_id is None:
        require_scope(
            conn, user_id=current["user_id"], scope_type=current["scope_type"],
            scope_id=current["scope_id"],
        )
    backend = current.get("storage_backend") or "appwrite"
    if backend not in {"appwrite", "sqlite"}:
        raise StorageIntegrityError("The chat attachment storage backend is invalid.")
    if backend == "appwrite":
        bucket = current.get("storage_bucket_id") or runtime_environment_config().appwrite_chat_attachments_bucket_id
        if not bucket:
            raise StorageUnavailable("Legacy chat attachment storage is not configured.")
        for object_id in (current["storage_file_id"], current["preview_file_id"]):
            if object_id:
                enqueue_legacy_deletion(
                    conn, NAMESPACE, bucket, object_id,
                    account_user_id=account_user_id or current["user_id"],
                    parent_id=current.get("message_id") or None,
                )
    # Imported objects retain their source IDs, so remove any known SQLite
    # copy even while the metadata still marks an object as legacy.
    for object_id in (current["storage_file_id"], current["preview_file_id"]):
        if object_id:
            storage_objects.delete_object(conn, NAMESPACE, object_id)
    conn.execute("DELETE FROM chat_attachments WHERE id = ?", [attachment_id])
    return True
