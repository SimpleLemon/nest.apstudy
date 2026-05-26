import logging
import uuid
from datetime import datetime, timezone

from flask import Blueprint, abort, jsonify, request
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    format_datetime,
    get_row_safe,
    list_rows_all,
    update_row_safe,
)
from services.discord_audit import emit_creation_event, format_actor


notes_api_bp = Blueprint("notes_api", __name__)
logger = logging.getLogger(__name__)

NOTES_TABLE_ID = "notes"
FOLDERS_TABLE_ID = "note_folders"


@notes_api_bp.errorhandler(404)
def notes_not_found(error):
    return jsonify({"error": "Not found."}), 404


@notes_api_bp.errorhandler(500)
def notes_server_error(error):
    return jsonify({"error": "Unable to complete notes request."}), 500


def _utcnow_iso():
    return format_datetime(datetime.now(timezone.utc))


def _note_to_payload(note):
    note_id = note.get("$id") or note.get("id")
    return {
        "$id": note_id,
        "id": note_id,
        "folder_id": note.get("folder_id"),
        "title": note.get("title") or "Untitled",
        "content": note.get("content") or "",
        "order": note.get("order") or 0,
        "created_at": note.get("created_at"),
        "updated_at": note.get("updated_at"),
    }


def _folder_to_payload(folder):
    folder_id = folder.get("$id") or folder.get("id")
    return {
        "$id": folder_id,
        "id": folder_id,
        "name": folder.get("name") or "Untitled Folder",
        "order": folder.get("order") or 0,
        "created_at": folder.get("created_at"),
    }


def _note_owner_or_404(note_id):
    try:
        note = get_row_safe(NOTES_TABLE_ID, note_id, allow_missing=True)
    except AppwriteException:
        logger.exception("Failed to read note")
        abort(500)

    if not note or note.get("user_id") != str(current_user.id):
        abort(404)
    return note


def _folder_owner_or_404(folder_id):
    try:
        folder = get_row_safe(FOLDERS_TABLE_ID, folder_id, allow_missing=True)
    except AppwriteException:
        logger.exception("Failed to read folder")
        abort(500)

    if not folder or folder.get("user_id") != str(current_user.id):
        abort(404)
    return folder


def _normalize_owned_folder_id(folder_id):
    if not folder_id:
        return None
    normalized = str(folder_id).strip()
    if not normalized:
        return None
    _folder_owner_or_404(normalized)
    return normalized


@notes_api_bp.route("/api/notes", methods=["GET"])
@login_required
def list_notes():
    user_id = str(current_user.id)
    try:
        notes = list_rows_all(
            NOTES_TABLE_ID,
            queries=[Query.equal("user_id", [user_id])],
        )
        folders = list_rows_all(
            FOLDERS_TABLE_ID,
            queries=[Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to fetch notes/folders")
        return jsonify({"notes": [], "folders": [], "error": "Unable to fetch notes right now."}), 500

    return jsonify(
        {
            "notes": [_note_to_payload(note) for note in notes],
            "folders": [_folder_to_payload(folder) for folder in folders],
        }
    )


@notes_api_bp.route("/api/notes", methods=["POST"])
@login_required
def create_note():
    payload = request.get_json(silent=True) or {}
    title = (payload.get("title") or "Untitled").strip() or "Untitled"
    content = payload.get("content") or ""
    folder_id = _normalize_owned_folder_id(payload.get("folder_id"))

    try:
        notes = list_rows_all(
            NOTES_TABLE_ID,
            queries=[Query.equal("user_id", [str(current_user.id)])],
        )
        max_order = max((int(note.get("order") or 0) for note in notes), default=0)

        created = create_row_safe(
            NOTES_TABLE_ID,
            row_id=str(uuid.uuid4()),
            data={
                "user_id": str(current_user.id),
                "folder_id": folder_id,
                "title": title,
                "content": content,
                "order": max_order + 1000,
                "created_at": _utcnow_iso(),
                "updated_at": _utcnow_iso(),
            },
        )
    except AppwriteException:
        logger.exception("Failed to create note")
        return jsonify({"error": "Unable to create note."}), 500

    emit_creation_event(
        "New Note Created",
        actor=format_actor(current_user),
        target=title,
        metadata={
            "page_context": "notes",
            "resource_type": "note",
            "resource_id": created.get("$id") or created.get("id"),
            "folder_id": folder_id,
        },
        color="green",
    )
    return jsonify(_note_to_payload(created)), 201


@notes_api_bp.route("/api/notes/<note_id>", methods=["GET"])
@login_required
def get_note(note_id):
    note = _note_owner_or_404(note_id)
    return jsonify(_note_to_payload(note))


@notes_api_bp.route("/api/notes/<note_id>", methods=["PATCH"])
@login_required
def update_note(note_id):
    _note_owner_or_404(note_id)
    payload = request.get_json(silent=True) or {}

    allowed = {"title", "content", "folder_id", "order"}
    updates = {key: payload[key] for key in allowed if key in payload}
    if "title" in updates:
        updates["title"] = (updates.get("title") or "").strip() or "Untitled"
    if "folder_id" in updates:
        updates["folder_id"] = _normalize_owned_folder_id(updates.get("folder_id"))

    if not updates:
        return jsonify({"error": "No updatable fields were provided."}), 400

    updates["updated_at"] = _utcnow_iso()

    try:
        updated = update_row_safe(NOTES_TABLE_ID, note_id, updates)
    except AppwriteException:
        logger.exception("Failed to update note")
        return jsonify({"error": "Unable to update note."}), 500

    return jsonify(_note_to_payload(updated))


@notes_api_bp.route("/api/notes/<note_id>", methods=["DELETE"])
@login_required
def delete_note(note_id):
    _note_owner_or_404(note_id)
    try:
        delete_row_safe(NOTES_TABLE_ID, note_id)
    except AppwriteException:
        logger.exception("Failed to delete note")
        return jsonify({"error": "Unable to delete note."}), 500

    return jsonify({"ok": True})


@notes_api_bp.route("/api/note-folders", methods=["POST"])
@notes_api_bp.route("/api/notes/folders", methods=["POST"])
@login_required
def create_folder():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "New Folder").strip() or "New Folder"

    try:
        folders = list_rows_all(
            FOLDERS_TABLE_ID,
            queries=[Query.equal("user_id", [str(current_user.id)])],
        )
        max_order = max((int(folder.get("order") or 0) for folder in folders), default=0)

        created = create_row_safe(
            FOLDERS_TABLE_ID,
            row_id=str(uuid.uuid4()),
            data={
                "user_id": str(current_user.id),
                "name": name,
                "order": max_order + 1000,
                "created_at": _utcnow_iso(),
            },
        )
    except AppwriteException:
        logger.exception("Failed to create note folder")
        return jsonify({"error": "Unable to create folder."}), 500

    emit_creation_event(
        "New Note Folder Created",
        actor=format_actor(current_user),
        target=name,
        metadata={
            "page_context": "notes",
            "resource_type": "note_folder",
            "resource_id": created.get("$id") or created.get("id"),
        },
        color="green",
    )
    return jsonify(_folder_to_payload(created)), 201


@notes_api_bp.route("/api/notes/folders/<folder_id>", methods=["PATCH"])
@notes_api_bp.route("/api/note-folders/<folder_id>", methods=["PATCH"])
@login_required
def update_folder(folder_id):
    _folder_owner_or_404(folder_id)
    payload = request.get_json(silent=True) or {}
    updates = {}

    if "name" in payload:
        updates["name"] = (payload.get("name") or "").strip() or "Untitled Folder"

    if "order" in payload:
        updates["order"] = payload.get("order")

    if not updates:
        return jsonify({"error": "No updatable fields were provided."}), 400

    updates["updated_at"] = _utcnow_iso()

    try:
        updated = update_row_safe(FOLDERS_TABLE_ID, folder_id, updates)
    except AppwriteException:
        logger.exception("Failed to update note folder")
        return jsonify({"error": "Unable to update folder."}), 500

    return jsonify(_folder_to_payload(updated))


@notes_api_bp.route("/api/notes/folders/<folder_id>", methods=["DELETE"])
@notes_api_bp.route("/api/note-folders/<folder_id>", methods=["DELETE"])
@login_required
def delete_folder(folder_id):
    _folder_owner_or_404(folder_id)

    try:
        notes = list_rows_all(
            NOTES_TABLE_ID,
            queries=[
                Query.equal("user_id", [str(current_user.id)]),
                Query.equal("folder_id", [folder_id]),
            ],
        )
        for note in notes:
            note_id = note.get("$id") or note.get("id")
            if note_id:
                delete_row_safe(NOTES_TABLE_ID, note_id)

        delete_row_safe(FOLDERS_TABLE_ID, folder_id)
    except AppwriteException:
        logger.exception("Failed to delete note folder")
        return jsonify({"error": "Unable to delete folder."}), 500

    return jsonify({"ok": True})
