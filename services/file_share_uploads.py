"""Validate shared-file batches and persist their payloads and metadata."""

import logging
from dataclasses import dataclass
from datetime import timedelta
from uuid import uuid4

from werkzeug.utils import secure_filename

from appwrite.exception import AppwriteException

from appwrite.input_file import InputFile
from appwrite_client import COLLECTIONS, FILE_SHARE_BUCKET_ID
from appwrite_helpers import format_datetime, get_row_safe
from services import storage_rows
from services.discord_audit import emit_creation_event, format_actor
from services.entitlements import (
    EntitlementError, EntitlementLimitError, check_storage,
    check_storage_transaction, request_entitlements,
)
from services.file_share_store import (
    ALLOWED_EXPIRY_OPTIONS, DEFAULT_EXPIRY_DAYS, MAX_FILE_SIZE, MAX_UPLOAD_FILES,
    _appwrite_upload_error, _folders_collection, _generate_share_code,
    _normalize_folder_id, _shared_file_payload, _storage, _storage_path,
)
from services.storage_backend import require_mutations_enabled, write_backend
from services.storage_objects import StorageError, StorageNotFound, prepare_object, put_object, write_transaction
from services.time_utils import utcnow


logger = logging.getLogger(__name__)


SHARED_FILE_NAMESPACE = "shared_files"


@dataclass(frozen=True, slots=True)
class _Upload:
    object_id: str
    user_id: str
    folder_id: str | None
    filename: str
    data: bytes
    mime_type: str
    expiry_days: int
    visibility: str
    batch_count: int


def _metadata(upload):
    now = utcnow()
    return {
        "user_id": upload.user_id,
        "folder_id": upload.folder_id,
        "original_filename": upload.filename,
        "file_size_bytes": len(upload.data),
        "mime_type": upload.mime_type,
        "share_code": _generate_share_code() if upload.visibility == "public" else None,
        "is_public": upload.visibility == "public",
        "expires_at": format_datetime(now + timedelta(days=upload.expiry_days)),
        "created_at": format_datetime(now),
        "updated_at": format_datetime(now),
        "downloaded_count": 0,
    }


def _validate_upload_transaction(conn, upload, entitlements):
    if upload.folder_id:
        folder = storage_rows.get_row(
            conn, _folders_collection(), upload.folder_id, allow_missing=True,
        )
        if not folder or folder.get("user_id") != upload.user_id:
            raise StorageNotFound("File or folder was not found.")
    current = check_storage_transaction(
        conn, upload.user_id, len(upload.data), entitlements=entitlements,
    )
    limits = current["limits"]
    file_limit = limits.get("max_file_size_bytes")
    if file_limit is not None and len(upload.data) > file_limit:
        raise EntitlementLimitError("file size bytes", 0, len(upload.data), file_limit)
    batch_limit = limits.get("max_upload_files")
    if batch_limit is not None and upload.batch_count > batch_limit:
        raise EntitlementLimitError("files per upload", 0, upload.batch_count, batch_limit)


def _save_sqlite_file(upload, entitlements):
    prepared = prepare_object(
        SHARED_FILE_NAMESPACE,
        upload.object_id,
        upload.data,
        filename=secure_filename(upload.filename) or "file",
        mime_type=upload.mime_type,
    )
    metadata = _metadata(upload)
    metadata.update({
        "stored_path": f"sqlite://{SHARED_FILE_NAMESPACE}/{upload.object_id}",
        "storage_backend": "sqlite",
        "storage_bucket_id": None,
        "storage_file_id": upload.object_id,
    })
    # Scanning, hashing, encryption, and share-code lookup finish before this
    # lock. Recheck ownership and account usage on the connection that commits.
    with write_transaction() as conn:
        _validate_upload_transaction(conn, upload, entitlements)
        put_object(conn, prepared)
        return storage_rows.insert_row(conn, COLLECTIONS["shared_files"], upload.object_id, metadata)


def _save_appwrite_file(upload, entitlements):
    storage = _storage()
    storage.create_file(
        FILE_SHARE_BUCKET_ID,
        upload.object_id,
        InputFile.from_bytes(
            upload.data,
            filename=secure_filename(upload.filename) or "file",
            mime_type=upload.mime_type,
        ),
    )
    try:
        metadata = _metadata(upload)
        metadata.update({
            "stored_path": _storage_path(upload.object_id),
            "storage_backend": "appwrite",
            "storage_bucket_id": FILE_SHARE_BUCKET_ID,
            "storage_file_id": upload.object_id,
        })
        # Appwrite transport and share-code lookup finish before acquiring the
        # local writer. Account deletion, quota, tier, and folder changes are
        # checked on the same connection that commits the feature metadata.
        with write_transaction() as conn:
            _validate_upload_transaction(conn, upload, entitlements)
            return storage_rows.insert_row(conn, COLLECTIONS["shared_files"], upload.object_id, metadata)
    except BaseException as exc:
        if isinstance(exc, AppwriteException):
            logger.exception("Failed to save shared file row for upload %s", upload.object_id)
        try:
            storage.delete_file(FILE_SHARE_BUCKET_ID, upload.object_id)
        except Exception:
            logger.exception("Failed to clean up uploaded Appwrite file %s after row failure", upload.object_id)
        # Preserve the existing distinction between upload and metadata errors.
        if isinstance(exc, AppwriteException):
            raise _MetadataSaveError() from None
        raise


class _MetadataSaveError(RuntimeError):
    pass


def _upload_limits(user, files):
    entitlements = request_entitlements(user)
    limits = entitlements["limits"]
    batch_limit = limits.get("max_upload_files")
    file_limit = limits.get("max_file_size_bytes")
    if batch_limit is not None and len(files) > batch_limit:
        raise EntitlementLimitError("files per upload", 0, len(files), batch_limit)
    effective_batch = min(MAX_UPLOAD_FILES, batch_limit) if batch_limit is not None else MAX_UPLOAD_FILES
    effective_file = min(MAX_FILE_SIZE, file_limit) if file_limit is not None else MAX_FILE_SIZE
    return entitlements, effective_batch, effective_file, file_limit


def _file_size_error(filename, size, effective_limit, tier_limit):
    if tier_limit is not None and size > tier_limit:
        return EntitlementLimitError("file size bytes", 0, size, tier_limit).payload()
    if size > effective_limit:
        return {"error": f"{filename} exceeds the current file-size limit.", "code": "file_too_large"}
    if size == 0:
        return {"error": f"{filename} is empty."}
    return None


def _audit_created(user, shared_file, upload):
    emit_creation_event(
        "Shared File Created",
        actor=format_actor(user),
        target=upload.filename,
        metadata={
            "page_context": "files/upload",
            "resource_type": "shared_file",
            "resource_id": shared_file.get("$id") or shared_file.get("id"),
            "folder_id": upload.folder_id,
            "is_public": shared_file["is_public"],
            "file_size_bytes": shared_file["file_size_bytes"],
            "mime_type": shared_file["mime_type"],
            "expiry_days": upload.expiry_days,
        },
        color="green",
    )


def upload_files(user, files, form, *, share_base_url):
    require_mutations_enabled()
    backend = write_backend()
    if not files:
        return {"error": "At least one file is required."}, 400

    try:
        entitlements, batch_limit, file_limit, tier_file_limit = _upload_limits(user, files)
    except EntitlementLimitError as exc:
        return exc.payload(), 403
    except EntitlementError:
        logger.exception("Failed to calculate file upload limits")
        return {"error": "Unable to verify your storage limits right now.", "code": "tier_check_unavailable"}, 503

    user_id = str(user.id)
    folder_id = _normalize_folder_id(form.get("folderId"))
    if folder_id:
        folder = get_row_safe(_folders_collection(), folder_id, allow_missing=True)
        if not folder or str(folder.get("user_id")) != user_id:
            raise StorageNotFound("File or folder was not found.")
    filenames, visibilities, expiries = (form.getlist(key) for key in ("filename", "visibility", "expiryDays"))
    to_process = files[:batch_limit]
    skipped = len(files) - len(to_process)
    created, errors, statuses = [], [], []
    reserved_bytes = 0

    for index, uploaded_file in enumerate(to_process):
        if not uploaded_file or not uploaded_file.filename:
            errors.append({"index": index, "error": "Missing file or filename."})
            continue
        filename = ((filenames[index] if index < len(filenames) else "") or "").strip() or uploaded_file.filename
        visibility = ((visibilities[index] if index < len(visibilities) else "private") or "private").strip().lower()
        try:
            expiry_days = int(expiries[index]) if index < len(expiries) else DEFAULT_EXPIRY_DAYS
        except (TypeError, ValueError):
            expiry_days = DEFAULT_EXPIRY_DAYS
        if visibility not in {"public", "private"} or expiry_days not in ALLOWED_EXPIRY_OPTIONS:
            message = "Invalid visibility option." if visibility not in {"public", "private"} else "Invalid expiry selection."
            errors.append({"index": index, "error": message})
            continue

        data = uploaded_file.read(file_limit + 1)
        size_error = _file_size_error(uploaded_file.filename, len(data), file_limit, tier_file_limit)
        if size_error:
            errors.append({"index": index, **size_error})
            continue
        file_id = str(uuid4())
        upload = _Upload(
            file_id, user_id, folder_id, filename, data,
            uploaded_file.mimetype or "application/octet-stream", expiry_days, visibility, len(files),
        )
        try:
            check_storage(entitlements, reserved_bytes + len(data))
            require_mutations_enabled()
            if backend == "sqlite":
                shared_file = _save_sqlite_file(upload, entitlements)
            else:
                shared_file = _save_appwrite_file(upload, entitlements)
        except EntitlementLimitError as exc:
            errors.append({"index": index, **exc.payload()})
            continue
        except EntitlementError:
            logger.exception("Failed to recheck file upload limits")
            errors.append({"index": index, "error": "Unable to verify your storage limits right now.", "code": "tier_check_unavailable"})
            statuses.append(503)
            continue
        except StorageError as exc:
            logger.exception("Failed to store shared file %s", file_id)
            errors.append({"index": index, "error": str(exc), "code": exc.code})
            statuses.append(exc.status_code)
            continue
        except _MetadataSaveError:
            errors.append({"index": index, "error": "Unable to save file."})
            continue
        except AppwriteException as exc:
            logger.exception("Failed to upload shared file %s", file_id)
            errors.append({"index": index, "error": _appwrite_upload_error(exc) if backend == "appwrite" else "Unable to save file."})
            continue

        reserved_bytes += len(data)
        created.append(_shared_file_payload(shared_file, share_base_url=share_base_url))
        _audit_created(user, shared_file, upload)
        del data, upload

    response = {"files": created}
    if skipped:
        response["skipped"] = skipped
        response["errors"] = [{"error": f"Only {batch_limit} files are accepted; {skipped} file(s) were ignored."}]
    if errors:
        response.setdefault("errors", []).extend(errors)
        if not created:
            response["error"] = errors[0].get("error") or "Upload failed."
    return response, 201 if created else (max(statuses) if statuses else 400)
