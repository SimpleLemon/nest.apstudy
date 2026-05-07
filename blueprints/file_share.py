import io
import os
import secrets
import uuid
import logging
from datetime import datetime, timedelta, timezone

from flask import (
    Blueprint,
    abort,
    current_app,
    jsonify,
    render_template,
    request,
    send_file,
    url_for,
)
from flask_login import current_user, login_required
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    first_row,
    format_datetime,
    get_row_safe,
    list_rows_all,
    parse_datetime,
    update_row_safe,
)

file_share_bp = Blueprint("file_share", __name__)
logger = logging.getLogger(__name__)

MAX_FILE_SIZE = 50 * 1024 * 1024
DEFAULT_EXPIRY_DAYS = 1
ALLOWED_EXPIRY_OPTIONS = [1, 3, 7, 14, 30]
SHARE_CODE_LENGTH = 7
SHARE_CODE_CHARS = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
PUBLIC_SHARE_BASE_URL = "https://nest.apstudy.org/files/share"


def _utcnow():
    return datetime.now(timezone.utc)


def _isoformat(value):
    if not value:
        return None
    parsed = parse_datetime(value)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _format_expiry_display(value):
    if not value:
        return ""
    return value.strftime("%B %d, %Y at %I:%M %p UTC").replace(" 0", " ")


def _possessive(name):
    cleaned = (name or "Someone").strip()
    if not cleaned:
        cleaned = "Someone"
    if cleaned.endswith(("s", "S")):
        return f"{cleaned}'"
    return f"{cleaned}'s"


def _human_readable_size(size_bytes):
    value = float(size_bytes or 0)
    units = ["B", "KB", "MB", "GB"]
    for unit in units:
        if value < 1024.0 or unit == units[-1]:
            if unit == "B":
                return f"{int(value)} {unit}"
            return f"{value:.1f} {unit}"
        value /= 1024.0
    return f"{int(size_bytes)} B"


def _share_url(share_code):
    return f"{PUBLIC_SHARE_BASE_URL}/{share_code}"


def _uploads_dir():
    return current_app.config["FILE_SHARE_UPLOAD_DIR"]


def _relative_storage_path(user_id, file_id, filename):
    return os.path.join(str(user_id), file_id, filename)


def _absolute_storage_path(relative_path):
    return os.path.join(_uploads_dir(), relative_path)


def _is_expired(shared_file):
    expires_at = parse_datetime(shared_file.get("expires_at"))
    if not expires_at:
        return True
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at <= _utcnow()


def _generate_share_code():
    while True:
        raw_bytes = secrets.token_bytes(SHARE_CODE_LENGTH)
        code = "".join(SHARE_CODE_CHARS[byte % len(SHARE_CODE_CHARS)] for byte in raw_bytes)
        try:
            existing = first_row(
                COLLECTIONS["shared_files"],
                [Query.equal("share_code", [code])],
            )
        except AppwriteException:
            logger.exception("Failed to check share code")
            raise
        if not existing:
            return code


def _shared_file_payload(shared_file):
    return {
        "id": shared_file.get("$id"),
        "filename": shared_file.get("original_filename"),
        "fileSizeBytes": shared_file.get("file_size_bytes"),
        "mimeType": shared_file.get("mime_type"),
        "isPublic": shared_file.get("is_public"),
        "shareUrl": _share_url(shared_file.get("share_code")) if shared_file.get("is_public") and shared_file.get("share_code") else None,
        "expiresAt": _isoformat(shared_file.get("expires_at")),
        "createdAt": _isoformat(shared_file.get("created_at")),
        "downloads": shared_file.get("downloaded_count"),
    }


def _send_shared_file(shared_file):
    absolute_path = _absolute_storage_path(shared_file.get("stored_path"))
    if not os.path.exists(absolute_path):
        raise FileNotFoundError(absolute_path)

    try:
        update_row_safe(
            COLLECTIONS["shared_files"],
            shared_file.get("$id"),
            {"downloaded_count": int(shared_file.get("downloaded_count") or 0) + 1},
        )
    except AppwriteException:
        logger.exception("Failed to update download count")

    return send_file(
        absolute_path,
        as_attachment=True,
        download_name=shared_file.get("original_filename"),
        mimetype=shared_file.get("mime_type") or None,
    )


def _render_public_share_page(shared_file=None, error_message=None):
    shared_by_name = None
    if shared_file:
        owner = None
        try:
            owner = get_row_safe(COLLECTIONS["users"], shared_file.get("user_id"))
        except AppwriteException as exc:
            if exc.code != 404:
                logger.exception("Failed to load shared file owner")
        if owner and owner.get("name"):
            shared_by_name = _possessive(owner.get("name"))
        elif owner and owner.get("email"):
            shared_by_name = _possessive(owner.get("email").split("@")[0])
        else:
            shared_by_name = _possessive("Someone")

    return render_template(
        "file_share_download.html",
        shared_file=shared_file,
        shared_by_name=shared_by_name,
        file_size_display=_human_readable_size(shared_file.get("file_size_bytes")) if shared_file else None,
        expires_at_display=_format_expiry_display(parse_datetime(shared_file.get("expires_at"))) if shared_file else None,
        download_url=url_for("file_share.public_share", share_code=shared_file.get("share_code"), download=1) if shared_file else None,
        error_message=error_message or "File not found or expired.",
    )


@file_share_bp.errorhandler(RequestEntityTooLarge)
def handle_file_too_large(_error):
    return jsonify({"error": "File exceeds the 50 MB limit."}), 413


@file_share_bp.route("/files")
@login_required
def file_share_page():
    try:
        user_settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load file share settings")
        user_settings = None
    return render_template(
        "file_share.html",
        user={
            "name": current_user.name,
            "email": current_user.email,
            "picture": current_user.picture_url,
            "emory_student": current_user.emory_student,
        },
        max_file_size=MAX_FILE_SIZE,
        allowed_expiry_options=ALLOWED_EXPIRY_OPTIONS,
        default_expiry_days=DEFAULT_EXPIRY_DAYS,
        theme_preference=user_settings.get("interface_theme") if user_settings else None,
    )


@file_share_bp.route("/api/files/upload", methods=["POST"])
@login_required
def upload_file():
    # Accept multiple files (up to 5). Client may submit multiple 'file' parts and
    # parallel form values for 'filename', 'visibility', and 'expiryDays'.
    files = request.files.getlist("file")
    if not files:
        return jsonify({"error": "At least one file is required."}), 400

    # Gather per-file metadata lists; if not provided, default values will be used.
    filenames = request.form.getlist("filename")
    visibilities = request.form.getlist("visibility")
    expiries = request.form.getlist("expiryDays")

    max_allowed = 5
    total_provided = len(files)
    to_process = files[:max_allowed]
    skipped = total_provided - len(to_process)

    created = []
    errors = []

    for idx, uploaded_file in enumerate(to_process):
        if not uploaded_file or not uploaded_file.filename:
            errors.append({"index": idx, "error": "Missing file or filename."})
            continue

        # metadata for this file (fall back to sensible defaults)
        custom_filename = (filenames[idx] if idx < len(filenames) else "") or ""
        visibility = (visibilities[idx] if idx < len(visibilities) else "private") or "private"
        try:
            expiry_days = int(expiries[idx]) if idx < len(expiries) else DEFAULT_EXPIRY_DAYS
        except (TypeError, ValueError):
            expiry_days = DEFAULT_EXPIRY_DAYS

        visibility = visibility.strip().lower()
        if visibility not in {"public", "private"}:
            errors.append({"index": idx, "error": "Invalid visibility option."})
            continue
        if expiry_days not in ALLOWED_EXPIRY_OPTIONS:
            errors.append({"index": idx, "error": "Invalid expiry selection."})
            continue

        display_filename = custom_filename.strip() or uploaded_file.filename

        try:
            uploaded_file.stream.seek(0, os.SEEK_END)
            file_size_bytes = uploaded_file.stream.tell()
            uploaded_file.stream.seek(0)
        except (AttributeError, OSError):
            uploaded_data = uploaded_file.stream.read()
            file_size_bytes = len(uploaded_data)
            uploaded_file.stream = io.BytesIO(uploaded_data)

        if file_size_bytes > MAX_FILE_SIZE:
            errors.append({"index": idx, "error": "File exceeds the 50 MB limit."})
            continue

        file_id = str(uuid.uuid4())
        sanitized_name = secure_filename(display_filename) or "file"
        relative_path = _relative_storage_path(current_user.id, file_id, sanitized_name)
        absolute_path = _absolute_storage_path(relative_path)
        os.makedirs(os.path.dirname(absolute_path), exist_ok=True)
        uploaded_file.save(absolute_path)

        is_public = visibility == "public"
        share_code = _generate_share_code() if is_public else None
        expires_at = _utcnow() + timedelta(days=expiry_days)

        try:
            shared_file = create_row_safe(
                COLLECTIONS["shared_files"],
                row_id=file_id,
                data={
                    "user_id": str(current_user.id),
                    "original_filename": display_filename,
                    "stored_path": relative_path,
                    "file_size_bytes": file_size_bytes,
                    "mime_type": uploaded_file.mimetype,
                    "share_code": share_code,
                    "is_public": is_public,
                    "expires_at": format_datetime(expires_at),
                    "created_at": format_datetime(_utcnow()),
                    "downloaded_count": 0,
                },
            )
        except AppwriteException:
            logger.exception("Failed to save shared file row")
            if os.path.exists(absolute_path):
                os.remove(absolute_path)
            errors.append({"index": idx, "error": "Unable to save file."})
            continue

        payload = _shared_file_payload(shared_file)
        created.append(payload)

    response = {"files": created}
    if skipped:
        response["skipped"] = skipped
        response.setdefault("errors", []).append({"error": f"Only {max_allowed} files are accepted; {skipped} file(s) were ignored."})
    if errors:
        response.setdefault("errors", []).extend(errors)

    status_code = 201 if created else 400
    return jsonify(response), status_code


@file_share_bp.route("/api/files/my/<file_id>/visibility", methods=["POST"])
@login_required
def change_visibility(file_id):
    try:
        shared_file = get_row_safe(COLLECTIONS["shared_files"], file_id)
    except AppwriteException as exc:
        if exc.code == 404:
            abort(404)
        logger.exception("Failed to load shared file")
        return jsonify({"error": "Unable to update visibility."}), 500

    if shared_file.get("user_id") != str(current_user.id):
        abort(404)

    data = request.get_json() or request.form
    visibility = (data.get("visibility") or "").strip().lower()
    if visibility not in {"public", "private"}:
        return jsonify({"error": "Invalid visibility option."}), 400

    updates = {}
    if visibility == "public":
        if not shared_file.get("is_public"):
            updates["is_public"] = True
            updates["share_code"] = _generate_share_code()
    else:
        updates["is_public"] = False
        updates["share_code"] = None

    try:
        shared_file = update_row_safe(
            COLLECTIONS["shared_files"],
            shared_file.get("$id"),
            updates,
        )
    except AppwriteException:
        logger.exception("Failed to update file visibility")
        return jsonify({"error": "Unable to update visibility."}), 500

    return jsonify(_shared_file_payload(shared_file)), 200


@file_share_bp.route("/api/files/my")
@login_required
def my_files():
    now = _utcnow()
    try:
        files = list_rows_all(
            COLLECTIONS["shared_files"],
            [
                Query.equal("user_id", [str(current_user.id)]),
                Query.greaterThan("expires_at", format_datetime(now)),
                Query.order_desc("created_at"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load shared files")
        return jsonify({"error": "Unable to load files."}), 500
    return jsonify({"files": [_shared_file_payload(shared_file) for shared_file in files]})


@file_share_bp.route("/api/files/my/<file_id>/download")
@login_required
def download_my_file(file_id):
    try:
        shared_file = get_row_safe(COLLECTIONS["shared_files"], file_id)
    except AppwriteException as exc:
        if exc.code == 404:
            abort(404)
        logger.exception("Failed to load shared file")
        abort(500)

    if shared_file.get("user_id") != str(current_user.id) or _is_expired(shared_file):
        abort(404)

    try:
        return _send_shared_file(shared_file)
    except FileNotFoundError:
        abort(404)


@file_share_bp.route("/api/files/my/<file_id>", methods=["DELETE"])
@login_required
def delete_my_file(file_id):
    try:
        shared_file = get_row_safe(COLLECTIONS["shared_files"], file_id)
    except AppwriteException as exc:
        if exc.code == 404:
            abort(404)
        logger.exception("Failed to load shared file")
        abort(500)

    if shared_file.get("user_id") != str(current_user.id):
        abort(404)

    absolute_path = _absolute_storage_path(shared_file.get("stored_path"))
    try:
        os.remove(absolute_path)
    except FileNotFoundError:
        pass

    try:
        delete_row_safe(COLLECTIONS["shared_files"], shared_file.get("$id"))
    except AppwriteException:
        logger.exception("Failed to delete shared file row")
        return jsonify({"error": "Unable to delete file."}), 500
    return jsonify({"message": "File deleted."})


@file_share_bp.route("/files/share/<share_code>")
def public_share(share_code):
    try:
        shared_file = first_row(
            COLLECTIONS["shared_files"],
            [
                Query.equal("share_code", [share_code]),
                Query.equal("is_public", [True]),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to resolve public share")
        return _render_public_share_page(error_message="File not found or expired.")

    if not shared_file or _is_expired(shared_file):
        return _render_public_share_page(error_message="File not found or expired.")

    if request.args.get("download"):
        try:
            return _send_shared_file(shared_file)
        except FileNotFoundError:
            return _render_public_share_page(error_message="File not found or expired.")

    return _render_public_share_page(shared_file=shared_file)
