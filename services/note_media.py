import io
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from PIL import Image, UnidentifiedImageError
from appwrite.exception import AppwriteException
from appwrite.input_file import InputFile
from appwrite.query import Query
from appwrite.services.storage import Storage

from appwrite_client import NOTES_MEDIA_BUCKET_ID, client as appwrite_client
from appwrite_helpers import create_row_safe, delete_row_safe, get_row_safe, list_rows_all, update_row_safe
from services.database import utcnow_iso


logger = logging.getLogger(__name__)
NOTE_MEDIA_TABLE_ID = "note_media"
MAX_NOTE_IMAGE_BYTES = 10 * 1024 * 1024
MAX_NOTE_IMAGE_PIXELS = 40_000_000
ALLOWED_IMAGE_FORMATS = {
    "JPEG": ("image/jpeg", "jpg"),
    "PNG": ("image/png", "png"),
    "GIF": ("image/gif", "gif"),
    "WEBP": ("image/webp", "webp"),
}


def storage_service():
    return Storage(appwrite_client)


def inspect_image(data):
    if not data:
        raise ValueError("Image file is empty.")
    if len(data) > MAX_NOTE_IMAGE_BYTES:
        raise ValueError("Image exceeds the 10 MiB limit.")
    try:
        with Image.open(io.BytesIO(data)) as image:
            image_format = str(image.format or "").upper()
            if image_format not in ALLOWED_IMAGE_FORMATS:
                raise ValueError("Use a JPEG, PNG, GIF, or WebP image.")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_NOTE_IMAGE_PIXELS:
                raise ValueError("Image dimensions are too large.")
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("The uploaded file is not a valid supported image.") from exc
    mime_type, extension = ALLOWED_IMAGE_FORMATS[image_format]
    return {"mime_type": mime_type, "extension": extension, "width": width, "height": height}


def create_media(note_id, user_id, uploaded_file):
    data = uploaded_file.read(MAX_NOTE_IMAGE_BYTES + 1)
    details = inspect_image(data)
    claimed_mime = str(uploaded_file.mimetype or "").split(";", 1)[0].strip().lower()
    if claimed_mime and claimed_mime != "application/octet-stream" and claimed_mime != details["mime_type"]:
        raise ValueError("The image content does not match its reported file type.")
    media_id = str(uuid.uuid4())
    storage_file_id = str(uuid.uuid4())
    safe_name = f"{media_id}.{details['extension']}"
    storage_service().create_file(
        NOTES_MEDIA_BUCKET_ID,
        storage_file_id,
        InputFile.from_bytes(data, filename=safe_name, mime_type=details["mime_type"]),
    )
    now = utcnow_iso()
    try:
        return create_row_safe(
            NOTE_MEDIA_TABLE_ID,
            row_id=media_id,
            data={
                "note_id": str(note_id),
                "user_id": str(user_id),
                "storage_bucket_id": NOTES_MEDIA_BUCKET_ID,
                "storage_file_id": storage_file_id,
                "original_filename": str(uploaded_file.filename or safe_name)[:255],
                "mime_type": details["mime_type"],
                "file_size_bytes": len(data),
                "width": details["width"],
                "height": details["height"],
                "status": "pending",
                "created_at": now,
                "updated_at": now,
            },
        )
    except Exception:
        try:
            storage_service().delete_file(NOTES_MEDIA_BUCKET_ID, storage_file_id)
        except AppwriteException:
            logger.exception("Failed to roll back note media storage upload")
        raise


def get_media(media_id):
    return get_row_safe(NOTE_MEDIA_TABLE_ID, str(media_id), allow_missing=True)


def media_bytes(media):
    return storage_service().get_file_download(
        media.get("storage_bucket_id") or NOTES_MEDIA_BUCKET_ID,
        media.get("storage_file_id"),
    )


def delete_media(media):
    if not media:
        return
    try:
        storage_service().delete_file(
            media.get("storage_bucket_id") or NOTES_MEDIA_BUCKET_ID,
            media.get("storage_file_id"),
        )
    except AppwriteException as exc:
        status = int(getattr(exc, "code", 0) or getattr(exc, "response_code", 0) or 0)
        if status != 404:
            logger.exception("Failed to delete note media storage object")
    delete_row_safe(NOTE_MEDIA_TABLE_ID, media.get("$id") or media.get("id"))


def delete_note_media(note_id):
    for media in list_rows_all(NOTE_MEDIA_TABLE_ID, [Query.equal("note_id", [str(note_id)])]):
        delete_media(media)


def referenced_media_ids(content):
    try:
        document = json.loads(content or "[]") if isinstance(content, str) else content
    except (TypeError, ValueError, json.JSONDecodeError):
        return set()
    found = set()

    def visit(value):
        if isinstance(value, list):
            for item in value:
                visit(item)
            return
        if not isinstance(value, dict):
            return
        if value.get("type") == "inlineImage":
            props = value.get("props") if isinstance(value.get("props"), dict) else {}
            media_id = str(props.get("mediaId") or "").strip()
            if media_id:
                found.add(media_id)
        for child in value.values():
            if isinstance(child, (list, dict)):
                visit(child)

    visit(document)
    return found


def sync_note_media(note_id, content):
    referenced = referenced_media_ids(content)
    rows = list_rows_all(NOTE_MEDIA_TABLE_ID, [Query.equal("note_id", [str(note_id)])])
    now = utcnow_iso()
    for media in rows:
        media_id = str(media.get("$id") or media.get("id") or "")
        if media_id in referenced:
            if media.get("status") != "active":
                update_row_safe(NOTE_MEDIA_TABLE_ID, media_id, {"status": "active", "updated_at": now})
        elif media.get("status") == "active":
            delete_media(media)


def cleanup_abandoned_media(max_age_hours=24):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
    rows = list_rows_all(NOTE_MEDIA_TABLE_ID, [Query.equal("status", ["pending"])])
    deleted = 0
    for media in rows:
        raw_created = str(media.get("created_at") or "").replace("Z", "+00:00")
        try:
            created = datetime.fromisoformat(raw_created)
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
        except ValueError:
            created = datetime.min.replace(tzinfo=timezone.utc)
        if created <= cutoff:
            delete_media(media)
            deleted += 1
    return deleted
