"""Private note images with atomic local metadata and payload persistence."""

import io
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from PIL import Image, UnidentifiedImageError
from appwrite.exception import AppwriteException
from appwrite.input_file import InputFile
from appwrite.services.storage import Storage

from appwrite_client import NOTES_MEDIA_BUCKET_ID, client as appwrite_client
from appwrite_helpers import get_row_safe
from services.database import utcnow_iso
from services.entitlements import check_storage_transaction
from services.storage_backend import (
    require_legacy_reads, require_mutations_enabled, write_backend,
)
from services.storage_legacy_cleanup import drain_legacy_deletions, enqueue_legacy_deletion
from services.storage_legacy_transport import read_legacy_file
from services.storage_objects import (
    StorageIntegrityError, StorageNotFound, delete_object, object_metadata,
    prepare_object, put_object, read_object, write_transaction,
)


logger = logging.getLogger(__name__)
NOTE_MEDIA_TABLE_ID = "note_media"
NOTE_MEDIA_NAMESPACE = "note_media"
MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024
MAX_NOTE_IMAGE_PIXELS = 40_000_000
ALLOWED_IMAGE_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "GIF": ("image/gif", "gif"),
    "WEBP": ("image/webp", "webp"),
}
# Only Nest grants reads after checking the parent note, including for legacy
# writes. Newly uploaded private images must not have a direct public URL.
NOTE_MEDIA_FILE_PERMISSIONS = []


def storage_service():
    return Storage(appwrite_client)


def inspect_image(data):
    if not data:
        raise ValueError("Image file is empty.")
    if len(data) > MAX_NOTE_IMAGE_BYTES:
        raise ValueError("Image exceeds the 10 MiB limit.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image_format = str(image.format or "").upper()
            if image_format not in ALLOWED_IMAGE_FORMATS:
                raise ValueError("Use a JPEG, PNG, GIF, or WebP image.")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_NOTE_IMAGE_PIXELS:
                raise ValueError("Image dimensions are too large.")
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The uploaded file is not a valid supported image.") from exc
    mime_type, extension = ALLOWED_IMAGE_FORMATS[image_format]
    return {"mime_type": mime_type, "extension": extension, "width": width, "height": height}


def _media_dict(row):
    if row is None:
        return None
    media = dict(row)
    media["$id"] = media["id"]
    return media


def _require_owner(conn, note_id, user_id):
    # Deletion or transfer can race with upload validation/scanning. Recheck
    # ownership after preparation and after acquiring SQLite's writer lock.
    note = conn.execute(
        "SELECT user_id FROM notes WHERE id = ?", [str(note_id)]
    ).fetchone()
    if not note or str(note["user_id"]) != str(user_id):
        raise StorageNotFound("Note was not found.")


def _insert_media(conn, media):
    columns = (
        "id", "note_id", "user_id", "storage_backend", "storage_bucket_id",
        "storage_file_id", "original_filename", "mime_type", "file_size_bytes",
        "width", "height", "status", "created_at", "updated_at",
    )
    conn.execute(
        f"INSERT INTO note_media ({', '.join(columns)}) VALUES ({', '.join('?' for _ in columns)})",
        [media[column] for column in columns],
    )


def create_media(note_id, user_id, uploaded_file, *, entitlements=None):
    require_mutations_enabled()
    data = uploaded_file.read(MAX_NOTE_IMAGE_BYTES + 1)
    details = inspect_image(data)
    claimed_mime = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower()
    if claimed_mime and claimed_mime != "application/octet-stream" and claimed_mime != details["mime_type"]:
        raise ValueError("The image content does not match its reported file type.")
    backend = write_backend()
    media_id = str(uuid.uuid4())
    storage_file_id = str(uuid.uuid4())
    safe_name = f"{media_id}.{details['extension']}"
    original_filename = str(uploaded_file.filename or safe_name)[:255]
    prepared = None
    if backend == "sqlite":
        # Content scanning, hashing, and encryption finish before locking.
        prepared = prepare_object(
            NOTE_MEDIA_NAMESPACE, storage_file_id, data,
            filename=original_filename, mime_type=details["mime_type"],
        )
    else:
        storage_service().create_file(
            NOTES_MEDIA_BUCKET_ID,
            storage_file_id,
            InputFile.from_bytes(data, filename=safe_name, mime_type=details["mime_type"]),
            permissions=NOTE_MEDIA_FILE_PERMISSIONS,
        )
    now = utcnow_iso()
    media = {
        "id": media_id,
        "note_id": str(note_id),
        "user_id": str(user_id),
        "storage_backend": backend,
        "storage_bucket_id": NOTES_MEDIA_BUCKET_ID if backend == "appwrite" else "",
        "storage_file_id": storage_file_id,
        "original_filename": original_filename,
        "mime_type": details["mime_type"],
        "file_size_bytes": len(data),
        "width": details["width"],
        "height": details["height"],
        "status": "pending",
        "created_at": now,
        "updated_at": now,
    }
    try:
        with write_transaction() as conn:
            _require_owner(conn, note_id, user_id)
            check_storage_transaction(conn, user_id, len(data), entitlements=entitlements)
            if prepared is not None:
                put_object(conn, prepared)
            _insert_media(conn, media)
    except Exception:
        if backend == "appwrite":
            try:
                storage_service().delete_file(NOTES_MEDIA_BUCKET_ID, storage_file_id)
            except AppwriteException:
                logger.exception("Failed to roll back note media storage upload")
        raise
    return {**media, "$id": media_id}


def get_media(media_id):
    return get_row_safe(NOTE_MEDIA_TABLE_ID, str(media_id), allow_missing=True)


def media_bytes(media):
    backend = str(media.get("storage_backend") or "appwrite").strip().lower()
    object_id = str(media.get("storage_file_id") or "")
    if backend == "sqlite":
        metadata = object_metadata(NOTE_MEDIA_NAMESPACE, object_id)
        if not metadata:
            raise StorageNotFound("Note image was not found.")
        if (
            metadata["mime_type"] != media.get("mime_type")
            or int(metadata["byte_length"]) != int(media.get("file_size_bytes") or 0)
            or int(metadata["byte_length"]) > MAX_NOTE_IMAGE_BYTES
        ):
            raise StorageIntegrityError("Note image metadata does not match its stored content.")
        data = read_object(NOTE_MEDIA_NAMESPACE, object_id)
    elif backend == "appwrite":
        require_legacy_reads()
        data = read_legacy_file(
            media.get("storage_bucket_id") or NOTES_MEDIA_BUCKET_ID, object_id,
            max_bytes=MAX_NOTE_IMAGE_BYTES,
            expected_bytes=int(media.get("file_size_bytes") or 0),
        )
    else:
        raise StorageIntegrityError("Note image has an unsupported storage backend.")
    # Validate legacy content too; never render a mismatched MIME inline.
    try:
        details = inspect_image(data)
    except ValueError as exc:
        raise StorageIntegrityError("Stored note image is invalid.") from exc
    if details["mime_type"] != media.get("mime_type"):
        raise StorageIntegrityError("Stored note image type does not match its metadata.")
    return data


def cleanup_legacy_media(rows=None, *, account_user_id=None, object_ids=None, parent_id=None):
    """Retry committed legacy deletions within an account, parent, or object scope.

    Removed rows limit ordinary edits to their own legacy identities. Omitting
    rows and filters explicitly retries the entire note-media queue.
    """
    if rows is not None:
        row_ids = {
            str(row["storage_file_id"]) for row in rows
            if row and str(row.get("storage_backend") or "appwrite").strip().lower() == "appwrite"
        }
        if object_ids is not None:
            row_ids.intersection_update([object_ids] if isinstance(object_ids, str) else object_ids)
        object_ids = row_ids
    return drain_legacy_deletions(
        NOTE_MEDIA_NAMESPACE,
        lambda bucket_id, object_id: storage_service().delete_file(bucket_id, object_id),
        account_user_id=account_user_id, object_ids=object_ids, parent_id=parent_id,
    )


def _delete_media_record(conn, media, *, account_user_id=None):
    backend = str(media.get("storage_backend") or "appwrite").strip().lower()
    if backend == "appwrite":
        parent = conn.execute(
            "SELECT user_id FROM notes WHERE id = ?", [str(media["note_id"])],
        ).fetchone()
        owner = account_user_id if account_user_id is not None else (
            parent["user_id"] if parent else media.get("user_id")
        )
        enqueue_legacy_deletion(
            conn, NOTE_MEDIA_NAMESPACE,
            media.get("storage_bucket_id") or NOTES_MEDIA_BUCKET_ID,
            media["storage_file_id"],
            account_user_id=owner, parent_id=media["note_id"],
        )
    # An unpromoted legacy row can already have a copied SQLite object.
    delete_object(conn, NOTE_MEDIA_NAMESPACE, media["storage_file_id"])
    conn.execute("DELETE FROM note_media WHERE id = ?", [media["id"]])


def delete_media(media, *, conn=None, user_id=None, account_user_id=None):
    require_mutations_enabled()
    if not media:
        return None
    if conn is None:
        with write_transaction() as owned_conn:
            deleted = delete_media(
                media, conn=owned_conn, user_id=user_id, account_user_id=account_user_id,
            )
        cleanup_legacy_media([deleted] if deleted else [], account_user_id=account_user_id)
        return deleted
    current = _media_dict(conn.execute(
        "SELECT * FROM note_media WHERE id = ?",
        [str(media.get("$id") or media.get("id"))],
    ).fetchone())
    if not current:
        return None
    if str(current["note_id"]) != str(media.get("note_id")):
        raise StorageNotFound("Note image was not found.")
    if user_id is not None:
        _require_owner(conn, current["note_id"], user_id)
    if account_user_id is not None:
        parent = conn.execute(
            "SELECT user_id FROM notes WHERE id = ?", [current["note_id"]],
        ).fetchone()
        if str(current["user_id"]) != str(account_user_id) and (
            not parent or str(parent["user_id"]) != str(account_user_id)
        ):
            raise StorageNotFound("Note image was not found.")
    _delete_media_record(conn, current, account_user_id=account_user_id)
    return current


def delete_note_media(note_id, *, conn=None):
    require_mutations_enabled()
    if conn is None:
        with write_transaction() as owned_conn:
            deleted = delete_note_media(note_id, conn=owned_conn)
        cleanup_legacy_media(deleted)
        return deleted
    rows = [_media_dict(row) for row in conn.execute(
        "SELECT * FROM note_media WHERE note_id = ?", [str(note_id)],
    ).fetchall()]
    for media in rows:
        _delete_media_record(conn, media)
    return rows


def referenced_media_ids(content):
    try:
        document = json.loads(content or "[]") if isinstance(content, str) else content
    except (TypeError, ValueError, json.JSONDecodeError):
        return set()
    found = set()

    def visit(value):
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        if value.get("type") == "inlineImage":
            props = value.get("props") if isinstance(value.get("props"), dict) else {}
            media_id = str(props.get("mediaId") or "").strip()
            if media_id:
                found.add(media_id)
        for child in value.values():
            if isinstance(child, (list, dict)):
                visit(child)

    visit(document)
    return found


def sync_note_media(note_id, content, *, conn=None):
    require_mutations_enabled()
    if conn is None:
        with write_transaction() as owned_conn:
            deleted = sync_note_media(note_id, content, conn=owned_conn)
        cleanup_legacy_media(deleted)
        return deleted
    referenced = referenced_media_ids(content)
    rows = [_media_dict(row) for row in conn.execute(
        "SELECT * FROM note_media WHERE note_id = ?", [str(note_id)],
    ).fetchall()]
    now = utcnow_iso()
    deleted = []
    for media in rows:
        if media["id"] in referenced:
            if media["status"] != "active":
                conn.execute(
                    "UPDATE note_media SET status = 'active', updated_at = ? WHERE id = ?",
                    [now, media["id"]],
                )
        elif media["status"] == "active":
            _delete_media_record(conn, media)
            deleted.append(media)
    return deleted


def cleanup_abandoned_media(max_age_hours=24):
    require_mutations_enabled()
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    deleted = []
    with write_transaction() as conn:
        rows = [_media_dict(row) for row in conn.execute(
            "SELECT * FROM note_media WHERE status = 'pending'",
        ).fetchall()]
        for media in rows:
            raw_created = str(media.get("created_at") or "").replace("Z", "+00:00")
            try:
                created = datetime.fromisoformat(raw_created)
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
            except ValueError:
                created = datetime.min.replace(tzinfo=timezone.utc)
            if created <= cutoff:
                _delete_media_record(conn, media)
                deleted.append(media)
    # This scheduled sweep also retries work whose feature rows were already
    # removed on a previous pass while the remote service was unavailable.
    cleanup_legacy_media()
    return len(deleted)
