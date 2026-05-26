import logging
import os
from datetime import datetime, timedelta, timezone

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query
from appwrite.services.messaging import Messaging

from appwrite_client import COLLECTIONS, client as appwrite_client
from appwrite_helpers import format_datetime, list_rows_all, parse_datetime, update_row_safe
from services.atlas_client import fetch_live_section_status
from services.discord_audit import emit_course_track_event


logger = logging.getLogger(__name__)
NOTIFICATION_COOLDOWN = timedelta(hours=1)


def _now_utc():
    return datetime.now(timezone.utc)


def _as_utc(value):
    parsed = parse_datetime(value)
    if not parsed:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _section_open_for_notification(section):
    status = str(section.get("enrollment_status") or "").strip().lower()
    seats_available = section.get("seats_available")
    try:
        seats_available = int(seats_available) if seats_available is not None else None
    except (TypeError, ValueError):
        seats_available = None
    return status == "open" or (seats_available is not None and seats_available > 0)


def _notification_allowed(track, now):
    last_notified_at = _as_utc(track.get("last_notified_at"))
    if not last_notified_at:
        return True
    return now - last_notified_at >= NOTIFICATION_COOLDOWN


def _send_open_email(track, section):
    messaging = Messaging(appwrite_client)
    base_url = os.environ.get("APP_BASE_URL", "https://nest.apstudy.org").rstrip("/")
    course_code = section.get("course_code") or track.get("course_code") or "Tracked class"
    course_title = section.get("course_title") or track.get("course_title") or ""
    status = section.get("enrollment_status") or "Open"
    seats_available = section.get("seats_available")
    seats_text = "unknown"
    if seats_available is not None:
        seats_text = str(seats_available)
    subject = f"{course_code} has an open seat"
    content = (
        f"<p>{course_code} {course_title} appears to have an available seat.</p>"
        f"<p>Status: <strong>{status}</strong><br>"
        f"Seats available: <strong>{seats_text}</strong><br>"
        f"Section: {section.get('section_number') or track.get('section_id') or 'N/A'}<br>"
        f"CRN: {section.get('crn') or track.get('crn') or 'N/A'}</p>"
        f'<p><a href="{base_url}/courses">Open APStudy Courses</a></p>'
    )
    messaging.create_email(
        message_id=ID.unique(),
        subject=subject,
        content=content,
        users=[track.get("user_id")],
        html=True,
    )


def check_course_seat_tracks():
    """Poll enabled course seat trackers and notify users when seats open."""
    table_id = COLLECTIONS.get("course_seat_tracks")
    if not table_id:
        logger.info("Course tracking skipped: collection mapping missing.")
        return 0

    try:
        tracks = list_rows_all(table_id, [Query.equal("enabled", [True])])
    except AppwriteException:
        logger.exception("Failed to list course seat tracks")
        return 0

    now = _now_utc()
    notified_count = 0
    for track in tracks:
        row_id = track.get("$id") or track.get("id")
        if not row_id:
            continue

        result = fetch_live_section_status(
            track.get("term"),
            track.get("subject"),
            track.get("catalog"),
            crn=track.get("crn"),
        )
        updates = {
            "last_checked_at": format_datetime(now),
            "updated_at": format_datetime(now),
        }

        if "error" in result:
            logger.warning("Course track %s live check failed: %s", row_id, result["error"])
            emit_course_track_event(
                "Automated Course Track Check Failed",
                actor="System",
                target=track.get("course_code") or row_id,
                metadata={
                    "course_name": track.get("course_title"),
                    "teacher": track.get("instructor_name"),
                    "section_number": track.get("section_id"),
                    "seats_open": track.get("last_seats_available"),
                    "enrollment_type": track.get("last_status"),
                    "request_source": "automated",
                    "track_id": row_id,
                    "error": result["error"],
                },
                color="yellow",
            )
            try:
                update_row_safe(table_id, row_id, updates)
            except AppwriteException:
                logger.exception("Failed to update failed course track check: %s", row_id)
            continue

        section = result.get("section") or {}
        updates["last_status"] = section.get("enrollment_status")
        updates["last_seats_available"] = section.get("seats_available")

        if _section_open_for_notification(section) and _notification_allowed(track, now):
            try:
                _send_open_email(track, section)
                updates["last_notified_at"] = format_datetime(now)
                notified_count += 1
                emit_course_track_event(
                    "Tracked Course Seat Opened",
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
            except Exception:
                logger.exception("Failed to send course opening email for track %s", row_id)

        try:
            update_row_safe(table_id, row_id, updates)
        except AppwriteException:
            logger.exception("Failed to update course track: %s", row_id)
            continue

        emit_course_track_event(
            "Automated Course Track Checked",
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
            color="gray",
        )

    return notified_count
