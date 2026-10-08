"""Promote verified metadata atomically; no source transport is used here."""

from __future__ import annotations

from contextlib import closing
from urllib.parse import quote

from config import load_environment_config
from services.time_utils import utcnow_iso

from . import manifest
from .destination import require_unchanged, verified_fingerprint
from .ownership import record_avatar_ownership
from .references import collect_references, readonly_connection
from .source import MigrationError


def _paused():
    configured = load_environment_config().upload_storage_settings
    return str(configured.get("NEST_STORAGE_MUTATIONS_PAUSED", "")).strip().lower() in {"1", "true", "yes", "on"}


def _manifest_rows(conn, config):
    return [dict(row) for row in conn.execute(
        f"SELECT * FROM {manifest.TABLE} WHERE source_endpoint=? AND source_project_id=?",
        (config.endpoint, config.project_id),
    )]


def _verified_destinations(path, rows):
    fingerprints = {}
    for row in rows:
        if row["status"] == "missing":
            continue
        if row["status"] == "removed" and row["reference_status"] == "source_disappeared":
            # Intent was recorded by feature deletion in its writer transaction.
            # Fresh inventory proved the remote identity is now absent too.
            continue
        if row["reference_status"] == "source_disappeared":
            raise MigrationError("A source disappeared after inventory; reconcile before promotion.")
        if row["status"] not in {"verified", "promoted"} or not row["verified_at"]:
            raise MigrationError("All present source objects must pass verify before promotion.")
        fingerprints[row["id"]] = verified_fingerprint(
            path, row["namespace"], row["object_id"], expected=(row["byte_length"], row["sha256"]))
    return fingerprints


def _validate_references(references, indexed):
    for ref in references:
        imported = indexed.get((ref.bucket_id, ref.file_id))
        if not imported:
            raise MigrationError("A current reference is absent from the manifest; refresh copy and verify.")
        if imported["reference_status"] == "source_disappeared":
            raise MigrationError("A referenced source disappeared after inventory; reconcile before promotion.")
        if imported["status"] == "missing":
            if (ref.table != "chat_messages" or ref.column not in {"author_avatar_url", "author_picture_url"}
                    or imported["reference_status"] != "missing_baseline"):
                raise MigrationError("Missing feature bytes cannot be promoted.")
        elif imported["status"] not in {"verified", "promoted"}:
            raise MigrationError("A current reference is not verified.")


def _promote_users(conn, references, indexed):
    changed = 0
    grouped = {}
    for ref in references:
        if ref.table == "users":
            grouped.setdefault(ref.row_id, []).append(ref)
    for row_id, refs in grouped.items():
        file_ids = {ref.file_id for ref in refs}
        if len(file_ids) != 1:
            raise MigrationError("Avatar metadata and picture URL disagree; reconcile before promotion.")
        ref = refs[0]
        obj = indexed[(ref.bucket_id, ref.file_id)]
        updates = {"avatar_storage_backend": "sqlite", "avatar_file_id": obj["object_id"]}
        if any(item.column == "picture_url" for item in refs):
            updates["picture_url"] = "/api/avatars/" + quote(obj["object_id"], safe="")
        assignments = ",".join(f"{column}=?" for column in updates)
        conn.execute(f"UPDATE users SET {assignments} WHERE id=?", (*updates.values(), row_id))
        changed += 1
    return changed


def _promote_chat_avatars(conn, references, indexed):
    changed = missing = 0
    for ref in references:
        if ref.table != "chat_messages":
            continue
        imported = indexed[(ref.bucket_id, ref.file_id)]
        value = None if imported["status"] == "missing" else (
            "/api/avatars/" + quote(imported["object_id"], safe=""))
        conn.execute(f"UPDATE chat_messages SET {ref.column}=? WHERE id=? AND {ref.column}=?",
                     (value, ref.row_id, ref.row[ref.column]))
        changed += 1
        missing += value is None
    return changed, missing


def _promote_features(conn, references, indexed):
    changed = 0
    grouped = {}
    for ref in references:
        if ref.table in {"shared_files", "note_media", "chat_attachments"}:
            grouped.setdefault((ref.table, ref.row_id), []).append(ref)
    for (table, row_id), refs in grouped.items():
        conn.execute(f"UPDATE {table} SET storage_backend='sqlite' WHERE id=?", (row_id,))
        # IDs, share codes, editor references and the legacy source path remain intact.
        changed += 1
    return changed


def promote(path, config):
    if not _paused():
        raise MigrationError("Promotion requires NEST_STORAGE_MUTATIONS_PAUSED=true in all application workers.")
    with closing(readonly_connection(path)) as conn:
        rows = _manifest_rows(conn, config)
    if not rows:
        raise MigrationError("No inventory manifest exists; run copy and verify first.")
    fingerprints = _verified_destinations(path, rows)
    with manifest.transaction(path) as conn:
        # All checks below are local. No scanner, HTTP call or decryption holds the write lock.
        current_rows = _manifest_rows(conn, config)
        previous = {tuple(sorted(row.items())) for row in rows}
        current = {tuple(sorted(row.items())) for row in current_rows}
        if current != previous or not _paused():
            raise MigrationError("Import state changed before promotion; rerun verification.")
        indexed = {(row["source_bucket_id"], row["source_file_id"]): row for row in current_rows}
        references = collect_references(conn, config)
        _validate_references(references, indexed)
        # Check existence for avatar imports as well as feature objects.
        for row in current_rows:
            if row["status"] not in {"missing", "removed"}:
                require_unchanged(conn, row["namespace"], row["object_id"], fingerprints[row["id"]])
                if row["namespace"] == "avatars":
                    record_avatar_ownership(conn, row["object_id"], row["byte_length"], references, promote=True)
        users = _promote_users(conn, references, indexed)
        chat, missing = _promote_chat_avatars(conn, references, indexed)
        features = _promote_features(conn, references, indexed)
        now = utcnow_iso()
        conn.execute(
            f"UPDATE {manifest.TABLE} SET status='promoted',promoted_at=COALESCE(promoted_at,?),updated_at=? "
            "WHERE source_endpoint=? AND source_project_id=? AND status IN ('verified','promoted')",
            (now, now, config.endpoint, config.project_id),
        )
    return {"stage": "promote", "users": users, "chat_avatars": chat,
            "missing_historical_avatars_fallback": missing, "feature_rows": features, "failed": 0}
