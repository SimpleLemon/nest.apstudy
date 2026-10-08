import logging

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    format_datetime,
    list_rows_all,
)
from services.file_share_store import _delete_file_record, cleanup_legacy_files
from services.storage_backend import require_mutations_enabled
from services.storage_objects import StorageError, StorageMutationPaused
from services.time_utils import utcnow

logger = logging.getLogger(__name__)


def cleanup_expired_files():
    try:
        require_mutations_enabled()
    except StorageMutationPaused:
        logger.info("Expired shared-file cleanup skipped while storage mutations are paused.")
        return 0
    now = utcnow()
    try:
        expired_files = list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.less_than_equal("expires_at", format_datetime(now))],
        )
    except AppwriteException:
        logger.exception("Failed to list expired shared files")
        raise
    deleted_count = 0
    for shared_file in expired_files:
        try:
            if _delete_file_record(shared_file, expires_before=now):
                deleted_count += 1
        except StorageMutationPaused:
            logger.info("Expired shared-file cleanup paused after deleting %s file(s).", deleted_count)
            return deleted_count
        except (AppwriteException, StorageError):
            logger.exception("Failed to delete expired shared file.")
            raise

    try:
        # Retain retries for expired files whose metadata was removed on a
        # previous pass, and for explicit deletions with transient failures.
        cleanup_legacy_files()
    except StorageMutationPaused:
        logger.info("Expired shared-file legacy cleanup paused after deleting %s file(s).", deleted_count)
    logger.info("Deleted %s expired shared file(s).", deleted_count)
    return deleted_count
