"""Authenticate a destination before locking; recheck the same bytes at commit."""

from __future__ import annotations

import hashlib
from contextlib import closing
from dataclasses import dataclass

from services import storage_objects
from services.storage_crypto import decrypt_payload

from .references import readonly_connection
from .source import MigrationError


@dataclass(frozen=True)
class DestinationFingerprint:
    metadata: tuple
    ciphertext_sha256: str


def _metadata_fingerprint(metadata):
    return tuple(sorted(metadata.items()))


def verified_fingerprint(path, namespace, object_id, *, expected):
    """One read snapshot supplies the checked metadata and bounded ciphertext."""
    with closing(readonly_connection(path)) as conn:
        conn.execute("BEGIN")
        metadata = storage_objects.object_metadata(namespace, object_id, conn=conn)
        ciphertext = storage_objects._read_ciphertext(conn, metadata)
    ciphertext_sha256 = hashlib.sha256(ciphertext).hexdigest()
    data = decrypt_payload(
        ciphertext, namespace=namespace, object_id=object_id, mime_type=metadata["mime_type"],
        byte_length=metadata["byte_length"], encryption_key_id=metadata["encryption_key_id"],
        nonce=metadata["nonce"], format_version=metadata["format_version"],
    )
    fingerprint = len(data), hashlib.sha256(data).hexdigest()
    if fingerprint != (metadata["byte_length"], metadata["sha256"]) or fingerprint != expected:
        raise MigrationError("Decrypted destination differs from its verified source; no overwrite performed.")
    return DestinationFingerprint(_metadata_fingerprint(metadata), ciphertext_sha256)


def _ciphertext_sha256(conn, metadata):
    """Hash in bounded chunks while holding the writer, without decrypting."""
    expected = metadata["ciphertext_length"]
    digest = hashlib.sha256()
    if hasattr(conn, "blobopen"):
        with conn.blobopen("storage_objects", "payload", metadata["id"], readonly=True) as blob:
            if len(blob) != expected:
                raise MigrationError("Destination payload length changed before commit.")
            for offset in range(0, expected, 64 * 1024):
                chunk = blob.read(min(64 * 1024, expected - offset))
                if len(chunk) != min(64 * 1024, expected - offset):
                    raise MigrationError("Destination payload changed before commit.")
                digest.update(chunk)
    else:
        for offset in range(0, expected, 64 * 1024):
            length = min(64 * 1024, expected - offset)
            row = conn.execute("SELECT substr(payload,?,?) FROM storage_objects WHERE id=?",
                               (offset + 1, length, metadata["id"])).fetchone()
            if row is None or not isinstance(row[0], bytes) or len(row[0]) != length:
                raise MigrationError("Destination payload changed before commit.")
            digest.update(row[0])
    return digest.hexdigest()


def require_unchanged(conn, namespace, object_id, verified):
    metadata = storage_objects.object_metadata(namespace, object_id, conn=conn)
    if (_metadata_fingerprint(metadata) != verified.metadata
            or _ciphertext_sha256(conn, metadata) != verified.ciphertext_sha256):
        raise MigrationError("A verified destination changed before commit; rerun verification.")
    return metadata
