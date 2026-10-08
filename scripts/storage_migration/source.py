"""Read-only, bounded Appwrite Storage transport and source identities."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import parse_qs, quote, unquote, urlsplit

import requests
from appwrite.query import Query

MAX_BYTES = 50 * 1024 * 1024
NAMESPACE_LIMITS = {
    "avatars": 10 * 1024 * 1024,
    "shared_files": MAX_BYTES,
    "note_media": 10 * 1024 * 1024,
    "chat_attachments": MAX_BYTES,
}


class MigrationError(RuntimeError):
    """An import cannot safely proceed; messages never contain remote bodies."""


@dataclass(frozen=True)
class SourceConfig:
    endpoint: str
    project_id: str
    buckets: dict[str, str]

    def __post_init__(self):
        endpoint = urlsplit(self.endpoint)
        if endpoint.scheme not in {"https", "http"} or not endpoint.netloc:
            raise MigrationError("A valid configured Appwrite endpoint is required.")
        if endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise MigrationError("The Appwrite endpoint must not contain credentials or a query.")
        if not self.project_id or set(self.buckets) != set(NAMESPACE_LIMITS):
            raise MigrationError("Configure the project and all four storage buckets.")
        if any(not value for value in self.buckets.values()):
            raise MigrationError("All four bucket IDs are required for a complete inventory.")
        if len(set(self.buckets.values())) != len(self.buckets):
            raise MigrationError("Storage namespaces must use distinct source buckets.")
        object.__setattr__(self, "endpoint", self.endpoint.rstrip("/"))

    def file_url(self, bucket: str, file_id: str) -> str:
        return (
            f"{self.endpoint}/storage/buckets/{quote(bucket, safe='')}/files/"
            f"{quote(file_id, safe='')}/view?project={quote(self.project_id, safe='')}"
        )

    def parse_file_url(self, value: str | None) -> tuple[str, str] | None:
        """Accept exactly this origin/API path/project, with one project parameter."""
        if not value or not isinstance(value, str):
            return None
        try:
            parsed, endpoint = urlsplit(value), urlsplit(self.endpoint)
        except ValueError:
            return None
        if (parsed.scheme.lower(), parsed.netloc.lower()) != (endpoint.scheme.lower(), endpoint.netloc.lower()):
            return None
        if parsed.username or parsed.password or parsed.fragment:
            return None
        prefix = endpoint.path.rstrip("/") + "/storage/buckets/"
        if not parsed.path.startswith(prefix):
            return None
        parts = parsed.path[len(prefix):].split("/")
        if len(parts) != 4 or parts[1] != "files" or parts[3] not in {"view", "download", "preview"}:
            return None
        bucket, file_id = unquote(parts[0]), unquote(parts[2])
        if not bucket or not file_id or "/" in bucket or "/" in file_id:
            return None
        if bucket not in self.buckets.values():
            return None
        if parse_qs(parsed.query, keep_blank_values=True).get("project") != [self.project_id]:
            return None
        return bucket, file_id


@dataclass(frozen=True)
class SourceObject:
    namespace: str
    bucket_id: str
    file_id: str
    filename: str
    mime_type: str
    byte_length: int
    created_at: str | None = None
    updated_at: str | None = None


class AppwriteSource:
    """Never uses the SDK's unbounded download helper or follows redirects."""

    def __init__(self, config: SourceConfig, api_key: str, *, session=None):
        if not api_key:
            raise MigrationError("APPWRITE_API_KEY is required for source reads.")
        self.config = config
        self.session = session or requests.Session()
        self.headers = {"X-Appwrite-Project": config.project_id, "X-Appwrite-Key": api_key}

    def _get(self, path, **kwargs):
        try:
            response = self.session.get(
                self.config.endpoint + path, headers=self.headers, timeout=(10, 90),
                allow_redirects=False, **kwargs,
            )
        except requests.RequestException as exc:
            raise MigrationError("Source request failed; check transport and configuration.") from exc
        if response.status_code != 200:
            response.close()
            raise MigrationError(f"Source request returned HTTP {response.status_code}.")
        return response

    def inventory(self):
        for namespace, bucket in self.config.buckets.items():
            cursor = None
            seen = set()
            while True:
                queries = [Query.limit(100), Query.order_asc("$id")]
                if cursor:
                    queries.append(Query.cursor_after(cursor))
                path = f"/storage/buckets/{quote(bucket, safe='')}/files"
                with self._get(path, params={"queries[]": queries}) as response:
                    try:
                        rows = response.json()["files"]
                    except (ValueError, KeyError, TypeError) as exc:
                        raise MigrationError("Source inventory response is malformed.") from exc
                if not isinstance(rows, list):
                    raise MigrationError("Source inventory files must be a list.")
                for row in rows:
                    try:
                        file_id = str(row["$id"])
                        length = int(row["sizeOriginal"])
                    except (KeyError, ValueError, TypeError) as exc:
                        raise MigrationError("Source object metadata is malformed.") from exc
                    if not file_id or file_id in seen or length < 0:
                        raise MigrationError("Source inventory did not progress consistently.")
                    seen.add(file_id)
                    yield SourceObject(namespace, bucket, file_id,
                                       str(row.get("name") or file_id),
                                       str(row.get("mimeType") or "application/octet-stream"),
                                       length, row.get("$createdAt"), row.get("$updatedAt"))
                if not rows:
                    break
                cursor = str(rows[-1]["$id"])

    def download(self, obj: SourceObject) -> bytes:
        limit = NAMESPACE_LIMITS[obj.namespace]
        if obj.byte_length > limit:
            raise MigrationError("Source object exceeds its namespace size limit.")
        path = (f"/storage/buckets/{quote(obj.bucket_id, safe='')}/files/"
                f"{quote(obj.file_id, safe='')}/download")
        data = bytearray()
        with self._get(path, stream=True) as response:
            response.raw.decode_content = False
            # Raw reads avoid allocating an unbounded decompressed HTTP body.
            while chunk := response.raw.read(min(64 * 1024, limit + 1 - len(data))):
                data.extend(chunk)
                if len(data) > limit:
                    raise MigrationError("Source download exceeds its namespace size limit.")
        if len(data) != obj.byte_length:
            raise MigrationError("Source download length differs from refreshed metadata.")
        return bytes(data)
