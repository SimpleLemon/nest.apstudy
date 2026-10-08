"""Refresh inventory, copy immutable bytes, then compare decrypted destinations."""

from __future__ import annotations

import hashlib
from contextlib import closing, contextmanager

from flask import Flask

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config

from services import storage_objects
from services.storage_errors import StorageNotFound
from services.time_utils import utcnow_iso

from . import manifest
from .destination import require_unchanged, verified_fingerprint
from .ownership import copy_avatar_ownership
from .references import readonly_connection, reference_index, scan_content
from .source import MigrationError


@contextmanager
def import_context():
    """Give the explicit operator import its own guard; worker settings stay intact."""
    app = Flask("nest_storage_import")
    app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = load_environment_config()
    app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
    with app.app_context():
        yield


def refreshed_inventory(source, path, *, persist):
    objects = list(source.inventory())
    identities = {(obj.bucket_id, obj.file_id) for obj in objects}
    if len(identities) != len(objects):
        raise MigrationError("The refreshed source inventory contains duplicate identities.")
    references = reference_index(path, source.config)
    missing = {key: refs for key, refs in references.items() if key not in identities}
    if persist:
        with manifest.transaction(path) as conn:
            for obj in objects:
                manifest.inventory_record(conn, source.config, obj,
                                          referenced=(obj.bucket_id, obj.file_id) in references)
            for (bucket, file_id), refs in missing.items():
                manifest.record_missing(conn, source.config, bucket, file_id, refs[0].namespace)
            rows = conn.execute(
                f"SELECT source_bucket_id,source_file_id FROM {manifest.TABLE} "
                "WHERE source_endpoint=? AND source_project_id=? AND status<>'missing'",
                (source.config.endpoint, source.config.project_id),
            ).fetchall()
            for row in rows:
                if tuple(row) not in identities:
                    conn.execute(
                        f"UPDATE {manifest.TABLE} SET reference_status='source_disappeared',updated_at=? "
                        f"WHERE {manifest.IDENTITY_WHERE}",
                        (utcnow_iso(), *manifest.identity(source.config, *row)),
                    )
    return objects, references, missing


def dry_run(source, path):
    objects, references, missing = refreshed_inventory(source, path, persist=False)
    by_namespace = {namespace: {"objects": 0, "bytes": 0, "unreferenced": 0}
                    for namespace in source.config.buckets}
    for obj in objects:
        stats = by_namespace[obj.namespace]
        stats["objects"] += 1
        stats["bytes"] += obj.byte_length
        stats["unreferenced"] += (obj.bucket_id, obj.file_id) not in references
    return {"stage": "dry-run", "objects": len(objects), "bytes": sum(obj.byte_length for obj in objects), "namespaces": by_namespace,
            "missing_references": len(missing), "writes": 0}


def _fingerprint(data):
    return len(data), hashlib.sha256(data).hexdigest()


def _matching_manifest(row, fingerprint):
    if row and row.get("sha256"):
        if (row["byte_length"], row["sha256"]) != fingerprint:
            raise MigrationError("Source bytes changed under an existing import identity; no overwrite performed.")


def _metadata(obj, *, path=None, conn=None):
    try:
        return storage_objects.object_metadata(obj.namespace, obj.file_id, path=path, conn=conn)
    except StorageNotFound:
        return None


def _copy_one(source, path, obj, references):
    data = source.download(obj)
    fingerprint = _fingerprint(data)
    with closing(readonly_connection(path)) as conn:
        row = manifest.get(conn, source.config, obj.bucket_id, obj.file_id)
    _matching_manifest(row, fingerprint)
    metadata = _metadata(obj, path=path)
    verified = None
    if metadata:
        verified = verified_fingerprint(path, obj.namespace, obj.file_id, expected=fingerprint)
        if row and row["status"] in {"verified", "promoted"}:
            with manifest.transaction(path) as conn:
                current = manifest.get(conn, source.config, obj.bucket_id, obj.file_id)
                _matching_manifest(current, fingerprint)
                if current != row:
                    raise MigrationError("Import state changed during copy; rerun verification.")
                require_unchanged(conn, obj.namespace, obj.file_id, verified)
                copy_avatar_ownership(conn, source.config, obj, fingerprint[0])
            return "matched"
    prepared = storage_objects.prepare_object(
        obj.namespace, obj.file_id, data, filename=obj.filename, mime_type=obj.mime_type,
        scan_data=scan_content(obj, data, references),
    )
    with manifest.transaction(path) as conn:
        current = manifest.get(conn, source.config, obj.bucket_id, obj.file_id)
        _matching_manifest(current, fingerprint)
        existing = _metadata(obj, conn=conn)
        if existing:
            if verified is None:
                raise MigrationError("Destination appeared during copy; rerun to authenticate it.")
            require_unchanged(conn, obj.namespace, obj.file_id, verified)
        else:
            storage_objects.put_object(conn, prepared)
        copy_avatar_ownership(conn, source.config, obj, fingerprint[0])
        manifest.result(conn, source.config, obj, status="copied",
                        byte_length=fingerprint[0], sha256=fingerprint[1])
    return "copied"


def _verify_one(source, path, obj, references):
    del references
    downloaded = source.download(obj)
    fingerprint = _fingerprint(downloaded)
    with closing(readonly_connection(path)) as conn:
        row = manifest.get(conn, source.config, obj.bucket_id, obj.file_id)
    if not row or not row.get("sha256"):
        raise MigrationError("Object has no successful copy record; run copy first.")
    _matching_manifest(row, fingerprint)
    verified = verified_fingerprint(path, obj.namespace, obj.file_id, expected=fingerprint)
    with manifest.transaction(path) as conn:
        current = manifest.get(conn, source.config, obj.bucket_id, obj.file_id)
        if current != row:
            raise MigrationError("Import state changed during verification; rerun verification.")
        require_unchanged(conn, obj.namespace, obj.file_id, verified)
        manifest.result(conn, source.config, obj,
                        status="promoted" if row["status"] == "promoted" else "verified",
                        byte_length=fingerprint[0], sha256=fingerprint[1])
        if row["status"] == "promoted":
            conn.execute(f"UPDATE {manifest.TABLE} SET verified_at=? WHERE {manifest.IDENTITY_WHERE}",
                         (utcnow_iso(), *manifest.identity(source.config, obj.bucket_id, obj.file_id)))
    return "verified"


def run_stage(stage, source, path):
    if stage == "dry-run":
        return dry_run(source, path)
    if stage not in {"copy", "verify"}:
        raise ValueError("Expected a copy or verify stage.")
    objects, indexed, missing = refreshed_inventory(source, path, persist=True)
    counts = {"stage": stage, "objects": len(objects), "copied": 0, "matched": 0,
              "verified": 0, "failed": 0, "missing_references": len(missing)}
    action = _copy_one if stage == "copy" else _verify_one
    with import_context():
        for obj in objects:
            try:
                result = action(source, path, obj, indexed.get((obj.bucket_id, obj.file_id), []))
                counts[result] += 1
            except Exception as exc:
                # Never persist exception text from transports or scanners: it may contain secrets/content.
                failure = f"{type(exc).__name__}: import/verification failed; destination was not overwritten."
                with manifest.transaction(path) as conn:
                    manifest.result(conn, source.config, obj, status="failed", error=failure)
                counts["failed"] += 1
    return counts
