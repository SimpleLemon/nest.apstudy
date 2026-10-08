"""Durable retries for explicit Appwrite object deletions after local commit."""

import logging
import sqlite3

from appwrite.exception import AppwriteException

from services import database
from services.storage_backend import require_mutations_enabled
from services.storage_objects import (
    NAMESPACES, StorageMutationPaused, StorageUnavailable, StorageValidationError,
    write_transaction,
)
from services.time_utils import utcnow_iso


logger = logging.getLogger(__name__)


def _scope_identity(value, label):
    if value is None:
        return None
    value = str(value)
    if not value or len(value) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise StorageValidationError(f"Legacy deletion {label} is invalid.")
    return value


def _deletion_scope(namespace, *, account_user_id=None, object_ids=None, parent_id=None):
    if namespace is not None and (not isinstance(namespace, str) or namespace not in NAMESPACES):
        raise StorageValidationError("Legacy deletion namespace is invalid.")
    clauses, values = [], []
    for column, value in (
        ("namespace", namespace),
        ("account_user_id", _scope_identity(account_user_id, "account")),
        ("parent_id", _scope_identity(parent_id, "parent")),
    ):
        if value is not None:
            clauses.append(f"{column} = ?")
            values.append(value)
    if object_ids is not None:
        if isinstance(object_ids, str):
            object_ids = [object_ids]
        try:
            ids = tuple(dict.fromkeys(_scope_identity(value, "object") for value in object_ids))
        except TypeError:
            raise StorageValidationError("Legacy deletion object filter is invalid.") from None
        if None in ids:
            raise StorageValidationError("Legacy deletion object filter is invalid.")
        clauses.append(f"object_id IN ({', '.join('?' for _ in ids)})" if ids else "0 = 1")
        values.extend(ids)
    return " AND ".join(clauses) or "1 = 1", values


def enqueue_legacy_deletion(conn, namespace, bucket_id, object_id, *, account_user_id=None, parent_id=None):
    """Keep remote identity in the transaction that removes feature metadata.

    Callers must enqueue only explicitly legacy references. A promoted SQLite
    reference may retain the same source IDs for rollback and must keep them.
    Missing attribution may be filled on retry; existing attribution survives.
    """
    require_mutations_enabled()
    if not isinstance(conn, sqlite3.Connection) or not conn.in_transaction:
        raise StorageValidationError("Legacy deletion requires an active SQLite transaction.")
    if not isinstance(namespace, str) or namespace not in NAMESPACES or not bucket_id or not object_id:
        raise StorageValidationError("Legacy deletion identity is invalid.")
    account_user_id = _scope_identity(account_user_id, "account")
    parent_id = _scope_identity(parent_id, "parent")
    try:
        conn.execute(
            "INSERT INTO storage_legacy_deletions "
            "(namespace, bucket_id, object_id, account_user_id, parent_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(namespace, bucket_id, object_id) DO UPDATE SET "
            "account_user_id = COALESCE(storage_legacy_deletions.account_user_id, excluded.account_user_id), "
            "parent_id = COALESCE(storage_legacy_deletions.parent_id, excluded.parent_id)",
            [namespace, str(bucket_id), str(object_id), account_user_id, parent_id, utcnow_iso()],
        )
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None


def _pending_for_scope(where, values):
    conn = None
    try:
        conn = database.connect()
        return conn.execute(
            f"SELECT COUNT(*) FROM storage_legacy_deletions WHERE {where}", values,
        ).fetchone()[0]
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
    finally:
        if conn is not None:
            conn.close()


def pending_legacy_deletions(namespace=None, *, account_user_id=None, object_ids=None, parent_id=None):
    """Count the intersection of supplied filters, including while paused."""
    return _pending_for_scope(*_deletion_scope(
        namespace, account_user_id=account_user_id, object_ids=object_ids, parent_id=parent_id,
    ))


def drain_legacy_deletions(namespace, delete_file, *, account_user_id=None, object_ids=None, parent_id=None):
    """Try queued remote deletions without a database lock during network I/O.

    Missing remote objects count as success. Transport failures keep their
    durable intent for the next cleanup pass and do not undo a committed edit.
    Filters intersect; an empty object list selects no work. Pending counts
    only the selected scope, so unrelated retry work cannot block this caller.
    """
    require_mutations_enabled()
    if not isinstance(namespace, str) or namespace not in NAMESPACES:
        raise StorageValidationError("Legacy deletion namespace is invalid.")
    where, values = _deletion_scope(
        namespace, account_user_id=account_user_id, object_ids=object_ids, parent_id=parent_id,
    )
    conn = None
    try:
        conn = database.connect()
        queued = [dict(row) for row in conn.execute(
            "SELECT id, bucket_id, object_id, created_at FROM storage_legacy_deletions "
            f"WHERE {where} ORDER BY id", values,
        ).fetchall()]
    except sqlite3.Error:
        raise StorageUnavailable("Upload database is unavailable.") from None
    finally:
        if conn is not None:
            conn.close()
    completed = 0
    for item in queued:
        require_mutations_enabled()
        try:
            delete_file(item["bucket_id"], item["object_id"])
        except StorageMutationPaused:
            raise
        except AppwriteException as exc:
            status = int(getattr(exc, "code", 0) or getattr(exc, "response_code", 0) or 0)
            if status != 404:
                logger.warning("Legacy %s deletion deferred for object %s", namespace, item["object_id"])
                continue
        except Exception:
            logger.warning("Legacy %s transport unavailable for object %s", namespace, item["object_id"])
            continue
        with write_transaction() as conn:
            cursor = conn.execute(
                "DELETE FROM storage_legacy_deletions WHERE id = ? AND namespace = ? "
                "AND bucket_id = ? AND object_id = ? AND created_at = ?",
                [item["id"], namespace, item["bucket_id"], item["object_id"], item["created_at"]],
            )
            completed += cursor.rowcount
    return {"completed": completed, "pending": _pending_for_scope(where, values)}
