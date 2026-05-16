import logging
from datetime import datetime

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite.services.storage import Storage
from appwrite_client import COLLECTIONS, FILE_SHARE_BUCKET_ID, client as appwrite_client
from appwrite_helpers import (
    delete_row_safe,
    format_datetime,
    list_rows_all,
)

logger = logging.getLogger(__name__)


def cleanup_expired_files():
    now = datetime.utcnow()
    try:
        expired_files = list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.less_than_equal("expires_at", format_datetime(now))],
        )
    except AppwriteException:
        logger.exception("Failed to list expired shared files")
        raise
    deleted_count = 0
    storage = Storage(appwrite_client)

    for shared_file in expired_files:
        storage_file_id = shared_file.get("storage_file_id")
        if storage_file_id:
            try:
                storage.delete_file(shared_file.get("storage_bucket_id") or FILE_SHARE_BUCKET_ID, storage_file_id)
            except AppwriteException as exc:
                if int(getattr(exc, "code", 0) or 0) != 404:
                    logger.exception("Failed to delete expired shared file from Appwrite Storage.")
                    raise

        try:
            delete_row_safe(COLLECTIONS["shared_files"], shared_file.get("$id"))
            deleted_count += 1
        except AppwriteException:
            logger.exception("Failed to delete expired shared file row.")
            raise

    logger.info("Deleted %s expired shared file(s).", deleted_count)
    return deleted_count
