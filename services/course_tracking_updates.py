"""Persist each track transition and its next polling time after delivery."""
import logging
from datetime import datetime, timedelta
from typing import Any
from appwrite.exception import AppwriteException
from appwrite_helpers import format_datetime
from services.course_tracking_delivery import deliver_opening
from services.course_tracking_ports import PollingPorts
from services.course_tracking_state import Row, section_open_for_notification, track_was_open, track_result_changed

logger = logging.getLogger(__name__)


def apply_track_result(track: Row, section: Row, updates: dict[str, Any], *,
                       table_id: str, now: datetime, counters: dict[str, Any],
                       ports: PollingPorts) -> int:
    notified_count = 0
    if not ports.term_is_polling(track.get("term")):
        return 0
    row_id = track.get("$id") or track.get("id")
    if not row_id:
        return 0
    track_updates = dict(updates)
    should_notify = section_open_for_notification(section) and not track_was_open(track)
    if should_notify:
        delivered = deliver_opening(track, section, row_id=row_id, counters=counters, ports=ports)
        if delivered:
            track_updates["last_notified_at"] = format_datetime(now)
            track_updates["cooldown_until_closed"] = True
            notified_count = 1
            counters["notifications_sent"] += 1
            ports.emit_event(
                "Tracked Course Availability Opened",
                actor="System",
                target=section.get("course_code") or track.get("course_code") or row_id,
                metadata={
                    "course_name": section.get("course_title") or track.get("course_title"),
                    "teacher": section.get("instructor") or track.get("instructor_name"),
                    "section_number": section.get("section_number") or track.get("section_id"),
                    "seats_open": section.get("seats_available"),
                    "enrollment_type": section.get("enrollment_status"),
                    "request_source": "automated",
                    "track_id": row_id,
                    "user_id": track.get("user_id"),
                },
                color="green",
            )
        else:
            # Preserve the previous transition so a later poll can retry delivery.
            return 0

    available = section_open_for_notification(section)
    cooldown = bool(track_updates.get("cooldown_until_closed", track.get("cooldown_until_closed")))
    if cooldown and not available:
        cooldown = False
        track_updates["cooldown_until_closed"] = False
    effective_minutes = 180 if cooldown else int(track.get("interval_minutes") or 30)
    track_updates["next_check_at"] = format_datetime(now + timedelta(minutes=effective_minutes))
    if not track_result_changed(track, section):
        counters["unchanged_rows_skipped"] += 1

    try:
        ports.update_row(table_id, row_id, track_updates)
        counters["row_updates"] += 1
        counters["changed_rows_written"] += 1
    except AppwriteException:
        counters["row_update_failures"] += 1
        logger.exception("Failed to update course track: %s", row_id)
        return notified_count
    return notified_count
