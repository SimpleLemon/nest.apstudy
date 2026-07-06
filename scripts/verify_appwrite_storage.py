#!/usr/bin/env python3
"""Verify Appwrite Storage buckets used by Nest.APStudy."""

from __future__ import annotations

import argparse
import io
import sys
import uuid
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from dotenv import load_dotenv

load_dotenv(ROOT_DIR / ".env")

from appwrite.exception import AppwriteException
from appwrite.input_file import InputFile
from appwrite.permission import Permission
from appwrite.role import Role
from appwrite.services.storage import Storage

from appwrite_client import (
    FILE_SHARE_BUCKET_ID,
    NOTES_MEDIA_BUCKET_ID,
    PROFILE_AVATAR_BUCKET_ID,
    client as appwrite_client,
)
from services.appwrite_storage import appwrite_upload_error


BUCKETS = (
    ("profile_avatars", PROFILE_AVATAR_BUCKET_ID),
    ("file_share_files", FILE_SHARE_BUCKET_ID),
    ("notes_media", NOTES_MEDIA_BUCKET_ID),
)


def _bucket_attr(bucket, name, default=None):
    if bucket is None:
        return default
    if isinstance(bucket, dict):
        return bucket.get(name, default)
    return getattr(bucket, name, default)


def _format_bytes(value):
    try:
        size = int(value or 0)
    except (TypeError, ValueError):
        return str(value)
    if size <= 0:
        return "unlimited"
    units = ["B", "KiB", "MiB", "GiB"]
    current = float(size)
    for unit in units:
        if current < 1024 or unit == units[-1]:
            if unit == "B":
                return f"{int(current)} {unit}"
            return f"{current:.1f} {unit}"
        current /= 1024
    return f"{size} B"


def inspect_bucket(storage, label, bucket_id):
    print(f"\n== {label} ({bucket_id}) ==")
    try:
        bucket = storage.get_bucket(bucket_id)
    except AppwriteException as exc:
        print(f"ERROR: {appwrite_upload_error(exc)}")
        print(f"detail: {exc}")
        return False

    enabled = _bucket_attr(bucket, "enabled", True)
    file_security = _bucket_attr(bucket, "fileSecurity", _bucket_attr(bucket, "file_security", False))
    max_size = _bucket_attr(bucket, "maximumFileSize", _bucket_attr(bucket, "maximum_file_size"))
    extensions = _bucket_attr(bucket, "allowedFileExtensions", _bucket_attr(bucket, "allowed_file_extensions", []))

    print(f"enabled: {enabled}")
    print(f"fileSecurity: {file_security}")
    print(f"maximumFileSize: {_format_bytes(max_size)}")
    print(f"allowedFileExtensions: {', '.join(extensions) if extensions else '(all)'}")
    return True


def probe_notes_media_upload(storage, bucket_id):
    print(f"\n== notes_media upload probe ({bucket_id}) ==")
    file_id = str(uuid.uuid4())
    png_bytes = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\x00\x01"
        b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    try:
        storage.create_file(
            bucket_id,
            file_id,
            InputFile.from_bytes(png_bytes, filename="probe.png", mime_type="image/png"),
            permissions=[Permission.read(Role.any())],
        )
        storage.delete_file(bucket_id, file_id)
    except AppwriteException as exc:
        print(f"ERROR: {appwrite_upload_error(exc, image=True)}")
        print(f"detail: {exc}")
        return False

    print("upload/delete probe: ok")
    return True


def main():
    parser = argparse.ArgumentParser(description="Verify Appwrite Storage buckets for Nest.APStudy")
    parser.add_argument(
        "--probe-upload",
        action="store_true",
        help="Upload and delete a 1x1 PNG in notes_media to validate write access",
    )
    args = parser.parse_args()

    if not appwrite_client:
        print("Appwrite client is not configured. Set APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID, and APPWRITE_API_KEY.")
        return 1

    storage = Storage(appwrite_client)
    ok = True
    for label, bucket_id in BUCKETS:
        ok = inspect_bucket(storage, label, bucket_id) and ok

    if args.probe_upload:
        ok = probe_notes_media_upload(storage, NOTES_MEDIA_BUCKET_ID) and ok

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
