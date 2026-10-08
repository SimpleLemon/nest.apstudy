"""Bounded encrypted upload objects in the application's SQLite database.

Prepare outside the writer lock, then recheck quota and insert feature rows in
the same ``write_transaction`` as ``put_object``. Reads release their SQLite
snapshot before decrypting or handing any bytes to an HTTP response.
"""

import hashlib
import hmac
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from os import PathLike
from typing import Any, Iterator

from services import database
from services.storage_backend import require_mutations_enabled
from services.storage_crypto import (
    FORMAT_VERSION, KEY_ID_PATTERN, NONCE_BYTES, TAG_BYTES, decrypt_payload, encrypt_payload,
)
from services.storage_errors import (
    StorageError, StorageIntegrityError, StorageMutationPaused, StorageNotFound,
    StorageUnavailable, StorageValidationError,
)
from services.storage_scanner import scan_upload
from services.time_utils import utcnow_iso


NAMESPACES = frozenset({"avatars", "shared_files", "note_media", "chat_attachments"})
MAX_OBJECT_BYTES = 50 * 1024 * 1024
_OBJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_MIME_TYPE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_METADATA_COLUMNS = (
    "id, namespace, object_id, original_filename, mime_type, byte_length, sha256, "
    "format_version, encryption_key_id, nonce, created_at, updated_at, "
    "length(payload) AS ciphertext_length, typeof(payload) AS ciphertext_type"
)


@dataclass(frozen=True, slots=True)
class PreparedObject:
    namespace: str
    object_id: str
    original_filename: str
    mime_type: str
    byte_length: int
    sha256: str
    format_version: int
    encryption_key_id: str
    nonce: bytes
    payload: bytes
    created_at: str


def _identity(namespace: str, object_id: str) -> None:
    if not isinstance(namespace, str) or namespace not in NAMESPACES:
        raise StorageValidationError("Invalid upload namespace.")
    if not isinstance(object_id, str) or not _OBJECT_ID.fullmatch(object_id):
        raise StorageValidationError("Invalid upload object ID.")


def _text(value: str, limit: int, label: str) -> None:
    if not isinstance(value, str) or not 1 <= len(value) <= limit or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise StorageValidationError(f"Invalid upload {label}.")


def _upload_metadata(namespace: str, object_id: str, filename: str, mime_type: str) -> None:
    _identity(namespace, object_id)
    _text(filename, 1024, "filename")
    _text(mime_type, 255, "MIME type")
    if not _MIME_TYPE.fullmatch(mime_type):
        raise StorageValidationError("Invalid upload MIME type.")


def _bytes(value: bytes | bytearray | memoryview, *, label: str = "content") -> bytes:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise StorageValidationError(f"Upload {label} must be bytes.")
    if memoryview(value).nbytes > MAX_OBJECT_BYTES:
        raise StorageValidationError("Upload exceeds the 50 MiB storage limit.")
    return bytes(value)


def prepare_object(
    namespace: str, object_id: str, data: bytes | bytearray | memoryview, *,
    filename: str, mime_type: str, scan_data: bytes | bytearray | memoryview | None = None,
) -> PreparedObject:
    """Validate, scan original bytes, hash stored bytes, and encrypt before lock."""
    require_mutations_enabled()
    _upload_metadata(namespace, object_id, filename, mime_type)
    data = _bytes(data)
    original = data if scan_data is None else _bytes(scan_data, label="scan content")
    scan_upload(original)
    encrypted = encrypt_payload(data, namespace=namespace, object_id=object_id, mime_type=mime_type)
    return PreparedObject(
        namespace, object_id, filename, mime_type, len(data), hashlib.sha256(data).hexdigest(),
        FORMAT_VERSION, encrypted.encryption_key_id, encrypted.nonce, encrypted.payload, utcnow_iso(),
    )


def _active_transaction(conn: sqlite3.Connection) -> None:
    if not isinstance(conn, sqlite3.Connection) or not conn.in_transaction:
        raise StorageValidationError("Upload changes require an active SQLite transaction.")


@contextmanager
def write_transaction(*, path: str | PathLike[str] | None = None) -> Iterator[sqlite3.Connection]:
    """Acquire the writer before quota checks; commit feature and object together."""
    require_mutations_enabled()
    conn = None
    try:
        conn = database.connect(path)
        conn.execute("BEGIN IMMEDIATE")
        require_mutations_enabled()
        yield conn
        conn.commit()
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
    finally:
        if conn is not None:
            if conn.in_transaction:
                conn.rollback()
            conn.close()


def put_object(conn: sqlite3.Connection, prepared: PreparedObject) -> dict[str, Any]:
    """Insert one immutable identity; never replace an existing object's bytes."""
    require_mutations_enabled()
    _active_transaction(conn)
    if not isinstance(prepared, PreparedObject):
        raise StorageValidationError("Upload was not prepared for storage.")
    _upload_metadata(prepared.namespace, prepared.object_id, prepared.original_filename, prepared.mime_type)
    if (isinstance(prepared.byte_length, bool) or not isinstance(prepared.byte_length, int)
            or not 0 <= prepared.byte_length <= MAX_OBJECT_BYTES
            or prepared.format_version != FORMAT_VERSION
            or not isinstance(prepared.sha256, str) or not _SHA256.fullmatch(prepared.sha256)
            or not isinstance(prepared.encryption_key_id, str) or not KEY_ID_PATTERN.fullmatch(prepared.encryption_key_id)
            or not isinstance(prepared.nonce, bytes) or len(prepared.nonce) != NONCE_BYTES
            or not isinstance(prepared.payload, bytes) or len(prepared.payload) != prepared.byte_length + TAG_BYTES):
        raise StorageValidationError("Prepared upload metadata is invalid.")
    try:
        conn.execute(
            "INSERT INTO storage_objects (namespace, object_id, original_filename, mime_type, "
            "byte_length, sha256, format_version, encryption_key_id, nonce, payload, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (prepared.namespace, prepared.object_id, prepared.original_filename, prepared.mime_type,
             prepared.byte_length, prepared.sha256, prepared.format_version, prepared.encryption_key_id,
             prepared.nonce, prepared.payload, prepared.created_at, prepared.created_at),
        )
    except sqlite3.IntegrityError:
        raise StorageIntegrityError("An upload already exists under this object ID or violates storage constraints.") from None
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
    return object_metadata(prepared.namespace, prepared.object_id, conn=conn)


def _checked_metadata(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    try:
        _upload_metadata(result["namespace"], result["object_id"], result["original_filename"], result["mime_type"])
        length = result["byte_length"]
        valid = (isinstance(length, int) and 0 <= length <= MAX_OBJECT_BYTES
                 and result["format_version"] == FORMAT_VERSION
                 and isinstance(result["sha256"], str) and bool(_SHA256.fullmatch(result["sha256"]))
                 and isinstance(result["encryption_key_id"], str) and bool(KEY_ID_PATTERN.fullmatch(result["encryption_key_id"]))
                 and isinstance(result["nonce"], bytes) and len(result["nonce"]) == NONCE_BYTES
                 and result["ciphertext_type"] == "blob" and result["ciphertext_length"] == length + TAG_BYTES)
        if not valid:
            raise StorageValidationError("Invalid object metadata")
    except (StorageValidationError, KeyError, TypeError):
        raise StorageIntegrityError("Stored upload metadata is invalid.") from None
    result.pop("ciphertext_type")
    return result


def object_metadata(
    namespace: str, object_id: str, *, conn: sqlite3.Connection | None = None,
    path: str | PathLike[str] | None = None,
) -> dict[str, Any]:
    """Select bounded metadata only; callers may share their feature transaction."""
    _identity(namespace, object_id)
    owned = conn is None
    try:
        if conn is None:
            conn = database.connect(path)
        row = conn.execute(
            f"SELECT {_METADATA_COLUMNS} FROM storage_objects WHERE namespace = ? AND object_id = ?",
            (namespace, object_id),
        ).fetchone()
        if row is None:
            raise StorageNotFound("Upload was not found.")
        return _checked_metadata(row)
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
    finally:
        if owned and conn is not None:
            conn.close()


def _read_ciphertext(conn: sqlite3.Connection, metadata: dict[str, Any]) -> bytes:
    expected = metadata["byte_length"] + TAG_BYTES
    if hasattr(conn, "blobopen"):
        with conn.blobopen("storage_objects", "payload", metadata["id"], readonly=True) as blob:
            if len(blob) != expected:
                raise StorageIntegrityError("Stored upload length is invalid.")
            return blob.read(expected)
    # Older supported Python runtimes still cannot allocate an unbounded BLOB.
    row = conn.execute("SELECT substr(payload, 1, ?) FROM storage_objects WHERE id = ?",
                       (expected, metadata["id"])).fetchone()
    if row is None or not isinstance(row[0], bytes) or len(row[0]) != expected:
        raise StorageIntegrityError("Stored upload length is invalid.")
    return row[0]


def read_object(
    namespace: str, object_id: str, *, path: str | PathLike[str] | None = None,
) -> bytes:
    """Read one bounded encrypted payload, close its snapshot, then authenticate."""
    _identity(namespace, object_id)
    conn = None
    try:
        conn = database.connect(path)
        conn.execute("BEGIN")
        metadata = object_metadata(namespace, object_id, conn=conn)
        payload = _read_ciphertext(conn, metadata)
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
    finally:
        if conn is not None:
            if conn.in_transaction:
                conn.rollback()
            conn.close()
    data = decrypt_payload(
        payload, namespace=namespace, object_id=object_id, mime_type=metadata["mime_type"],
        byte_length=metadata["byte_length"], encryption_key_id=metadata["encryption_key_id"],
        nonce=metadata["nonce"], format_version=metadata["format_version"],
    )
    if len(data) != metadata["byte_length"] or not hmac.compare_digest(hashlib.sha256(data).hexdigest(), metadata["sha256"]):
        raise StorageIntegrityError("Stored upload content failed verification.")
    return data


def delete_object(conn: sqlite3.Connection, namespace: str, object_id: str) -> bool:
    """Delete in the feature transaction; missing objects are already deleted."""
    require_mutations_enabled()
    _active_transaction(conn)
    _identity(namespace, object_id)
    try:
        # The source mapping must survive intentional cleanup while bulk copy
        # is running. Reconciliation can distinguish this from unexplained
        # source loss without discarding a checksum or its rollback history.
        conn.execute(
            "UPDATE storage_migration_manifest SET status='removed', "
            "error='Intentional local storage deletion', updated_at=? "
            "WHERE namespace=? AND object_id=? AND status<>'missing'",
            (utcnow_iso(), namespace, object_id),
        )
        cursor = conn.execute("DELETE FROM storage_objects WHERE namespace = ? AND object_id = ?", (namespace, object_id))
        if namespace == "avatars":
            conn.execute(
                "DELETE FROM storage_avatar_ownership WHERE object_id=? AND NOT EXISTS "
                "(SELECT 1 FROM storage_legacy_deletions WHERE namespace='avatars' AND object_id=?)",
                (object_id, object_id),
            )
        return cursor.rowcount > 0
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
