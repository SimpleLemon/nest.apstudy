"""Cross-user admin tracker projection and effective policy summaries."""
import logging
from collections.abc import Mapping
from typing import Any

from appwrite.query import Query
from services.row_utils import row_id as _row_id
from services.course_tracking_terms import term_policy, track_policy_fields

from services.admin_ports import ListAdminRows

logger = logging.getLogger(__name__)
Row = Mapping[str, Any]


def track_group_key(track: Row) -> dict[str, str]:
    return {
        "term": track.get("term") or "",
        "subject": str(track.get("subject") or "").upper(),
        "catalog": str(track.get("catalog") or ""),
        "crn": str(track.get("crn") or ""),
    }


def track_group_id(key: Mapping[str, str]) -> str:
    return "|".join([key["term"], key["subject"], key["catalog"], key["crn"]])


def serialize_admin_track(track: Row) -> dict[str, Any]:
    return {
        **track_policy_fields(track),
        "id": _row_id(track),
        "user_id": track.get("user_id"),
        "term": track.get("term"),
        "subject": track.get("subject"),
        "catalog": track.get("catalog"),
        "crn": track.get("crn"),
        "section_id": track.get("section_id"),
        "course_code": track.get("course_code"),
        "course_title": track.get("course_title"),
        "enabled": bool(track.get("enabled")),
        "last_status": track.get("last_status"),
        "last_seats_available": track.get("last_seats_available"),
        "last_checked_at": track.get("last_checked_at"),
        "last_notified_at": track.get("last_notified_at"),
        "created_at": track.get("created_at"),
        "updated_at": track.get("updated_at"),
    }


def course_tracking_groups(*, table_id: str, list_rows_all: ListAdminRows) -> tuple[list[dict[str, Any]], str | None]:
    try:
        tracks = list_rows_all(
            table_id,
            [Query.order_desc("updated_at")],
        )
    except Exception:
        logger.exception("Failed to load course tracking rows")
        return [], "Unable to load course tracking."

    grouped = {}
    for track in tracks:
        key = track_group_key(track)
        if not key["term"] or not key["subject"] or not key["catalog"]:
            continue
        group_id = track_group_id(key)
        group = grouped.setdefault(group_id, {
            "id": group_id,
            **key,
            "course_code": track.get("course_code") or f"{key['subject']} {key['catalog']}".strip(),
            "course_title": track.get("course_title") or "",
            "tracks": [],
        })
        if not group.get("course_code") and track.get("course_code"):
            group["course_code"] = track.get("course_code")
        if not group.get("course_title") and track.get("course_title"):
            group["course_title"] = track.get("course_title")
        group["tracks"].append(serialize_admin_track(track))

    groups = []
    for group in grouped.values():
        tracks = group["tracks"]
        enabled_tracks = [track for track in tracks if track.get("enabled")]
        paused_tracks = [track for track in tracks if not track.get("enabled")]
        users = sorted({track.get("user_id") for track in tracks if track.get("user_id")})
        last_checked_values = [track.get("last_checked_at") for track in tracks if track.get("last_checked_at")]
        last_updated_values = [track.get("updated_at") for track in tracks if track.get("updated_at")]
        representative = tracks[0] if tracks else {}
        group.update({
            "track_count": len(tracks),
            "active_count": sum(track["effective_enabled"] for track in tracks),
            "waiting_count": sum(track["enabled"] and not track["effective_enabled"] for track in tracks),
            "can_enable": term_policy(group["term"])["can_enable"],
            "paused_count": len(paused_tracks),
            "user_count": len(users),
            "users": users,
            "last_checked_at": max(last_checked_values) if last_checked_values else None,
            "last_updated_at": max(last_updated_values) if last_updated_values else None,
            "last_status": representative.get("last_status"),
            "last_seats_available": representative.get("last_seats_available"),
            "enabled": bool(enabled_tracks),
        })
        groups.append(group)

    groups.sort(key=lambda item: (item.get("term") or "", item.get("subject") or "", item.get("catalog") or "", item.get("crn") or ""))
    return groups, None


