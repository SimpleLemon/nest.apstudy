"""AES-256-GCM payload encryption with separately managed upload key material."""

import base64
import binascii
import json
import os
import re
import stat
from dataclasses import dataclass
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from services.storage_backend import storage_setting
from services.storage_errors import StorageIntegrityError, StorageUnavailable


FORMAT_VERSION = 1
NONCE_BYTES = 12
TAG_BYTES = 16
KEY_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
_MAX_KEYRING_BYTES = 65536


@dataclass(frozen=True, slots=True)
class EncryptedPayload:
    encryption_key_id: str
    nonce: bytes
    payload: bytes


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate keyring field")
        result[name] = value
    return result


def load_keyring() -> tuple[str, dict[str, bytes]]:
    """Read a bounded, protected file; never generate a replacement key."""
    path = storage_setting("NEST_UPLOAD_KEYRING_PATH")
    if not path:
        raise StorageUnavailable("Upload encryption is not configured.")
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)
        descriptor = os.open(os.path.expanduser(os.fspath(path)), flags)
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            # 0600 and 0640 permit an operator/app group to share the keyring.
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o037:
                raise ValueError("Unprotected keyring")
            raw = handle.read(_MAX_KEYRING_BYTES + 1)
        if len(raw) > _MAX_KEYRING_BYTES:
            raise ValueError("Oversized keyring")
        document = json.loads(raw, object_pairs_hook=_unique_json_object)
        if not isinstance(document, dict) or set(document) != {"active_key_id", "keys"}:
            raise ValueError("Invalid keyring schema")
        active = document["active_key_id"]
        encoded_keys = document["keys"]
        if not isinstance(active, str) or not KEY_ID_PATTERN.fullmatch(active):
            raise ValueError("Invalid active key ID")
        if not isinstance(encoded_keys, dict) or not 1 <= len(encoded_keys) <= 128:
            raise ValueError("Invalid key map")
        keys = {}
        for key_id, encoded in encoded_keys.items():
            if not isinstance(key_id, str) or not KEY_ID_PATTERN.fullmatch(key_id) or not isinstance(encoded, str):
                raise ValueError("Invalid key entry")
            decoded = base64.b64decode(encoded, validate=True)
            if len(decoded) != 32:
                raise ValueError("Upload keys must contain 256 bits")
            keys[key_id] = decoded
        if active not in keys:
            raise ValueError("Missing active upload key")
        return active, keys
    except (OSError, TypeError, ValueError, binascii.Error):
        raise StorageUnavailable("Upload encryption keys are unavailable.") from None


def associated_data(
    namespace: str, object_id: str, mime_type: str, byte_length: int,
    *, format_version: int = FORMAT_VERSION,
) -> bytes:
    """Canonical format: every routing and decoding identity is authenticated."""
    return json.dumps(
        {"namespace": namespace, "object_id": object_id, "format_version": format_version,
         "mime_type": mime_type, "byte_length": byte_length},
        sort_keys=True, separators=(",", ":"), ensure_ascii=True,
    ).encode("ascii")


def encrypt_payload(data: bytes, *, namespace: str, object_id: str, mime_type: str) -> EncryptedPayload:
    active, keys = load_keyring()
    nonce = os.urandom(NONCE_BYTES)
    aad = associated_data(namespace, object_id, mime_type, len(data))
    payload = AESGCM(keys[active]).encrypt(nonce, data, aad)
    return EncryptedPayload(active, nonce, payload)


def decrypt_payload(
    payload: bytes, *, namespace: str, object_id: str, mime_type: str, byte_length: int,
    encryption_key_id: str, nonce: bytes, format_version: int = FORMAT_VERSION,
) -> bytes:
    if format_version != FORMAT_VERSION:
        raise StorageIntegrityError("Stored upload format is unsupported.")
    _, keys = load_keyring()
    key = keys.get(encryption_key_id)
    if key is None:
        raise StorageUnavailable("The encryption key for this upload is unavailable.")
    aad = associated_data(namespace, object_id, mime_type, byte_length, format_version=format_version)
    try:
        return AESGCM(key).decrypt(nonce, payload, aad)
    except (InvalidTag, TypeError, ValueError):
        raise StorageIntegrityError("Stored upload authentication failed.") from None
