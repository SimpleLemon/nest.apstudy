"""Bounded compatibility downloads; feature authorization belongs to callers."""

from urllib.parse import quote, urlsplit

import requests
from urllib3.exceptions import HTTPError as TransportHTTPError

from services.environment_config import runtime_environment_config
from services.storage_backend import require_legacy_reads
from services.storage_errors import StorageIntegrityError, StorageNotFound, StorageUnavailable


MAX_LEGACY_BYTES = 50 * 1024 * 1024


def read_legacy_file(bucket_id, object_id, *, max_bytes, expected_bytes=None):
    """Read only explicitly legacy bytes and refuse redirects or oversized data."""
    require_legacy_reads()
    if not isinstance(max_bytes, int) or not 0 < max_bytes <= MAX_LEGACY_BYTES:
        raise StorageIntegrityError("The legacy upload limit is invalid.")
    if expected_bytes is not None:
        try:
            expected_bytes = int(expected_bytes)
        except (TypeError, ValueError):
            raise StorageIntegrityError("The legacy upload length is invalid.") from None
        if not 0 <= expected_bytes <= max_bytes:
            raise StorageIntegrityError("The legacy upload exceeds its size limit.")
    configured = runtime_environment_config()
    endpoint = str(configured.appwrite_endpoint or "").rstrip("/")
    try:
        parsed = urlsplit(endpoint)
    except ValueError:
        raise StorageUnavailable("Legacy upload storage is not configured.") from None
    if (parsed.scheme not in {"https", "http"} or not parsed.netloc
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or not configured.appwrite_project_id or not configured.appwrite_api_key
            or not bucket_id or not object_id):
        raise StorageUnavailable("Legacy upload storage is not configured.")
    url = (f"{endpoint}/storage/buckets/{quote(str(bucket_id), safe='')}/files/"
           f"{quote(str(object_id), safe='')}/download")
    headers = {"X-Appwrite-Project": configured.appwrite_project_id,
               "X-Appwrite-Key": configured.appwrite_api_key, "Accept-Encoding": "identity"}
    try:
        with requests.get(url, headers=headers, stream=True, timeout=(10, 90), allow_redirects=False) as response:
            if response.status_code == 404:
                raise StorageNotFound("Legacy upload was not found.")
            if response.status_code != 200:
                raise StorageUnavailable("Legacy upload storage is unavailable.")
            content_encoding = response.headers.get("Content-Encoding", "identity").strip().lower()
            if content_encoding not in {"", "identity"}:
                raise StorageIntegrityError("Legacy upload transport encoding is unsupported.")
            declared_length = None
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    declared_length = int(content_length)
                except (TypeError, ValueError):
                    raise StorageIntegrityError("Legacy upload transport length is invalid.") from None
                if not 0 <= declared_length <= max_bytes:
                    raise StorageIntegrityError("Legacy upload exceeds its size limit.")
                if expected_bytes is not None and declared_length != expected_bytes:
                    raise StorageIntegrityError("Legacy upload length differs from its metadata.")
            response.raw.decode_content = False
            data = bytearray()
            while chunk := response.raw.read(min(64 * 1024, max_bytes + 1 - len(data))):
                data.extend(chunk)
                if len(data) > max_bytes:
                    raise StorageIntegrityError("Legacy upload exceeds its size limit.")
            if expected_bytes is not None and len(data) != expected_bytes:
                raise StorageIntegrityError("Legacy upload length differs from its metadata.")
            if declared_length is not None and len(data) != declared_length:
                raise StorageIntegrityError("Legacy upload length differs from its transport metadata.")
            return bytes(data)
    except (requests.RequestException, TransportHTTPError, OSError):
        raise StorageUnavailable("Legacy upload storage is unavailable.") from None
