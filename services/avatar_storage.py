"""Profile image validation and storage, with atomic SQLite profile writes."""

import io
import logging
import sqlite3
from contextlib import contextmanager
from urllib.parse import quote, urljoin

import requests as http_requests
from PIL import Image, UnidentifiedImageError
from flask import current_app, has_app_context
from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.input_file import InputFile
from appwrite.permission import Permission
from appwrite.role import Role
from appwrite.services.storage import Storage

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from appwrite_client import ENDPOINT, PROFILE_AVATAR_BUCKET_ID, PROJECT_ID, client as appwrite_client
from services import database, storage_backend, storage_objects
from services.avatar_references import legacy_avatar_id as _legacy_avatar_id, local_avatar_id as _local_avatar_id
from services.avatar_ownership import (
    avatar_identities,
    avatar_referenced as _avatar_referenced,
    avatar_replacement_credit,
    record_avatar_ownership,
    reject_retiring_avatar_references,
    remember_current_avatar_ownership,
)
from services.outbound_http import redacted_url, require_public_http_url
from services.storage_legacy_cleanup import drain_legacy_deletions, enqueue_legacy_deletion

logger = logging.getLogger(__name__)
AVATAR_NAMESPACE = "avatars"
MAX_AVATAR_BYTES = 10 * 1024 * 1024
MAX_AVATAR_PIXELS = 40_000_000
ALLOWED_AVATAR_MIME_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_AVATAR_REDIRECTS = 4
MIME_TYPE_EXTENSIONS = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
IMAGE_FORMAT_MIME_TYPES = {"JPEG": "image/jpeg", "PNG": "image/png", "GIF": "image/gif", "WEBP": "image/webp"}


def _environment_config_snapshot():
    if has_app_context():
        configured = current_app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
        if configured is not None:
            return configured
    return load_environment_config()


def _legacy_identity():
    configured = _environment_config_snapshot()
    return (
        (ENDPOINT or configured.appwrite_endpoint or "").rstrip("/"),
        PROJECT_ID or configured.appwrite_project_id or "",
        PROFILE_AVATAR_BUCKET_ID,
    )


def build_avatar_view_url(file_id, *, backend=None):
    """Build a canonical Nest URL or an explicitly selected legacy URL."""
    if not file_id:
        return None
    if (backend or storage_backend.write_backend()) == "sqlite":
        return f"/api/avatars/{quote(str(file_id), safe='')}"
    endpoint, project_id, bucket_id = _legacy_identity()
    if not endpoint or not project_id:
        return None
    return f"{endpoint}/storage/buckets/{bucket_id}/files/{quote(str(file_id), safe='')}/view?project={quote(project_id, safe='')}"


def legacy_avatar_id(url):
    return _legacy_avatar_id(url, identity=_legacy_identity())


def local_avatar_id(url):
    return _local_avatar_id(url, app_base_url=_environment_config_snapshot().app_base_url)


def resolve_avatar_url(url, *, file_id=None, backend=None):
    """Keep provider URLs; resolve a known local object to Nest's public route."""
    raw_url = str(url or "").strip()
    legacy_id = legacy_avatar_id(raw_url) if raw_url else None
    if file_id and backend == "sqlite" and (not raw_url or legacy_id == str(file_id) or local_avatar_id(raw_url) == str(file_id)):
        return build_avatar_view_url(file_id, backend="sqlite")
    if legacy_id:
        # Legacy reads must pass through Nest's compatibility gate too. Missing
        # baseline images use the browser's normal image-error fallback.
        return build_avatar_view_url(legacy_id, backend="sqlite")
    return raw_url


def inspect_avatar(data, declared_mime=None):
    if not data:
        raise storage_objects.StorageValidationError("Avatar file is empty.")
    if len(data) > MAX_AVATAR_BYTES:
        raise storage_objects.StorageValidationError("Avatar must be 10 MB or smaller.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            mime_type = IMAGE_FORMAT_MIME_TYPES.get(str(image.format or "").upper())
            if not mime_type:
                raise storage_objects.StorageValidationError("Avatar must be a JPG, PNG, GIF, or WebP image.")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_AVATAR_PIXELS:
                raise storage_objects.StorageValidationError("Avatar image dimensions are too large.")
            image.verify()
        with Image.open(io.BytesIO(data)) as image:
            image.load()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise storage_objects.StorageValidationError("Avatar is not a valid supported image.") from exc
    claimed_mime = str(declared_mime or "").split(";", 1)[0].strip().lower()
    if claimed_mime and claimed_mime != mime_type:
        raise storage_objects.StorageValidationError("Avatar image content does not match its reported file type.")
    return mime_type


def prepare_avatar_upload(user_id, data, *, filename, mime_type, backend=None):
    """Validate, scan and encrypt before any metadata write lock is acquired."""
    storage_backend.require_mutations_enabled()
    mime_type = inspect_avatar(data, mime_type)
    selected_backend = backend or storage_backend.write_backend()
    file_id = ID.unique()
    view_url = build_avatar_view_url(file_id, backend=selected_backend)
    if not view_url:
        raise storage_objects.StorageUnavailable("Avatar storage is not configured.")
    stored_filename = f"{user_id}-{file_id}.{MIME_TYPE_EXTENSIONS[mime_type]}"
    payload = bytes(data)
    if selected_backend == "sqlite":
        payload = storage_objects.prepare_object(
            AVATAR_NAMESPACE, file_id, payload,
            filename=str(filename or stored_filename)[:255], mime_type=mime_type,
        )
    return {"user_id": str(user_id), "file_id": file_id, "view_url": view_url, "size_bytes": len(data), "mime_type": mime_type,
            "filename": stored_filename, "backend": selected_backend, "payload": payload}


def _download_provider_avatar(source_url, *, timeout, max_bytes):
    current_url, response = str(source_url or "").strip(), None
    if not current_url:
        return None
    try:
        for _ in range(MAX_AVATAR_REDIRECTS + 1):
            require_public_http_url(current_url)
            response = http_requests.get(current_url, timeout=timeout, stream=True, allow_redirects=False)
            if 300 <= response.status_code < 400 and response.headers.get("Location"):
                next_url = urljoin(current_url, response.headers["Location"])
                response.close()
                response = None
                current_url = next_url
                continue
            break
        else:
            return None
        if response.status_code != 200:
            return None
        mime_type = str(response.headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
        if mime_type not in ALLOWED_AVATAR_MIME_TYPES:
            return None
        try:
            if int(response.headers.get("Content-Length") or 0) > max_bytes:
                return None
        except (TypeError, ValueError):
            pass
        data = bytearray()
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if chunk:
                if len(data) + len(chunk) > max_bytes:
                    return None
                data.extend(chunk)
        return bytes(data), mime_type
    except Exception as exc:
        logger.warning("Provider avatar download failed: source=%s error_type=%s", redacted_url(current_url)[:120], type(exc).__name__)
        return None
    finally:
        if response is not None:
            response.close()


def prepare_avatar_from_url(user_id, source_url, *, timeout=8, max_bytes=MAX_AVATAR_BYTES):
    """Best-effort provider copy preparation; no object or user is committed."""
    try:
        storage_backend.require_mutations_enabled()
        downloaded = _download_provider_avatar(source_url, timeout=timeout, max_bytes=min(max_bytes, MAX_AVATAR_BYTES))
        if downloaded is None:
            return None
        data, mime_type = downloaded
        return prepare_avatar_upload(user_id, data, filename="provider-avatar", mime_type=mime_type)
    except storage_objects.StorageMutationPaused:
        return None
    except (storage_objects.StorageError, ValueError):
        logger.exception("Failed to prepare provider avatar")
        return None


def _upload_legacy(prepared):
    storage_backend.require_mutations_enabled()
    Storage(appwrite_client).create_file(
        PROFILE_AVATAR_BUCKET_ID, prepared["file_id"],
        InputFile.from_bytes(prepared["payload"], prepared["filename"], mime_type=prepared["mime_type"]),
        permissions=[Permission.read(Role.any())],
    )


def avatar_profile_fields(prepared, source="provider"):
    return {"picture_url": prepared["view_url"], "avatar_file_id": prepared["file_id"],
            "avatar_file_size_bytes": prepared["size_bytes"], "avatar_source": source,
            "avatar_storage_backend": prepared["backend"]}


def retire_avatar(conn, file_id, *, backend, account_user_id=None):
    """Retire an unreferenced image in its profile/account writer transaction.

    Legacy ownership remains charged until the queued remote delete succeeds.
    A SQLite avatar's historical Appwrite source remains available for rollback.
    """
    if not file_id or _avatar_referenced(conn, str(file_id)):
        return False
    storage_backend.require_mutations_enabled()
    if backend == "appwrite":
        owner = conn.execute(
            "SELECT user_id FROM storage_avatar_ownership WHERE object_id = ?", [str(file_id)],
        ).fetchone()
        enqueue_legacy_deletion(
            conn, AVATAR_NAMESPACE, PROFILE_AVATAR_BUCKET_ID, str(file_id),
            account_user_id=account_user_id if account_user_id is not None else (owner["user_id"] if owner else None),
        )
    elif backend != "sqlite":
        raise storage_objects.StorageValidationError("Avatar storage backend is invalid.")
    storage_objects.delete_object(conn, AVATAR_NAMESPACE, str(file_id))
    return True


def _write_user(conn, user_id, row_data, *, create):
    payload = database._clean_payload(conn, "users", row_data)
    reject_retiring_avatar_references(conn, payload)
    if create:
        payload = {"id": str(user_id), **payload}
        columns = ", ".join(f'"{column}"' for column in payload)
        placeholders = ", ".join("?" for _ in payload)
        conn.execute(f"INSERT INTO users ({columns}) VALUES ({placeholders})", list(payload.values()))
    elif payload:
        assignments = ", ".join(f'"{column}" = ?' for column in payload)
        result = conn.execute(f"UPDATE users SET {assignments} WHERE id = ?", [*payload.values(), str(user_id)])
        if result.rowcount != 1:
            raise storage_objects.StorageNotFound("Profile was not found.")
    return database._row_to_dict("users", conn.execute("SELECT * FROM users WHERE id = ?", [str(user_id)]).fetchone())


def _write_initial_settings(conn, user_id, settings):
    payload = {"id": str(user_id), **database._clean_payload(conn, "user_settings", settings),
               "user_id": str(user_id)}
    columns = ", ".join(f'"{column}"' for column in payload)
    placeholders = ", ".join("?" for _ in payload)
    conn.execute(
        f"INSERT INTO user_settings ({columns}) VALUES ({placeholders}) ON CONFLICT(user_id) DO NOTHING",
        list(payload.values()),
    )


@contextmanager
def _profile_transaction():
    # Identity-only OAuth writes remain available during the storage pause.
    # Every profile change still shares the account-deletion writer lock.
    try:
        with database.db_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            yield conn
    except sqlite3.Error as exc:
        raise storage_objects.StorageUnavailable("Unable to save the profile.") from exc


def _without_avatar_fields(row_data):
    return {key: value for key, value in row_data.items()
            if key != "picture_url" and not key.startswith("avatar_")}


def persist_avatar_user(user_id, row_data, *, prepared=None, create=False,
                        entitlements=None, avatar_change=False, provider_source_url=None,
                        initial_settings=None):
    """Lock the live profile and quota before publishing either backend's image.

    Remote creation happens before the writer; a failed or superseded profile
    change removes that uncommitted remote object after releasing the lock.
    """
    from services.entitlements import EntitlementError, assert_account_storage_active, check_storage_transaction

    row_data = dict(row_data)
    if prepared and (prepared.get("user_id") not in (None, str(user_id))
                     or row_data.get("avatar_file_id") != prepared["file_id"]
                     or row_data.get("picture_url") != prepared["view_url"]):
        raise storage_objects.StorageValidationError("Avatar upload does not match the profile.")
    provider_refresh = bool(provider_source_url and not avatar_change)
    uploaded_legacy_id = None
    legacy_upload_error = None
    if prepared or avatar_change or provider_refresh:
        try:
            storage_backend.require_mutations_enabled()
        except storage_objects.StorageMutationPaused:
            if not provider_refresh:
                raise
            prepared = None
            row_data = _without_avatar_fields(row_data)
    if prepared and prepared["backend"] == "appwrite":
        try:
            _upload_legacy(prepared)
            uploaded_legacy_id = prepared["file_id"]
        except AppwriteException as exc:
            if not provider_source_url:
                raise storage_objects.StorageUnavailable("Unable to save the avatar.") from exc
            legacy_upload_error = storage_objects.StorageUnavailable("Unable to copy the provider avatar.")
        except storage_objects.StorageMutationPaused:
            if not provider_refresh:
                raise
            prepared = None
            row_data = _without_avatar_fields(row_data)

    retired_legacy_ids = []
    try:
        with _profile_transaction() as conn:
            assert_account_storage_active(conn, str(user_id))
            previous = conn.execute("SELECT * FROM users WHERE id = ?", [str(user_id)]).fetchone()
            if not previous and not create:
                raise storage_objects.StorageUnavailable("This account is unavailable for uploads.")
            avatar_metadata_change = bool(previous and any(
                key in row_data and row_data[key] != previous[key]
                for key in ("picture_url", "avatar_file_id", "avatar_file_size_bytes", "avatar_source", "avatar_storage_backend")
            ))
            if prepared or avatar_change or provider_refresh or avatar_metadata_change:
                try:
                    storage_backend.require_mutations_enabled()
                except storage_objects.StorageMutationPaused:
                    if not provider_refresh:
                        raise
                    prepared = None
                    row_data = _without_avatar_fields(row_data)
            if previous and row_data.get("avatar_source") == "provider":
                # A manual choice made during the provider download wins the race.
                replaceable = previous["avatar_source"] == "provider" or (
                    not previous["picture_url"] and previous["avatar_source"] != "upload"
                )
                if not replaceable:
                    row_data = _without_avatar_fields(row_data)
                    prepared = None
            if prepared or avatar_change or avatar_metadata_change:
                remember_current_avatar_ownership(conn, str(user_id), previous)
            if prepared:
                replacing_bytes = avatar_replacement_credit(conn, str(user_id), previous, row_data)
                conn.execute("SAVEPOINT avatar_copy")
                try:
                    check_storage_transaction(conn, str(user_id), prepared["size_bytes"], replacing_bytes=replacing_bytes,
                                              entitlements=entitlements, allow_new_user=create)
                    if legacy_upload_error:
                        raise legacy_upload_error
                    if prepared["backend"] == "sqlite":
                        storage_objects.put_object(conn, prepared["payload"])
                    record_avatar_ownership(conn, str(user_id), prepared)
                except (EntitlementError, storage_objects.StorageError) as exc:
                    conn.execute("ROLLBACK TO avatar_copy")
                    if not provider_source_url or (avatar_change and isinstance(exc, storage_objects.StorageMutationPaused)):
                        raise
                    logger.exception("Provider avatar persistence failed; retaining previous or source URL")
                    row_data = _without_avatar_fields(row_data)
                    if (not previous or not previous["picture_url"]) and not isinstance(exc, storage_objects.StorageMutationPaused):
                        row_data.update({"picture_url": provider_source_url, "avatar_source": "provider",
                                         "avatar_file_id": None, "avatar_file_size_bytes": 0,
                                         "avatar_storage_backend": "appwrite"})
                    prepared = None
                finally:
                    conn.execute("RELEASE avatar_copy")
            user_doc = _write_user(conn, user_id, row_data, create=create)
            if initial_settings is not None:
                _write_initial_settings(conn, user_id, initial_settings)
            previous_id = previous["avatar_file_id"] if previous else None
            if previous_id and str(previous_id) not in avatar_identities(user_doc):
                previous_backend = previous["avatar_storage_backend"] or "appwrite"
                if retire_avatar(conn, previous_id, backend=previous_backend, account_user_id=str(user_id)):
                    if previous_backend == "appwrite":
                        retired_legacy_ids.append(str(previous_id))
    except Exception:
        if uploaded_legacy_id:
            _delete_legacy_avatar(uploaded_legacy_id, rollback=True)
        raise
    if uploaded_legacy_id and uploaded_legacy_id != user_doc.get("avatar_file_id"):
        _delete_legacy_avatar(uploaded_legacy_id, rollback=True)
    if retired_legacy_ids:
        _cleanup_retired_legacy_avatars(object_ids=retired_legacy_ids)
    return user_doc


def delete_legacy_avatar(file_id, *, rollback=False):
    """Delete a known legacy source, propagating failures to account cleanup."""
    if not rollback:
        storage_backend.require_mutations_enabled()
    try:
        Storage(appwrite_client).delete_file(PROFILE_AVATAR_BUCKET_ID, file_id)
    except AppwriteException as exc:
        if int(getattr(exc, "code", 0) or getattr(exc, "response_code", 0) or 0) != 404:
            raise storage_objects.StorageUnavailable("Unable to delete a legacy avatar.") from exc
    except Exception as exc:
        raise storage_objects.StorageUnavailable("Unable to delete a legacy avatar.") from exc


def _delete_legacy_avatar(file_id, *, rollback=False):
    try:
        if rollback:
            delete_legacy_avatar(file_id, rollback=True)
        else:
            delete_legacy_avatar(file_id)
    except storage_objects.StorageError:
        logger.exception("Failed to delete old avatar file")


def cleanup_legacy_avatars(*, account_user_id=None, object_ids=None):
    """Drain only scoped avatar retirements, guarding references before I/O."""
    def delete_unreferenced(bucket_id, file_id):
        if bucket_id != PROFILE_AVATAR_BUCKET_ID:
            raise storage_objects.StorageUnavailable("Legacy avatar bucket identity is invalid.")
        with database.db_connection() as conn:
            if _avatar_referenced(conn, file_id):
                raise storage_objects.StorageUnavailable("This avatar still has active references.")
        delete_legacy_avatar(file_id)
        # The durable queue marker still blocks profile/message publication.
        # Remove attribution only after the remote deletion is confirmed.
        with storage_objects.write_transaction() as conn:
            if _avatar_referenced(conn, file_id):
                raise storage_objects.StorageUnavailable("This avatar still has active references.")
            storage_objects.delete_object(conn, AVATAR_NAMESPACE, file_id)
            conn.execute("DELETE FROM storage_avatar_ownership WHERE object_id = ?", [file_id])

    return drain_legacy_deletions(
        AVATAR_NAMESPACE, delete_unreferenced,
        account_user_id=account_user_id, object_ids=object_ids,
    )


def _cleanup_retired_legacy_avatars(**scope):
    try:
        return cleanup_legacy_avatars(**scope)
    except storage_objects.StorageError:
        logger.exception("Legacy avatar cleanup deferred")
        return None


def delete_avatar_file(file_id, *, backend="appwrite", account_user_id=None):
    """Retire known copies only when no user or historical message needs them."""
    if not file_id:
        return
    storage_backend.require_mutations_enabled()
    with storage_objects.write_transaction() as conn:
        storage_backend.require_mutations_enabled()
        retired = retire_avatar(conn, str(file_id), backend=backend, account_user_id=account_user_id)
    if retired and backend == "appwrite":
        _cleanup_retired_legacy_avatars(object_ids=[str(file_id)])


def store_avatar_from_url(user_id, source_url, *, timeout=8, max_bytes=MAX_AVATAR_BYTES):
    """Best-effort adapter that publishes only an owned, committed avatar."""
    prepared = prepare_avatar_from_url(user_id, source_url, timeout=timeout, max_bytes=max_bytes)
    if not prepared:
        return None
    try:
        saved = persist_avatar_user(
            str(user_id), avatar_profile_fields(prepared), prepared=prepared,
            provider_source_url=source_url,
        )
    except storage_objects.StorageError:
        logger.exception("Failed to store provider avatar")
        return None
    if saved.get("avatar_file_id") != prepared["file_id"]:
        return None
    return {key: prepared[key] for key in ("file_id", "view_url", "size_bytes")}


def read_avatar(file_id):
    """Use local bytes when known; only explicit legacy identities permit fallback."""
    try:
        metadata = storage_objects.object_metadata(AVATAR_NAMESPACE, str(file_id))
    except storage_objects.StorageNotFound:
        metadata = None
    if metadata:
        data = storage_objects.read_object(AVATAR_NAMESPACE, str(file_id))
        try:
            mime_type = inspect_avatar(data, metadata["mime_type"])
        except storage_objects.StorageValidationError as exc:
            raise storage_objects.StorageIntegrityError("The stored avatar is not a valid image.") from exc
        return data, mime_type, metadata
    with database.db_connection() as conn:
        ownership = conn.execute(
            "SELECT storage_backend, size_bytes FROM storage_avatar_ownership WHERE object_id = ?",
            [str(file_id)],
        ).fetchone()
        candidates = conn.execute("SELECT avatar_file_id, picture_url, avatar_storage_backend, avatar_file_size_bytes FROM users WHERE avatar_file_id = ? OR picture_url IS NOT NULL", [str(file_id)]).fetchall()
        users = [row for row in candidates if row["avatar_file_id"] == str(file_id)
                 or legacy_avatar_id(row["picture_url"]) == str(file_id) or local_avatar_id(row["picture_url"]) == str(file_id)]
        if (ownership and ownership["storage_backend"] == "sqlite") or any(row["avatar_storage_backend"] == "sqlite" for row in users):
            raise storage_objects.StorageNotFound("Avatar was not found.")
        legacy = bool(ownership and ownership["storage_backend"] == "appwrite" and _avatar_referenced(conn, str(file_id)))
        legacy = legacy or any(row["avatar_storage_backend"] == "appwrite" and (
            row["avatar_file_id"] == str(file_id) or legacy_avatar_id(row["picture_url"]) == str(file_id)
        ) for row in users)
        if not legacy:
            for column in database.table_columns(conn, "chat_messages") & {"author_avatar_url", "author_picture_url"}:
                for row in conn.execute(f'SELECT DISTINCT "{column}" FROM chat_messages WHERE "{column}" IS NOT NULL'):
                    if legacy_avatar_id(row[0]) == str(file_id):
                        legacy = True
                        break
                if legacy:
                    break
    if not legacy:
        raise storage_objects.StorageNotFound("Avatar was not found.")
    storage_backend.require_legacy_reads()
    from services.storage_legacy_transport import read_legacy_file

    expected_sizes = {int(row["avatar_file_size_bytes"] or 0) for row in users if row["avatar_file_size_bytes"]}
    if ownership:
        expected_sizes.add(int(ownership["size_bytes"]))
    if len(expected_sizes) > 1:
        raise storage_objects.StorageIntegrityError("Legacy avatar size records disagree.")
    data = read_legacy_file(PROFILE_AVATAR_BUCKET_ID, str(file_id), max_bytes=MAX_AVATAR_BYTES,
                            expected_bytes=next(iter(expected_sizes), None))
    return data, inspect_avatar(data), None
