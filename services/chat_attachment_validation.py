"""Content validation and bounded transforms for private chat uploads."""

from __future__ import annotations

import gzip
import hashlib
import io
import logging
import math
import posixpath
import re
import zipfile
import zlib
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


logger = logging.getLogger(__name__)
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
MAX_IMAGE_DIMENSION = 2560
MAX_ARCHIVE_ENTRIES = 2_000
MAX_ARCHIVE_EXPANDED_BYTES = 250 * 1024 * 1024
MAX_ARCHIVE_RATIO = 100

IMAGE_FORMATS = {
    "JPEG": ("image/jpeg", {".jpg", ".jpeg"}),
    "PNG": ("image/png", {".png"}),
    "WEBP": ("image/webp", {".webp"}),
    "GIF": ("image/gif", {".gif"}),
}
DOCUMENT_MIMES = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation",
    ".zip": "application/zip",
}
ZIP_CONTAINER_MARKERS = {
    ".docx": "word/",
    ".xlsx": "xl/",
    ".pptx": "ppt/",
}
DENIED_ARCHIVE_EXTENSIONS = {
    ".app", ".bat", ".bin", ".cmd", ".com", ".cpl", ".dll", ".dmg", ".exe",
    ".hta", ".htm", ".html", ".iso", ".jar", ".js", ".jse", ".lnk", ".msi",
    ".msp", ".ps1", ".py", ".rb", ".reg", ".scr", ".sh", ".svg", ".vbs",
    ".xlsm", ".docm", ".pptm", ".xls", ".doc", ".ppt",
}
COMPRESSIBLE_EXTENSIONS = {".txt", ".md", ".markdown", ".csv", ".json"}
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._()\- ]+")


class AttachmentError(ValueError):
    pass


def bounded_gzip(data, limit, *, message="The compressed upload could not be read."):
    """Read only one bounded result, including concatenated gzip members."""
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as compressed:
            result = compressed.read(limit + 1)
    except (gzip.BadGzipFile, EOFError, OSError, zlib.error) as exc:
        raise AttachmentError(message) from exc
    if len(result) > limit:
        raise AttachmentError("The decompressed attachment exceeds the safe size limit.")
    return result


def _safe_filename(value):
    name = Path(str(value or "attachment").replace("\\", "/")).name
    name = SAFE_NAME_RE.sub("_", name).strip(" .")[:255]
    return name or "attachment"


def _inspect_archive(data, extension):
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if not infos or len(infos) > MAX_ARCHIVE_ENTRIES:
                raise AttachmentError("This archive has too many entries or is empty.")
            expanded = 0
            names = []
            for info in infos:
                if info.flag_bits & 0x1:
                    raise AttachmentError("Encrypted archives are not supported.")
                normalized = posixpath.normpath(info.filename.replace("\\", "/"))
                if normalized.startswith("../") or normalized.startswith("/") or normalized == "..":
                    raise AttachmentError("This archive contains an unsafe path.")
                nested_extension = Path(normalized).suffix.lower()
                if nested_extension in DENIED_ARCHIVE_EXTENSIONS:
                    raise AttachmentError("This archive contains an unsafe file type.")
                expanded += int(info.file_size or 0)
                compressed = max(1, int(info.compress_size or 0))
                if info.file_size > 10 * 1024 * 1024 and info.file_size / compressed > MAX_ARCHIVE_RATIO:
                    raise AttachmentError("This archive expands beyond the safe compression ratio.")
                names.append(normalized)
            if expanded > MAX_ARCHIVE_EXPANDED_BYTES:
                raise AttachmentError("This archive expands beyond the safe size limit.")
            marker = ZIP_CONTAINER_MARKERS.get(extension)
            if marker and not any(name.startswith(marker) for name in names):
                raise AttachmentError("The file contents do not match its Office format.")
            if extension in {".odt", ".ods", ".odp"}:
                expected = DOCUMENT_MIMES[extension]
                try:
                    mimetype = archive.read("mimetype").decode("ascii", "strict").strip()
                except (KeyError, UnicodeDecodeError):
                    raise AttachmentError("The file contents do not match its OpenDocument format.")
                if mimetype != expected:
                    raise AttachmentError("The file contents do not match its OpenDocument format.")
    except (zipfile.BadZipFile, RuntimeError) as exc:
        raise AttachmentError("The file is not a valid, readable archive.") from exc


def _optimize_image(data, extension):
    try:
        with Image.open(io.BytesIO(data)) as image:
            image_format = str(image.format or "").upper()
            if image_format not in IMAGE_FORMATS or extension not in IMAGE_FORMATS[image_format][1]:
                raise AttachmentError("The image contents do not match its filename.")
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                raise AttachmentError("Image dimensions are too large.")
            image.verify()
        if image_format == "GIF":
            return data, IMAGE_FORMATS[image_format][0], width, height, "identity"
        with Image.open(io.BytesIO(data)) as image:
            has_metadata = bool(image.getexif()) or any(
                key in image.info for key in ("icc_profile", "xmp", "XML:com.adobe.xmp")
            )
            image = ImageOps.exif_transpose(image)
            image.thumbnail((MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            if image_format == "JPEG":
                image = image.convert("RGB")
                save_kwargs = {"optimize": True, "quality": 86, "progressive": True}
            elif image_format == "WEBP":
                save_kwargs = {"optimize": True, "quality": 86, "method": 5}
            else:
                save_kwargs = {"optimize": True}
            image.save(output, format=image_format, **save_kwargs)
            optimized = output.getvalue()
            if len(optimized) >= len(data) and image.size == (width, height) and not has_metadata:
                optimized = data
            return optimized, IMAGE_FORMATS[image_format][0], image.width, image.height, "identity"
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, RuntimeError, Image.DecompressionBombError) as exc:
        raise AttachmentError("The uploaded file is not a valid supported image.") from exc


def _pdf_thumbnail(data):
    try:
        import pypdfium2 as pdfium

        with pdfium.PdfDocument(data) as document:
            if len(document) < 1:
                return None
            page = document[0]
            try:
                width, height = page.get_size()
                if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                    return None
                bitmap = page.render(scale=min(1.25, 720 / width, 960 / height))
                try:
                    image = bitmap.to_pil().convert("RGB")
                    image.thumbnail((720, 960), Image.Resampling.LANCZOS)
                    output = io.BytesIO()
                    image.save(output, format="WEBP", quality=72, method=4)
                    return output.getvalue(), image.width, image.height
                finally:
                    bitmap.close()
            finally:
                page.close()
    except Exception:
        logger.info("PDF preview generation failed; using generic file card", exc_info=True)
        return None


def inspect_and_prepare(data, filename):
    if len(data) > MAX_UPLOAD_BYTES:
        raise AttachmentError("Chat attachments may not exceed 50 MiB.")
    if not data:
        raise AttachmentError("The selected file is empty.")
    safe_name = _safe_filename(filename)
    extension = Path(safe_name).suffix.lower()
    if extension in DENIED_ARCHIVE_EXTENSIONS or extension not in DOCUMENT_MIMES and not any(
        extension in value[1] for value in IMAGE_FORMATS.values()
    ):
        raise AttachmentError("This file type is not allowed in chat.")
    original_sha256 = hashlib.sha256(data).hexdigest()
    preview = None
    width = height = None
    if any(extension in value[1] for value in IMAGE_FORMATS.values()):
        stored, mime_type, width, height, encoding = _optimize_image(data, extension)
        kind = "image"
    else:
        mime_type = DOCUMENT_MIMES[extension]
        kind = "pdf" if extension == ".pdf" else "file"
        if extension == ".pdf":
            if not data.startswith(b"%PDF-"):
                raise AttachmentError("The file is not a valid PDF.")
            preview = _pdf_thumbnail(data)
        elif extension in COMPRESSIBLE_EXTENSIONS:
            try:
                data.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise AttachmentError("Text attachments must use UTF-8 encoding.") from exc
        elif extension in ZIP_CONTAINER_MARKERS or extension in {".odt", ".ods", ".odp", ".zip"}:
            _inspect_archive(data, extension)
        compressed = gzip.compress(data, compresslevel=6, mtime=0) if extension in COMPRESSIBLE_EXTENSIONS else data
        if len(compressed) < len(data):
            stored, encoding = compressed, "gzip"
        else:
            stored, encoding = data, "identity"
    return {
        "filename": safe_name,
        "mime_type": mime_type,
        "kind": kind,
        "original_size_bytes": len(data),
        "stored": stored,
        "stored_size_bytes": len(stored),
        "compression_encoding": encoding,
        "sha256": original_sha256,
        "width": width,
        "height": height,
        "preview": preview,
    }

