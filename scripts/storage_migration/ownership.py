"""Attribute retained imported avatars without inventing owners for orphans."""

from .references import collect_references
from .source import MigrationError


def avatar_owner(references):
    """Prefer one stored-ID owner; URLs identify borrowers, not uploaders."""
    current = {ref.row_id for ref in references
               if ref.table == "users" and ref.column == "avatar_file_id"}
    if current:
        return next(iter(current)) if len(current) == 1 else None
    historical = {str(ref.row["user_id"]) for ref in references
                  if ref.table == "chat_messages" and ref.row.get("user_id")}
    return next(iter(historical)) if len(historical) == 1 else None


def record_avatar_ownership(conn, object_id, byte_length, references, *, promote=False):
    """Never transfer an existing owner; mismatched size requires reconciliation."""
    relevant = [ref for ref in references if ref.namespace == "avatars" and ref.file_id == object_id]
    owner = avatar_owner(relevant)
    if owner:
        conn.execute(
            "INSERT INTO storage_avatar_ownership(object_id,user_id,size_bytes,storage_backend) "
            "VALUES (?,?,?,?) ON CONFLICT(object_id) DO NOTHING",
            (object_id, owner, byte_length, "sqlite" if promote else "appwrite"),
        )
    row = conn.execute(
        "SELECT size_bytes FROM storage_avatar_ownership WHERE object_id=?", (object_id,),
    ).fetchone()
    if row and row["size_bytes"] != byte_length:
        raise MigrationError("Imported avatar ownership byte accounting needs reconciliation.")
    if promote and row:
        conn.execute("UPDATE storage_avatar_ownership SET storage_backend='sqlite' WHERE object_id=?",
                     (object_id,))


def copy_avatar_ownership(conn, config, obj, byte_length):
    if obj.namespace == "avatars":
        # Profile/history changes can occur while bulk download and scanning
        # run. Attribute against references in the same writer transaction.
        record_avatar_ownership(conn, obj.file_id, byte_length, collect_references(conn, config))
