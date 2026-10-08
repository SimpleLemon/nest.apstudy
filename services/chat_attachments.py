"""Private, conversation-scoped storage for chat attachment payloads."""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime, timedelta, timezone

from appwrite.exception import AppwriteException
from appwrite.input_file import InputFile
from appwrite.query import Query
from appwrite.services.storage import Storage

from appwrite_client import COLLECTIONS, client as appwrite_client
from appwrite_helpers import get_row_safe, list_rows_all
from services import storage_objects
from services.chat_attachment_store import (
    NAMESPACE,
    activate_attachments,
    attachment_rows,
    delete_attachment_record,
    insert_attachment,
    require_scope,
)
from services.chat_attachment_validation import (
    AttachmentError,
    DOCUMENT_MIMES,
    IMAGE_FORMATS,
    MAX_UPLOAD_BYTES,
    bounded_gzip,
    inspect_and_prepare,
)
from services.database import utcnow_iso
from services.entitlements import EntitlementLimitError, check_storage, check_storage_transaction
from services.environment_config import runtime_environment_config
from services.storage_backend import (
    chat_attachments_enabled,
    require_legacy_reads,
    require_mutations_enabled,
    write_backend,
)
from services.storage_errors import StorageIntegrityError, StorageUnavailable
from services.storage_legacy_cleanup import drain_legacy_deletions
from services.storage_legacy_transport import read_legacy_file
from services.storage_scanner import scan_upload


logger = logging.getLogger(__name__)
TABLE_ID = COLLECTIONS["chat_attachments"]
MAX_ATTACHMENTS_PER_MESSAGE = 5


def _chat_attachments_enabled():
    return chat_attachments_enabled()


def storage_service():
    """Legacy-only transport, retained until all references are promoted."""
    return Storage(appwrite_client)


def _legacy_bucket():
    return runtime_environment_config().appwrite_chat_attachments_bucket_id


def _create_storage_file(data, filename, mime_type):
    bucket = _legacy_bucket()
    if not bucket:
        raise StorageUnavailable("Legacy chat attachment storage is not configured.")
    file_id = str(uuid.uuid4())
    storage_service().create_file(
        bucket, file_id,
        InputFile.from_bytes(data, filename=filename, mime_type=mime_type), permissions=[],
    )
    return file_id


def _attachment_limit(entitlements):
    limit = (entitlements or {}).get("limits", {}).get("max_chat_attachment_size_bytes")
    return min(MAX_UPLOAD_BYTES, int(limit)) if limit is not None else MAX_UPLOAD_BYTES


def _read_upload(uploaded_file, entitlements, original_size, upload_encoding):
    try:
        declared_size = int(original_size or 0)
    except (TypeError, ValueError) as exc:
        raise AttachmentError("The declared attachment size is invalid.") from exc
    if declared_size < 0:
        raise AttachmentError("The declared attachment size is invalid.")
    if upload_encoding not in {"identity", "gzip"}:
        raise AttachmentError("The upload encoding is not supported.")
    limit = _attachment_limit(entitlements)
    if declared_size > limit:
        raise EntitlementLimitError("chat attachment size", 0, declared_size, limit)
    data = uploaded_file.read(limit + 1)
    if len(data) > limit:
        raise EntitlementLimitError("chat attachment size", 0, len(data), limit)
    if upload_encoding == "gzip":
        data = bounded_gzip(data, limit)
    original_size = max(declared_size, len(data))
    if original_size > limit:
        raise EntitlementLimitError("chat attachment size", 0, original_size, limit)
    return data, original_size


def _metadata(prepared, *, user_id, scope_type, scope_id, original_size, backend, file_id, preview_id):
    now = utcnow_iso()
    return {
        "user_id": str(user_id),
        "scope_type": scope_type,
        "scope_id": str(scope_id),
        "message_id": "",
        "status": "pending",
        "original_filename": prepared["filename"],
        "mime_type": prepared["mime_type"],
        "kind": prepared["kind"],
        "original_size_bytes": original_size,
        "stored_size_bytes": prepared["stored_size_bytes"],
        "compression_encoding": prepared["compression_encoding"],
        "sha256": prepared["sha256"],
        "width": prepared["width"],
        "height": prepared["height"],
        "storage_backend": backend,
        "storage_bucket_id": _legacy_bucket() if backend == "appwrite" else "",
        "storage_file_id": file_id,
        "preview_file_id": preview_id or "",
        "preview_size_bytes": len(prepared["preview"][0]) if prepared["preview"] else 0,
        "provider": "nest",
        "provider_metadata_json": "{}",
        "created_at": now,
        "updated_at": now,
    }


def cleanup_legacy_attachments(*, account_user_id=None, object_ids=None, parent_id=None):
    """Retry explicit legacy payload deletion after its metadata commit."""
    return drain_legacy_deletions(
        NAMESPACE,
        lambda bucket, object_id: storage_service().delete_file(bucket, object_id),
        account_user_id=account_user_id, object_ids=object_ids, parent_id=parent_id,
    )


def _finish_legacy_cleanup(**scope):
    if cleanup_legacy_attachments(**scope)["pending"]:
        raise StorageUnavailable("Legacy chat attachment deletion is pending. Please retry.")


def create_attachment(*, user_id, scope_type, scope_id, uploaded_file, entitlements,
                      original_size=None, upload_encoding="identity"):
    require_mutations_enabled()
    if not _chat_attachments_enabled():
        raise AttachmentError("Chat attachments are disabled.")
    data, original_size = _read_upload(uploaded_file, entitlements, original_size, upload_encoding)
    backend = write_backend()
    if backend == "sqlite":
        # Scan before parsing the original image/PDF. The object service scans
        # again before encrypting the stored representation.
        scan_upload(data)
    prepared = inspect_and_prepare(data, uploaded_file.filename)
    total_bytes = prepared["stored_size_bytes"] + (len(prepared["preview"][0]) if prepared["preview"] else 0)
    check_storage(entitlements, total_bytes)
    attachment_id = str(uuid.uuid4())
    file_id = str(uuid.uuid4())
    preview_id = str(uuid.uuid4()) if prepared["preview"] else ""
    objects = []
    created_legacy_ids = []
    if backend == "sqlite":
        objects.append(storage_objects.prepare_object(
            NAMESPACE, file_id, prepared["stored"], filename=prepared["filename"],
            mime_type=prepared["mime_type"], scan_data=data,
        ))
        if preview_id:
            objects.append(storage_objects.prepare_object(
                NAMESPACE, preview_id, prepared["preview"][0],
                filename=f"{attachment_id}-preview.webp", mime_type="image/webp",
            ))
    else:
        try:
            file_id = _create_storage_file(prepared["stored"], f"{attachment_id}.bin", "application/octet-stream")
            created_legacy_ids.append(file_id)
            if preview_id:
                preview_id = _create_storage_file(prepared["preview"][0], f"{attachment_id}-preview.webp", "image/webp")
                created_legacy_ids.append(preview_id)
        except Exception:
            _rollback_legacy(created_legacy_ids)
            raise
    metadata = _metadata(
        prepared, user_id=user_id, scope_type=scope_type, scope_id=scope_id,
        original_size=original_size, backend=backend, file_id=file_id, preview_id=preview_id,
    )
    try:
        with storage_objects.write_transaction() as conn:
            if not _chat_attachments_enabled():
                raise AttachmentError("Chat attachments are disabled.")
            require_scope(conn, user_id=user_id, scope_type=scope_type, scope_id=scope_id)
            fresh = check_storage_transaction(conn, user_id, total_bytes, entitlements=entitlements)
            current_limit = _attachment_limit(fresh)
            if original_size > current_limit:
                raise EntitlementLimitError("chat attachment size", 0, original_size, current_limit)
            for item in objects:
                storage_objects.put_object(conn, item)
            return insert_attachment(conn, attachment_id, metadata)
    except Exception:
        _rollback_legacy(created_legacy_ids)
        raise


def _rollback_legacy(ids):
    for object_id in ids:
        try:
            storage_service().delete_file(_legacy_bucket(), object_id)
        except AppwriteException:
            logger.exception("Failed to roll back legacy chat attachment storage")


def get_attachment(attachment_id):
    return get_row_safe(TABLE_ID, str(attachment_id), allow_missing=True)


def serialize_attachment(row):
    attachment_id = str(row.get("$id") or row.get("id") or "")
    return {
        "id": attachment_id,
        "filename": row.get("original_filename") or "attachment",
        "mime_type": row.get("mime_type") or "application/octet-stream",
        "kind": row.get("kind") or "file",
        "size_bytes": int(row.get("original_size_bytes") or 0),
        "stored_size_bytes": int(row.get("stored_size_bytes") or 0),
        "sha256": row.get("sha256") or "",
        "width": row.get("width"),
        "height": row.get("height"),
        "preview_url": f"/api/chat/attachments/{attachment_id}/preview" if row.get("kind") in {"image", "pdf"} else None,
        "download_url": f"/api/chat/attachments/{attachment_id}/download",
        "requires_download_warning": row.get("kind") != "image",
        "virus_total_url": f"https://www.virustotal.com/gui/file/{row.get('sha256')}" if row.get("sha256") else None,
    }


def attachments_for_messages(message_ids):
    if not _chat_attachments_enabled():
        return {}
    ids = [str(value) for value in message_ids if value]
    if not ids:
        return {}
    try:
        rows = list_rows_all(TABLE_ID, [Query.equal("message_id", ids), Query.equal("status", ["active"])])
    except AppwriteException:
        logger.warning("Chat attachment metadata is unavailable; returning messages without attachments")
        return {}
    result = {}
    for row in rows:
        result.setdefault(str(row.get("message_id") or ""), []).append(serialize_attachment(row))
    return result


def bind_pending(attachment_ids, *, user_id, scope_type, scope_id, message_id):
    ids = list(dict.fromkeys(str(value) for value in attachment_ids if value))
    if len(ids) > MAX_ATTACHMENTS_PER_MESSAGE:
        raise AttachmentError("A message can include at most five attachments.")
    if not ids:
        return []
    with storage_objects.write_transaction() as conn:
        return activate_attachments(
            conn, ids, user_id=user_id, scope_type=scope_type, scope_id=scope_id,
            message_id=message_id, now=utcnow_iso(),
        )


def attachment_bytes(row, *, preview=False):
    file_id = row.get("preview_file_id") if preview else row.get("storage_file_id")
    if not file_id:
        return None
    expected = row.get("preview_size_bytes") if preview else row.get("stored_size_bytes")
    try:
        expected = int(expected) if expected is not None else None
    except (TypeError, ValueError, OverflowError) as exc:
        raise StorageIntegrityError("The chat attachment size is invalid.") from exc
    if expected is not None and not 0 <= expected <= MAX_UPLOAD_BYTES:
        raise StorageIntegrityError("The chat attachment size is invalid.")
    backend = row.get("storage_backend") or "appwrite"
    if backend == "sqlite":
        data = storage_objects.read_object(NAMESPACE, str(file_id))
    elif backend == "appwrite":
        require_legacy_reads()
        bucket = row.get("storage_bucket_id") or _legacy_bucket()
        if not bucket:
            raise StorageUnavailable("Legacy chat attachment storage is not configured.")
        data = read_legacy_file(
            bucket, str(file_id), max_bytes=MAX_UPLOAD_BYTES, expected_bytes=expected,
        )
    else:
        raise StorageIntegrityError("The chat attachment storage backend is invalid.")
    if not isinstance(data, bytes) or len(data) > MAX_UPLOAD_BYTES or (expected is not None and len(data) != expected):
        raise StorageIntegrityError("The chat attachment size is invalid.")
    if not preview and row.get("compression_encoding") == "gzip":
        try:
            original_size = row.get("original_size_bytes")
            declared = MAX_UPLOAD_BYTES if original_size is None else int(original_size)
        except (TypeError, ValueError, OverflowError) as exc:
            raise StorageIntegrityError("The chat attachment size is invalid.") from exc
        if not 0 <= declared <= MAX_UPLOAD_BYTES:
            raise StorageIntegrityError("The chat attachment size is invalid.")
        try:
            data = bounded_gzip(data, declared)
        except AttachmentError as exc:
            raise StorageIntegrityError("The compressed chat attachment is invalid.") from exc
        if row.get("sha256") and hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise StorageIntegrityError("The restored chat attachment hash is invalid.")
    elif not preview and row.get("compression_encoding") not in {None, "", "identity"}:
        raise StorageIntegrityError("The chat attachment compression is invalid.")
    return data


def delete_attachment(row, *, conn=None, account_user_id=None):
    if not row:
        return
    require_mutations_enabled()
    if conn is not None:
        return delete_attachment_record(conn, row, account_user_id=account_user_id)
    with storage_objects.write_transaction() as transaction:
        deleted = delete_attachment_record(transaction, row, account_user_id=account_user_id)
    if (row.get("storage_backend") or "appwrite") == "appwrite":
        _finish_legacy_cleanup(
            account_user_id=account_user_id,
            object_ids=[object_id for object_id in (
                row.get("storage_file_id"), row.get("preview_file_id"),
            ) if object_id],
        )
    return deleted


def delete_message_attachments(message_id):
    require_mutations_enabled()
    with storage_objects.write_transaction() as conn:
        conn.execute(
            "UPDATE chat_messages SET delete_requested_at = "
            "COALESCE(delete_requested_at, ?) WHERE id = ?",
            [utcnow_iso(), str(message_id)],
        )
        for row in attachment_rows(conn, "message_id", message_id):
            delete_attachment_record(conn, row)
    # The parent scope survives removal of every attachment row, so retries
    # still prevent hiding/pruning this message while its payload is remote.
    _finish_legacy_cleanup(parent_id=str(message_id))


def delete_user_attachments(user_id):
    require_mutations_enabled()
    with storage_objects.write_transaction() as conn:
        for row in attachment_rows(conn, "user_id", user_id):
            delete_attachment_record(conn, row, account_user_id=str(user_id))
    _finish_legacy_cleanup(account_user_id=str(user_id))


def cleanup_abandoned_attachments(max_age_hours=24):
    require_mutations_enabled()
    cleanup_legacy_attachments()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    rows = list_rows_all(TABLE_ID, [Query.equal("status", ["pending"])])
    deleted = 0
    for row in rows:
        raw_created = str(row.get("created_at") or "").replace("Z", "+00:00")
        try:
            created = datetime.fromisoformat(raw_created)
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
        except ValueError:
            created = datetime.min.replace(tzinfo=timezone.utc)
        if created <= cutoff:
            try:
                deleted += bool(delete_attachment(row, account_user_id=str(row["user_id"])))
            except AttachmentError:
                logger.info("Abandoned attachment changed before cleanup")
    return deleted
