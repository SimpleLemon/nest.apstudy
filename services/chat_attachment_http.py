"""Private, seekable HTTP responses for previously authorized attachments."""

import hashlib
import io

from flask import send_file

from services.chat_attachment_validation import DOCUMENT_MIMES, IMAGE_FORMATS, _safe_filename
from services.storage_errors import StorageIntegrityError


IMAGE_MIMES = frozenset(value[0] for value in IMAGE_FORMATS.values())
SAFE_MIMES = IMAGE_MIMES | frozenset(DOCUMENT_MIMES.values())


def attachment_response(row, data, *, preview=False):
    mime_type = row.get("mime_type")
    if preview:
        if row.get("kind") == "pdf":
            mime_type = "image/webp"
        elif row.get("kind") != "image" or mime_type not in IMAGE_MIMES:
            raise StorageIntegrityError("The attachment preview MIME type is invalid.")
    elif mime_type not in SAFE_MIMES:
        mime_type = "application/octet-stream"
    response = send_file(
        io.BytesIO(data),
        mimetype=mime_type,
        as_attachment=not preview,
        download_name=_safe_filename(row.get("original_filename")),
        max_age=3600 if preview else 0,
        conditional=True,
        etag=hashlib.sha256(data).hexdigest(),
    )
    response.headers["Cache-Control"] = (
        "private, max-age=3600" if preview else "private, max-age=0, must-revalidate"
    )
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Content-Security-Policy"] = "default-src 'none'; sandbox"
    response.vary.add("Cookie")
    return response
