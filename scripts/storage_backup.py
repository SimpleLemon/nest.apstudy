"""Restore SQLite snapshots privately and authenticate every upload object."""

from __future__ import annotations

import hashlib
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from urllib.parse import unquote, urlsplit

from flask import Flask

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services import storage_objects
from services.storage_backend import storage_setting
from scripts.storage_migration.references import table_columns
from scripts.storage_migration.source import MigrationError, NAMESPACE_LIMITS, SourceConfig


class BackupVerificationError(RuntimeError):
    pass


def check_database(path):
    with closing(sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as conn:
        if conn.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise BackupVerificationError("Restored database failed integrity_check.")
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            raise BackupVerificationError("Restored database failed foreign_key_check.")


def verify_objects(database_path, *, keyring_path=None):
    """Select only metadata, then decrypt one bounded object at a time."""
    with closing(sqlite3.connect(Path(database_path).resolve().as_uri() + "?mode=ro", uri=True)) as conn:
        present = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='storage_objects'").fetchone()
        rows = conn.execute("SELECT namespace,object_id,byte_length,sha256 FROM storage_objects ORDER BY id").fetchall() if present else []
    app = Flask("nest_storage_restore_verification")
    app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = load_environment_config()
    if keyring_path is not None:
        app.config["NEST_UPLOAD_KEYRING_PATH"] = str(keyring_path)
    verified_bytes = 0
    namespaces = {}
    with app.app_context():
        for namespace, object_id, byte_length, digest in rows:
            try:
                data = storage_objects.read_object(namespace, object_id, path=database_path)
            except Exception as exc:
                raise BackupVerificationError("A restored upload could not be decrypted and authenticated.") from exc
            if (len(data), hashlib.sha256(data).hexdigest()) != (byte_length, digest):
                raise BackupVerificationError("A restored upload failed its stored-payload hash check.")
            verified_bytes += len(data)
            namespaces[namespace] = namespaces.get(namespace, 0) + 1
    coverage = verify_coverage(database_path, rows, app_base_url=load_environment_config().app_base_url)
    return {"objects": len(rows), "bytes": verified_bytes, "namespaces": namespaces, "coverage": coverage}


def _local_avatar(value, app_base_url):
    try:
        parsed = urlsplit(str(value or ""))
        if parsed.username or parsed.password or parsed.fragment:
            return None
        if parsed.netloc:
            base = urlsplit(app_base_url)
            if (parsed.scheme.lower(), parsed.netloc.lower()) != (base.scheme.lower(), base.netloc.lower()):
                return None
        elif parsed.scheme:
            return None
        prefix = "/api/avatars/"
        if not parsed.path.startswith(prefix):
            return None
        object_id = unquote(parsed.path[len(prefix):])
        return object_id if object_id and "/" not in object_id and "\\" not in object_id else None
    except (TypeError, ValueError):
        return None


def _legacy_avatar_configs(conn):
    """Use the invocation's source mapping and retained manifest identities."""
    configured = load_environment_config()
    configs = []
    if configured.appwrite_endpoint and configured.appwrite_project_id:
        try:
            configs.append(SourceConfig(configured.appwrite_endpoint, configured.appwrite_project_id, {
                "avatars": configured.appwrite_profile_avatar_bucket_id,
                "shared_files": configured.appwrite_file_share_bucket_id,
                "note_media": configured.appwrite_notes_media_bucket_id,
                "chat_attachments": configured.appwrite_chat_attachments_bucket_id or "chat_attachments",
            }))
        except MigrationError as exc:
            raise BackupVerificationError("The backup verifier's source mapping is invalid.") from exc
    if table_columns(conn, "storage_migration_manifest"):
        grouped = {}
        for endpoint, project, bucket in conn.execute(
                "SELECT DISTINCT source_endpoint,source_project_id,source_bucket_id "
                "FROM storage_migration_manifest WHERE namespace='avatars' "
                "AND source_endpoint<>'' AND source_project_id<>''"):
            grouped.setdefault((endpoint, project), set()).add(bucket)
        for (endpoint, project), buckets in grouped.items():
            for bucket in buckets:
                mapping = {namespace: "__unused_backup_" + namespace for namespace in NAMESPACE_LIMITS}
                mapping["avatars"] = bucket
                try:
                    configs.append(SourceConfig(endpoint, project, mapping))
                except MigrationError as exc:
                    raise BackupVerificationError("A retained avatar source mapping is invalid.") from exc
    return configs


def _legacy_avatar(value, configs):
    return any(identity and identity[0] == config.buckets["avatars"]
               for config in configs for identity in (config.parse_file_url(value),))


def verify_coverage(database_path, rows, *, app_base_url):
    """Check every live SQLite pointer and every surviving manifest payload hash.

    The manifest deliberately outlives intentionally deleted objects. Missing
    copied destinations require that durable receipt; live pointers must resolve.
    Explicit Appwrite pointers are counted for the rollout gate, not fetched.
    """
    objects = {(namespace, object_id): (length, digest) for namespace, object_id, length, digest in rows}
    result = {"sqlite_references": 0, "legacy_references": 0, "manifest_hashes_verified": 0,
              "retired_manifest_objects": 0, "unrecovered_manifest_objects": 0,
              "missing_baseline": 0, "manifest_statuses": {}}

    def require(namespace, object_id, expected_length=None):
        fingerprint = objects.get((namespace, object_id))
        if fingerprint is None:
            raise BackupVerificationError("A restored live SQLite upload reference has no payload.")
        if expected_length is not None and fingerprint[0] != expected_length:
            raise BackupVerificationError("A restored live upload reference has inconsistent byte accounting.")
        result["sqlite_references"] += 1

    def selected(conn, table, names):
        columns = table_columns(conn, table)
        available = [name for name in names if name in columns]
        if not available:
            return []
        return conn.execute("SELECT " + ",".join(available) + " FROM " + table)

    with closing(sqlite3.connect(Path(database_path).resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        legacy_configs = _legacy_avatar_configs(conn)
        for row in selected(conn, "users", ("avatar_file_id", "avatar_storage_backend", "picture_url")):
            row = dict(row)
            backend = row.get("avatar_storage_backend") or "appwrite"
            if row.get("avatar_file_id"):
                if backend == "sqlite":
                    require("avatars", row["avatar_file_id"])
                elif backend == "appwrite":
                    result["legacy_references"] += 1
                else:
                    raise BackupVerificationError("A restored avatar uses an unsupported storage backend.")
            local_id = _local_avatar(row.get("picture_url"), app_base_url)
            if local_id:
                require("avatars", local_id)
            elif _legacy_avatar(row.get("picture_url"), legacy_configs):
                result["legacy_references"] += 1
        for row in selected(conn, "chat_messages", ("author_avatar_url", "author_picture_url")):
            for value in row:
                local_id = _local_avatar(value, app_base_url)
                if local_id:
                    require("avatars", local_id)
                elif _legacy_avatar(value, legacy_configs):
                    result["legacy_references"] += 1
        for row in selected(conn, "storage_avatar_ownership", ("object_id", "storage_backend", "size_bytes")):
            if row["storage_backend"] == "sqlite":
                require("avatars", row["object_id"], row["size_bytes"])
            elif row["storage_backend"] == "appwrite":
                result["legacy_references"] += 1
            else:
                raise BackupVerificationError("A restored avatar owner uses an unsupported storage backend.")
        for table in ("shared_files", "note_media", "chat_attachments"):
            for row in selected(conn, table, ("storage_backend", "storage_file_id", "preview_file_id",
                                             "file_size_bytes", "stored_size_bytes", "preview_size_bytes")):
                row = dict(row)
                backend = row.get("storage_backend") or "appwrite"
                if backend == "sqlite":
                    expected = row.get("stored_size_bytes") if table == "chat_attachments" else row.get("file_size_bytes")
                    require(table, row.get("storage_file_id"), expected)
                    if row.get("preview_file_id"):
                        require(table, row["preview_file_id"], row.get("preview_size_bytes"))
                elif backend == "appwrite":
                    result["legacy_references"] += bool(row.get("storage_file_id")) + bool(row.get("preview_file_id"))
                else:
                    raise BackupVerificationError("A restored upload uses an unsupported storage backend.")
        for row in selected(conn, "storage_migration_manifest", ("namespace", "object_id", "byte_length", "sha256", "status")):
            status = row["status"]
            result["manifest_statuses"][status] = result["manifest_statuses"].get(status, 0) + 1
            if status == "missing":
                result["missing_baseline"] += 1
                continue
            fingerprint = objects.get((row["namespace"], row["object_id"]))
            if fingerprint is None:
                if status == "removed":
                    result["retired_manifest_objects"] += 1
                elif row["sha256"] or status in {"copied", "verified", "promoted"}:
                    raise BackupVerificationError("A restored imported upload is absent without an intentional removal receipt.")
                else:
                    result["unrecovered_manifest_objects"] += 1
            elif row["sha256"]:
                if fingerprint != (row["byte_length"], row["sha256"]):
                    raise BackupVerificationError("A restored upload differs from its source-mapping manifest hash.")
                result["manifest_hashes_verified"] += 1
    return result


def _restore_and_verify(backup_dir, restore_dir, *, keyring_path):
    for name in ("nest.sqlite3", "calendar.sqlite3"):
        source = backup_dir / name
        if not source.is_file():
            raise BackupVerificationError("The backup lacks a required SQLite database.")
        restored = restore_dir / name
        shutil.copy2(source, restored)
        os.chmod(restored, 0o600)
        check_database(restored)
    result = verify_objects(restore_dir / "nest.sqlite3", keyring_path=keyring_path)
    result["databases"] = 2
    return result


def verify_backup(backup_dir, *, keyring_path=None, restore_dir=None):
    backup_dir = Path(backup_dir).resolve()
    if keyring_path is None:
        keyring_path = storage_setting("NEST_UPLOAD_KEYRING_PATH")
    if keyring_path is not None:
        keyring_path = Path(keyring_path).resolve()
        if keyring_path.is_relative_to(backup_dir):
            raise BackupVerificationError("Recover upload keys separately from the database backup set.")
    if restore_dir is None:
        with tempfile.TemporaryDirectory(prefix="nest-backup-restore-") as temporary:
            return _restore_and_verify(backup_dir, Path(temporary), keyring_path=keyring_path)
    restore_dir = Path(restore_dir).resolve()
    if restore_dir == backup_dir or restore_dir.is_relative_to(backup_dir):
        raise BackupVerificationError("Use a disposable restore directory outside the backup set.")
    if keyring_path and keyring_path.is_relative_to(restore_dir):
        raise BackupVerificationError("Keep the recovered keyring outside the disposable database directory.")
    restore_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    return _restore_and_verify(backup_dir, restore_dir, keyring_path=keyring_path)
