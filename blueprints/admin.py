import io
import logging
import os
import platform
import re
import secrets
from functools import wraps
from datetime import datetime, timezone

from flask import Blueprint, abort, jsonify, redirect, render_template, request, send_file, url_for
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite.services.storage import Storage
from appwrite.services.users import Users
from appwrite_client import COLLECTIONS, FILE_SHARE_BUCKET_ID, PROFILE_AVATAR_BUCKET_ID, client as appwrite_client
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    first_row,
    format_datetime,
    get_row_safe,
    list_rows_all,
    list_rows_safe,
    update_row_safe,
)
from extensions import csrf
from blueprints.settings import _settings_defaults
from blueprints.chat_api import create_university_channel, emit_chat_event
from services.chat_presence import sync_chat_presence_labels_for_school
from services.discord_audit import discord_audit_status, emit_admin_event, format_actor, format_user_target

try:
    import psutil
except ImportError:  # pragma: no cover - optional dependency for monitoring
    psutil = None


admin_bp = Blueprint("admin", __name__)
logger = logging.getLogger(__name__)
admin_actions_logger = logging.getLogger("admin_actions")
SECRET_TEXT_RE = re.compile(r"((?:[?&]|\b)(?:secret|key|token|password)=)[^&\s]+", re.IGNORECASE)

ALLOWED_SECTIONS = {
    "overview",
    "settings",
    "files",
    "notes",
    "calendars",
    "courses",
    "seat_tracks",
    "chat",
}


def _row_id(row):
    return row.get("$id") or row.get("id")


def _admin_ids():
    raw = os.environ.get("ADMIN_USER_IDS") or os.environ.get("ADMIN_USER_ID") or ""
    return {item.strip() for item in raw.split(",") if item.strip()}


def _read_os_pretty():
    try:
        if hasattr(platform, "freedesktop_os_release"):
            release = platform.freedesktop_os_release()
            pretty = release.get("PRETTY_NAME")
            if pretty:
                return pretty
    except Exception:
        pass
    try:
        return platform.platform()
    except Exception:
        return "Unknown"


def _system_status():
    status = {
        "os_pretty": _read_os_pretty(),
        "cpu_percent": None,
        "cpu_logical": None,
        "cpu_physical": None,
        "mem_percent": None,
        "mem_used_gb": None,
        "mem_total_gb": None,
    }
    if psutil is None:
        return status
    try:
        status["cpu_percent"] = round(psutil.cpu_percent(interval=0.1), 1)
    except Exception:
        pass
    try:
        status["cpu_logical"] = psutil.cpu_count(logical=True)
        status["cpu_physical"] = psutil.cpu_count(logical=False)
    except Exception:
        pass
    try:
        memory = psutil.virtual_memory()
        status["mem_percent"] = round(memory.percent, 1)
        status["mem_used_gb"] = round(memory.used / (1024**3), 1)
        status["mem_total_gb"] = round(memory.total / (1024**3), 1)
    except Exception:
        pass
    return status


def _sanitize_admin_error(error):
    text = SECRET_TEXT_RE.sub(r"\1[redacted]", str(error or ""))
    return " ".join(text.split())[:500]


def _require_admin():
    if not current_user.is_authenticated:
        return redirect(url_for("dashboard.dashboard"))
    user_id = str(getattr(current_user, "id", "") or "")
    if not user_id or user_id not in _admin_ids():
        return redirect(url_for("dashboard.dashboard"))
    return None


@admin_bp.before_request
def _protect_admin_csrf():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        csrf.protect()


def _admin_client_ip():
    return request.remote_addr or ""


def _admin_request_metadata(action, extra=None):
    metadata = {
        "action_type": action,
        "ip": _admin_client_ip(),
    }
    session_hint = (request.cookies.get("session") or "")[:16]
    if session_hint:
        metadata["session_identifier"] = session_hint
    if extra:
        metadata.update(extra)
    return metadata


def _admin_event_title(action):
    labels = {
        "view_admin_index": "Admin Viewed Dashboard",
        "view_admin_users": "Admin Viewed User Directory",
        "view_admin_requests": "Admin Viewed Requests",
        "view_admin_detail": "Admin Viewed Profile",
        "export_admin_detail": "Admin Exported User Data",
        "update_onboarding": "Admin Updated Onboarding",
        "reset_ics_token": "Admin Reset ICS Token",
        "disable_seat_tracks": "Admin Disabled Seat Tracks",
        "delete_shared_file": "Admin Deleted Shared File",
        "delete_shared_folder": "Admin Deleted Shared Folder",
        "delete_user": "Admin Deleted User",
        "approve_admin_request": "Admin Approved Request",
        "deny_admin_request": "Admin Denied Request",
        "manual_course_tracking_run": "Admin Ran Course Tracking Diagnostics",
        "toggle_course_tracking": "Admin Updated Course Tracking",
        "test_chem_150_tracking": "Admin Tested CHEM 150 Tracking",
    }
    return labels.get(action, "Admin Action")


def _log_admin_action(action, target, *, target_user=None, metadata=None, color="gray"):
    admin_actions_logger.info(
        "admin_id=%s action=%s target=%s ip=%s",
        str(getattr(current_user, "id", "") or ""),
        action,
        target,
        _admin_client_ip(),
    )
    event_target = format_user_target(target_user) if target_user else target
    emit_admin_event(
        _admin_event_title(action),
        actor=format_actor(current_user),
        target=event_target,
        metadata=_admin_request_metadata(action, metadata),
        color=color,
    )


def admin_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        gate = _require_admin()
        if gate:
            return gate
        return view(*args, **kwargs)

    return wrapped


def _theme_preference():
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load admin theme preference")
        return None
    return settings.get("interface_theme") if settings else None


def _account_to_dict(value):
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, mode="json")
    return {}


def _fetch_account(user_id):
    try:
        account = Users(appwrite_client).get(user_id)
    except Exception:
        logger.exception("Failed to fetch Appwrite account data")
        return {}
    return _account_to_dict(account)


def _user_summary(user_doc):
    return {
        "id": _row_id(user_doc),
        "username": user_doc.get("username"),
        "name": user_doc.get("name"),
        "email": user_doc.get("email"),
        "created_at": format_datetime(user_doc.get("created_at")),
        "last_login": format_datetime(user_doc.get("last_login")),
        "onboarding_complete": bool(user_doc.get("onboarding_complete")),
        "onboarding_step": user_doc.get("onboarding_step") or 1,
        "emory_student": bool(user_doc.get("emory_student")),
        "school": user_doc.get("school"),
        "major": user_doc.get("major"),
        "graduation_year": user_doc.get("graduation_year"),
    }


def _search_users(query, field):
    query = (query or "").strip()
    if not query:
        return []

    if field == "id":
        doc = get_row_safe(COLLECTIONS["users"], query, allow_missing=True)
        return [doc] if doc else []

    if field in {"email", "username"}:
        return list_rows_all(
            COLLECTIONS["users"],
            [Query.equal(field, [query]), Query.order_desc("created_at")],
        )

    results = []
    seen_ids = set()

    doc = get_row_safe(COLLECTIONS["users"], query, allow_missing=True)
    if doc:
        row_id = _row_id(doc)
        if row_id and row_id not in seen_ids:
            seen_ids.add(row_id)
            results.append(doc)

    for key in ("email", "username"):
        rows = list_rows_all(
            COLLECTIONS["users"],
            [Query.equal(key, [query]), Query.order_desc("created_at")],
        )
        for row in rows:
            row_id = _row_id(row)
            if row_id and row_id not in seen_ids:
                seen_ids.add(row_id)
                results.append(row)

    return results


def _count_rows(table_id, queries):
    try:
        response = list_rows_safe(
            table_id,
            queries + [Query.limit(1)],
        )
    except Exception:
        logger.exception("Failed to count rows for %s", table_id)
        return None

    total = response.get("total")
    if isinstance(total, int):
        return total
    try:
        return len(list_rows_all(table_id, queries))
    except Exception:
        logger.exception("Failed to fully count rows for %s", table_id)
        return None


def _safe_count_rows(table_id, queries):
    value = _count_rows(table_id, queries)
    return value if isinstance(value, int) else 0


def _user_chat_messages(user_id):
    try:
        return list_rows_all(
            COLLECTIONS["chat_messages"],
            [Query.equal("user_id", [user_id]), Query.order_desc("created_at")],
        )
    except AppwriteException:
        logger.exception("Failed to load chat history for admin")
        return []


def _user_dm_threads(user_id):
    threads = {}
    for field in ("participant_a", "participant_b"):
        try:
            rows = list_rows_all(
                COLLECTIONS["chat_dm_threads"],
                [Query.equal(field, [user_id]), Query.order_desc("updated_at")],
            )
        except AppwriteException:
            logger.exception("Failed to load chat threads for admin")
            rows = []
        for row in rows:
            row_id = _row_id(row)
            if row_id:
                threads[row_id] = row
    return sorted(
        threads.values(),
        key=lambda row: row.get("last_message_at") or row.get("updated_at") or row.get("created_at") or "",
        reverse=True,
    )


def _user_chat_blocks(user_id):
    blocks = {}
    for field in ("blocker_id", "blocked_id"):
        try:
            rows = list_rows_all(
                COLLECTIONS["chat_blocks"],
                [Query.equal(field, [user_id])],
            )
        except AppwriteException:
            logger.exception("Failed to load chat blocks for admin")
            rows = []
        for row in rows:
            row_id = _row_id(row)
            if row_id:
                blocks[row_id] = row
    return sorted(blocks.values(), key=lambda row: row.get("created_at") or "", reverse=True)


def _chat_count_summary(user_id):
    messages = _user_chat_messages(user_id)
    return {
        "chat_messages": len(messages),
        "deleted_chat_messages": sum(1 for row in messages if row.get("deleted_at")),
        "dm_threads": len(_user_dm_threads(user_id)),
        "chat_blocks": len(_user_chat_blocks(user_id)),
    }


def _pending_admin_request_count():
    return _count_rows(
        COLLECTIONS["admin_requests"],
        [Query.equal("status", ["pending"])],
    ) or 0


def _storage_service():
    return Storage(appwrite_client)


def _status_code(exc):
    status = getattr(exc, "code", None)
    if status is None:
        status = getattr(exc, "response_code", None)
    try:
        return int(status or 0)
    except (TypeError, ValueError):
        return 0


def _delete_storage_file(shared_file):
    storage_file_id = shared_file.get("storage_file_id")
    if not storage_file_id:
        return
    bucket_id = shared_file.get("storage_bucket_id") or FILE_SHARE_BUCKET_ID
    try:
        _storage_service().delete_file(bucket_id, storage_file_id)
    except AppwriteException as exc:
        if _status_code(exc) != 404:
            logger.exception("Failed to delete storage file %s", storage_file_id)


def _delete_shared_file_row(shared_file):
    _delete_storage_file(shared_file)
    delete_row_safe(COLLECTIONS["shared_files"], _row_id(shared_file))


def _collect_folder_tree_ids(user_id, root_folder_id):
    if not root_folder_id:
        return []

    folders = list_rows_all(
        COLLECTIONS["file_folders"],
        [Query.equal("user_id", [user_id])],
    )
    children_by_parent = {}
    for folder in folders:
        parent_id = folder.get("parent_folder_id")
        children_by_parent.setdefault(parent_id, []).append(_row_id(folder))

    collected = []
    stack = [root_folder_id]
    seen = set()
    while stack:
        folder_id = stack.pop()
        if not folder_id or folder_id in seen:
            continue
        seen.add(folder_id)
        collected.append(folder_id)
        stack.extend(children_by_parent.get(folder_id, []))
    return collected


def _delete_user_rows(user_id):
    table_ids = [
        COLLECTIONS["user_settings"],
        COLLECTIONS["user_courses"],
        COLLECTIONS["course_seat_tracks"],
        COLLECTIONS["calendar_cache"],
        COLLECTIONS["calendar_feeds"],
        COLLECTIONS["user_calendar_preferences"],
        COLLECTIONS["user_calendar_sources"],
        COLLECTIONS["user_events"],
        COLLECTIONS["user_event_overrides"],
        COLLECTIONS["notes"],
        COLLECTIONS["note_folders"],
        COLLECTIONS["shared_files"],
        COLLECTIONS["file_folders"],
        COLLECTIONS["chat_messages"],
        COLLECTIONS["chat_presence"],
        COLLECTIONS["chat_read_states"],
    ]

    for table_id in table_ids:
        try:
            rows = list_rows_all(
                table_id,
                [Query.equal("user_id", [user_id])],
            )
        except AppwriteException:
            logger.exception("Failed to list %s rows for deletion", table_id)
            continue

        for row in rows:
            row_id = _row_id(row)
            if not row_id:
                continue
            if table_id == COLLECTIONS["shared_files"]:
                _delete_shared_file_row(row)
                continue
            try:
                delete_row_safe(table_id, row_id)
            except AppwriteException:
                logger.exception("Failed to delete %s row %s", table_id, row_id)

    for table_id, fields in (
        (COLLECTIONS["chat_dm_threads"], ("participant_a", "participant_b")),
        (COLLECTIONS["chat_blocks"], ("blocker_id", "blocked_id")),
    ):
        for field in fields:
            try:
                rows = list_rows_all(table_id, [Query.equal(field, [user_id])])
            except AppwriteException:
                logger.exception("Failed to list %s rows for deletion", table_id)
                continue
            for row in rows:
                row_id = _row_id(row)
                if row_id:
                    try:
                        delete_row_safe(table_id, row_id)
                    except AppwriteException:
                        logger.exception("Failed to delete %s row %s", table_id, row_id)


def _load_section(section, user_id):
    if section == "settings":
        try:
            return {
                "settings": first_row(
                    COLLECTIONS["user_settings"],
                    [Query.equal("user_id", [user_id])],
                )
            }
        except AppwriteException:
            logger.exception("Failed to load user settings")
            return {"settings": None}

    if section == "files":
        try:
            folders = list_rows_all(
                COLLECTIONS["file_folders"],
                [Query.equal("user_id", [user_id]), Query.order_asc("created_at")],
            )
            files = list_rows_all(
                COLLECTIONS["shared_files"],
                [Query.equal("user_id", [user_id]), Query.order_desc("created_at")],
            )
        except AppwriteException:
            logger.exception("Failed to load files for admin")
            return {"folders": [], "files": []}
        return {
            "folders": folders,
            "files": files,
        }

    if section == "notes":
        try:
            notes = list_rows_all(
                COLLECTIONS["notes"],
                [Query.equal("user_id", [user_id]), Query.order_desc("updated_at")],
            )
            folders = list_rows_all(
                COLLECTIONS["note_folders"],
                [Query.equal("user_id", [user_id]), Query.order_asc("created_at")],
            )
        except AppwriteException:
            logger.exception("Failed to load notes for admin")
            return {"notes": [], "note_folders": []}
        return {
            "notes": notes,
            "note_folders": folders,
        }

    if section == "calendars":
        try:
            cache_rows = list_rows_all(
                COLLECTIONS["calendar_cache"],
                [Query.equal("user_id", [user_id]), Query.order_desc("event_start")],
            )
            feeds = list_rows_all(
                COLLECTIONS["calendar_feeds"],
                [Query.equal("user_id", [user_id]), Query.order_desc("updated_at")],
            )
            preferences = list_rows_all(
                COLLECTIONS["user_calendar_preferences"],
                [Query.equal("user_id", [user_id]), Query.order_asc("calendar_name")],
            )
            sources = list_rows_all(
                COLLECTIONS["user_calendar_sources"],
                [Query.equal("user_id", [user_id]), Query.order_desc("updated_at")],
            )
            events = list_rows_all(
                COLLECTIONS["user_events"],
                [Query.equal("user_id", [user_id]), Query.order_desc("start")],
            )
            overrides = list_rows_all(
                COLLECTIONS["user_event_overrides"],
                [Query.equal("user_id", [user_id]), Query.order_desc("updated_at")],
            )
        except AppwriteException:
            logger.exception("Failed to load calendar data for admin")
            return {
                "calendar_cache": [],
                "calendar_feeds": [],
                "calendar_preferences": [],
                "calendar_sources": [],
                "calendar_events": [],
                "calendar_overrides": [],
            }
        return {
            "calendar_cache": cache_rows,
            "calendar_feeds": feeds,
            "calendar_preferences": preferences,
            "calendar_sources": sources,
            "calendar_events": events,
            "calendar_overrides": overrides,
        }

    if section == "courses":
        try:
            courses = list_rows_all(
                COLLECTIONS["user_courses"],
                [Query.equal("user_id", [user_id]), Query.order_asc("term")],
            )
        except AppwriteException:
            logger.exception("Failed to load courses for admin")
            courses = []
        return {"courses": courses}

    if section == "seat_tracks":
        try:
            tracks = list_rows_all(
                COLLECTIONS["course_seat_tracks"],
                [Query.equal("user_id", [user_id]), Query.order_desc("updated_at")],
            )
        except AppwriteException:
            logger.exception("Failed to load seat tracks for admin")
            tracks = []
        return {"seat_tracks": tracks}

    if section == "chat":
        return {
            "messages": _user_chat_messages(user_id),
            "dm_threads": _user_dm_threads(user_id),
            "blocks": _user_chat_blocks(user_id),
        }

    return {}


def _export_payload(user_id):
    user_doc = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
    if not user_doc:
        return None

    return {
        "user": user_doc,
        "account": _fetch_account(user_id),
        "settings": first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        ),
        "files": list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.equal("user_id", [user_id])],
        ),
        "file_folders": list_rows_all(
            COLLECTIONS["file_folders"],
            [Query.equal("user_id", [user_id])],
        ),
        "notes": list_rows_all(
            COLLECTIONS["notes"],
            [Query.equal("user_id", [user_id])],
        ),
        "note_folders": list_rows_all(
            COLLECTIONS["note_folders"],
            [Query.equal("user_id", [user_id])],
        ),
        "calendar_cache": list_rows_all(
            COLLECTIONS["calendar_cache"],
            [Query.equal("user_id", [user_id])],
        ),
        "calendar_feeds": list_rows_all(
            COLLECTIONS["calendar_feeds"],
            [Query.equal("user_id", [user_id])],
        ),
        "calendar_preferences": list_rows_all(
            COLLECTIONS["user_calendar_preferences"],
            [Query.equal("user_id", [user_id])],
        ),
        "calendar_sources": list_rows_all(
            COLLECTIONS["user_calendar_sources"],
            [Query.equal("user_id", [user_id])],
        ),
        "calendar_events": list_rows_all(
            COLLECTIONS["user_events"],
            [Query.equal("user_id", [user_id])],
        ),
        "calendar_overrides": list_rows_all(
            COLLECTIONS["user_event_overrides"],
            [Query.equal("user_id", [user_id])],
        ),
        "courses": list_rows_all(
            COLLECTIONS["user_courses"],
            [Query.equal("user_id", [user_id])],
        ),
        "seat_tracks": list_rows_all(
            COLLECTIONS["course_seat_tracks"],
            [Query.equal("user_id", [user_id])],
        ),
        "chat_messages": _user_chat_messages(user_id),
        "chat_dm_threads": _user_dm_threads(user_id),
        "chat_blocks": _user_chat_blocks(user_id),
    }


def _redirect_detail(user_id, section, status=None, error=None):
    args = {"user_id": user_id, "section": section}
    if status:
        args["status"] = status
    if error:
        args["error"] = error
    return redirect(url_for("admin.admin_detail", **args))


@admin_bp.route("/admin")
@admin_required
def admin_index():
    error = None
    metrics = {}
    try:
        metrics = _admin_home_metrics()
    except AppwriteException:
        logger.exception("Failed to load admin home metrics")
        error = "Unable to load all admin metrics right now."

    _log_admin_action("view_admin_index", "admin home")
    return render_template(
        "admin.html",
        metrics=metrics,
        error=error,
        status=request.args.get("status"),
        system_status=_system_status(),
        theme_preference=_theme_preference(),
        pending_request_count=_pending_admin_request_count(),
        active_admin_page="home",
        breadcrumbs=[("Admin", url_for("admin.admin_index")), ("Home", None)],
    )


@admin_bp.route("/admin/users")
@admin_required
def admin_users():
    query = (request.args.get("q") or "").strip()
    field = (request.args.get("field") or "").strip()
    error = None

    try:
        if query:
            users = _search_users(query, field)
        else:
            users = list_rows_all(
                COLLECTIONS["users"],
                [Query.order_desc("created_at")],
            )
    except AppwriteException:
        logger.exception("Failed to load admin user list")
        users = []
        error = "Unable to load users right now."

    _log_admin_action("view_admin_users", "admin user directory", metadata={"query": query, "field": field})
    return render_template(
        "admin_users.html",
        users=[_user_summary(user) for user in users],
        q=query,
        field=field,
        error=error,
        status=request.args.get("status"),
        theme_preference=_theme_preference(),
        pending_request_count=_pending_admin_request_count(),
        active_admin_page="users",
        breadcrumbs=[("Admin", url_for("admin.admin_index")), ("User Directory", None)],
    )


@admin_bp.route("/admin/system-status")
@admin_required
def admin_system_status():
    return jsonify(_system_status())


def _enabled_course_track_count():
    try:
        return len(list_rows_all(
            COLLECTIONS["course_seat_tracks"],
            [Query.equal("enabled", [True])],
        )), None
    except AppwriteException as exc:
        logger.exception("Failed to count enabled course seat tracks")
        return None, _sanitize_admin_error(exc)


def _format_bytes(value):
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


def _storage_usage_summary():
    try:
        files = list_rows_all(COLLECTIONS["shared_files"])
    except Exception as exc:
        logger.exception("Failed to load file storage summary")
        return {
            "bytes": 0,
            "formatted": "--",
            "file_count": 0,
            "avatar_count": 0,
            "error": _sanitize_admin_error(exc),
        }

    total_bytes = 0
    for file_row in files:
        try:
            total_bytes += int(file_row.get("file_size_bytes") or 0)
        except (TypeError, ValueError):
            continue

    try:
        users = list_rows_all(COLLECTIONS["users"])
        avatar_count = sum(1 for user in users if user.get("avatar_file_id"))
    except Exception:
        logger.exception("Failed to count avatar storage rows")
        avatar_count = 0
    return {
        "bytes": total_bytes,
        "formatted": _format_bytes(total_bytes),
        "file_count": len(files),
        "avatar_count": avatar_count,
        "error": None,
    }


def _admin_home_metrics():
    active_tracks = _safe_count_rows(COLLECTIONS["course_seat_tracks"], [Query.equal("enabled", [True])])
    paused_tracks = _safe_count_rows(COLLECTIONS["course_seat_tracks"], [Query.equal("enabled", [False])])
    return {
        "total_users": _safe_count_rows(COLLECTIONS["users"], []),
        "emory_users": _safe_count_rows(COLLECTIONS["users"], [Query.equal("emory_student", [True])]),
        "non_emory_users": _safe_count_rows(COLLECTIONS["users"], [Query.equal("emory_student", [False])]),
        "pending_requests": _pending_admin_request_count(),
        "saved_courses": _safe_count_rows(COLLECTIONS["user_courses"], []),
        "active_course_tracks": active_tracks,
        "paused_course_tracks": paused_tracks,
        "file_storage": _storage_usage_summary(),
    }


def _course_tracking_diagnostics():
    from services.course_tracking import get_last_course_tracking_poll
    from services.scheduler import scheduler_status

    enabled_count, enabled_error = _enabled_course_track_count()
    payload = {
        **scheduler_status(),
        **discord_audit_status(),
        "enabled_track_count": enabled_count,
        "enabled_track_count_error": enabled_error,
        "last_course_tracking_poll": get_last_course_tracking_poll(),
    }
    payload["course_tracking_job_registered"] = any(
        job.get("id") == "check_course_seat_tracks"
        for job in payload.get("jobs", [])
    )
    return payload


def _track_group_key(track):
    return {
        "term": track.get("term") or "",
        "subject": str(track.get("subject") or "").upper(),
        "catalog": str(track.get("catalog") or ""),
        "crn": str(track.get("crn") or ""),
    }


def _track_group_id(key):
    return "|".join([key["term"], key["subject"], key["catalog"], key["crn"]])


def _serialize_admin_track(track):
    return {
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


def _course_tracking_groups():
    try:
        tracks = list_rows_all(
            COLLECTIONS["course_seat_tracks"],
            [Query.order_desc("updated_at")],
        )
    except Exception:
        logger.exception("Failed to load course tracking rows")
        return [], "Unable to load course tracking."

    grouped = {}
    for track in tracks:
        key = _track_group_key(track)
        if not key["term"] or not key["subject"] or not key["catalog"]:
            continue
        group_id = _track_group_id(key)
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
        group["tracks"].append(_serialize_admin_track(track))

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
            "active_count": len(enabled_tracks),
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


def _toggle_track(track, enabled):
    row_id = _row_id(track)
    if not row_id:
        raise AppwriteException("Track row is missing an id.")
    return update_row_safe(
        COLLECTIONS["course_seat_tracks"],
        row_id,
        {
            "enabled": bool(enabled),
            "updated_at": format_datetime(datetime.utcnow()),
        },
    )


@admin_bp.route("/admin/course-tracking-status")
@admin_required
def admin_course_tracking_status():
    return jsonify(_course_tracking_diagnostics())


@admin_bp.route("/admin/course-tracking/tracks")
@admin_required
def admin_course_tracking_tracks():
    groups, error = _course_tracking_groups()
    status_code = 500 if error else 200
    return jsonify({
        "groups": groups,
        "count": sum(group.get("track_count", 0) for group in groups),
        "group_count": len(groups),
        "error": error,
    }), status_code


@admin_bp.route("/admin/course-tracking/groups/toggle", methods=["POST"])
@admin_required
def admin_course_tracking_group_toggle():
    payload = request.get_json(silent=True) or request.form or {}
    enabled = str(payload.get("enabled", "")).strip().lower() in {"1", "true", "yes", "on"}
    term = str(payload.get("term") or "").strip()
    subject = str(payload.get("subject") or "").strip().upper()
    catalog = str(payload.get("catalog") or "").strip()
    crn = str(payload.get("crn") or "").strip()
    if not term or not subject or not catalog:
        return jsonify({"error": "Missing course tracking group identifiers."}), 400

    try:
        tracks = list_rows_all(
            COLLECTIONS["course_seat_tracks"],
            [
                Query.equal("term", [term]),
                Query.equal("subject", [subject]),
                Query.equal("catalog", [catalog]),
                Query.equal("crn", [crn]),
            ],
        )
        updated = [_toggle_track(track, enabled) for track in tracks]
    except AppwriteException as exc:
        logger.exception("Failed to update course tracking group")
        return jsonify({"error": "Unable to update course tracking.", "message": _sanitize_admin_error(exc)}), 500

    _log_admin_action(
        "toggle_course_tracking",
        f"group:{term}:{subject}:{catalog}:{crn}",
        metadata={"enabled": enabled, "updated_count": len(updated), "scope": "group"},
        color="green" if enabled else "yellow",
    )
    groups, _ = _course_tracking_groups()
    return jsonify({"status": "ok", "updated_count": len(updated), "groups": groups})


@admin_bp.route("/admin/course-tracking/tracks/<track_id>/toggle", methods=["POST"])
@admin_required
def admin_course_tracking_track_toggle(track_id):
    payload = request.get_json(silent=True) or request.form or {}
    enabled = str(payload.get("enabled", "")).strip().lower() in {"1", "true", "yes", "on"}
    track = get_row_safe(COLLECTIONS["course_seat_tracks"], track_id, allow_missing=True)
    if not track:
        abort(404)

    try:
        updated = _toggle_track(track, enabled)
    except AppwriteException as exc:
        logger.exception("Failed to update course tracking row")
        return jsonify({"error": "Unable to update course tracking.", "message": _sanitize_admin_error(exc)}), 500

    _log_admin_action(
        "toggle_course_tracking",
        f"track:{track_id}",
        metadata={"enabled": enabled, "scope": "track", "track_id": track_id},
        color="green" if enabled else "yellow",
    )
    return jsonify({"status": "ok", "track": _serialize_admin_track(updated)})


@admin_bp.route("/admin/course-tracking/test-chem-150", methods=["POST"])
@admin_required
def admin_course_tracking_test_chem_150():
    from services.atlas_client import fetch_live_subject_sections

    try:
        result = fetch_live_subject_sections("Fall_2026", "CHEM", catalog="150")
    except Exception as exc:
        logger.exception("CHEM 150 tracking diagnostic failed")
        return jsonify({
            "status": "error",
            "request": {"term": "Fall_2026", "subject": "CHEM", "catalog": "150"},
            "error": _sanitize_admin_error(exc),
        }), 500

    _log_admin_action(
        "test_chem_150_tracking",
        "Fall_2026:CHEM:150",
        metadata={
            "term": "Fall_2026",
            "subject": "CHEM",
            "catalog": "150",
            "section_count": len(result.get("sections") or []),
            "has_error": "error" in result,
        },
        color="yellow" if "error" in result else "green",
    )
    return jsonify({
        "status": "error" if "error" in result else "ok",
        "request": {"term": "Fall_2026", "subject": "CHEM", "catalog": "150"},
        "result": result,
        "section_count": len(result.get("sections") or []),
    }), 500 if "error" in result else 200


@admin_bp.route("/admin/course-tracking-run-now", methods=["POST"])
@admin_required
def admin_course_tracking_run_now():
    from services.course_tracking import check_course_seat_tracks

    try:
        notified_count = check_course_seat_tracks()
    except Exception as exc:
        logger.exception("Manual course tracking run failed")
        return jsonify({
            "error": "manual_course_tracking_run_failed",
            "message": _sanitize_admin_error(exc),
            "diagnostics": _course_tracking_diagnostics(),
        }), 500

    _log_admin_action(
        "manual_course_tracking_run",
        "course_tracking",
        metadata={"notifications_sent": notified_count},
        color="yellow",
    )
    return jsonify({
        "status": "ok",
        "notifications_sent": notified_count,
        "diagnostics": _course_tracking_diagnostics(),
    })


@admin_bp.route("/admin/requests")
@admin_required
def admin_requests():
    status_filter = (request.args.get("status") or "pending").strip().lower()
    if status_filter not in {"pending", "approved", "denied", "all"}:
        status_filter = "pending"
    queries = [Query.order_desc("created_at")]
    if status_filter != "all":
        queries.insert(0, Query.equal("status", [status_filter]))
    try:
        requests_rows = list_rows_all(COLLECTIONS["admin_requests"], queries)
    except AppwriteException:
        logger.exception("Failed to load admin requests")
        requests_rows = []
    tracking_groups, tracking_error = _course_tracking_groups()
    _log_admin_action("view_admin_requests", "admin requests", metadata={"status_filter": status_filter})
    return render_template(
        "admin_requests.html",
        requests=requests_rows,
        tracking_groups=tracking_groups,
        tracking_error=tracking_error,
        status_filter=status_filter,
        status=request.args.get("notice"),
        error=request.args.get("error"),
        theme_preference=_theme_preference(),
        pending_request_count=_pending_admin_request_count(),
        active_admin_page="requests",
        breadcrumbs=[("Admin", url_for("admin.admin_index")), ("Requests", None)],
    )


@admin_bp.route("/admin/requests/<request_id>/approve", methods=["POST"])
@admin_required
def approve_admin_request(request_id):
    request_row = get_row_safe(COLLECTIONS["admin_requests"], request_id, allow_missing=True)
    if not request_row:
        abort(404)
    if request_row.get("request_type") != "uni_channel_approval":
        return redirect(url_for("admin.admin_requests", error="Unsupported request type."))
    school_key = request_row.get("school_key")
    school_name = request_row.get("school_name")
    if not school_key or not school_name:
        return redirect(url_for("admin.admin_requests", error="Request is missing school data."))
    now = format_datetime(datetime.now(timezone.utc))
    try:
        channel = create_university_channel(school_key, school_name)
        update_row_safe(
            COLLECTIONS["admin_requests"],
            request_id,
            {
                "status": "approved",
                "resolved_by": str(current_user.id),
                "resolved_at": now,
                "updated_at": now,
            },
        )
        emit_chat_event(
            "university",
            school_key,
            "university_approved",
            channel_id=_row_id(channel),
            actor_id=str(current_user.id),
        )
        sync_chat_presence_labels_for_school(school_key)
    except AppwriteException:
        logger.exception("Failed to approve admin request")
        return redirect(url_for("admin.admin_requests", error="Unable to approve request."))
    _log_admin_action(
        "approve_admin_request",
        f"request:{request_id}",
        metadata={"request_type": request_row.get("request_type"), "school_name": school_name},
        color="green",
    )
    return redirect(url_for("admin.admin_requests", notice="request-approved"))


@admin_bp.route("/admin/requests/<request_id>/deny", methods=["POST"])
@admin_required
def deny_admin_request(request_id):
    request_row = get_row_safe(COLLECTIONS["admin_requests"], request_id, allow_missing=True)
    if not request_row:
        abort(404)
    now = format_datetime(datetime.now(timezone.utc))
    try:
        update_row_safe(
            COLLECTIONS["admin_requests"],
            request_id,
            {
                "status": "denied",
                "resolved_by": str(current_user.id),
                "resolved_at": now,
                "updated_at": now,
            },
        )
        if request_row.get("school_key"):
            emit_chat_event(
                "university",
                request_row.get("school_key"),
                "university_denied",
                actor_id=str(current_user.id),
            )
            sync_chat_presence_labels_for_school(request_row.get("school_key"))
    except AppwriteException:
        logger.exception("Failed to deny admin request")
        return redirect(url_for("admin.admin_requests", error="Unable to deny request."))
    _log_admin_action(
        "deny_admin_request",
        f"request:{request_id}",
        metadata={"request_type": request_row.get("request_type"), "school_name": request_row.get("school_name")},
        color="yellow",
    )
    return redirect(url_for("admin.admin_requests", notice="request-denied"))


@admin_bp.route("/admin/<user_id>")
@admin_required
def admin_detail(user_id):
    section = (request.args.get("section") or "overview").strip().lower()
    if section not in ALLOWED_SECTIONS:
        section = "overview"

    user_doc = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
    if not user_doc:
        abort(404)

    overview_counts = None
    account_data = None
    if section == "overview":
        account_data = _fetch_account(user_id)
        overview_counts = {
            "files": _safe_count_rows(COLLECTIONS["shared_files"], [Query.equal("user_id", [user_id])]),
            "folders": _safe_count_rows(COLLECTIONS["file_folders"], [Query.equal("user_id", [user_id])]),
            "notes": _safe_count_rows(COLLECTIONS["notes"], [Query.equal("user_id", [user_id])]),
            "calendar_cache": _safe_count_rows(COLLECTIONS["calendar_cache"], [Query.equal("user_id", [user_id])]),
            "calendar_feeds": _safe_count_rows(COLLECTIONS["calendar_feeds"], [Query.equal("user_id", [user_id])]),
            "courses": _safe_count_rows(COLLECTIONS["user_courses"], [Query.equal("user_id", [user_id])]),
            "seat_tracks": _safe_count_rows(COLLECTIONS["course_seat_tracks"], [Query.equal("user_id", [user_id])]),
            **_chat_count_summary(user_id),
        }

    section_data = _load_section(section, user_id)

    _log_admin_action(
        "view_admin_detail",
        f"user:{user_id}",
        target_user=user_doc,
        metadata={"section": section},
    )

    return render_template(
        "admin_detail.html",
        user=_user_summary(user_doc),
        user_doc=user_doc,
        account_data=account_data,
        overview_counts=overview_counts,
        section=section,
        section_data=section_data,
        status=request.args.get("status"),
        error=request.args.get("error"),
        theme_preference=_theme_preference(),
        pending_request_count=_pending_admin_request_count(),
        active_admin_page="users",
        breadcrumbs=[
            ("Admin", url_for("admin.admin_index")),
            ("User Directory", url_for("admin.admin_users")),
            ((_user_summary(user_doc).get("name") or _row_id(user_doc) or "User"), None),
        ],
    )


@admin_bp.route("/admin/<user_id>.json", methods=["POST"])
@admin_required
def admin_detail_export(user_id):
    payload = _export_payload(user_id)
    if not payload:
        abort(404)
    _log_admin_action(
        "export_admin_detail",
        f"user:{user_id}",
        target_user=payload.get("user"),
        metadata={"exported_sections": sorted(payload.keys())},
        color="yellow",
    )
    return jsonify(payload)


@admin_bp.route("/admin/<user_id>/onboarding", methods=["POST"])
@admin_required
def update_onboarding(user_id):
    section = (request.form.get("section") or "overview").strip() or "overview"
    onboarding_complete = bool(request.form.get("onboarding_complete"))
    step_raw = (request.form.get("onboarding_step") or "").strip()
    try:
        onboarding_step = int(step_raw) if step_raw else 1
    except (TypeError, ValueError):
        onboarding_step = 1

    try:
        update_row_safe(
            COLLECTIONS["users"],
            user_id,
            {
                "onboarding_complete": onboarding_complete,
                "onboarding_step": onboarding_step,
            },
        )
    except AppwriteException:
        logger.exception("Failed to update onboarding for %s", user_id)
        return _redirect_detail(user_id, section, error="Unable to update onboarding.")

    _log_admin_action(
        "update_onboarding",
        f"user:{user_id}",
        target_user={"$id": user_id},
        metadata={
            "onboarding_complete": onboarding_complete,
            "onboarding_step": onboarding_step,
        },
        color="green" if onboarding_complete else "gray",
    )
    return _redirect_detail(user_id, section, status="onboarding-updated")


@admin_bp.route("/admin/<user_id>/reset-ics-token", methods=["POST"])
@admin_required
def reset_ics_token(user_id):
    section = (request.form.get("section") or "settings").strip() or "settings"
    token = secrets.token_urlsafe(32)
    now = format_datetime(datetime.utcnow())

    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
        if settings:
            update_row_safe(
                COLLECTIONS["user_settings"],
                _row_id(settings),
                {"ics_secret_token": token, "updated_at": now},
            )
        else:
            create_row_safe(
                COLLECTIONS["user_settings"],
                row_id=str(user_id),
                data={**_settings_defaults(str(user_id)), "ics_secret_token": token, "updated_at": now},
            )
    except AppwriteException:
        logger.exception("Failed to reset ICS token for %s", user_id)
        return _redirect_detail(user_id, section, error="Unable to reset token.")

    _log_admin_action("reset_ics_token", f"user:{user_id}", target_user={"$id": user_id}, color="yellow")
    return _redirect_detail(user_id, section, status="token-reset")


@admin_bp.route("/admin/<user_id>/seat-tracks/disable", methods=["POST"])
@admin_required
def disable_seat_tracks(user_id):
    section = (request.form.get("section") or "seat_tracks").strip() or "seat_tracks"
    now = format_datetime(datetime.utcnow())
    updated = 0

    try:
        tracks = list_rows_all(
            COLLECTIONS["course_seat_tracks"],
            [Query.equal("user_id", [user_id])],
        )
        for track in tracks:
            update_row_safe(
                COLLECTIONS["course_seat_tracks"],
                _row_id(track),
                {"enabled": False, "updated_at": now},
            )
            updated += 1
    except AppwriteException:
        logger.exception("Failed to disable seat tracks for %s", user_id)
        return _redirect_detail(user_id, section, error="Unable to disable seat tracks.")

    _log_admin_action(
        "disable_seat_tracks",
        f"user:{user_id}",
        target_user={"$id": user_id},
        metadata={"tracks_disabled": updated},
        color="yellow",
    )
    return _redirect_detail(user_id, section, status=f"disabled-{updated}")


@admin_bp.route("/admin/<user_id>/files/<file_id>/delete", methods=["POST"])
@admin_required
def delete_shared_file(user_id, file_id):
    section = (request.form.get("section") or "files").strip() or "files"
    shared_file = get_row_safe(COLLECTIONS["shared_files"], file_id, allow_missing=True)
    if not shared_file or shared_file.get("user_id") != user_id:
        abort(404)

    try:
        _delete_shared_file_row(shared_file)
    except AppwriteException:
        logger.exception("Failed to delete shared file %s", file_id)
        return _redirect_detail(user_id, section, error="Unable to delete file.")

    _log_admin_action(
        "delete_shared_file",
        f"user:{user_id} file:{file_id}",
        target_user={"$id": user_id},
        metadata={"resource_type": "shared_file", "resource_id": file_id},
        color="yellow",
    )
    return _redirect_detail(user_id, section, status="file-deleted")


@admin_bp.route("/admin/<user_id>/folders/<folder_id>/delete", methods=["POST"])
@admin_required
def delete_shared_folder(user_id, folder_id):
    section = (request.form.get("section") or "files").strip() or "files"
    folder = get_row_safe(COLLECTIONS["file_folders"], folder_id, allow_missing=True)
    if not folder or folder.get("user_id") != user_id:
        abort(404)

    try:
        folder_ids = _collect_folder_tree_ids(user_id, folder_id)
        files = list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.equal("user_id", [user_id])],
        )
        for shared_file in files:
            if shared_file.get("folder_id") in folder_ids:
                _delete_shared_file_row(shared_file)
        for target_id in reversed(folder_ids):
            delete_row_safe(COLLECTIONS["file_folders"], target_id)
    except AppwriteException:
        logger.exception("Failed to delete shared folder %s", folder_id)
        return _redirect_detail(user_id, section, error="Unable to delete folder.")

    _log_admin_action(
        "delete_shared_folder",
        f"user:{user_id} folder:{folder_id}",
        target_user={"$id": user_id},
        metadata={"resource_type": "file_folder", "resource_id": folder_id},
        color="yellow",
    )
    return _redirect_detail(user_id, section, status="folder-deleted")


@admin_bp.route("/admin/users/<user_id>/files/<file_id>/download")
@admin_required
def download_shared_file(user_id, file_id):
    shared_file = get_row_safe(COLLECTIONS["shared_files"], file_id, allow_missing=True)
    if not shared_file or shared_file.get("user_id") != user_id:
        abort(404)

    storage_file_id = shared_file.get("storage_file_id")
    if not storage_file_id:
        abort(404)

    bucket_id = shared_file.get("storage_bucket_id") or FILE_SHARE_BUCKET_ID
    try:
        data = _storage_service().get_file_download(bucket_id, storage_file_id)
    except AppwriteException as exc:
        if _status_code(exc) == 404:
            abort(404)
        logger.exception("Failed to download shared file %s", file_id)
        abort(500)

    try:
        update_row_safe(
            COLLECTIONS["shared_files"],
            _row_id(shared_file),
            {
                "downloaded_count": int(shared_file.get("downloaded_count") or 0) + 1,
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to update download count for %s", file_id)

    return send_file(
        io.BytesIO(data),
        as_attachment=True,
        download_name=shared_file.get("original_filename") or "download",
        mimetype=shared_file.get("mime_type") or "application/octet-stream",
    )


@admin_bp.route("/admin/<user_id>/delete", methods=["POST"])
@admin_required
def delete_user(user_id):
    confirm = (request.form.get("confirm") or "").strip()
    if confirm != "DELETE":
        return _redirect_detail(user_id, "overview", error="Type DELETE to confirm removal.")

    user_doc = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
    if not user_doc:
        abort(404)

    avatar_file_id = user_doc.get("avatar_file_id")

    try:
        Users(appwrite_client).delete(user_id)
    except Exception:
        logger.exception("Failed to delete Appwrite account for %s", user_id)
        return _redirect_detail(user_id, "overview", error="Unable to delete Appwrite user.")

    _log_admin_action("delete_user", f"user:{user_id}", target_user=user_doc, color="red")

    try:
        _delete_user_rows(user_id)
    except AppwriteException:
        logger.exception("Failed to remove user data for %s", user_id)

    if avatar_file_id:
        try:
            _storage_service().delete_file(PROFILE_AVATAR_BUCKET_ID, avatar_file_id)
        except AppwriteException as exc:
            if _status_code(exc) != 404:
                logger.exception("Failed to delete avatar file %s", avatar_file_id)

    try:
        delete_row_safe(COLLECTIONS["users"], user_id)
    except AppwriteException:
        logger.exception("Failed to delete user row %s", user_id)

    return redirect(url_for("admin.admin_users", status="user-deleted"))
