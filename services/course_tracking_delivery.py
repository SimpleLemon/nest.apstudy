"""Idempotent email transport and per-track opening notification channels."""
import logging
from typing import Any
from appwrite.exception import AppwriteException
from services.course_tracking_email import (
    build_nest_courses_detail_path, build_nest_courses_detail_url,
    build_open_seat_html, build_open_seat_subject,
)
from services.course_tracking_state import Row, waitlist_available, open_notification_id
from services.course_tracking_ports import CourseEmailMessaging, PollingPorts

logger = logging.getLogger(__name__)


def send_open_email(track: Row, section: Row, *, messaging: CourseEmailMessaging, base_url: str) -> None:
    base_url = base_url.rstrip("/")
    course_code = section.get("course_code") or track.get("course_code") or "Tracked class"
    section_id = section.get("id") or track.get("section_id") or ""
    subject = build_open_seat_subject(
        course_code,
        section.get("seats_available"),
        waitlist_available(section.get("waitlist_total"), section.get("waitlist_capacity")),
    )
    content = build_open_seat_html(
        section,
        base_url=base_url,
        nest_details_url=build_nest_courses_detail_url(base_url, section_id),
    )
    message_id = open_notification_id(track)
    try:
        messaging.create_email(
            message_id=message_id,
            subject=subject,
            content=content,
            users=[track.get("user_id")],
            html=True,
        )
    except AppwriteException as exc:
        if exc.code != 409:
            raise
        # A retry after an ambiguous timeout may find that Appwrite accepted the
        # first request. Verify that the deterministic message exists before
        # treating the conflict as a successful, already-enqueued delivery.
        messaging.get_message(message_id)


def deliver_opening(track: Row, section: Row, *, row_id: str,
                    counters: dict[str, Any], ports: PollingPorts) -> bool:
    prefs = ports.preferences(track.get("user_id"))
    delivered = False
    if prefs["course_email_enabled"] and ports.term_is_polling(track.get("term")):
        try:
            ports.send_open_email(track, section)
            counters["email_notifications"] += 1
            delivered = True
        except Exception:
            counters["email_failures"] += 1
            logger.exception("Failed to send course opening email for track %s", row_id)
    if prefs["course_push_enabled"] and ports.term_is_polling(track.get("term")):
        code = section.get("course_code") or track.get("course_code") or "Tracked course"
        seats = section.get("seats_available")
        body = f"{seats} seat{'s' if seats != 1 else ''} available." if seats is not None else "Enrollment is now available."
        try:
            _, push_result = ports.notify(
                track.get("user_id"), "courses", f"{code} has an opening", body,
                build_nest_courses_detail_path(
                    section.get("id") or track.get("section_id"),
                ),
                source_ref=row_id,
                dedupe_key=f"course-open:{row_id}:{section.get('enrollment_status')}:{seats}", tag=f"course:{row_id}",
            )
            delivered = delivered or push_result["accepted"] > 0
        except Exception:
            logger.exception("Failed to send course opening push for track %s", row_id)
    return delivered
