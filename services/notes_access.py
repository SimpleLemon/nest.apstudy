"""Current collaboration permissions, independent of admission ticket expiry."""

from services import note_store
from services.database import db_connection


def _permission_revision(note, folder):
    return [
        str(note.get("user_id") or ""), int(note.get("access_version") or 1),
        str(note.get("folder_id") or ""),
        str(folder.get("user_id") or "") if folder else "",
        int(folder.get("access_version") or 1) if folder else 0,
    ]


def collaboration_access(note_id, user_id=None):
    note = note_store.get_note(note_id)
    if not note:
        return None
    folder = note_store.get_folder(note["folder_id"]) if note.get("folder_id") else None
    permission_revision = _permission_revision(note, folder)
    access = note_store.resolve_note_access(note, user_id)
    if not access["can_view"]:
        return None
    # Resolution reads grants separately. Do not combine a role from one ACL
    # generation with the owner/folder revisions from another generation.
    current_note = note_store.get_note(note_id)
    if not current_note:
        return None
    current_folder = note_store.get_folder(current_note["folder_id"]) if current_note.get("folder_id") else None
    if permission_revision != _permission_revision(current_note, current_folder):
        raise RuntimeError("Collaboration permissions changed during resolution.")
    public = "public" in str(access.get("source") or "")
    with db_connection() as conn:
        document = conn.execute(
            "SELECT document_generation FROM note_collaboration_documents WHERE note_id = ?",
            [str(note_id)],
        ).fetchone()
    document_generation = document["document_generation"] if document else "initial"
    return {
        "ok": True,
        "note_id": str(note_id), "user_id": user_id,
        "role": access["role"], "can_write": access["can_edit"],
        "access": access,
        "can_review": access["can_review"],
        "public": public, "anonymous": not bool(user_id),
        "awareness_allowed": bool(user_id and not public),
        "access_revision": int(note.get("access_version") or 1),
        "permission_revision": permission_revision,
        "document_generation": document_generation,
        "user": note_store.get_safe_user(user_id) if user_id else None,
    }
