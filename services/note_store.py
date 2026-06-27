import logging
import json
import uuid

from appwrite.exception import AppwriteException
from appwrite.query import Query

from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    get_row_safe,
    list_rows_all,
    update_row_safe,
)
from services.database import db_connection, utcnow_iso
from services.notes_preview import preview_text_from_content

logger = logging.getLogger(__name__)

NOTES_TABLE_ID = "notes"
FOLDERS_TABLE_ID = "note_folders"
GRANTS_TABLE_ID = "note_access_grants"
USERS_TABLE_ID = "users"
ORDER_STEP = 1000


def _row_id(row):
    return row.get("$id") or row.get("id")


def _max_order(user_id, table_id):
    try:
        with db_connection() as conn:
            row = conn.execute(
                f'SELECT COALESCE(MAX("order"), 0) AS max_order FROM {table_id} WHERE user_id = ?',
                [str(user_id)],
            ).fetchone()
        return int(row["max_order"] or 0) if row else 0
    except Exception:
        logger.exception("Failed to read max order for %s", table_id)
        return 0


def _ensure_preview_text(note):
    preview = note.get("preview_text")
    if isinstance(preview, str) and preview.strip():
        return preview
    return preview_text_from_content(note.get("content") or "")


def list_notes_for_user(user_id):
    notes = list_rows_all(
        NOTES_TABLE_ID,
        queries=[
            Query.equal("user_id", [str(user_id)]),
            Query.order_asc("order"),
        ],
    )
    return notes


def list_folders_for_user(user_id):
    return list_rows_all(
        FOLDERS_TABLE_ID,
        queries=[
            Query.equal("user_id", [str(user_id)]),
            Query.order_asc("order"),
        ],
    )


def get_note(note_id):
    return get_row_safe(NOTES_TABLE_ID, note_id, allow_missing=True)


def get_folder(folder_id):
    return get_row_safe(FOLDERS_TABLE_ID, folder_id, allow_missing=True)


def list_notes_in_folder(folder_id):
    return list_rows_all(
        NOTES_TABLE_ID,
        queries=[
            Query.equal("folder_id", [str(folder_id)]),
            Query.order_asc("order"),
        ],
    )


def get_note_for_user(note_id, user_id):
    note = get_row_safe(NOTES_TABLE_ID, note_id, allow_missing=True)
    if not note or note.get("user_id") != str(user_id):
        return None
    return note


def get_folder_for_user(folder_id, user_id):
    folder = get_row_safe(FOLDERS_TABLE_ID, folder_id, allow_missing=True)
    if not folder or folder.get("user_id") != str(user_id):
        return None
    return folder


def note_list_payload(note, *, is_shared=None, owner=None):
    note_id = _row_id(note)
    payload = {
        "$id": note_id,
        "id": note_id,
        "folder_id": note.get("folder_id"),
        "title": note.get("title") or "Untitled",
        "preview_text": _ensure_preview_text(note),
        "order": note.get("order") or 0,
        "created_at": note.get("created_at"),
        "updated_at": note.get("updated_at"),
    }
    if is_shared is not None:
        payload["is_shared"] = bool(is_shared)
    if owner is not None:
        payload["owner"] = owner
    return payload


def folder_payload(folder, *, is_shared=None, owner=None):
    folder_id = _row_id(folder)
    payload = {
        "$id": folder_id,
        "id": folder_id,
        "name": folder.get("name") or "Untitled Folder",
        "order": folder.get("order") or 0,
        "created_at": folder.get("created_at"),
    }
    if is_shared is not None:
        payload["is_shared"] = bool(is_shared)
    if owner is not None:
        payload["owner"] = owner
    return payload


def safe_user_payload(user):
    if not user:
        return None
    user_id = _row_id(user)
    name = user.get("name") or user.get("username") or "Nest User"
    return {
        "id": user_id,
        "name": name,
        "username": user.get("username") or "",
        "picture_url": user.get("picture_url") or "",
        "profile_url": f"/u/{user.get('username')}" if user.get("username") else f"/user/{user_id}",
    }


def get_safe_user(user_id):
    return safe_user_payload(get_row_safe(USERS_TABLE_ID, user_id, allow_missing=True))


def resource_grants(resource_type, resource_id):
    return list_rows_all(
        GRANTS_TABLE_ID,
        queries=[
            Query.equal("resource_type", [str(resource_type)]),
            Query.equal("resource_id", [str(resource_id)]),
        ],
    )


def _owned_resource_grants(resource_type, resource_id, owner_user_id):
    owner_user_id = str(owner_user_id)
    return [
        grant for grant in resource_grants(resource_type, resource_id)
        if str(grant.get("owner_user_id") or "") == owner_user_id
    ]


def shared_resource_ids(owner_user_id, resource_type):
    rows = list_rows_all(
        GRANTS_TABLE_ID,
        queries=[
            Query.equal("owner_user_id", [str(owner_user_id)]),
            Query.equal("resource_type", [str(resource_type)]),
        ],
    )
    return {row.get("resource_id") for row in rows if row.get("resource_id")}


def _viewer_grant(grants, viewer_id):
    viewer_id = str(viewer_id or "")
    if viewer_id:
        for grant in grants:
            if grant.get("principal_type") == "user" and grant.get("principal_id") == viewer_id:
                return grant
    for grant in grants:
        if grant.get("principal_type") == "public" and grant.get("principal_id") == "*":
            return grant
    return None


def _access_payload(*, role=None, source=None, source_id=None):
    is_owner = role == "owner"
    can_view = bool(role)
    return {
        "role": role or "none",
        "source": source,
        "source_id": source_id,
        "can_view": can_view,
        "can_edit": is_owner,
        "can_suggest": False,
        "can_share": is_owner,
    }


def resolve_folder_access(folder, viewer_id=None):
    if not folder:
        return _access_payload()
    folder_id = _row_id(folder)
    owner_id = str(folder.get("user_id") or "")
    if viewer_id and str(viewer_id) == owner_id:
        return _access_payload(role="owner", source="owner", source_id=folder_id)
    grant = _viewer_grant(_owned_resource_grants("folder", folder_id, owner_id), viewer_id)
    if grant:
        source = "folder_user" if grant.get("principal_type") == "user" else "folder_public"
        return _access_payload(role="viewer", source=source, source_id=folder_id)
    return _access_payload()


def resolve_note_access(note, viewer_id=None):
    if not note:
        return _access_payload()
    note_id = _row_id(note)
    owner_id = str(note.get("user_id") or "")
    if viewer_id and str(viewer_id) == owner_id:
        return _access_payload(role="owner", source="owner", source_id=note_id)

    direct = _viewer_grant(_owned_resource_grants("note", note_id, owner_id), viewer_id)
    if direct and direct.get("principal_type") == "user":
        return _access_payload(role="viewer", source="note_user", source_id=note_id)

    folder_id = note.get("folder_id")
    folder_grant = None
    if folder_id:
        folder_grant = _viewer_grant(_owned_resource_grants("folder", folder_id, owner_id), viewer_id)
        if folder_grant and folder_grant.get("principal_type") == "user":
            return _access_payload(role="viewer", source="folder_user", source_id=folder_id)

    if direct:
        return _access_payload(role="viewer", source="note_public", source_id=note_id)
    if folder_grant:
        return _access_payload(role="viewer", source="folder_public", source_id=folder_id)
    return _access_payload()


def replace_resource_grants(resource_type, resource_id, owner_user_id, *, public, user_ids, granted_by_user_id):
    resource_type = str(resource_type)
    resource_id = str(resource_id)
    owner_user_id = str(owner_user_id)
    timestamp = utcnow_iso()
    principals = []
    if public:
        principals.append(("public", "*"))
    seen_user_ids = set()
    for user_id in user_ids:
        normalized_user_id = str(user_id)
        if not normalized_user_id or normalized_user_id in seen_user_ids:
            continue
        seen_user_ids.add(normalized_user_id)
        principals.append(("user", normalized_user_id))

    try:
        with db_connection() as conn:
            conn.execute(
                "DELETE FROM note_access_grants WHERE resource_type = ? AND resource_id = ?",
                [resource_type, resource_id],
            )
            for principal_type, principal_id in principals:
                conn.execute(
                    """
                    INSERT INTO note_access_grants (
                        id, owner_user_id, resource_type, resource_id, principal_type,
                        principal_id, access_level, granted_by_user_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'viewer', ?, ?, ?)
                    """,
                    [
                        str(uuid.uuid4()),
                        owner_user_id,
                        resource_type,
                        resource_id,
                        principal_type,
                        principal_id,
                        str(granted_by_user_id),
                        timestamp,
                        timestamp,
                    ],
                )
    except Exception as exc:
        logger.exception("Failed to replace %s sharing grants for %s", resource_type, resource_id)
        raise AppwriteException("Unable to update note sharing.") from exc
    return resource_grants(resource_type, resource_id)


def delete_resource_grants(resource_type, resource_id):
    try:
        with db_connection() as conn:
            conn.execute(
                "DELETE FROM note_access_grants WHERE resource_type = ? AND resource_id = ?",
                [str(resource_type), str(resource_id)],
            )
    except Exception as exc:
        logger.exception("Failed to delete note sharing grants")
        raise AppwriteException("Unable to delete note sharing grants.") from exc


def search_share_users(query, owner_user_id, limit=20):
    normalized = str(query or "").strip().lower().lstrip("@")
    if len(normalized) < 2:
        return []
    pattern = f"%{normalized}%"
    try:
        with db_connection() as conn:
            rows = conn.execute(
                """
                SELECT * FROM users
                WHERE id <> ?
                  AND (LOWER(COALESCE(name, '')) LIKE ? OR LOWER(COALESCE(username, '')) LIKE ?)
                ORDER BY CASE WHEN LOWER(COALESCE(username, '')) = ? THEN 0 ELSE 1 END,
                         LOWER(COALESCE(name, username, '')) ASC
                LIMIT ?
                """,
                [str(owner_user_id), pattern, pattern, normalized, int(limit)],
            ).fetchall()
    except Exception as exc:
        logger.exception("Failed to search users for note sharing")
        raise AppwriteException("Unable to search users.") from exc
    return [safe_user_payload(dict(row)) for row in rows]


def sharing_state(resource_type, resource_id):
    grants = resource_grants(resource_type, resource_id)
    public = any(row.get("principal_type") == "public" for row in grants)
    users = []
    for row in grants:
        if row.get("principal_type") != "user":
            continue
        user = get_safe_user(row.get("principal_id"))
        if user:
            users.append(user)
    users.sort(key=lambda user: (user.get("name") or "").lower())
    return {"public": public, "users": users}


def list_shared_for_user(user_id):
    grants = list_rows_all(
        GRANTS_TABLE_ID,
        queries=[
            Query.equal("principal_type", ["user"]),
            Query.equal("principal_id", [str(user_id)]),
        ],
    )
    owner_cache = {}
    shared_folders = []
    shared_folder_ids = set()
    direct_notes = []

    for grant in grants:
        if grant.get("resource_type") != "folder":
            continue
        folder = get_folder(grant.get("resource_id"))
        if not folder or folder.get("user_id") != grant.get("owner_user_id"):
            continue
        owner_id = str(folder.get("user_id"))
        owner = owner_cache.setdefault(owner_id, get_safe_user(owner_id))
        folder_id = _row_id(folder)
        shared_folder_ids.add(folder_id)
        folder_notes = [note_list_payload(note, owner=owner) for note in list_notes_in_folder(folder_id)]
        payload = folder_payload(folder, is_shared=True, owner=owner)
        payload["notes"] = folder_notes
        shared_folders.append(payload)

    for grant in grants:
        if grant.get("resource_type") != "note":
            continue
        note = get_note(grant.get("resource_id"))
        if not note or note.get("user_id") != grant.get("owner_user_id"):
            continue
        if note.get("folder_id") in shared_folder_ids:
            continue
        owner_id = str(note.get("user_id"))
        owner = owner_cache.setdefault(owner_id, get_safe_user(owner_id))
        direct_notes.append(note_list_payload(note, is_shared=True, owner=owner))

    shared_folders.sort(key=lambda folder: (folder.get("name") or "").lower())
    direct_notes.sort(key=lambda note: note.get("updated_at") or note.get("created_at") or "", reverse=True)
    return {"folders": shared_folders, "notes": direct_notes}


def create_note(user_id, *, title, content="", folder_id=None, now=None):
    timestamp = now or utcnow_iso()
    preview = preview_text_from_content(content)
    return create_row_safe(
        NOTES_TABLE_ID,
        row_id=str(uuid.uuid4()),
        data={
            "user_id": str(user_id),
            "folder_id": folder_id,
            "title": title,
            "content": content,
            "preview_text": preview,
            "order": _max_order(user_id, NOTES_TABLE_ID) + ORDER_STEP,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )


def update_note(note_id, updates):
    if "content" in updates:
        updates["preview_text"] = preview_text_from_content(updates.get("content") or "")
    return update_row_safe(NOTES_TABLE_ID, note_id, updates)


def delete_note(note_id):
    delete_resource_grants("note", note_id)
    delete_row_safe(NOTES_TABLE_ID, note_id)


def create_folder(user_id, *, name, now=None):
    timestamp = now or utcnow_iso()
    return create_row_safe(
        FOLDERS_TABLE_ID,
        row_id=str(uuid.uuid4()),
        data={
            "user_id": str(user_id),
            "name": name,
            "order": _max_order(user_id, FOLDERS_TABLE_ID) + ORDER_STEP,
            "created_at": timestamp,
            "updated_at": timestamp,
        },
    )


def update_folder(folder_id, updates):
    return update_row_safe(FOLDERS_TABLE_ID, folder_id, updates)


def delete_folder_and_notes(user_id, folder_id):
    notes = list_rows_all(
        NOTES_TABLE_ID,
        queries=[
            Query.equal("user_id", [str(user_id)]),
            Query.equal("folder_id", [folder_id]),
        ],
    )
    for note in notes:
        note_id = _row_id(note)
        if note_id:
            delete_resource_grants("note", note_id)
            delete_row_safe(NOTES_TABLE_ID, note_id)
    delete_resource_grants("folder", folder_id)
    delete_row_safe(FOLDERS_TABLE_ID, folder_id)


def backfill_preview_texts(batch_size=100, path=None):
    updated = 0
    try:
        with db_connection(path) as conn:
            while True:
                rows = conn.execute(
                    """
                    SELECT id, content, preview_text
                    FROM notes
                    WHERE preview_text IS NULL OR preview_text = ''
                    LIMIT ?
                    """,
                    [batch_size],
                ).fetchall()
                if not rows:
                    break
                for row in rows:
                    preview = preview_text_from_content(row["content"] or "")
                    conn.execute(
                        "UPDATE notes SET preview_text = ? WHERE id = ?",
                        [preview, row["id"]],
                    )
                    updated += 1
    except Exception:
        logger.exception("Failed to backfill note preview_text values")
        raise AppwriteException("Failed to backfill note previews")
    return updated
