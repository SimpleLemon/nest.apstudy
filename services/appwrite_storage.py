"""Shared helpers for Appwrite Storage uploads."""

from appwrite.exception import AppwriteException


def _exception_message(exc):
    return str(getattr(exc, "message", "") or exc or "").strip()


def appwrite_upload_error(exc, *, fallback="Unable to upload file.", image=False):
    message = _exception_message(exc)
    lowered = message.lower()
    if "maximum" in lowered and "size" in lowered:
        return (
            "Image exceeds the storage bucket size limit."
            if image
            else "File exceeds the storage bucket size limit."
        )
    if "extension" in lowered or "mime" in lowered:
        return "This image type is not allowed." if image else "This file type is not allowed."
    if "bucket" in lowered and ("not found" in lowered or "could not be found" in lowered):
        return "File storage is not configured. Contact support."
    if message:
        return message
    return fallback


def appwrite_upload_status_code(exc):
    message = _exception_message(exc).lower()
    if ("extension" in message or "mime" in message) and "bucket" not in message:
        return 400
    if "maximum" in message and "size" in message:
        return 400
    return 500


def appwrite_upload_failure(exc, *, fallback="Unable to upload file.", image=False):
    return appwrite_upload_status_code(exc), appwrite_upload_error(
        exc,
        fallback=fallback,
        image=image,
    )


def note_media_upload_failure(exc):
    return appwrite_upload_failure(
        exc,
        fallback="Unable to store this image.",
        image=True,
    )
