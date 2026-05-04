import logging
import os
from datetime import datetime

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    delete_row_safe,
    format_datetime,
    list_rows_all,
)

logger = logging.getLogger(__name__)


def cleanup_expired_files():
    from flask import current_app

    now = datetime.utcnow()
    try:
        expired_files = list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.lessThanEqual("expires_at", format_datetime(now))],
        )
    except AppwriteException:
        logger.exception("Failed to list expired shared files")
        raise
    deleted_count = 0
    upload_dir = current_app.config["FILE_SHARE_UPLOAD_DIR"]

    for shared_file in expired_files:
        absolute_path = os.path.join(upload_dir, shared_file.get("stored_path"))
        try:
            os.remove(absolute_path)
        except FileNotFoundError:
            logger.info("Missing expired shared file on disk: %s", absolute_path)
        except OSError:
            logger.exception("Failed to delete expired shared file on disk: %s", absolute_path)

        try:
            delete_row_safe(COLLECTIONS["shared_files"], shared_file.get("$id"))
            deleted_count += 1
        except AppwriteException:
            logger.exception("Failed to delete expired shared file row.")
            raise

    logger.info("Deleted %s expired shared file(s).", deleted_count)
    return deleted_count
