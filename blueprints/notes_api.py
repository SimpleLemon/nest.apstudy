import logging
import json
import io
import uuid
from datetime import datetime, timezone
from urllib.parse import urlparse

from flask import Blueprint, abort, jsonify, request, send_file, url_for
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
from services import note_media


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


def _note_to_payload(note, global_page_setup=None, *, access=None, owner=None):
    note_id = note.get("$id") or note.get("id")
    payload = {
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
    if access is not None:
        payload["access"] = access
    if owner is not None:
        payload["owner"] = owner
    return payload


def _viewer_id():
    if not current_user.is_authenticated:
        return None
    return str(current_user.id)


def _access_denied_response():
    if not current_user.is_authenticated:
        return jsonify({"error": "Log in to view this shared note.", "login_required": True}), 401
    return jsonify({"error": "Not found."}), 404


def _sharing_url(resource_type, resource_id):
    endpoint = "dashboard.note_document" if resource_type == "note" else "dashboard.shared_note_folder"
    key = "note_id" if resource_type == "note" else "folder_id"
    return url_for(endpoint, **{key: resource_id}, _external=True)


def _sharing_payload(resource_type, resource_id):
    state = note_store.sharing_state(resource_type, resource_id)
    return {
        "resource_type": resource_type,
        "resource_id": resource_id,
        "share_url": _sharing_url(resource_type, resource_id),
        **state,
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
        shared_note_ids = note_store.shared_resource_ids(user_id, "note")
        shared_folder_ids = note_store.shared_resource_ids(user_id, "folder")
    except AppwriteException:
        logger.exception("Failed to fetch notes/folders")
        return jsonify({"notes": [], "folders": [], "error": "Unable to fetch notes right now."}), 500

    return jsonify(
        {
            "notes": [
                note_store.note_list_payload(note, is_shared=(note.get("$id") or note.get("id")) in shared_note_ids)
                for note in notes
            ],
            "folders": [
                note_store.folder_payload(folder, is_shared=(folder.get("$id") or folder.get("id")) in shared_folder_ids)
                for folder in folders
            ],
        }
    )


@notes_api_bp.route("/api/notes/shared", methods=["GET"])
@login_required
def list_shared_notes():
    try:
        return jsonify(note_store.list_shared_for_user(current_user.id))
    except AppwriteException:
        logger.exception("Failed to load notes shared with user")
        return jsonify({"folders": [], "notes": [], "error": "Unable to load shared notes."}), 500


@notes_api_bp.route("/api/notes/share-users", methods=["GET"])
@login_required
def search_note_share_users():
    try:
        return jsonify({"results": note_store.search_share_users(request.args.get("q"), current_user.id)})
    except AppwriteException:
        return jsonify({"results": [], "error": "Unable to search users."}), 500


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


def _media_payload(note_id, media):
    media_id = media.get("$id") or media.get("id")
    return {
        "id": media_id,
        "url": url_for("notes_api.get_note_media", note_id=note_id, media_id=media_id),
        "name": media.get("original_filename") or "Image",
        "mimeType": media.get("mime_type"),
        "size": media.get("file_size_bytes"),
        "width": media.get("width"),
        "height": media.get("height"),
    }


@notes_api_bp.route("/api/notes/<note_id>/media", methods=["POST"])
@login_required
def upload_note_media(note_id):
    note = _note_owner_or_404(note_id)
    access = note_store.resolve_note_access(note, current_user.id)
    if not access["can_edit"]:
        abort(404)
    uploaded_file = request.files.get("file")
    if not uploaded_file or not uploaded_file.filename:
        return jsonify({"error": "Choose an image to upload."}), 400
    try:
        media = note_media.create_media(note_id, current_user.id, uploaded_file)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except AppwriteException:
        logger.exception("Failed to upload note media")
        return jsonify({"error": "Unable to store this image."}), 500
    return jsonify(_media_payload(note_id, media)), 201


@notes_api_bp.route("/api/notes/<note_id>/media/<media_id>", methods=["GET"])
def get_note_media(note_id, media_id):
    note = note_store.get_note(note_id)
    media = note_media.get_media(media_id)
    if not note or not media or str(media.get("note_id")) != str(note_id):
        abort(404)
    access = note_store.resolve_note_access(note, _viewer_id())
    if not access["can_view"]:
        return _access_denied_response()
    try:
        data = note_media.media_bytes(media)
    except AppwriteException:
        logger.exception("Failed to read note media")
        abort(404)
    response = send_file(
        io.BytesIO(data),
        mimetype=media.get("mime_type") or "application/octet-stream",
        as_attachment=False,
        download_name=media.get("original_filename") or "image",
        conditional=True,
    )
    response.headers["Cache-Control"] = "private, no-cache"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.set_etag(str(media.get("storage_file_id") or media_id))
    return response.make_conditional(request)


@notes_api_bp.route("/api/notes/<note_id>/media/<media_id>", methods=["DELETE"])
@login_required
def delete_note_media(note_id, media_id):
    note = _note_owner_or_404(note_id)
    access = note_store.resolve_note_access(note, current_user.id)
    media = note_media.get_media(media_id)
    if not access["can_edit"] or not media or str(media.get("note_id")) != str(note_id):
        abort(404)
    try:
        note_media.delete_media(media)
    except AppwriteException:
        logger.exception("Failed to delete note media")
        return jsonify({"error": "Unable to delete this image."}), 500
    return jsonify({"ok": True})


@notes_api_bp.route("/api/notes/<note_id>", methods=["GET"])
def get_note(note_id):
    note = note_store.get_note(note_id)
    if not note:
        abort(404)
    access = note_store.resolve_note_access(note, _viewer_id())
    if not access["can_view"]:
        return _access_denied_response()
    try:
        global_page_setup = _load_global_notes_page_setup(note.get("user_id"))
    except AppwriteException:
        logger.exception("Failed to load note page setup defaults")
        global_page_setup = {}
    owner = note_store.get_safe_user(note.get("user_id"))
    return jsonify(_note_to_payload(note, global_page_setup=global_page_setup, access=access, owner=owner))


@notes_api_bp.route("/api/notes/<note_id>", methods=["PATCH"])
@login_required
def update_note(note_id):
    note = _note_owner_or_404(note_id)
    access = note_store.resolve_note_access(note, current_user.id)
    if not access["can_edit"]:
        abort(404)
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
    if "content" in updates:
        try:
            note_media.sync_note_media(note_id, updates["content"])
        except AppwriteException:
            logger.exception("Failed to synchronize note media references")

    try:
        global_page_setup = _load_global_notes_page_setup(note.get("user_id"))
    except AppwriteException:
        logger.exception("Failed to load note page setup defaults")
        global_page_setup = {}
    owner = note_store.get_safe_user(note.get("user_id"))
    return jsonify(_note_to_payload(updated, global_page_setup=global_page_setup, access=access, owner=owner))


@notes_api_bp.route("/api/notes/<note_id>/sharing", methods=["GET", "PATCH"])
@login_required
def note_sharing(note_id):
    note = _note_owner_or_404(note_id)
    access = note_store.resolve_note_access(note, current_user.id)
    if not access["can_share"]:
        abort(404)
    if request.method == "GET":
        return jsonify(_sharing_payload("note", note_id))
    return _replace_sharing("note", note_id, note.get("user_id"))


@notes_api_bp.route("/api/notes/<note_id>", methods=["DELETE"])
@login_required
def delete_note(note_id):
    _note_owner_or_404(note_id)
    try:
        note_media.delete_note_media(note_id)
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


@notes_api_bp.route("/api/notes/folders/<folder_id>", methods=["GET"])
def get_shared_folder(folder_id):
    folder = note_store.get_folder(folder_id)
    if not folder:
        abort(404)
    access = note_store.resolve_folder_access(folder, _viewer_id())
    if not access["can_view"]:
        return _access_denied_response()
    owner = note_store.get_safe_user(folder.get("user_id"))
    notes = [note_store.note_list_payload(note, owner=owner) for note in note_store.list_notes_in_folder(folder_id)]
    return jsonify({
        "folder": note_store.folder_payload(folder, is_shared=True, owner=owner),
        "notes": notes,
        "owner": owner,
        "access": access,
    })


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


@notes_api_bp.route("/api/notes/folders/<folder_id>/sharing", methods=["GET", "PATCH"])
@login_required
def folder_sharing(folder_id):
    folder = _folder_owner_or_404(folder_id)
    access = note_store.resolve_folder_access(folder, current_user.id)
    if not access["can_share"]:
        abort(404)
    if request.method == "GET":
        return jsonify(_sharing_payload("folder", folder_id))
    return _replace_sharing("folder", folder_id, folder.get("user_id"))


@notes_api_bp.route("/api/notes/folders/<folder_id>", methods=["DELETE"])
@login_required
def delete_folder(folder_id):
    _folder_owner_or_404(folder_id)

    try:
        for note in note_store.list_notes_in_folder(folder_id):
            note_media.delete_note_media(note.get("$id") or note.get("id"))
        note_store.delete_folder_and_notes(current_user.id, folder_id)
    except AppwriteException:
        logger.exception("Failed to delete note folder")
        return jsonify({"error": "Unable to delete folder."}), 500

    return jsonify({"ok": True})


def _replace_sharing(resource_type, resource_id, owner_user_id):
    payload = request.get_json(silent=True) or {}
    public = payload.get("public")
    if not isinstance(public, bool):
        return jsonify({"error": "public must be a boolean."}), 400
    raw_user_ids = payload.get("user_ids", [])
    if not isinstance(raw_user_ids, list):
        return jsonify({"error": "user_ids must be a list."}), 400
    if len(raw_user_ids) > 100:
        return jsonify({"error": "A resource can be shared with at most 100 users."}), 400

    user_ids = []
    for value in raw_user_ids:
        if not isinstance(value, str):
            return jsonify({"error": "Every user_id must be a valid Nest user ID."}), 400
        user_id = value.strip()
        if not user_id or user_id == str(owner_user_id):
            return jsonify({"error": "Every user_id must be a valid recipient."}), 400
        if user_id in user_ids:
            continue
        if not note_store.get_safe_user(user_id):
            return jsonify({"error": "One or more selected users no longer exist."}), 400
        user_ids.append(user_id)

    try:
        note_store.replace_resource_grants(
            resource_type,
            resource_id,
            owner_user_id,
            public=public,
            user_ids=user_ids,
            granted_by_user_id=current_user.id,
        )
    except AppwriteException:
        return jsonify({"error": "Unable to update sharing."}), 500
    return jsonify(_sharing_payload(resource_type, resource_id))
