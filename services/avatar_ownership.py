"""Immutable uploader attribution and reference guards for profile images."""

from services import database
from services.storage_errors import StorageValidationError
from services.avatar_references import avatar_identities, reject_retiring_avatar_references


def avatar_referenced(conn, file_id, *, excluding_user_id=None):
    """Check identities, including historical URL crop/size variants."""
    file_id = str(file_id)
    sql = "SELECT avatar_file_id, picture_url FROM users"
    parameters = []
    if excluding_user_id is not None:
        sql += " WHERE id <> ?"
        parameters.append(str(excluding_user_id))
    for row in conn.execute(sql, parameters):
        if file_id in avatar_identities(dict(row)):
            return True
    columns = database.table_columns(conn, "chat_messages") & {"author_avatar_url", "author_picture_url"}
    for column in columns:
        for row in conn.execute(f'SELECT DISTINCT "{column}" FROM chat_messages WHERE "{column}" IS NOT NULL'):
            if file_id in avatar_identities({column: row[0]}):
                return True
    return False


def record_avatar_ownership(conn, user_id, prepared):
    """Publish one new uploader attribution with its payload and profile."""
    if prepared.get("user_id") not in (None, str(user_id)):
        raise StorageValidationError("Avatar upload belongs to a different account.")
    conn.execute(
        "INSERT INTO storage_avatar_ownership (object_id, user_id, size_bytes, storage_backend) VALUES (?, ?, ?, ?)",
        [prepared["file_id"], str(user_id), prepared["size_bytes"], prepared["backend"]],
    )


def remember_current_avatar_ownership(conn, user_id, previous):
    """Preserve an attributable pre-migration current charge when it changes.

    Existing ledger rows always keep their original uploader. A baseline with
    multiple current users cannot identify an uploader and is left untouched.
    """
    if not previous:
        return
    previous = dict(previous)
    file_id = previous.get("avatar_file_id")
    if not file_id or conn.execute(
        "SELECT 1 FROM storage_avatar_ownership WHERE object_id = ?", [str(file_id)],
    ).fetchone():
        return
    size = int(previous.get("avatar_file_size_bytes") or 0)
    if size <= 0:
        return
    if conn.execute("SELECT 1 FROM users WHERE id <> ? AND avatar_file_id = ? LIMIT 1", [str(user_id), str(file_id)]).fetchone():
        return
    record_avatar_ownership(conn, user_id, {
        "file_id": str(file_id), "size_bytes": size,
        "backend": previous.get("avatar_storage_backend") or "appwrite",
    })


def avatar_replacement_credit(conn, user_id, previous, updates):
    """Credit only this uploader's bytes that retire in the profile writer.

    Legacy retirement retains its charge until the remote deletion succeeds,
    so a pending transport operation cannot grant replacement quota credit.
    """
    if not previous:
        return 0
    previous = dict(previous)
    old_id = previous.get("avatar_file_id")
    if not old_id or previous.get("avatar_storage_backend") != "sqlite":
        return 0
    after = {**previous, **updates}
    if str(old_id) in avatar_identities(after) or avatar_referenced(conn, old_id, excluding_user_id=user_id):
        return 0
    owned = conn.execute(
        "SELECT user_id, size_bytes, storage_backend FROM storage_avatar_ownership WHERE object_id = ?",
        [str(old_id)],
    ).fetchone()
    if not owned or owned["user_id"] != str(user_id) or owned["storage_backend"] != "sqlite":
        return 0
    return int(owned["size_bytes"])
