"""Source mappings survive reruns and rollback without storing key material."""

from __future__ import annotations

from contextlib import contextmanager

from services.database import db_connection
from services.time_utils import utcnow_iso

from .source import MigrationError

TABLE = "storage_migration_manifest"
IDENTITY_WHERE = "source_endpoint=? AND source_project_id=? AND source_bucket_id=? AND source_file_id=?"


@contextmanager
def transaction(path):
    """Offline operator import, deliberately independent of application pause guards."""
    with db_connection(path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        yield conn


def identity(config, bucket, file_id):
    return config.endpoint, config.project_id, bucket, file_id


def get(conn, config, bucket, file_id):
    row = conn.execute(f"SELECT * FROM {TABLE} WHERE {IDENTITY_WHERE}", identity(config, bucket, file_id)).fetchone()
    return dict(row) if row else None


def inventory_record(conn, config, obj, *, referenced):
    now = utcnow_iso()
    params = identity(config, obj.bucket_id, obj.file_id)
    existing = get(conn, config, obj.bucket_id, obj.file_id)
    if existing and (existing["namespace"], existing["object_id"]) != (obj.namespace, obj.file_id):
        raise MigrationError("A source identity has a conflicting destination mapping.")
    conn.execute(
        f"""INSERT INTO {TABLE}
        (source_endpoint, source_project_id, source_bucket_id, source_file_id, namespace,
         object_id, source_url, source_created_at, source_updated_at, source_byte_length,
         reference_status, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(source_endpoint, source_project_id, source_bucket_id, source_file_id)
        DO UPDATE SET source_url=excluded.source_url, source_created_at=excluded.source_created_at,
         source_updated_at=excluded.source_updated_at, source_byte_length=excluded.source_byte_length,
         reference_status=excluded.reference_status,
         status=CASE WHEN status='removed' THEN 'pending' ELSE status END,
         updated_at=excluded.updated_at""",
        (*params, obj.namespace, obj.file_id, config.file_url(obj.bucket_id, obj.file_id),
         obj.created_at, obj.updated_at, obj.byte_length,
         "referenced" if referenced else "unreferenced", now, now),
    )


def record_missing(conn, config, bucket, file_id, namespace):
    now = utcnow_iso()
    existing = get(conn, config, bucket, file_id)
    if existing:
        # An object that disappears after inventory is not an audited baseline gap.
        if existing["status"] != "missing":
            conn.execute(f"UPDATE {TABLE} SET reference_status='source_disappeared', updated_at=? WHERE {IDENTITY_WHERE}",
                         (now, *identity(config, bucket, file_id)))
        return
    conn.execute(
        f"""INSERT INTO {TABLE}
        (source_endpoint, source_project_id, source_bucket_id, source_file_id, namespace,
         object_id, source_url, reference_status, status, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'missing_baseline', 'missing', ?, ?, ?)""",
        (*identity(config, bucket, file_id), namespace, file_id, config.file_url(bucket, file_id),
         "Absent from first complete refreshed source inventory; no bytes recovered.", now, now),
    )


def result(conn, config, obj, *, status, byte_length=None, sha256=None, error=None):
    fields = ["status=?", "error=?", "updated_at=?"]
    values = [status, error, utcnow_iso()]
    if byte_length is not None:
        fields += ["byte_length=?", "sha256=?"]
        values += [byte_length, sha256]
    timestamp = {"copied": "copied_at", "verified": "verified_at", "promoted": "promoted_at"}.get(status)
    if timestamp:
        fields.append(f"{timestamp}=?")
        values.append(utcnow_iso())
    conn.execute(f"UPDATE {TABLE} SET {','.join(fields)} WHERE {IDENTITY_WHERE}",
                 (*values, *identity(config, obj.bucket_id, obj.file_id)))
