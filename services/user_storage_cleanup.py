"""Delete an account's upload references without losing their payload identities."""

import sqlite3

from appwrite.exception import AppwriteException

from services import database, storage_backend, storage_objects
from services.avatar_storage import cleanup_legacy_avatars, legacy_avatar_id, local_avatar_id, retire_avatar


def _backend(row, column="storage_backend"):
    backend = str(row.get(column) or "appwrite").strip().lower()
    if backend not in {"appwrite", "sqlite"}:
        raise storage_objects.StorageUnavailable("An account upload has an unsupported storage backend.")
    return backend


def _avatar_ids(url):
    local_id = local_avatar_id(url)
    if local_id:
        return local_id, "sqlite"
    legacy_id = legacy_avatar_id(url)
    return (legacy_id, "appwrite") if legacy_id else (None, None)


def _message_avatar_columns(conn):
    return sorted(database.table_columns(conn, "chat_messages") & {"author_avatar_url", "author_picture_url"})


def _account_avatars(conn, user_id):
    """Keep historical images that are still referenced by a different account."""
    candidates = {}
    ownership = {
        str(row["object_id"]): dict(row)
        for row in conn.execute("SELECT * FROM storage_avatar_ownership")
    }
    for file_id, item in ownership.items():
        if item["user_id"] == user_id:
            candidates[file_id] = _backend(item)
    user = conn.execute("SELECT * FROM users WHERE id = ?", [user_id]).fetchone()
    if user:
        user = dict(user)
        file_id = str(user.get("avatar_file_id") or "")
        if file_id:
            candidates[file_id] = _backend(user, "avatar_storage_backend")
        picture_id, picture_backend = _avatar_ids(user.get("picture_url"))
        if picture_id:
            candidates.setdefault(picture_id, picture_backend)

    avatar_columns = _message_avatar_columns(conn)
    for column in avatar_columns:
        for row in conn.execute(f'SELECT DISTINCT "{column}" FROM chat_messages WHERE user_id = ?', [user_id]):
            file_id, backend = _avatar_ids(row[0])
            if file_id:
                # A canonical local identity must never trigger remote deletion.
                if backend == "sqlite" or file_id not in candidates:
                    candidates[file_id] = backend

    remaining = set()
    for row in conn.execute("SELECT avatar_file_id, picture_url FROM users WHERE id <> ?", [user_id]):
        if row["avatar_file_id"]:
            remaining.add(str(row["avatar_file_id"]))
        file_id, _ = _avatar_ids(row["picture_url"])
        if file_id:
            remaining.add(file_id)
    for column in avatar_columns:
        for row in conn.execute(
            f'SELECT DISTINCT "{column}" FROM chat_messages WHERE user_id IS NULL OR user_id <> ?',
            [user_id],
        ):
            file_id, _ = _avatar_ids(row[0])
            if file_id:
                remaining.add(file_id)

    local_ids = {
        str(row["object_id"])
        for row in conn.execute("SELECT object_id FROM storage_objects WHERE namespace = 'avatars'")
    }
    sqlite_ids, legacy_ids = set(), set()
    for file_id, backend in candidates.items():
        if file_id in remaining:
            continue
        if file_id in ownership:
            backend = _backend(ownership[file_id])
        # A copied object may still occur in a historical Appwrite URL. Its
        # source remains intact during the migration observation period.
        if backend == "sqlite" or (file_id in local_ids and file_id not in ownership):
            sqlite_ids.add(file_id)
        else:
            legacy_ids.add(file_id)
    return sqlite_ids, legacy_ids


def _inventory(conn, user_id):
    rows = {
        "shared_files": [dict(row) for row in conn.execute("SELECT * FROM shared_files WHERE user_id = ?", [user_id])],
        "note_media": [
            dict(row)
            for row in conn.execute(
                "SELECT media.* FROM note_media AS media "
                "WHERE media.user_id = ? OR media.note_id IN (SELECT id FROM notes WHERE user_id = ?)",
                [user_id, user_id],
            )
        ],
        "chat_attachments": [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM chat_attachments WHERE user_id = ? "
                "OR message_id IN (SELECT id FROM chat_messages WHERE user_id = ?)",
                [user_id, user_id],
            )
        ],
    }
    for feature_rows in rows.values():
        for row in feature_rows:
            _backend(row)
    sqlite_avatars, legacy_avatars = _account_avatars(conn, user_id)
    return rows, sqlite_avatars, legacy_avatars


def _delete_legacy_rows(rows, avatars, user_id):
    """Network calls finish before acquiring the SQLite writer lock."""
    from services.chat_attachments import cleanup_legacy_attachments, delete_attachment
    from services.file_share_store import cleanup_legacy_files, _delete_file_record
    from services.note_media import cleanup_legacy_media, delete_media
    from services.storage_legacy_cleanup import pending_legacy_deletions

    deleters = {"shared_files": _delete_file_record, "note_media": delete_media, "chat_attachments": delete_attachment}
    for feature, feature_rows in rows.items():
        for row in feature_rows:
            if _backend(row) == "appwrite":
                deleters[feature](row, account_user_id=user_id)
    for cleanup in (cleanup_legacy_files, cleanup_legacy_media, cleanup_legacy_attachments, cleanup_legacy_avatars):
        cleanup(account_user_id=user_id)
    if pending_legacy_deletions(account_user_id=user_id):
        # The queue retains removed media identities if the remote service is
        # down. Keep the profile/parent notes available for a deletion retry.
        raise storage_objects.StorageUnavailable("Legacy upload deletion is pending. Please retry.")


def _delete_sqlite_rows(conn, rows):
    from services.chat_attachments import delete_attachment
    from services.file_share_store import _delete_file_record
    from services.note_media import delete_media

    deleters = {"shared_files": _delete_file_record, "note_media": delete_media, "chat_attachments": delete_attachment}
    for feature, feature_rows in rows.items():
        for row in feature_rows:
            if _backend(row) != "sqlite":
                raise storage_objects.StorageUnavailable("Account uploads changed during deletion. Please retry.")
            deleters[feature](row, conn=conn)


def delete_user_storage(user_id):
    """Delete uploads, their metadata, and the account profile atomically.

    Storage failures propagate so callers cannot proceed to account deletion.
    Feature enablement does not affect cleanup of already stored attachments.
    """
    user_id = str(user_id)
    storage_backend.require_mutations_enabled()
    try:
        with database.db_connection() as conn:
            rows, _, legacy_avatars = _inventory(conn, user_id)
        _delete_legacy_rows(rows, legacy_avatars, user_id)

        with storage_objects.write_transaction() as conn:
            conn.execute(
                "INSERT OR IGNORE INTO storage_account_deletions (user_id, deleted_at) VALUES (?, ?)",
                [user_id, database.utcnow_iso()],
            )
            rows, sqlite_avatars, remaining_legacy_avatars = _inventory(conn, user_id)
            # Rechecking after remote deletes also discovers uploads created
            # during those requests, before a note cascade can lose their IDs.
            _delete_sqlite_rows(conn, rows)
            conn.execute("DELETE FROM chat_messages WHERE user_id = ?", [user_id])
            conn.execute("DELETE FROM notes WHERE user_id = ?", [user_id])
            conn.execute("DELETE FROM user_settings WHERE user_id = ?", [user_id])
            conn.execute("DELETE FROM users WHERE id = ?", [user_id])
            for file_id in sorted(sqlite_avatars):
                retire_avatar(conn, file_id, backend="sqlite", account_user_id=user_id)
            for file_id in sorted(remaining_legacy_avatars):
                retire_avatar(conn, file_id, backend="appwrite", account_user_id=user_id)
        # Avatar retirement follows removal of the account's own references.
        # The queue and tombstone retain identity even if transport fails here.
        if cleanup_legacy_avatars(account_user_id=user_id)["pending"]:
            raise storage_objects.StorageUnavailable("Legacy avatar deletion is pending. Please retry.")
    except storage_objects.StorageError:
        raise
    except (AppwriteException, sqlite3.Error, ValueError) as exc:
        raise storage_objects.StorageUnavailable("Unable to delete account uploads.") from exc
