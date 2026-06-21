import logging
import json
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from flask import Blueprint, abort, jsonify, request
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_helpers import (
    create_row_safe,
    first_row,
    format_datetime,
    list_rows_all,
)
from services.discord_audit import emit_creation_event, format_actor
from services.chat_formatting import _is_public_host, fetch_link_preview, safe_url, url_hash
from services import note_store


notes_api_bp = Blueprint("notes_api", __name__)
logger = logging.getLogger(__name__)

USER_SETTINGS_TABLE_ID = "user_settings"
LINK_PREVIEWS_TABLE_ID = "chat_link_previews"
PAGE_SETUP_COLORS = {"default", "paper", "warm", "blue", "green", "rose", "dark"}
PAGE_SETUP_FONT_TYPES = {"default", "sans", "display", "serif", "mono"}
PAGE_SETUP_MARGIN_MIN = 2
PAGE_SETUP_MARGIN_MAX = 18


@notes_api_bp.errorhandler(404)
def notes_not_found(error):
    return jsonify({"error": "Not found."}), 404


@notes_api_bp.errorhandler(500)
def notes_server_error(error):
    return jsonify({"error": "Unable to complete notes request."}), 500


def _utcnow_iso():
    return format_datetime(datetime.now(timezone.utc))


def _parse_page_setup(value):
    if not value:
        return {}
    if isinstance(value, dict):
        data = value
    elif isinstance(value, str):
        try:
            data = json.loads(value)
        except (TypeError, ValueError):
            return {}
    else:
        return {}
    if not isinstance(data, dict):
        return {}
    return _normalize_page_setup(data)


def _normalize_page_setup(value):
    if not isinstance(value, dict):
        return {}

    normalized = {}
    page_color = value.get("pageColor")
    font_type = value.get("fontType")
    side_margins = value.get("sideMargins")

    if isinstance(page_color, str) and page_color in PAGE_SETUP_COLORS:
        normalized["pageColor"] = page_color
    if isinstance(font_type, str) and font_type in PAGE_SETUP_FONT_TYPES:
        normalized["fontType"] = font_type
    if side_margins is not None:
        try:
            margin_value = round(float(side_margins), 1)
        except (TypeError, ValueError):
            margin_value = None
        if margin_value is not None:
            normalized["sideMargins"] = min(PAGE_SETUP_MARGIN_MAX, max(PAGE_SETUP_MARGIN_MIN, margin_value))

    return normalized


def _load_global_notes_page_setup(user_id):
    settings = first_row(USER_SETTINGS_TABLE_ID, queries=[Query.equal("user_id", [str(user_id)])])
    return _parse_page_setup(settings.get("notes_page_setup_json") if settings else "")


def _note_to_payload(note, global_page_setup=None):
    note_id = note.get("$id") or note.get("id")
    return {
        "$id": note_id,
        "id": note_id,
        "folder_id": note.get("folder_id"),
        "title": note.get("title") or "Untitled",
        "content": note.get("content") or "",
        "preview_text": note.get("preview_text") or "",
        "order": note.get("order") or 0,
        "page_setup": _parse_page_setup(note.get("page_setup_json")),
        "global_page_setup": global_page_setup if global_page_setup is not None else {},
        "created_at": note.get("created_at"),
        "updated_at": note.get("updated_at"),
    }


def _note_owner_or_404(note_id):
    note = note_store.get_note_for_user(note_id, current_user.id)
    if not note:
        abort(404)
    return note


def _folder_owner_or_404(folder_id):
    folder = note_store.get_folder_for_user(folder_id, current_user.id)
    if not folder:
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


def _fallback_link_preview(url):
    parsed = urlparse(url)
    hostname = parsed.netloc or url
    return {
        "url": url,
        "title": hostname,
        "description": "",
        "image_url": "",
        "site_name": hostname,
        "content_type": "",
        "preview_found": False,
    }


def _link_preview_payload(url):
    normalized_url = safe_url(url)
    if not normalized_url:
        return None, 400
    if not _is_public_host(normalized_url):
        return None, 400

    key = url_hash(normalized_url)
    try:
        cached = first_row(LINK_PREVIEWS_TABLE_ID, queries=[Query.equal("url_hash", [key])])
    except AppwriteException:
        logger.exception("Failed to read cached notes link preview")
        cached = None

    if cached:
        return {
            "url": cached.get("url") or normalized_url,
            "title": cached.get("title") or "",
            "description": cached.get("description") or "",
            "image_url": cached.get("image_url") or "",
            "site_name": cached.get("site_name") or "",
            "content_type": cached.get("content_type") or "",
            "preview_found": True,
        }, 200

    try:
        preview = fetch_link_preview(normalized_url)
    except Exception:
        logger.exception("Failed to fetch notes link preview")
        preview = None

    if not preview:
        return _fallback_link_preview(normalized_url), 200

    now = _utcnow_iso()
    try:
        create_row_safe(
            LINK_PREVIEWS_TABLE_ID,
            row_id=str(uuid.uuid4()),
            data={
                "url_hash": key,
                "url": preview.get("url") or normalized_url,
                "title": preview.get("title") or None,
                "description": preview.get("description") or None,
                "image_url": preview.get("image_url") or None,
                "site_name": preview.get("site_name") or None,
                "content_type": preview.get("content_type") or None,
                "created_at": now,
            },
        )
    except AppwriteException:
        logger.exception("Failed to cache notes link preview")

    return {
        "url": preview.get("url") or normalized_url,
        "title": preview.get("title") or "",
        "description": preview.get("description") or "",
        "image_url": preview.get("image_url") or "",
        "site_name": preview.get("site_name") or "",
        "content_type": preview.get("content_type") or "",
        "preview_found": True,
    }, 200


@notes_api_bp.route("/api/notes", methods=["GET"])
@login_required
def list_notes():
    user_id = str(current_user.id)
    try:
        notes = note_store.list_notes_for_user(user_id)
        folders = note_store.list_folders_for_user(user_id)
    except AppwriteException:
        logger.exception("Failed to fetch notes/folders")
        return jsonify({"notes": [], "folders": [], "error": "Unable to fetch notes right now."}), 500

    return jsonify(
        {
            "notes": [note_store.note_list_payload(note) for note in notes],
            "folders": [note_store.folder_payload(folder) for folder in folders],
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
        created = note_store.create_note(
            current_user.id,
            title=title,
            content=content,
            folder_id=folder_id,
            now=_utcnow_iso(),
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


@notes_api_bp.route("/api/notes/tools/link-preview", methods=["GET"])
@login_required
def notes_link_preview():
    payload, status = _link_preview_payload(request.args.get("url", ""))
    if status == 400:
        return jsonify({"error": "Enter a valid public http or https URL."}), 400
    return jsonify(payload), status


@notes_api_bp.route("/api/notes/<note_id>", methods=["GET"])
@login_required
def get_note(note_id):
    note = _note_owner_or_404(note_id)
    try:
        global_page_setup = _load_global_notes_page_setup(current_user.id)
    except AppwriteException:
        logger.exception("Failed to load note page setup defaults")
        global_page_setup = {}
    return jsonify(_note_to_payload(note, global_page_setup=global_page_setup))


@notes_api_bp.route("/api/notes/<note_id>", methods=["PATCH"])
@login_required
def update_note(note_id):
    _note_owner_or_404(note_id)
    payload = request.get_json(silent=True) or {}

    allowed = {"title", "content", "folder_id", "order", "page_setup_json"}
    updates = {key: payload[key] for key in allowed if key in payload}
    if "title" in updates:
        updates["title"] = (updates.get("title") or "").strip() or "Untitled"
    if "folder_id" in updates:
        updates["folder_id"] = _normalize_owned_folder_id(updates.get("folder_id"))
    if "page_setup_json" in updates:
        page_setup = updates.get("page_setup_json")
        if isinstance(page_setup, str):
            try:
                page_setup = json.loads(page_setup)
            except (TypeError, ValueError):
                return jsonify({"error": "Page setup must be valid JSON."}), 400
        updates["page_setup_json"] = json.dumps(_normalize_page_setup(page_setup), separators=(",", ":"))

    if not updates:
        return jsonify({"error": "No updatable fields were provided."}), 400

    updates["updated_at"] = _utcnow_iso()

    try:
        updated = note_store.update_note(note_id, updates)
    except AppwriteException:
        logger.exception("Failed to update note")
        return jsonify({"error": "Unable to update note."}), 500

    try:
        global_page_setup = _load_global_notes_page_setup(current_user.id)
    except AppwriteException:
        logger.exception("Failed to load note page setup defaults")
        global_page_setup = {}
    return jsonify(_note_to_payload(updated, global_page_setup=global_page_setup))


@notes_api_bp.route("/api/notes/<note_id>", methods=["DELETE"])
@login_required
def delete_note(note_id):
    _note_owner_or_404(note_id)
    try:
        note_store.delete_note(note_id)
    except AppwriteException:
        logger.exception("Failed to delete note")
        return jsonify({"error": "Unable to delete note."}), 500

    return jsonify({"ok": True})


@notes_api_bp.route("/api/notes/folders", methods=["POST"])
@login_required
def create_folder():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "New Folder").strip() or "New Folder"

    try:
        created = note_store.create_folder(
            current_user.id,
            name=name,
            now=_utcnow_iso(),
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
    return jsonify(note_store.folder_payload(created)), 201


@notes_api_bp.route("/api/notes/folders/<folder_id>", methods=["PATCH"])
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
        updated = note_store.update_folder(folder_id, updates)
    except AppwriteException:
        logger.exception("Failed to update note folder")
        return jsonify({"error": "Unable to update folder."}), 500

    return jsonify(note_store.folder_payload(updated))


@notes_api_bp.route("/api/notes/folders/<folder_id>", methods=["DELETE"])
@login_required
def delete_folder(folder_id):
    _folder_owner_or_404(folder_id)

    try:
        note_store.delete_folder_and_notes(current_user.id, folder_id)
    except AppwriteException:
        logger.exception("Failed to delete note folder")
        return jsonify({"error": "Unable to delete folder."}), 500

    return jsonify({"ok": True})
