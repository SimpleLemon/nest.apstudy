"""Metadata references and bounded original-content reconstruction for scanning."""

from __future__ import annotations

import gzip
import hashlib
import io
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path

from .source import MAX_BYTES, MigrationError, SourceConfig, SourceObject


def readonly_connection(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def table_columns(conn, table):
    return {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}


@dataclass(frozen=True)
class Reference:
    namespace: str
    bucket_id: str
    file_id: str
    table: str
    row_id: str
    column: str
    row: dict


def collect_references(conn, config: SourceConfig) -> list[Reference]:
    references = []
    imported = set()
    if table_columns(conn, "storage_migration_manifest"):
        imported = {tuple(row) for row in conn.execute(
            "SELECT source_bucket_id,source_file_id FROM storage_migration_manifest "
            "WHERE source_endpoint=? AND source_project_id=? AND status<>'missing'",
            (config.endpoint, config.project_id),
        )}

    def append(namespace, bucket, file_id, table, row, column):
        if file_id and bucket == config.buckets[namespace]:
            references.append(Reference(namespace, bucket, str(file_id), table,
                                        str(row["id"]), column, row))

    if table_columns(conn, "users"):
        columns = table_columns(conn, "users")
        selected = [name for name in ("id", "avatar_file_id", "picture_url", "avatar_storage_backend") if name in columns]
        for row in conn.execute("SELECT " + ",".join(selected) + " FROM users"):
            row = dict(row)
            avatar_id = row.get("avatar_file_id")
            if (row.get("avatar_storage_backend", "appwrite") != "sqlite"
                    or (config.buckets["avatars"], avatar_id) in imported):
                append("avatars", config.buckets["avatars"], avatar_id, "users", row, "avatar_file_id")
            identity = config.parse_file_url(row.get("picture_url"))
            if identity and identity[0] == config.buckets["avatars"]:
                append("avatars", *identity, "users", row, "picture_url")
    message_columns = table_columns(conn, "chat_messages")
    avatar_columns = sorted(message_columns & {"author_avatar_url", "author_picture_url"})
    if avatar_columns:
        selected = ["id", *(["user_id"] if "user_id" in message_columns else []), *avatar_columns]
        for row in conn.execute("SELECT " + ",".join(selected) + " FROM chat_messages"):
            row = dict(row)
            for column in avatar_columns:
                identity = config.parse_file_url(row[column])
                if identity and identity[0] == config.buckets["avatars"]:
                    append("avatars", *identity, "chat_messages", row, column)
    for table, namespace in (("shared_files", "shared_files"), ("note_media", "note_media"),
                             ("chat_attachments", "chat_attachments")):
        columns = table_columns(conn, table)
        if not columns:
            continue
        names = [name for name in ("id", "storage_file_id", "storage_bucket_id", "storage_backend",
                                  "preview_file_id", "compression_encoding", "content_encoding",
                                  "original_size_bytes", "sha256") if name in columns]
        for row in conn.execute("SELECT " + ",".join(names) + f" FROM {table}"):
            row = dict(row)
            bucket = row.get("storage_bucket_id")
            if not bucket and row.get("storage_backend", "appwrite") == "appwrite":
                bucket = config.buckets[namespace]
            append(namespace, bucket, row.get("storage_file_id"), table, row, "storage_file_id")
            if table == "chat_attachments":
                append(namespace, bucket, row.get("preview_file_id"), table, row, "preview_file_id")
    return references


def reference_index(path, config):
    with closing(readonly_connection(path)) as conn:
        references = collect_references(conn, config)
    indexed = {}
    for reference in references:
        indexed.setdefault((reference.bucket_id, reference.file_id), []).append(reference)
    return indexed


def scan_content(obj: SourceObject, stored: bytes, references: list[Reference]) -> bytes:
    """Storage hashes refer to stored bytes; attachment hashes refer to original input."""
    if obj.namespace != "chat_attachments":
        return stored
    main_refs = [ref for ref in references if ref.column == "storage_file_id"]
    encodings = {ref.row.get("content_encoding") or ref.row.get("compression_encoding") or "identity"
                 for ref in main_refs}
    if len(encodings) > 1:
        raise MigrationError("Conflicting attachment content encodings need reconciliation.")
    encoding = next(iter(encodings), "identity")
    if not main_refs and stored.startswith(b"\x1f\x8b"):
        # Orphaned gzip objects have no row explaining their representation.
        encoding = "gzip"
    if encoding not in {"identity", "gzip"}:
        raise MigrationError("Unsupported attachment content encoding.")
    if encoding == "identity":
        return stored
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(stored)) as compressed:
            original = compressed.read(MAX_BYTES + 1)
    except (OSError, EOFError) as exc:
        raise MigrationError("Stored gzip attachment is malformed.") from exc
    if not original or len(original) > MAX_BYTES:
        raise MigrationError("Attachment expands beyond the safe original-content limit.")
    digest = hashlib.sha256(original).hexdigest()
    for ref in main_refs:
        claimed = int(ref.row.get("original_size_bytes") or 0)
        if claimed != len(original) or claimed > MAX_BYTES:
            raise MigrationError("Attachment original-size metadata is inconsistent.")
        if ref.row.get("sha256") and ref.row["sha256"] != digest:
            raise MigrationError("Attachment original-content hash is inconsistent.")
    return original
