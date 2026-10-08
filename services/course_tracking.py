import logging
from datetime import datetime, timezone
from collections.abc import Mapping
from typing import Any

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite.services.messaging import Messaging

from appwrite_client import COLLECTIONS, client as appwrite_client
from appwrite_helpers import format_datetime, list_rows_all, update_row_safe
from services.atlas_client import fetch_live_section_status
from services.course_tracking_terms import term_is_polling
from services.course_tracking_delivery import send_open_email
from services.course_tracking_groups import poll_track_group
from services.course_tracking_ports import PollingPorts
from services.course_tracking_state import (
    track_due as _track_due, track_group_key as _track_group_key,
    sanitize_track_error as _sanitize_track_error,
    track_matches_filter as _track_matches_filter, Row,
)
from services.discord_audit import emit_course_track_event, update_course_tracks_channel_topic
from services.environment_config import runtime_environment_config
from services import notifications


logger = logging.getLogger(__name__)
_last_poll_metadata: dict[str, Any] | None = None


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _send_open_email(track: Row, section: Row) -> None:
    return send_open_email(
        track, section, messaging=Messaging(appwrite_client),
        base_url=runtime_environment_config().app_base_url,
    )


def _emit_poll_event(title: str, *, metadata: Mapping[str, Any], color: str = "gray") -> bool:
    return emit_course_track_event(
        title,
        actor="System",
        target="Course seat tracking poll",
        metadata={
            "request_source": "automated",
            **metadata,
        },
        color=color,
    )


def _record_last_poll(title: str, metadata: Mapping[str, Any], *, discord_emit_returned: bool | None = None) -> dict[str, Any]:
    global _last_poll_metadata
    snapshot = dict(metadata or {})
    if discord_emit_returned is not None:
        snapshot["discord_emit_returned"] = bool(discord_emit_returned)
    snapshot["event_title"] = title
    snapshot["recorded_at"] = format_datetime(_now_utc())
    _last_poll_metadata = snapshot
    return snapshot


def get_last_course_tracking_poll() -> dict[str, Any]:
    return dict(_last_poll_metadata or {})


def check_course_seat_tracks(*, term: str | None = None, subject: str | None = None, catalog: str | None = None, poll_source: str = "automated") -> int:
    """Poll enabled course seat trackers and notify users when seats open."""
    table_id = COLLECTIONS.get("course_seat_tracks")
    filter_metadata = {
        key: value
        for key, value in {
            "term": term,
            "subject": str(subject or "").upper() if subject else None,
            "catalog": str(catalog or "").upper() if catalog else None,
            "poll_source": poll_source,
        }.items()
        if value
    }
    if not table_id:
        logger.info("Course tracking skipped: collection mapping missing.")
        metadata = {"reason": "collection_mapping_missing", **filter_metadata}
        emitted = _emit_poll_event(
            "Automated Course Track Poll Skipped",
            metadata=metadata,
            color="yellow",
        )
        _record_last_poll("Automated Course Track Poll Skipped", metadata, discord_emit_returned=emitted)
        return 0

    try:
        tracks = list_rows_all(table_id, [Query.equal("enabled", [True])])
    except AppwriteException as exc:
        logger.exception("Failed to list course seat tracks")
        metadata = {"error": _sanitize_track_error(exc), **filter_metadata}
        emitted = _emit_poll_event(
            "Automated Course Track Poll Failed",
            metadata=metadata,
            color="red",
        )
        _record_last_poll("Automated Course Track Poll Failed", metadata, discord_emit_returned=emitted)
        return 0

    if term or subject or catalog:
        tracks = [
            track for track in tracks
            if _track_matches_filter(track, term=term, subject=subject, catalog=catalog)
        ]

    now = _now_utc()
    enabled_count = len(tracks)
    polling_terms = {term: term_is_polling(term) for term in {track.get("term") for track in tracks}}
    tracks = [track for track in tracks if polling_terms[track.get("term")]]
    suspended_count = enabled_count - len(tracks)
    filter_metadata["term_suspended_count"] = suspended_count
    if poll_source == "automated":
        tracks = [track for track in tracks if _track_due(track, now)]
    notified_count = 0
    if not tracks:
        logger.info("Course tracking skipped: no enabled course seat tracks.")
        metadata = {"reason": "terms_not_open" if suspended_count == enabled_count and enabled_count else "no_due_tracks" if enabled_count else "no_enabled_tracks", "enabled_track_count": enabled_count, "track_count": 0, **filter_metadata}
        # Idle polls are expected outside registration and between track intervals.
        update_course_tracks_channel_topic(0)
        _record_last_poll("Automated Course Track Poll Skipped", metadata, discord_emit_returned=False)
        return 0

    grouped_tracks: dict[str, list[Row]] = {}
    for track in tracks:
        grouped_tracks.setdefault(_track_group_key(track), []).append(track)

    poll_metadata = {
        **filter_metadata,
        "enabled_track_count": enabled_count,
        "track_count": len(tracks),
        "section_group_count": len(grouped_tracks),
        "atlas_checks_attempted": 0,
        "atlas_checks_succeeded": 0,
        "atlas_checks_failed": 0,
        "row_updates": 0,
        "row_update_failures": 0,
        "email_notifications": 0,
        "email_failures": 0,
        "changed_rows_written": 0,
        "unchanged_rows_skipped": 0,
        "failed_rows_skipped": 0,
        "notifications_sent": 0,
        "due_track_count": len(tracks),
        "cooldown_track_count": len([track for track in tracks if track.get("cooldown_until_closed")]),
    }

    ports = PollingPorts(
        term_is_polling=term_is_polling, fetch_section=fetch_live_section_status,
        send_open_email=_send_open_email, preferences=notifications.preferences,
        notify=notifications.notify, update_row=update_row_safe,
        emit_event=emit_course_track_event,
    )
    for grouped in grouped_tracks.values():
        notified_count += poll_track_group(
            grouped, table_id=table_id, now=now, counters=poll_metadata, ports=ports,
        )

    if poll_metadata["enabled_track_count"] and not poll_metadata["atlas_checks_attempted"]:
        logger.warning("Course tracking found enabled tracks but made no Atlas checks.")
        emit_course_track_event(
            "Automated Course Track Poll Diagnostic",
            actor="System",
            target="Course seat tracking poll",
            metadata={**poll_metadata, "reason": "enabled_tracks_without_atlas_checks"},
            color="yellow",
        )

    title = "Automated Course Track Poll Completed"
    update_course_tracks_channel_topic(poll_metadata["section_group_count"])
    _record_last_poll(title, poll_metadata)
    return notified_count
