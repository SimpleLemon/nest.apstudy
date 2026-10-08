"""Cross-user uploaded file and avatar usage for the admin overview."""
import logging
from collections.abc import Callable, Mapping
from typing import Any

from services.admin_ports import ListAdminRows

logger = logging.getLogger(__name__)


def format_bytes(value: object) -> str:
    try:
        size = int(value or 0)
    except (TypeError, ValueError):
        size = 0
    units = ("B", "KB", "MB", "GB", "TB")
    amount = float(size)
    unit = units[0]
    for unit in units:
        if amount < 1024 or unit == units[-1]:
            break
        amount /= 1024
    if unit == "B":
        return f"{int(amount)} {unit}"
    return f"{amount:.1f} {unit}"


def storage_usage_summary(*, collections: Mapping[str, str], list_rows_all: ListAdminRows, sanitize_error: Callable[[Exception], str]) -> dict[str, Any]:
    try:
        files = list_rows_all(collections["shared_files"])
    except Exception as exc:
        logger.exception("Failed to load file storage summary")
        return {
            "bytes": 0,
            "formatted": "--",
            "file_count": 0,
            "avatar_count": None,
            "error": sanitize_error(exc),
        }

    total_bytes = 0
    for file_row in files:
        try:
            total_bytes += int(file_row.get("file_size_bytes") or 0)
        except (TypeError, ValueError):
            continue

    error = None
    try:
        users = list_rows_all(collections["users"])
        avatar_count = sum(1 for user in users if user.get("avatar_file_id"))
    except Exception as exc:
        logger.exception("Failed to count avatar storage rows")
        avatar_count = None
        error = sanitize_error(exc)
    return {
        "bytes": total_bytes,
        "formatted": format_bytes(total_bytes),
        "file_count": len(files),
        "avatar_count": avatar_count,
        "error": error,
    }


