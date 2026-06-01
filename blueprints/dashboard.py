"""Main application pages and dashboard summary APIs."""

import hashlib
import json
import logging
import os
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, render_template, redirect, request, url_for
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS, DATABASE_ID
from appwrite_helpers import (
    create_row_safe,
    first_row,
    format_datetime,
    list_rows_safe,
    list_rows_all,
    parse_datetime,
    update_row_safe,
)
from services.atlas_client import DEFAULT_TERM

dashboard_bp = Blueprint("dashboard", __name__)
logger = logging.getLogger(__name__)

DASHBOARD_TILE_IDS = ("calendar", "tasks", "files", "notes", "messages", "courses")
DEFAULT_DASHBOARD_TILE_ORDER = ("calendar", "tasks", "files", "notes", "messages", "courses")
DASHBOARD_DEFAULT_TILE_SIZES = {
    "calendar": "standard",
    "tasks": "standard",
    "files": "standard",
    "notes": "standard",
    "messages": "standard",
    "courses": "wide",
}
DASHBOARD_ALLOWED_TILE_SIZES = {
    "calendar": ("standard", "tall", "wide"),
    "tasks": ("standard", "tall", "wide"),
    "files": ("standard", "tall", "wide"),
    "notes": ("standard", "tall", "wide"),
    "messages": ("standard", "tall", "wide"),
    "courses": ("standard", "wide"),
}
DASHBOARD_LAYOUT_VERSION = 3
DASHBOARD_CALENDAR_VIEWS = ("month", "week", "upcoming")
DASHBOARD_DEFAULT_CALENDAR_VIEW = "month"
DASHBOARD_CALENDAR_UPCOMING_LIMIT = 6
DASHBOARD_LIST_LIMIT = 4
DASHBOARD_TASK_LIMIT = 5
DASHBOARD_TASK_PRIORITY_RANK = {
    "high": 0,
    "medium": 1,
    "low": 2,
}
def _user_payload():
    return {
        "id": str(current_user.id),
        "name": current_user.name,
        "username": current_user.username,
        "email": current_user.email,
        "picture": current_user.picture_url,
        "emory_student": current_user.emory_student,
        "school": current_user.school,
        "school_key": getattr(current_user, "school_key", None),
    }


def _load_user_settings():
    try:
        return first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
        return None


def _settings_row_id(settings):
    return settings.get("$id") or settings.get("id") if settings else None


def _ensure_user_settings(user_id):
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [str(user_id)])],
    )
    if settings:
        return settings

    from blueprints.settings import _settings_defaults

    return create_row_safe(
        COLLECTIONS["user_settings"],
        row_id=str(user_id),
        data={**_settings_defaults(str(user_id)), "updated_at": format_datetime(datetime.now(timezone.utc))},
    )


def _theme_from_settings(user_settings):
    return user_settings.get("interface_theme") if user_settings else None


def _row_id(row):
    return row.get("$id") or row.get("id") if row else None


def _as_utc(value):
    parsed = parse_datetime(value)
    if not parsed:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _date_key(value):
    parsed = _as_utc(value)
    if parsed:
        return parsed.date().isoformat()
    text = str(value or "").strip()
    return text[:10] if len(text) >= 10 else ""


def _sort_key(value):
    parsed = _as_utc(value)
    return parsed or datetime.min.replace(tzinfo=timezone.utc)


def _default_tile_size(tile_id):
    return DASHBOARD_DEFAULT_TILE_SIZES.get(tile_id, "standard")


def _layout_version(parsed):
    if isinstance(parsed, dict):
        try:
            return int(parsed.get("version") or 2)
        except (TypeError, ValueError):
            return 2
    if isinstance(parsed, list):
        return 1
    return 2


def _normalize_tile_size(tile_id, size):
    normalized = str(size or "").strip().lower()
    if normalized in {"compact", "medium"}:
        normalized = "standard"
    elif normalized == "large":
        normalized = "wide"
    if normalized not in DASHBOARD_ALLOWED_TILE_SIZES.get(tile_id, ()):
        return _default_tile_size(tile_id)
    return normalized


def _normalize_calendar_view(view):
    normalized = str(view or DASHBOARD_DEFAULT_CALENDAR_VIEW).strip().lower()
    return normalized if normalized in DASHBOARD_CALENDAR_VIEWS else DASHBOARD_DEFAULT_CALENDAR_VIEW


def _layout_tile_payload(tile_id, size=None, view=None):
    payload = {"id": tile_id, "size": _normalize_tile_size(tile_id, size)}
    if tile_id == "calendar":
        payload["view"] = _normalize_calendar_view(view)
    return payload


def _coerce_layout(raw_value):
    if isinstance(raw_value, (dict, list)):
        parsed = raw_value
    else:
        try:
            parsed = json.loads(raw_value or "[]")
        except (TypeError, ValueError):
            parsed = {}

    version = _layout_version(parsed)
    source_tiles = []
    if isinstance(parsed, dict):
        source_tiles = parsed.get("tiles") if isinstance(parsed.get("tiles"), list) else []
    elif isinstance(parsed, list):
        source_tiles = parsed

    tiles = []
    seen = set()
    for item in source_tiles:
        if isinstance(item, dict):
            tile_id = str(item.get("id") or "").strip()
            size = item.get("size")
            view = item.get("view")
        else:
            tile_id = str(item or "").strip()
            size = None
            view = None
        if tile_id not in DASHBOARD_TILE_IDS or tile_id in seen:
            continue
        tiles.append(_layout_tile_payload(tile_id, size, view))
        seen.add(tile_id)
    return {"version": version, "tiles": tiles}


def _coerce_layout_order(raw_value):
    return [tile["id"] for tile in _coerce_layout(raw_value)["tiles"]]


def _ordered_tile_layout(saved_layout, available_tile_ids):
    available = [tile_id for tile_id in available_tile_ids if tile_id in DASHBOARD_TILE_IDS]
    version = int(saved_layout.get("version") or 2) if isinstance(saved_layout, dict) else 2
    saved_tiles = saved_layout.get("tiles") if isinstance(saved_layout, dict) else []
    ordered = []
    seen = set()
    for item in saved_tiles:
        tile_id = str(item.get("id") or "").strip() if isinstance(item, dict) else ""
        if tile_id not in available or tile_id in seen:
            continue
        ordered.append(_layout_tile_payload(tile_id, item.get("size"), item.get("view")))
        seen.add(tile_id)
    if version >= DASHBOARD_LAYOUT_VERSION:
        return ordered
    for tile_id in DEFAULT_DASHBOARD_TILE_ORDER:
        if tile_id in available and tile_id not in seen:
            ordered.append(_layout_tile_payload(tile_id))
            seen.add(tile_id)
    for tile_id in available:
        if tile_id not in seen:
            ordered.append(_layout_tile_payload(tile_id))
            seen.add(tile_id)
    return ordered


def _ordered_tiles(saved_order, available_tile_ids):
    if isinstance(saved_order, dict):
        return [tile["id"] for tile in _ordered_tile_layout(saved_order, available_tile_ids)]
    available = [tile_id for tile_id in available_tile_ids if tile_id in DASHBOARD_TILE_IDS]
    ordered = []
    for item in saved_order:
        tile_id = str(item or "").strip()
        if tile_id in available and tile_id not in ordered:
            ordered.append(tile_id)
    ordered.extend(tile_id for tile_id in DEFAULT_DASHBOARD_TILE_ORDER if tile_id in available and tile_id not in ordered)
    ordered.extend(tile_id for tile_id in available if tile_id not in ordered)
    return ordered


def _validated_tile_size(tile_id, raw_size):
    if raw_size is None or str(raw_size).strip() == "":
        return _default_tile_size(tile_id)
    normalized = str(raw_size).strip().lower()
    if normalized in {"compact", "medium"}:
        normalized = "standard"
    elif normalized == "large":
        normalized = "wide"
    if normalized not in DASHBOARD_ALLOWED_TILE_SIZES.get(tile_id, ()):
        return None
    return normalized


def _validated_calendar_view(raw_view):
    if raw_view is None or str(raw_view).strip() == "":
        return DASHBOARD_DEFAULT_CALENDAR_VIEW
    normalized = str(raw_view).strip().lower()
    return normalized if normalized in DASHBOARD_CALENDAR_VIEWS else None


def _checklist_signature(items):
    payload = [
        {"id": item["id"], "complete": bool(item["complete"])}
        for item in items
    ]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _academic_year_value():
    return current_user.graduation_year or current_user.class_year


def _build_checklist(calendar_complete=False, tasks_complete=False):
    items = [
        {
            "id": "identity",
            "label": "Add your name and username",
            "complete": bool((current_user.name or "").strip() and (current_user.username or "").strip()),
            "href": url_for("settings.settings_page") + "#account",
        },
        {
            "id": "academic",
            "label": "Complete your academic profile",
            "complete": bool(
                (current_user.education_level or "").strip()
                and (current_user.school or "").strip()
                and str(_academic_year_value() or "").strip()
            ),
            "href": url_for("settings.settings_page") + "#account",
        },
        {
            "id": "calendar",
            "label": "Connect or create a calendar",
            "complete": bool(calendar_complete),
            "href": url_for("dashboard.calendar"),
        },
        {
            "id": "tasks",
            "label": "Create your first task",
            "complete": bool(tasks_complete),
            "href": url_for("dashboard.tasks"),
        },
    ]
    completed = sum(1 for item in items if item["complete"])
    signature = _checklist_signature(items)
    return {
        "items": items,
        "completed": completed,
        "total": len(items),
        "complete": completed == len(items),
        "signature": signature,
    }


def _load_calendar_summary(user_id, user_settings):
    today = datetime.now(timezone.utc).date()
    today_start = datetime(today.year, today.month, today.day, tzinfo=timezone.utc)
    week_start_date = today - timedelta(days=(today.weekday() + 1) % 7)
    week_start = datetime(week_start_date.year, week_start_date.month, week_start_date.day, tzinfo=timezone.utc)
    week_end = week_start + timedelta(days=7)
    upcoming_end = today_start + timedelta(days=8)
    month_start = datetime(today.year, today.month, 1, tzinfo=timezone.utc)
    if today.month == 12:
        month_end = datetime(today.year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        month_end = datetime(today.year, today.month + 1, 1, tzinfo=timezone.utc)
    range_start = min(month_start, week_start, today_start)
    range_end = max(month_end, week_end, upcoming_end)

    try:
        from blueprints.calendar_api import (
            _configured_calendar_sources,
            _configured_feed_urls,
            _filter_configured_cache_events,
            _load_calendar_feed_metadata,
            _load_calendar_preferences,
            _load_local_calendar_sources,
            _serialize_event,
            _serialize_user_event,
        )

        feed_urls = _configured_feed_urls(user_settings)
        cache_rows = list_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("event_start"),
            ],
        )
        event_rows = list_rows_all(
            COLLECTIONS["user_events"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("start"),
            ],
        )
        preferences = _load_calendar_preferences(user_id)
        local_sources = _load_local_calendar_sources(user_id)
        feed_metadata = _load_calendar_feed_metadata(user_id)
        sources = _configured_calendar_sources(
            user_settings,
            cache_rows,
            preferences,
            feed_metadata,
            local_sources,
            event_rows,
        )
        cache_rows = _filter_configured_cache_events(cache_rows, feed_urls)

        serialized = [_serialize_event(row, user_settings) for row in cache_rows]
        serialized.extend(_serialize_user_event(row) for row in event_rows)

        try:
            from blueprints.tasks_api import task_calendar_events_for_user

            serialized.extend(task_calendar_events_for_user(user_id, range_start, range_end))
        except (AppwriteException, AttributeError):
            logger.exception("Failed to load task events for dashboard calendar")

        visible = []
        source_by_id = {source.get("id"): source for source in sources}
        for event in serialized:
            start = _as_utc(event.get("start"))
            end = _as_utc(event.get("end")) or start
            if not start:
                continue
            if end and end < range_start:
                continue
            if start >= range_end:
                continue
            source = source_by_id.get(event.get("calendar_id")) or {}
            color = event.get("color") or source.get("color_hex") or "#6366f1"
            visible.append({
                "id": event.get("id") or event.get("uid") or event.get("event_ref"),
                "title": event.get("title") or "Untitled event",
                "start": event.get("start"),
                "end": event.get("end"),
                "date": _date_key(event.get("start")),
                "color": color,
                "all_day": bool(event.get("is_all_day")),
            })
        visible.sort(key=lambda item: _sort_key(item.get("start")))
        month_events = [
            event for event in visible
            if _sort_key(event.get("end") or event.get("start")) >= month_start and _sort_key(event.get("start")) < month_end
        ]
        week_events = [
            event for event in visible
            if _sort_key(event.get("end") or event.get("start")) >= week_start and _sort_key(event.get("start")) < week_end
        ]
        upcoming_events = [
            event for event in visible
            if _sort_key(event.get("end") or event.get("start")) >= today_start and _sort_key(event.get("start")) < upcoming_end
        ]
        return {
            "month": today.isoformat()[:7],
            "week_start": week_start.date().isoformat(),
            "upcoming_start": today.isoformat(),
            "upcoming_end": (today + timedelta(days=7)).isoformat(),
            "events": month_events[:80],
            "week_events": week_events[:40],
            "upcoming_events": upcoming_events[:DASHBOARD_CALENDAR_UPCOMING_LIMIT],
            "event_count": len(month_events),
            "setup_complete": bool(feed_urls or local_sources or event_rows),
            "error": None,
        }
    except AppwriteException:
        logger.exception("Failed to build dashboard calendar summary")
        return {
            "month": today.isoformat()[:7],
            "week_start": week_start.date().isoformat(),
            "upcoming_start": today.isoformat(),
            "upcoming_end": (today + timedelta(days=7)).isoformat(),
            "events": [],
            "week_events": [],
            "upcoming_events": [],
            "event_count": 0,
            "setup_complete": False,
            "error": "Unable to load calendar.",
        }


def _task_is_complete(task):
    if task.get("recurrence_json"):
        return False
    return bool(task.get("completed"))


def _task_payload(row, now):
    deadline = _as_utc(row.get("deadline_at"))
    overdue = bool(deadline and deadline < now and not _task_is_complete(row))
    return {
        "id": _row_id(row),
        "title": row.get("title") or "Untitled task",
        "priority": row.get("priority") or "none",
        "deadline_at": format_datetime(deadline) if deadline else None,
        "overdue": overdue,
        "starred": bool(row.get("starred")),
    }


def _task_priority_rank(row):
    priority = str(row.get("priority") or "").strip().lower()
    return DASHBOARD_TASK_PRIORITY_RANK.get(priority, len(DASHBOARD_TASK_PRIORITY_RANK))


def _dashboard_task_bucket(row, now, seven_day_end, thirty_day_end):
    deadline = _as_utc(row.get("deadline_at"))
    if not deadline:
        return 2
    if deadline <= seven_day_end:
        return 0
    if deadline <= thirty_day_end:
        return 1
    return None


def _load_tasks_summary(user_id):
    now = datetime.now(timezone.utc)
    seven_day_end = now + timedelta(days=7)
    thirty_day_end = now + timedelta(days=30)
    try:
        rows = list_rows_all(
            COLLECTIONS["tasks"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("deadline_at"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to build dashboard task summary")
        return {"items": [], "total_count": 0, "setup_complete": False, "error": "Unable to load tasks."}

    candidates = []
    for row in rows:
        if _task_is_complete(row):
            continue
        bucket = _dashboard_task_bucket(row, now, seven_day_end, thirty_day_end)
        if bucket is None:
            continue
        candidates.append((bucket, row))
    candidates.sort(key=lambda item: (
        item[0],
        _task_priority_rank(item[1]),
        _as_utc(item[1].get("deadline_at")) or datetime.max.replace(tzinfo=timezone.utc),
        item[1].get("title") or "",
    ))
    upcoming = [row for _, row in candidates]
    return {
        "items": [_task_payload(row, now) for row in upcoming[:DASHBOARD_TASK_LIMIT]],
        "total_count": len(upcoming),
        "setup_complete": bool(rows),
        "error": None,
    }


def _load_recent_files(user_id):
    now = datetime.now(timezone.utc)
    try:
        rows = list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to build dashboard file summary")
        return {"items": [], "total_count": 0, "error": "Unable to load files."}
    rows = [
        row for row in rows
        if not (expires_at := _as_utc(row.get("expires_at"))) or expires_at > now
    ]
    rows.sort(key=lambda row: _sort_key(row.get("updated_at") or row.get("created_at")), reverse=True)
    return {
        "items": [
            {
                "id": _row_id(row),
                "name": row.get("original_filename") or "Untitled file",
                "size_bytes": row.get("file_size_bytes") or 0,
                "updated_at": row.get("updated_at") or row.get("created_at"),
                "href": url_for("file_share.file_share_page"),
            }
            for row in rows[:DASHBOARD_LIST_LIMIT]
        ],
        "total_count": len(rows),
        "error": None,
    }


def _load_recent_notes(user_id):
    try:
        rows = list_rows_all(
            COLLECTIONS["notes"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to build dashboard notes summary")
        return {"items": [], "total_count": 0, "error": "Unable to load notes."}
    rows.sort(key=lambda row: _sort_key(row.get("updated_at") or row.get("created_at")), reverse=True)
    return {
        "items": [
            {
                "id": _row_id(row),
                "title": row.get("title") or "Untitled note",
                "updated_at": row.get("updated_at") or row.get("created_at"),
                "href": url_for("dashboard.notes_editor", note_id=_row_id(row)),
            }
            for row in rows[:DASHBOARD_LIST_LIMIT]
        ],
        "total_count": len(rows),
        "error": None,
    }


def _load_message_rooms(user_id):
    try:
        channels = list_rows_all(COLLECTIONS["chat_channels"], [Query.order_asc("created_at")])
        thread_rows_a = list_rows_all(COLLECTIONS["chat_dm_threads"], [Query.equal("participant_a", [user_id])])
        thread_rows_b = list_rows_all(COLLECTIONS["chat_dm_threads"], [Query.equal("participant_b", [user_id])])
        message_rows = list_rows_safe(
            COLLECTIONS["chat_messages"],
            [Query.order_desc("created_at"), Query.limit(250)],
        ).get("rows", [])
    except AppwriteException:
        logger.exception("Failed to build dashboard message summary")
        return {"items": [], "total_count": 0, "error": "Unable to load messages."}

    channel_by_id = {_row_id(row): row for row in channels if _row_id(row)}
    thread_by_id = {_row_id(row): row for row in thread_rows_a + thread_rows_b if _row_id(row)}
    room_latest = {}
    for row in message_rows:
        if row.get("deleted_at"):
            continue
        channel_id = row.get("channel_id")
        thread_id = row.get("thread_id")
        if channel_id and channel_id in channel_by_id:
            key = ("channel", channel_id)
        elif thread_id and thread_id in thread_by_id:
            key = ("thread", thread_id)
        else:
            continue
        created_at = row.get("created_at")
        if key not in room_latest or _sort_key(created_at) > _sort_key(room_latest[key]):
            room_latest[key] = created_at

    rooms = []
    for (room_type, room_id), last_at in room_latest.items():
        if room_type == "channel":
            row = channel_by_id.get(room_id) or {}
            if not _dashboard_can_access_channel(row):
                continue
            label = row.get("label") or row.get("name") or "Channel"
            href = url_for("dashboard.chat")
        else:
            row = thread_by_id.get(room_id) or {}
            other_id = row.get("participant_b") if row.get("participant_a") == user_id else row.get("participant_a")
            label = "Direct message"
            try:
                from appwrite_helpers import get_row_safe

                user = get_row_safe(COLLECTIONS["users"], other_id, allow_missing=True) if other_id else None
            except AppwriteException:
                user = None
            if user:
                label = user.get("name") or user.get("username") or label
            href = url_for("dashboard.chat")
        rooms.append({
            "id": room_id,
            "type": room_type,
            "label": label,
            "last_activity_at": last_at,
            "href": href,
        })
    rooms.sort(key=lambda item: _sort_key(item.get("last_activity_at")), reverse=True)
    return {"items": rooms[:DASHBOARD_LIST_LIMIT], "total_count": len(rooms), "error": None}


def _dashboard_can_access_channel(channel):
    if not channel:
        return False
    kind = channel.get("kind")
    if kind == "discord":
        return True
    if kind == "university":
        return bool(channel.get("approved")) and channel.get("school_key") == getattr(current_user, "school_key", None)
    return False


def _load_courses_summary(user_id):
    if not bool(getattr(current_user, "emory_student", False)):
        return {"items": [], "total_count": 0, "available": False, "error": None}
    try:
        rows = list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("term"),
                Query.order_asc("subject"),
                Query.order_asc("catalog"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to build dashboard courses summary")
        return {"items": [], "total_count": 0, "available": False, "error": "Unable to load courses."}
    rows.sort(key=lambda row: _sort_key(row.get("updated_at") or row.get("added_at")), reverse=True)
    return {
        "items": [
            {
                "id": _row_id(row),
                "code": f"{row.get('subject') or ''} {row.get('catalog') or ''}".strip() or "Course",
                "name": row.get("course_name") or "",
                "term": row.get("term") or "",
                "section": row.get("section_number") or row.get("crn") or "",
                "updated_at": row.get("updated_at") or row.get("added_at"),
            }
            for row in rows[:DASHBOARD_LIST_LIMIT]
        ],
        "total_count": len(rows),
        "available": bool(rows),
        "error": None,
    }


def _dashboard_summary_payload():
    user_id = str(current_user.id)
    user_settings = _load_user_settings()
    saved_layout = _coerce_layout(user_settings.get("dashboard_layout_json") if user_settings else "[]")

    calendar_summary = _load_calendar_summary(user_id, user_settings)
    tasks_summary = _load_tasks_summary(user_id)
    files_summary = _load_recent_files(user_id)
    notes_summary = _load_recent_notes(user_id)
    messages_summary = _load_message_rooms(user_id)
    courses_summary = _load_courses_summary(user_id)

    available_tiles = ["calendar", "tasks", "files", "notes", "messages"]
    if courses_summary.get("available"):
        available_tiles.append("courses")

    checklist = _build_checklist(
        calendar_complete=calendar_summary.get("setup_complete"),
        tasks_complete=tasks_summary.get("setup_complete"),
    )
    hidden_signature = user_settings.get("dashboard_checklist_hidden_signature") if user_settings else ""
    checklist["hidden"] = bool(hidden_signature and hidden_signature == checklist["signature"])

    tile_layout = _ordered_tile_layout(saved_layout, available_tiles)

    return {
        "user": _user_payload(),
        "generated_at": format_datetime(datetime.now(timezone.utc)),
        "tile_layout_version": saved_layout.get("version", DASHBOARD_LAYOUT_VERSION),
        "tile_layout": tile_layout,
        "tile_order": [tile["id"] for tile in tile_layout],
        "available_tiles": available_tiles,
        "checklist": checklist,
        "tiles": {
            "calendar": calendar_summary,
            "tasks": tasks_summary,
            "files": files_summary,
            "notes": notes_summary,
            "messages": messages_summary,
            "courses": courses_summary,
        },
    }


@dashboard_bp.route("/dashboard")
@login_required
def dashboard():
    """Render the authenticated user's dashboard."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = _load_user_settings()
    preferred_calendar_view = (
        user_settings.get("preferred_calendar_view")
        if user_settings and user_settings.get("preferred_calendar_view")
        else "week"
    )
    if preferred_calendar_view not in {"week", "month"}:
        preferred_calendar_view = "week"

    return render_template(
        "dashboard.html",
        user=_user_payload(),
        preferred_calendar_view=preferred_calendar_view,
        theme_preference=_theme_from_settings(user_settings),
    )


@dashboard_bp.route("/api/dashboard/summary")
@login_required
def dashboard_summary():
    """Return bounded morning-brief data for the dashboard."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403
    return jsonify(_dashboard_summary_payload())


@dashboard_bp.route("/api/dashboard/layout", methods=["PATCH"])
@login_required
def update_dashboard_layout():
    """Persist the user's visible dashboard tiles, preset sizes, and tile views."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403

    payload = request.get_json(silent=True) or {}
    raw_layout = payload.get("tile_layout", payload.get("layout"))
    if raw_layout is None:
        raw_layout = payload.get("tiles")
    if raw_layout is None:
        raw_layout = payload.get("tile_order", payload.get("order"))
    if not isinstance(raw_layout, (dict, list)):
        return jsonify({"error": "tile_layout must be an object or list."}), 400

    raw_tiles = raw_layout.get("tiles") if isinstance(raw_layout, dict) else raw_layout
    if not isinstance(raw_tiles, list):
        return jsonify({"error": "tile_layout tiles must be a list."}), 400

    normalized_tiles = []
    seen = set()
    for item in raw_tiles:
        if isinstance(item, dict):
            tile_id = str(item.get("id") or "").strip()
            raw_size = item.get("size")
            raw_view = item.get("view")
        else:
            tile_id = str(item or "").strip()
            raw_size = None
            raw_view = None
        if tile_id not in DASHBOARD_TILE_IDS:
            return jsonify({"error": f"Unknown dashboard tile: {tile_id or 'blank'}."}), 400
        if tile_id in seen:
            return jsonify({"error": f"Duplicate dashboard tile: {tile_id}."}), 400
        size = _validated_tile_size(tile_id, raw_size)
        if size is None:
            return jsonify({"error": f"Invalid size '{raw_size or 'blank'}' for dashboard tile: {tile_id}."}), 400
        tile_payload = {"id": tile_id, "size": size}
        if tile_id == "calendar":
            view = _validated_calendar_view(raw_view)
            if view is None:
                return jsonify({"error": f"Invalid calendar view '{raw_view or 'blank'}'."}), 400
            tile_payload["view"] = view
        normalized_tiles.append(tile_payload)
        seen.add(tile_id)

    normalized = {"version": DASHBOARD_LAYOUT_VERSION, "tiles": normalized_tiles}

    user_id = str(current_user.id)
    try:
        settings = _ensure_user_settings(user_id)
        settings = update_row_safe(
            COLLECTIONS["user_settings"],
            _settings_row_id(settings),
            {
                "dashboard_layout_json": json.dumps(normalized, separators=(",", ":")),
                "updated_at": format_datetime(datetime.now(timezone.utc)),
            },
        )
    except AppwriteException:
        logger.exception("Failed to save dashboard layout")
        return jsonify({"error": "Unable to save dashboard layout."}), 500

    saved_layout = _coerce_layout(settings.get("dashboard_layout_json"))
    return jsonify({
        "status": "ok",
        "tile_layout": saved_layout["tiles"],
        "tile_order": [tile["id"] for tile in saved_layout["tiles"]],
    })


@dashboard_bp.route("/api/dashboard/checklist/hidden", methods=["POST"])
@login_required
def update_dashboard_checklist_hidden():
    """Persist whether the current checklist state is hidden."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403

    payload = request.get_json(silent=True) or {}
    hidden = bool(payload.get("hidden"))
    summary = _dashboard_summary_payload()
    signature = summary.get("checklist", {}).get("signature") or ""

    user_id = str(current_user.id)
    try:
        settings = _ensure_user_settings(user_id)
        update_row_safe(
            COLLECTIONS["user_settings"],
            _settings_row_id(settings),
            {
                "dashboard_checklist_hidden_signature": signature if hidden else "",
                "updated_at": format_datetime(datetime.now(timezone.utc)),
            },
        )
    except AppwriteException:
        logger.exception("Failed to save dashboard checklist visibility")
        return jsonify({"error": "Unable to save checklist preference."}), 500

    return jsonify({"status": "ok", "hidden": hidden, "signature": signature})


@dashboard_bp.route("/calendar")
@login_required
def calendar():
    """Render the calendar page with user and preference context."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = _load_user_settings()
    preferred_calendar_view = (
        user_settings.get("preferred_calendar_view")
        if user_settings and user_settings.get("preferred_calendar_view")
        else "week"
    )
    if preferred_calendar_view not in {"week", "month"}:
        preferred_calendar_view = "week"
    interface_theme = _theme_from_settings(user_settings)
    try:
        calendar_buffer_days = int(os.environ.get("CALENDAR_DATE_BUFFER_DAYS", "7"))
    except (TypeError, ValueError):
        calendar_buffer_days = 7
    
    return render_template(
        "calendar.html",
        user=_user_payload(),
        preferred_calendar_view=preferred_calendar_view,
        theme_preference=interface_theme,
        calendar_buffer_days=calendar_buffer_days,
    )


@dashboard_bp.route("/calendar/share/<share_code>")
def public_calendar_share(share_code):
    """Render a public read-only shared calendar page."""
    from blueprints.calendar_api import _public_calendar_share_context, _resolve_calendar_share_by_code

    try:
        share = _resolve_calendar_share_by_code(share_code, active_only=True)
    except AppwriteException:
        logger.exception("Failed to resolve public calendar share")
        share = None

    theme_preference = None
    if current_user.is_authenticated:
        theme_preference = _theme_from_settings(_load_user_settings())

    try:
        calendar_buffer_days = int(os.environ.get("CALENDAR_DATE_BUFFER_DAYS", "7"))
    except (TypeError, ValueError):
        calendar_buffer_days = 7

    if not share:
        return render_template(
            "calendar_share.html",
            share_found=False,
            share_code=share_code,
            owner_name="",
            scope_label="",
            theme_preference=theme_preference,
            preferred_calendar_view="month",
            calendar_buffer_days=calendar_buffer_days,
        ), 404

    context = _public_calendar_share_context(share)
    return render_template(
        "calendar_share.html",
        share_found=True,
        preferred_calendar_view="month",
        theme_preference=theme_preference,
        calendar_buffer_days=calendar_buffer_days,
        **context,
    )


@dashboard_bp.route("/courses")
@login_required
def courses():
    """Render the Emory-only course planning page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))
    if not current_user.emory_student:
        return redirect(url_for("dashboard.dashboard"))

    user_settings = _load_user_settings()
    return render_template(
        "courses.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(user_settings),
        default_term=DEFAULT_TERM,
    )


@dashboard_bp.route("/notes")
@login_required
def notes():
    """Render the notes page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))
    
    return render_template(
        "notes.html",
        user=_user_payload(),
    )


@dashboard_bp.route("/task")
@login_required
def task_redirect():
    """Redirect the legacy task URL to the canonical tasks page."""
    return redirect(url_for("dashboard.tasks", **request.args))


@dashboard_bp.route("/tasks")
@login_required
def tasks():
    """Render the task management page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = _load_user_settings()
    return render_template(
        "task.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(user_settings),
    )


@dashboard_bp.route("/notes/editor", defaults={"note_id": None})
@dashboard_bp.route("/notes/editor/<note_id>")
@login_required
def notes_editor(note_id):
    """Render the note editor page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = _load_user_settings()
    return render_template(
        "notes_editor.html",
        user=_user_payload(),
        note_id=note_id,
        theme_preference=_theme_from_settings(user_settings),
    )


@dashboard_bp.route("/chat")
@login_required
def chat():
    """Render the chat page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = _load_user_settings()
    return render_template(
        "chat.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(user_settings),
        discord_invite_url=os.environ.get("DISCORD_INVITE_URL", ""),
        appwrite_database_id=DATABASE_ID or "",
        chat_events_table_id=COLLECTIONS.get("chat_events", "chat_events"),
    )
