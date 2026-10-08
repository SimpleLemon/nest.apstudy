"""Fetch and audit one live Atlas result for a group of seat trackers."""
import logging
from datetime import datetime
from collections.abc import Sequence
from typing import Any
from appwrite_helpers import format_datetime
from services.course_tracking_ports import PollingPorts
from services.course_tracking_state import Row, sanitize_track_error, track_group_key, group_metadata, group_target
from services.course_tracking_updates import apply_track_result

logger = logging.getLogger(__name__)


def poll_track_group(grouped: Sequence[Row], *, table_id: str, now: datetime,
                     counters: dict[str, Any], ports: PollingPorts) -> int:
    representative = grouped[0]
    if not ports.term_is_polling(representative.get("term")):
        return 0

    counters["atlas_checks_attempted"] += 1
    try:
        result = ports.fetch_section(
            representative.get("term"),
            representative.get("subject"),
            representative.get("catalog"),
            crn=representative.get("crn"),
        )
    except Exception as exc:
        error = sanitize_track_error(exc)
        logger.error(
            "Course track group %s live check raised an exception: %s",
            track_group_key(representative),
            error,
        )
        result = {"error": error}
    if not isinstance(result, dict):
        result = {"error": "Live Atlas returned invalid data"}
    elif "error" not in result and not isinstance(result.get("section"), dict):
        result = {"error": "Live Atlas returned an invalid section"}
    if not ports.term_is_polling(representative.get("term")):
        return 0
    updates = {
        "last_checked_at": format_datetime(now),
        "updated_at": format_datetime(now),
    }

    if "error" in result:
        counters["atlas_checks_failed"] += 1
        logger.warning(
            "Course track group %s live check failed: %s",
            track_group_key(representative),
            result["error"],
        )
        ports.emit_event(
            "Automated Course Track Check Failed",
            actor="System",
            target=group_target(grouped),
            metadata=group_metadata(grouped, error=result["error"]),
            color="yellow",
        )
        counters["failed_rows_skipped"] += len(grouped)
        return 0

    counters["atlas_checks_succeeded"] += 1
    section = result.get("section") or {}
    updates["last_status"] = section.get("enrollment_status")
    updates["last_seats_available"] = section.get("seats_available")
    updates["last_waitlist_total"] = section.get("waitlist_total")
    updates["last_waitlist_capacity"] = section.get("waitlist_capacity")

    ports.emit_event(
        "Automated Course Track Checked",
        actor="System",
        target=group_target(grouped, section),
        metadata=group_metadata(grouped, section),
        color="gray",
    )
    return sum(
        apply_track_result(track, section, updates, table_id=table_id, now=now,
                           counters=counters, ports=ports)
        for track in grouped
    )
