"""Finish durable account deletions after the local profile is removed."""

import logging
import sqlite3

from appwrite.exception import AppwriteException

from services import database, storage_backend, storage_objects
from services.storage_legacy_cleanup import pending_legacy_deletions


logger = logging.getLogger(__name__)
NAMESPACES = ("avatars", "shared_files", "note_media", "chat_attachments")


def _identity(user_id):
    if user_id is None:
        raise storage_objects.StorageValidationError("Account deletion identity is invalid.")
    user_id = str(user_id)
    if not user_id or len(user_id) > 128 or any(ord(char) < 32 or ord(char) == 127 for char in user_id):
        raise storage_objects.StorageValidationError("Account deletion identity is invalid.")
    return user_id


def _deletion_record(conn, user_id):
    return conn.execute(
        "SELECT deletion.*, EXISTS(SELECT 1 FROM users WHERE id = deletion.user_id) AS profile_present "
        "FROM storage_account_deletions AS deletion WHERE deletion.user_id = ?", [user_id],
    ).fetchone()


def _read_deletion(user_id):
    try:
        with database.db_connection() as conn:
            row = _deletion_record(conn, user_id)
            return dict(row) if row else None
    except sqlite3.Error:
        raise storage_objects.StorageUnavailable("Account deletion database is unavailable.") from None


def pending_account_deletion(user_id):
    """An absent profile can be retried only with pending durable intent."""
    row = _read_deletion(_identity(user_id))
    return bool(row and not row["profile_present"] and row["auth_deleted_at"] is None)


def _eligible_record(user_id):
    row = _read_deletion(user_id)
    if row is None or row["profile_present"]:
        raise storage_objects.StorageUnavailable("Local account deletion must finish before Auth deletion.")
    return row


def _cleanup_functions():
    from services.avatar_storage import cleanup_legacy_avatars
    from services.file_share_store import cleanup_legacy_files
    from services.note_media import cleanup_legacy_media
    from services.chat_attachments import cleanup_legacy_attachments

    return {"avatars": cleanup_legacy_avatars, "shared_files": cleanup_legacy_files,
            "note_media": cleanup_legacy_media, "chat_attachments": cleanup_legacy_attachments}


def _delete_auth_account(user_id):
    # A CLI loads its explicit environment file before constructing this client.
    from appwrite.services.users import Users
    from appwrite_client import client

    Users(client).delete(user_id)


def _drain_account_uploads(user_id, cleanup_functions):
    functions = cleanup_functions if cleanup_functions is not None else _cleanup_functions()
    failed = False
    for namespace in NAMESPACES:
        storage_backend.require_mutations_enabled()
        _eligible_record(user_id)
        try:
            functions[namespace](account_user_id=user_id)
        except storage_objects.StorageMutationPaused:
            raise
        except Exception as exc:
            logger.warning("Account %s legacy %s cleanup deferred (%s)", user_id, namespace, type(exc).__name__)
            failed = True
    if failed or pending_legacy_deletions(account_user_id=user_id):
        raise storage_objects.StorageUnavailable("Account upload deletion is pending. Please retry.")


def complete_account_deletion(user_id, *, delete_auth=None, cleanup_functions=None):
    """Drain this account's uploads, delete Auth outside the writer, then mark it.

    The tombstone remains permanently. Transport or marker-write failures leave
    Auth pending, so a later pass can safely retry a remote 404 as success.
    A user ID without a tombstone, or with a surviving profile, triggers no SDK.
    """
    user_id = _identity(user_id)
    storage_backend.require_mutations_enabled()
    row = _eligible_record(user_id)
    if row["auth_deleted_at"] is not None:
        return False

    _drain_account_uploads(user_id, cleanup_functions)
    row = _eligible_record(user_id)
    if row["auth_deleted_at"] is not None:
        return False
    storage_backend.require_mutations_enabled()
    try:
        (delete_auth if delete_auth is not None else _delete_auth_account)(user_id)
    except storage_objects.StorageMutationPaused:
        raise
    except AppwriteException as exc:
        status = getattr(exc, "code", None) or getattr(exc, "response_code", None)
        if str(status) != "404":
            raise storage_objects.StorageUnavailable("Account Auth deletion is pending. Please retry.") from None
    except Exception:
        raise storage_objects.StorageUnavailable("Account Auth deletion is pending. Please retry.") from None

    with storage_objects.write_transaction() as conn:
        current = _deletion_record(conn, user_id)
        if current is None or current["profile_present"] or current["deleted_at"] != row["deleted_at"]:
            raise storage_objects.StorageUnavailable("Account deletion changed before completion. Please retry.")
        if conn.execute(
            "SELECT 1 FROM storage_legacy_deletions WHERE account_user_id = ? LIMIT 1", [user_id],
        ).fetchone():
            raise storage_objects.StorageUnavailable("Account upload deletion is pending. Please retry.")
        storage_backend.require_mutations_enabled()
        cursor = conn.execute(
            "UPDATE storage_account_deletions SET auth_deleted_at = ? "
            "WHERE user_id = ? AND deleted_at = ? AND auth_deleted_at IS NULL",
            [database.utcnow_iso(), user_id, row["deleted_at"]],
        )
        return bool(cursor.rowcount)


def account_deletion_counts(conn, *, account_user_id=None):
    """Read counts on an existing connection; callers may use a read-only URI."""
    where, values = "", []
    if account_user_id is not None:
        where, values = " WHERE deletion.user_id = ?", [_identity(account_user_id)]
    row = conn.execute(
        "SELECT COUNT(*) AS total, "
        "COUNT(CASE WHEN auth_deleted_at IS NOT NULL THEN 1 END) AS completed, "
        "COUNT(CASE WHEN auth_deleted_at IS NULL THEN 1 END) AS pending, "
        "COUNT(CASE WHEN auth_deleted_at IS NULL AND users.id IS NULL THEN 1 END) AS eligible, "
        "COUNT(CASE WHEN auth_deleted_at IS NULL AND users.id IS NOT NULL THEN 1 END) AS blocked "
        "FROM storage_account_deletions AS deletion LEFT JOIN users ON users.id = deletion.user_id" + where,
        values,
    ).fetchone()
    return dict(zip(("total", "completed", "pending", "eligible", "blocked"), row))


def cleanup_pending_accounts(*, account_user_id=None, delete_auth=None, cleanup_functions=None, limit=100):
    """Run a bounded, notification-free completion pass for eligible tombstones."""
    storage_backend.require_mutations_enabled()
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise storage_objects.StorageValidationError("Account deletion batch limit is invalid.")
    scope = [_identity(account_user_id)] if account_user_id is not None else []
    where = " AND deletion.user_id = ?" if scope else ""
    try:
        with database.db_connection() as conn:
            ids = [row[0] for row in conn.execute(
                "SELECT deletion.user_id FROM storage_account_deletions AS deletion "
                "LEFT JOIN users ON users.id = deletion.user_id "
                "WHERE deletion.auth_deleted_at IS NULL AND users.id IS NULL" + where +
                " ORDER BY deletion.last_attempt_at, deletion.deleted_at, deletion.user_id LIMIT ?", [*scope, limit],
            )]
        completed, failed = 0, 0
        for user_id in ids:
            try:
                # Publish priority before remote I/O, so failed or interrupted
                # attempts cannot monopolize the next bounded scheduler pass.
                with storage_objects.write_transaction() as conn:
                    conn.execute(
                        "UPDATE storage_account_deletions SET last_attempt_at = ? "
                        "WHERE user_id = ? AND auth_deleted_at IS NULL "
                        "AND NOT EXISTS (SELECT 1 FROM users WHERE id = ?)",
                        [database.utcnow_iso(), user_id, user_id],
                    )
                completed += bool(complete_account_deletion(
                    user_id, delete_auth=delete_auth, cleanup_functions=cleanup_functions,
                ))
            except storage_objects.StorageMutationPaused:
                raise
            except Exception as exc:
                logger.warning("Account %s deletion completion deferred (%s)", user_id, type(exc).__name__)
                failed += 1
        with database.db_connection() as conn:
            final = account_deletion_counts(conn, account_user_id=account_user_id)
        return {"completed": completed, "pending": final["pending"], "eligible": final["eligible"],
                "blocked": final["blocked"], "failed": failed}
    except sqlite3.Error:
        raise storage_objects.StorageUnavailable("Account deletion database is unavailable.") from None
