"""Seat transition, due time, and polling group identity rules."""
from collections.abc import Mapping, Sequence
from typing import Any
from datetime import datetime, timedelta, timezone
import hashlib
import re
from services.redaction import SECRET_TEXT_RE

Row = Mapping[str, Any]


def section_open_for_notification(section: Row) -> bool:
    status = str(section.get("enrollment_status") or "").strip().lower()
    seats_available = section.get("seats_available")
    return open_from_values(status, seats_available) or waitlist_available(
        section.get("waitlist_total"), section.get("waitlist_capacity")
    )


def waitlist_available(total: object, capacity: object) -> bool:
    total = normalize_seats(total)
    capacity = normalize_seats(capacity)
    return total is not None and capacity is not None and capacity > total


def open_from_values(status: object, seats_available: object) -> bool:
    status = str(status or "").strip().lower()
    try:
        seats_available = int(seats_available) if seats_available is not None else None
    except (TypeError, ValueError):
        seats_available = None
    return status == "open" or (seats_available is not None and seats_available > 0)


def normalize_status(value: object) -> str:
    return str(value or "").strip().lower()


def normalize_seats(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        match = re.search(r"-?\d+", str(value))
        return int(match.group(0)) if match else None


def track_result_changed(track: Row, section: Row) -> bool:
    old_status = normalize_status(track.get("last_status"))
    new_status = normalize_status(section.get("enrollment_status"))
    old_seats = normalize_seats(track.get("last_seats_available"))
    new_seats = normalize_seats(section.get("seats_available"))
    return (
        old_status != new_status
        or old_seats != new_seats
        or normalize_seats(track.get("last_waitlist_total")) != normalize_seats(section.get("waitlist_total"))
        or normalize_seats(track.get("last_waitlist_capacity")) != normalize_seats(section.get("waitlist_capacity"))
    )


def track_was_open(track: Row) -> bool:
    return open_from_values(track.get("last_status"), track.get("last_seats_available")) or waitlist_available(
        track.get("last_waitlist_total"), track.get("last_waitlist_capacity")
    )


def parse_datetime(value: object) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def track_due(track: Row, now: datetime) -> bool:
    next_check = parse_datetime(track.get("next_check_at"))
    if next_check:
        return next_check <= now
    last_checked = parse_datetime(track.get("last_checked_at"))
    if not last_checked:
        return True
    minutes = 180 if track.get("cooldown_until_closed") else int(track.get("interval_minutes") or 30)
    return last_checked + timedelta(minutes=minutes) <= now


def open_notification_id(track: Row) -> str:
    transition_key = "|".join([
        str(track.get("$id") or track.get("id") or ""),
        str(track.get("user_id") or ""),
        str(track.get("section_id") or ""),
        str(track.get("last_status") or ""),
        str(track.get("last_seats_available") or ""),
        str(track.get("updated_at") or track.get("last_checked_at") or ""),
    ])
    return f"seat-{hashlib.sha256(transition_key.encode('utf-8')).hexdigest()[:31]}"


def track_group_key(track: Row) -> str:
    section_id = str(track.get("section_id") or "").strip()
    if section_id:
        return f"section:{section_id}"
    return "|".join([
        "course",
        str(track.get("term") or "").strip(),
        str(track.get("subject") or "").strip().upper(),
        str(track.get("catalog") or "").strip(),
        str(track.get("crn") or "").strip(),
    ])


def group_metadata(tracks: Sequence[Row], section: Row | None = None, error: object = None) -> dict[str, Any]:
    representative = tracks[0] if tracks else {}
    section = section or {}
    user_ids = {
        str(track.get("user_id"))
        for track in tracks
        if track.get("user_id")
    }
    metadata = {
        "course_name": section.get("course_title") or representative.get("course_title"),
        "term": section.get("term") or representative.get("term"),
        "crn": section.get("crn") or representative.get("crn"),
        "section_number": section.get("section_number") or representative.get("section_id"),
        "seats_open": section.get("seats_available") if section else representative.get("last_seats_available"),
        "enrollment_type": section.get("enrollment_status") if section else representative.get("last_status"),
        "track_count": len(tracks),
        "user_count": len(user_ids),
        "request_source": "automated",
    }
    if error:
        metadata["error"] = sanitize_track_error(error)
    return metadata


def group_target(tracks: Sequence[Row], section: Row | None = None) -> str:
    representative = tracks[0] if tracks else {}
    section = section or {}
    return section.get("course_code") or representative.get("course_code") or representative.get("section_id") or "Tracked course"


def sanitize_track_error(error: object) -> str:
    text = SECRET_TEXT_RE.sub(r"\1[redacted]", str(error or ""))
    return " ".join(text.split())[:500]


def track_matches_filter(track: Row, *, term: str | None = None, subject: str | None = None, catalog: str | None = None) -> bool:
    if term and str(track.get("term") or "") != str(term):
        return False
    if subject and str(track.get("subject") or "").upper() != str(subject).upper():
        return False
    if catalog and str(track.get("catalog") or "").upper() != str(catalog).upper():
        return False
    return True


