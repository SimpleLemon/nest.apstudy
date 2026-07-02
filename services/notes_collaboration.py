"""Persistence and domain operations for collaborative notes."""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timedelta, timezone

from appwrite.exception import AppwriteException

from services.database import db_connection, utcnow_iso
from services import note_store


ROLE_LEVELS = {"viewer", "reviewer", "editor"}
REVIEW_ROLES = {"owner", "editor", "reviewer"}
MANAGER_ROLES = {"owner", "editor"}
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
INVITATION_DAYS = 7
VERSION_DAYS = 30


def row_id():
    return str(uuid.uuid4())


def normalize_role(value):
    role = str(value or "").strip().lower()
    if role not in ROLE_LEVELS:
        raise ValueError("Role must be viewer, reviewer, or editor.")
    return role


def normalize_email(value):
    email = str(value or "").strip()
    if len(email) > 320 or not EMAIL_RE.fullmatch(email):
        raise ValueError("Enter a valid email address.")
    return email.casefold(), email


def _iso_after(days):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat().replace("+00:00", "Z")


def _dicts(rows):
    return [dict(row) for row in rows]


def record_access_event(
    actor_user_id,
    resource_type,
    resource_id,
    action,
    *,
    target_type=None,
    target_id=None,
    old_access_level=None,
    new_access_level=None,
):
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO note_access_events (
                id, actor_user_id, resource_type, resource_id, action,
                target_type, target_id, old_access_level, new_access_level, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                row_id(), str(actor_user_id), str(resource_type), str(resource_id), str(action),
                target_type, str(target_id) if target_id is not None else None,
                old_access_level, new_access_level, utcnow_iso(),
            ],
        )


def list_pending_invitations(resource_type, resource_id):
    now = utcnow_iso()
    with db_connection() as conn:
        conn.execute(
            """
            UPDATE note_share_invitations
            SET status = 'expired', updated_at = ?
            WHERE status = 'pending' AND expires_at <= ?
            """,
            [now, now],
        )
        rows = conn.execute(
            """
            SELECT id, email_display, access_level, expires_at, created_at, updated_at
            FROM note_share_invitations
            WHERE resource_type = ? AND resource_id = ? AND status = 'pending'
            ORDER BY LOWER(email_display)
            """,
            [resource_type, str(resource_id)],
        ).fetchall()
    return [
        {
            "id": row["id"],
            "email": row["email_display"],
            "role": row["access_level"],
            "status": "pending",
            "expires_at": row["expires_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        for row in rows
    ]


def replace_pending_invitations(
    resource_type,
    resource_id,
    owner_user_id,
    invitations,
    actor_user_id,
):
    normalized = []
    seen = set()
    for invitation in invitations:
        if not isinstance(invitation, dict):
            raise ValueError("Every invitation must be an object.")
        email_normalized, email_display = normalize_email(invitation.get("email"))
        if email_normalized in seen:
            continue
        seen.add(email_normalized)
        normalized.append((email_normalized, email_display, normalize_role(invitation.get("role"))))

    now = utcnow_iso()
    expiry = _iso_after(INVITATION_DAYS)
    with db_connection() as conn:
        existing = {
            row["email_normalized"]: dict(row)
            for row in conn.execute(
                """
                SELECT * FROM note_share_invitations
                WHERE resource_type = ? AND resource_id = ? AND status = 'pending'
                """,
                [resource_type, str(resource_id)],
            ).fetchall()
        }
        retained = {email for email, _, _ in normalized}
        for email, row in existing.items():
            if email not in retained:
                conn.execute(
                    "UPDATE note_share_invitations SET status = 'revoked', updated_at = ? WHERE id = ?",
                    [now, row["id"]],
                )
        for email, display, role in normalized:
            row = existing.get(email)
            if row:
                conn.execute(
                    """
                    UPDATE note_share_invitations
                    SET email_display = ?, access_level = ?, invited_by_user_id = ?,
                        expires_at = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    [display, role, str(actor_user_id), expiry, now, row["id"]],
                )
            else:
                conn.execute(
                    """
                    INSERT INTO note_share_invitations (
                        id, owner_user_id, resource_type, resource_id, email_normalized,
                        email_display, access_level, invited_by_user_id, status,
                        expires_at, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                    """,
                    [
                        row_id(), str(owner_user_id), resource_type, str(resource_id), email,
                        display, role, str(actor_user_id), expiry, now, now,
                    ],
                )
        table = "notes" if resource_type == "note" else "note_folders"
        conn.execute(
            f"UPDATE {table} SET access_version = access_version + 1, updated_at = ? WHERE id = ?",
            [now, str(resource_id)],
        )
    return list_pending_invitations(resource_type, resource_id)


def claim_pending_invitations(user_id, email):
    normalized_email, _ = normalize_email(email)
    now = utcnow_iso()
    claimed = []
    with db_connection() as conn:
        conn.execute(
            """
            UPDATE note_share_invitations SET status = 'expired', updated_at = ?
            WHERE status = 'pending' AND expires_at <= ?
            """,
            [now, now],
        )
        rows = conn.execute(
            """
            SELECT * FROM note_share_invitations
            WHERE email_normalized = ? AND status = 'pending' AND expires_at > ?
            """,
            [normalized_email, now],
        ).fetchall()
        for row in rows:
            existing = conn.execute(
                """
                SELECT id, access_level FROM note_access_grants
                WHERE resource_type = ? AND resource_id = ?
                  AND principal_type = 'user' AND principal_id = ?
                """,
                [row["resource_type"], row["resource_id"], str(user_id)],
            ).fetchone()
            invited_role = normalize_role(row["access_level"])
            if existing:
                current = note_store._normalized_access_level(existing["access_level"])
                if note_store.ACCESS_RANK[invited_role] > note_store.ACCESS_RANK[current]:
                    conn.execute(
                        "UPDATE note_access_grants SET access_level = ?, updated_at = ? WHERE id = ?",
                        [invited_role, now, existing["id"]],
                    )
            else:
                conn.execute(
                    """
                    INSERT INTO note_access_grants (
                        id, owner_user_id, resource_type, resource_id, principal_type,
                        principal_id, access_level, granted_by_user_id, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)
                    """,
                    [
                        row_id(), row["owner_user_id"], row["resource_type"], row["resource_id"],
                        str(user_id), invited_role, row["invited_by_user_id"], now, now,
                    ],
                )
            table = "notes" if row["resource_type"] == "note" else "note_folders"
            conn.execute(
                f"UPDATE {table} SET access_version = access_version + 1, updated_at = ? WHERE id = ?",
                [now, row["resource_id"]],
            )
            conn.execute(
                """
                UPDATE note_share_invitations
                SET status = 'accepted', accepted_user_id = ?, accepted_at = ?, updated_at = ?
                WHERE id = ?
                """,
                [str(user_id), now, now, row["id"]],
            )
            claimed.append(dict(row))
    return claimed


def create_notification(user_id, notification_type, message, *, actor_user_id=None, note_id=None, thread_id=None, suggestion_id=None):
    if str(user_id) == str(actor_user_id or ""):
        return None
    notification_id = row_id()
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO user_notifications (
                id, user_id, actor_user_id, notification_type, note_id, thread_id,
                suggestion_id, message, is_read, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            [
                notification_id, str(user_id), str(actor_user_id) if actor_user_id else None,
                notification_type, note_id, thread_id, suggestion_id,
                str(message)[:500], utcnow_iso(),
            ],
        )
    return notification_id


def list_notifications(user_id, limit=50):
    with db_connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM user_notifications WHERE user_id = ?
            ORDER BY created_at DESC LIMIT ?
            """,
            [str(user_id), min(max(int(limit), 1), 100)],
        ).fetchall()
        unread = conn.execute(
            "SELECT COUNT(*) AS count FROM user_notifications WHERE user_id = ? AND is_read = 0",
            [str(user_id)],
        ).fetchone()["count"]
    return {"notifications": _dicts(rows), "unread_count": int(unread or 0)}


def mark_notifications_read(user_id, notification_ids=None):
    now = utcnow_iso()
    with db_connection() as conn:
        if notification_ids:
            placeholders = ",".join("?" for _ in notification_ids)
            conn.execute(
                f"UPDATE user_notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND id IN ({placeholders})",
                [now, str(user_id), *[str(value) for value in notification_ids]],
            )
        else:
            conn.execute(
                "UPDATE user_notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0",
                [now, str(user_id)],
            )
    return list_notifications(user_id)


def _note_participant_ids(note_id, include_reviewers=True):
    note = note_store.get_note(note_id)
    if not note:
        return []
    ids = {str(note.get("user_id"))}
    grants = list(note_store.resource_grants("note", note_id))
    folder_id = note.get("folder_id")
    if folder_id:
        grants.extend(note_store.resource_grants("folder", folder_id))
    for grant in grants:
        if grant.get("principal_type") != "user":
            continue
        level = note_store._normalized_access_level(grant.get("access_level"))
        if level == "viewer" or (level == "reviewer" and not include_reviewers):
            continue
        ids.add(str(grant.get("principal_id")))
    return sorted(ids)


def list_suggestions(note_id):
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM note_suggestions WHERE note_id = ? ORDER BY created_at ASC",
            [str(note_id)],
        ).fetchall()
    payload = []
    for row in rows:
        item = dict(row)
        item["operations"] = json.loads(item.pop("operations_json") or "[]")
        item["author"] = note_store.get_safe_user(item.get("author_user_id"))
        item["resolved_by"] = note_store.get_safe_user(item.get("resolved_by_user_id"))
        payload.append(item)
    return payload


def create_suggestion(note_id, author_user_id, payload):
    operations = payload.get("operations")
    if not isinstance(operations, list) or not operations or len(operations) > 100:
        raise ValueError("A suggestion requires one to 100 operations.")
    encoded = json.dumps(operations, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 256_000:
        raise ValueError("Suggestion is too large.")
    now = utcnow_iso()
    suggestion_id = row_id()
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO note_suggestions (
                id, note_id, author_user_id, status, operation_kind, operations_json,
                anchor_start, anchor_end, block_id, base_state_vector, summary,
                created_at, updated_at
            ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                suggestion_id, str(note_id), str(author_user_id),
                str(payload.get("operation_kind") or "batch")[:64], encoded,
                payload.get("anchor_start"), payload.get("anchor_end"), payload.get("block_id"),
                payload.get("base_state_vector"), str(payload.get("summary") or "")[:500], now, now,
            ],
        )
    for user_id in _note_participant_ids(note_id, include_reviewers=False):
        create_notification(
            user_id, "note_suggestion_created", "A new note suggestion is ready for review.",
            actor_user_id=author_user_id, note_id=note_id, suggestion_id=suggestion_id,
        )
    return next(row for row in list_suggestions(note_id) if row["id"] == suggestion_id)


def resolve_suggestion(note_id, suggestion_id, resolver_user_id, status):
    if status not in {"accepted", "rejected", "conflicted"}:
        raise ValueError("Unsupported suggestion status.")
    now = utcnow_iso()
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM note_suggestions WHERE id = ? AND note_id = ?",
            [str(suggestion_id), str(note_id)],
        ).fetchone()
        if not row:
            return None
        if row["status"] != "open":
            raise ValueError("Suggestion is already resolved.")
        conn.execute(
            """
            UPDATE note_suggestions SET status = ?, resolved_by_user_id = ?,
                resolved_at = ?, updated_at = ? WHERE id = ?
            """,
            [status, str(resolver_user_id), now, now, str(suggestion_id)],
        )
    create_notification(
        row["author_user_id"], f"note_suggestion_{status}",
        f"Your note suggestion was {status}.", actor_user_id=resolver_user_id,
        note_id=note_id, suggestion_id=suggestion_id,
    )
    return next(row for row in list_suggestions(note_id) if row["id"] == str(suggestion_id))


def list_comments(note_id):
    with db_connection() as conn:
        threads = _dicts(conn.execute(
            "SELECT * FROM note_comment_threads WHERE note_id = ? ORDER BY created_at ASC",
            [str(note_id)],
        ).fetchall())
        replies = _dicts(conn.execute(
            """
            SELECT r.* FROM note_comment_replies r
            JOIN note_comment_threads t ON t.id = r.thread_id
            WHERE t.note_id = ? ORDER BY r.created_at ASC
            """,
            [str(note_id)],
        ).fetchall())
    by_thread = {}
    for reply in replies:
        reply["author"] = note_store.get_safe_user(reply.get("author_user_id"))
        by_thread.setdefault(reply["thread_id"], []).append(reply)
    for thread in threads:
        thread["author"] = note_store.get_safe_user(thread.get("author_user_id"))
        thread["resolved_by"] = note_store.get_safe_user(thread.get("resolved_by_user_id"))
        thread["replies"] = by_thread.get(thread["id"], [])
    return threads


def create_comment(note_id, author_user_id, payload):
    body = str(payload.get("body") or "").strip()
    if not body or len(body) > 5000:
        raise ValueError("Comment must contain 1 to 5,000 characters.")
    now = utcnow_iso()
    thread_id = row_id()
    with db_connection() as conn:
        conn.execute(
            """
            INSERT INTO note_comment_threads (
                id, note_id, author_user_id, body, anchor_start, anchor_end,
                block_id, quoted_text, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
            """,
            [
                thread_id, str(note_id), str(author_user_id), body,
                payload.get("anchor_start"), payload.get("anchor_end"), payload.get("block_id"),
                str(payload.get("quoted_text") or "")[:1000], now, now,
            ],
        )
    for user_id in _note_participant_ids(note_id):
        create_notification(
            user_id, "note_comment_created", "A new comment was added to a shared note.",
            actor_user_id=author_user_id, note_id=note_id, thread_id=thread_id,
        )
    return next(row for row in list_comments(note_id) if row["id"] == thread_id)


def reply_to_comment(note_id, thread_id, author_user_id, body):
    body = str(body or "").strip()
    if not body or len(body) > 5000:
        raise ValueError("Reply must contain 1 to 5,000 characters.")
    now = utcnow_iso()
    reply_id = row_id()
    with db_connection() as conn:
        thread = conn.execute(
            "SELECT * FROM note_comment_threads WHERE id = ? AND note_id = ?",
            [str(thread_id), str(note_id)],
        ).fetchone()
        if not thread:
            return None
        conn.execute(
            "INSERT INTO note_comment_replies (id, thread_id, author_user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [reply_id, str(thread_id), str(author_user_id), body, now, now],
        )
        conn.execute("UPDATE note_comment_threads SET updated_at = ? WHERE id = ?", [now, str(thread_id)])
        participant_rows = conn.execute(
            "SELECT DISTINCT author_user_id FROM note_comment_replies WHERE thread_id = ?",
            [str(thread_id)],
        ).fetchall()
    recipients = {str(thread["author_user_id"]), *[str(row["author_user_id"]) for row in participant_rows]}
    for user_id in recipients:
        create_notification(
            user_id, "note_comment_reply", "Someone replied to a note comment.",
            actor_user_id=author_user_id, note_id=note_id, thread_id=thread_id,
        )
    return next(row for row in list_comments(note_id) if row["id"] == str(thread_id))


def set_comment_status(note_id, thread_id, resolver_user_id, status):
    if status not in {"open", "resolved"}:
        raise ValueError("Unsupported comment status.")
    now = utcnow_iso()
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM note_comment_threads WHERE id = ? AND note_id = ?",
            [str(thread_id), str(note_id)],
        ).fetchone()
        if not row:
            return None
        conn.execute(
            """
            UPDATE note_comment_threads SET status = ?, resolved_by_user_id = ?,
                resolved_at = ?, updated_at = ? WHERE id = ?
            """,
            [
                status,
                str(resolver_user_id) if status == "resolved" else None,
                now if status == "resolved" else None,
                now, str(thread_id),
            ],
        )
    create_notification(
        row["author_user_id"], f"note_comment_{status}", f"Your note comment was {status}.",
        actor_user_id=resolver_user_id, note_id=note_id, thread_id=thread_id,
    )
    return next(item for item in list_comments(note_id) if item["id"] == str(thread_id))


def create_version(note_id, actor_user_id=None, *, reason="automatic", name=None):
    now = utcnow_iso()
    expires = _iso_after(VERSION_DAYS)
    with db_connection() as conn:
        note = conn.execute("SELECT * FROM notes WHERE id = ?", [str(note_id)]).fetchone()
        if not note:
            return None
        collab = conn.execute(
            "SELECT * FROM note_collaboration_documents WHERE note_id = ?",
            [str(note_id)],
        ).fetchone()
        version_id = row_id()
        conn.execute(
            """
            INSERT INTO note_versions (
                id, note_id, actor_user_id, reason, name, ydoc_blob, title,
                content, page_setup_json, durable_revision, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                version_id, str(note_id), str(actor_user_id) if actor_user_id else None,
                str(reason)[:64], str(name)[:120] if name else None,
                collab["ydoc_blob"] if collab else None, note["title"] or "Untitled",
                note["content"] or "", note["page_setup_json"],
                int(collab["durable_revision"] or 0) if collab else 0, now, expires,
            ],
        )
    return get_version(note_id, version_id)


def get_version(note_id, version_id):
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM note_versions WHERE id = ? AND note_id = ?",
            [str(version_id), str(note_id)],
        ).fetchone()
    if not row:
        return None
    payload = dict(row)
    payload.pop("ydoc_blob", None)
    payload["actor"] = note_store.get_safe_user(payload.get("actor_user_id"))
    return payload


def list_versions(note_id):
    with db_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM note_versions WHERE note_id = ? AND expires_at > ? ORDER BY created_at DESC",
            [str(note_id), utcnow_iso()],
        ).fetchall()
    payload = []
    for row in rows:
        item = dict(row)
        item.pop("ydoc_blob", None)
        item["actor"] = note_store.get_safe_user(item.get("actor_user_id"))
        payload.append(item)
    return payload


def restore_version(note_id, version_id, actor_user_id):
    create_version(note_id, actor_user_id, reason="before_restore")
    now = utcnow_iso()
    with db_connection() as conn:
        version = conn.execute(
            "SELECT * FROM note_versions WHERE id = ? AND note_id = ?",
            [str(version_id), str(note_id)],
        ).fetchone()
        if not version:
            return None
        conn.execute(
            """
            UPDATE notes SET title = ?, content = ?, page_setup_json = ?,
                updated_at = ?, access_version = access_version + 1 WHERE id = ?
            """,
            [version["title"], version["content"], version["page_setup_json"], now, str(note_id)],
        )
        if version["ydoc_blob"] is not None:
            conn.execute(
                """
                INSERT INTO note_collaboration_documents (
                    note_id, ydoc_blob, schema_version, durable_revision,
                    projection_revision, initialized_at, updated_at
                ) VALUES (?, ?, 1, 1, 1, ?, ?)
                ON CONFLICT(note_id) DO UPDATE SET
                    ydoc_blob = excluded.ydoc_blob,
                    durable_revision = note_collaboration_documents.durable_revision + 1,
                    projection_revision = note_collaboration_documents.projection_revision + 1,
                    updated_at = excluded.updated_at
                """,
                [str(note_id), version["ydoc_blob"], now, now],
            )
    return note_store.get_note(note_id)


def get_collaboration_document(note_id):
    with db_connection() as conn:
        row = conn.execute(
            "SELECT * FROM note_collaboration_documents WHERE note_id = ?",
            [str(note_id)],
        ).fetchone()
    return dict(row) if row else None


def store_collaboration_document(note_id, blob, *, title=None, content=None, page_setup_json=None, schema_version=1):
    if not isinstance(blob, (bytes, bytearray)) or len(blob) > 10 * 1024 * 1024:
        raise ValueError("Collaboration document is invalid or too large.")
    now = utcnow_iso()
    with db_connection() as conn:
        note = conn.execute("SELECT * FROM notes WHERE id = ?", [str(note_id)]).fetchone()
        if not note:
            return None
        current = conn.execute(
            "SELECT durable_revision FROM note_collaboration_documents WHERE note_id = ?",
            [str(note_id)],
        ).fetchone()
        revision = int(current["durable_revision"] or 0) + 1 if current else 1
        conn.execute(
            """
            INSERT INTO note_collaboration_documents (
                note_id, ydoc_blob, schema_version, durable_revision,
                projection_revision, initialized_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(note_id) DO UPDATE SET
                ydoc_blob = excluded.ydoc_blob,
                schema_version = excluded.schema_version,
                durable_revision = excluded.durable_revision,
                projection_revision = excluded.projection_revision,
                updated_at = excluded.updated_at
            """,
            [str(note_id), bytes(blob), int(schema_version), revision, revision, now, now],
        )
        updates = {"updated_at": now, "collaboration_enabled": 1}
        if title is not None:
            updates["title"] = str(title).strip() or "Untitled"
        if content is not None:
            updates["content"] = str(content)
            from services.notes_preview import preview_text_from_content
            updates["preview_text"] = preview_text_from_content(str(content))
        if page_setup_json is not None:
            updates["page_setup_json"] = str(page_setup_json)
        assignments = ", ".join(f"{key} = ?" for key in updates)
        conn.execute(
            f"UPDATE notes SET {assignments} WHERE id = ?",
            [*updates.values(), str(note_id)],
        )
    return {"note_id": str(note_id), "durable_revision": revision, "updated_at": now}


def transfer_note(note_id, current_owner_id, new_owner_id):
    now = utcnow_iso()
    create_version(note_id, current_owner_id, reason="before_transfer")
    with db_connection() as conn:
        note = conn.execute(
            "SELECT * FROM notes WHERE id = ? AND user_id = ?",
            [str(note_id), str(current_owner_id)],
        ).fetchone()
        if not note:
            return None
        target = conn.execute("SELECT id FROM users WHERE id = ?", [str(new_owner_id)]).fetchone()
        grant = conn.execute(
            """
            SELECT access_level FROM note_access_grants
            WHERE resource_type = 'note' AND resource_id = ?
              AND principal_type = 'user' AND principal_id = ?
            """,
            [str(note_id), str(new_owner_id)],
        ).fetchone()
        inherited = None
        if note["folder_id"]:
            inherited = conn.execute(
                """
                SELECT access_level FROM note_access_grants
                WHERE resource_type = 'folder' AND resource_id = ?
                  AND principal_type = 'user' AND principal_id = ?
                """,
                [note["folder_id"], str(new_owner_id)],
            ).fetchone()
            folder_grants = conn.execute(
                """
                SELECT * FROM note_access_grants
                WHERE resource_type = 'folder' AND resource_id = ? AND principal_type = 'user'
                """,
                [note["folder_id"]],
            ).fetchall()
            for inherited_grant in folder_grants:
                conn.execute(
                    """
                    INSERT INTO note_access_grants (
                        id, owner_user_id, resource_type, resource_id, principal_type,
                        principal_id, access_level, granted_by_user_id, created_at, updated_at
                    ) VALUES (?, ?, 'note', ?, 'user', ?, ?, ?, ?, ?)
                    ON CONFLICT(resource_type, resource_id, principal_type, principal_id)
                    DO UPDATE SET access_level = CASE
                        WHEN excluded.access_level = 'editor' THEN 'editor'
                        WHEN excluded.access_level = 'reviewer' AND note_access_grants.access_level = 'viewer' THEN 'reviewer'
                        ELSE note_access_grants.access_level END,
                        updated_at = excluded.updated_at
                    """,
                    [
                        row_id(), str(new_owner_id), str(note_id), inherited_grant["principal_id"],
                        inherited_grant["access_level"], str(current_owner_id), now, now,
                    ],
                )
        effective_target = None
        for candidate in (grant, inherited):
            if not candidate:
                continue
            level = note_store._normalized_access_level(candidate["access_level"])
            if effective_target is None or note_store.ACCESS_RANK[level] > note_store.ACCESS_RANK[effective_target]:
                effective_target = level
        if not target or effective_target != "editor":
            raise ValueError("Ownership can only be transferred to an existing Editor.")
        conn.execute(
            "DELETE FROM note_access_grants WHERE resource_type = 'note' AND resource_id = ? AND principal_type = 'user' AND principal_id = ?",
            [str(note_id), str(new_owner_id)],
        )
        conn.execute(
            "UPDATE note_access_grants SET owner_user_id = ? WHERE resource_type = 'note' AND resource_id = ?",
            [str(new_owner_id), str(note_id)],
        )
        conn.execute(
            """
            INSERT INTO note_access_grants (
                id, owner_user_id, resource_type, resource_id, principal_type,
                principal_id, access_level, granted_by_user_id, created_at, updated_at
            ) VALUES (?, ?, 'note', ?, 'user', ?, 'editor', ?, ?, ?)
            """,
            [row_id(), str(new_owner_id), str(note_id), str(current_owner_id), str(current_owner_id), now, now],
        )
        conn.execute(
            "UPDATE notes SET user_id = ?, folder_id = NULL, access_version = access_version + 1, updated_at = ? WHERE id = ?",
            [str(new_owner_id), now, str(note_id)],
        )
        conn.execute(
            "UPDATE note_share_invitations SET owner_user_id = ?, updated_at = ? WHERE resource_type = 'note' AND resource_id = ? AND status = 'pending'",
            [str(new_owner_id), now, str(note_id)],
        )
    create_notification(
        new_owner_id, "note_ownership_transferred", "You are now the owner of a shared note.",
        actor_user_id=current_owner_id, note_id=note_id,
    )
    return note_store.get_note(note_id)


def transfer_folder(folder_id, current_owner_id, new_owner_id):
    now = utcnow_iso()
    with db_connection() as conn:
        folder = conn.execute(
            "SELECT * FROM note_folders WHERE id = ? AND user_id = ?",
            [str(folder_id), str(current_owner_id)],
        ).fetchone()
        if not folder:
            return None
        target = conn.execute("SELECT id FROM users WHERE id = ?", [str(new_owner_id)]).fetchone()
        grant = conn.execute(
            """
            SELECT access_level FROM note_access_grants
            WHERE resource_type = 'folder' AND resource_id = ?
              AND principal_type = 'user' AND principal_id = ?
            """,
            [str(folder_id), str(new_owner_id)],
        ).fetchone()
        if not target or not grant or grant["access_level"] != "editor":
            raise ValueError("Ownership can only be transferred to an existing folder Editor.")
        note_ids = [row["id"] for row in conn.execute("SELECT id FROM notes WHERE folder_id = ?", [str(folder_id)]).fetchall()]
        for note_id in note_ids:
            # Record a projection snapshot inside the same transaction.
            note = conn.execute("SELECT * FROM notes WHERE id = ?", [note_id]).fetchone()
            collab = conn.execute("SELECT * FROM note_collaboration_documents WHERE note_id = ?", [note_id]).fetchone()
            conn.execute(
                """
                INSERT INTO note_versions (
                    id, note_id, actor_user_id, reason, ydoc_blob, title, content,
                    page_setup_json, durable_revision, created_at, expires_at
                ) VALUES (?, ?, ?, 'before_transfer', ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    row_id(), note_id, str(current_owner_id), collab["ydoc_blob"] if collab else None,
                    note["title"] or "Untitled", note["content"] or "", note["page_setup_json"],
                    int(collab["durable_revision"] or 0) if collab else 0, now, _iso_after(VERSION_DAYS),
                ],
            )
        conn.execute(
            "DELETE FROM note_access_grants WHERE resource_type = 'folder' AND resource_id = ? AND principal_type = 'user' AND principal_id = ?",
            [str(folder_id), str(new_owner_id)],
        )
        conn.execute(
            "UPDATE note_access_grants SET owner_user_id = ? WHERE resource_type = 'folder' AND resource_id = ?",
            [str(new_owner_id), str(folder_id)],
        )
        conn.execute(
            """
            INSERT INTO note_access_grants (
                id, owner_user_id, resource_type, resource_id, principal_type,
                principal_id, access_level, granted_by_user_id, created_at, updated_at
            ) VALUES (?, ?, 'folder', ?, 'user', ?, 'editor', ?, ?, ?)
            """,
            [row_id(), str(new_owner_id), str(folder_id), str(current_owner_id), str(current_owner_id), now, now],
        )
        conn.execute(
            "UPDATE note_folders SET user_id = ?, access_version = access_version + 1, updated_at = ? WHERE id = ?",
            [str(new_owner_id), now, str(folder_id)],
        )
        conn.execute(
            "UPDATE notes SET user_id = ?, access_version = access_version + 1, updated_at = ? WHERE folder_id = ?",
            [str(new_owner_id), now, str(folder_id)],
        )
        if note_ids:
            placeholders = ",".join("?" for _ in note_ids)
            conn.execute(
                f"UPDATE note_access_grants SET owner_user_id = ? WHERE resource_type = 'note' AND resource_id IN ({placeholders})",
                [str(new_owner_id), *note_ids],
            )
            conn.execute(
                f"UPDATE note_share_invitations SET owner_user_id = ?, updated_at = ? WHERE resource_type = 'note' AND resource_id IN ({placeholders}) AND status = 'pending'",
                [str(new_owner_id), now, *note_ids],
            )
        conn.execute(
            "UPDATE note_share_invitations SET owner_user_id = ?, updated_at = ? WHERE resource_type = 'folder' AND resource_id = ? AND status = 'pending'",
            [str(new_owner_id), now, str(folder_id)],
        )
    create_notification(
        new_owner_id, "note_folder_ownership_transferred", "You are now the owner of a shared notes folder.",
        actor_user_id=current_owner_id,
    )
    return note_store.get_folder(folder_id)


def cleanup_expired_collaboration_rows():
    now = utcnow_iso()
    with db_connection() as conn:
        invitations = conn.execute(
            "UPDATE note_share_invitations SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at <= ?",
            [now, now],
        ).rowcount
        versions = conn.execute("DELETE FROM note_versions WHERE expires_at <= ?", [now]).rowcount
    return {"invitations_expired": invitations, "versions_deleted": versions}
