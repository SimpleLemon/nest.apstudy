"""Main application pages and dashboard summary APIs."""

import hashlib
import json
import logging
from datetime import datetime, timezone

from flask import Blueprint, current_app, g, jsonify, render_template, redirect, request, url_for
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    create_row_safe,
    first_row,
    format_datetime,
    list_rows_safe,
    list_rows_all,
    update_row_safe,
)
from services.discord_audit import emit_server_log_event
from services.environment_config import runtime_environment_config
from services.atlas_client import DEFAULT_TERM, get_atlas_term_srcdb, get_general_ed_composite_requirements, get_general_ed_requirement_aliases, get_starred_general_ed_requirements
from services.daily_quote import get_daily_quote_payload
from services.calendar_store import first_calendar_row, list_calendar_rows_all
from services.calendar_assets import calendar_asset_version as _calendar_asset_version
from services.calendar_feed_sources import (
    _configured_feed_urls,
    _load_calendar_feed_metadata,
    _filter_configured_cache_events,
)
from services.calendar_sources import (
    _load_local_calendar_sources,
    _load_calendar_preferences,
    _configured_calendar_sources,
    _load_event_overrides,
)
from services.calendar_serialization import (
    _serialize_event,
    _serialize_user_event,
    _api_event_overlaps_range,
    _apply_event_override,
)
from services.canvas_routing import (
    _project_canvas_calendar_events as _project_canvas_events,
)
from services.calendar_shares import (
    _public_calendar_share_context,
)
from services.dashboard_summary import (
    DASHBOARD_CALENDAR_UPCOMING_LIMIT,
    DASHBOARD_LIST_LIMIT,
    DASHBOARD_TASK_FILTER_SOURCE_LIMIT,
    DASHBOARD_TASK_LIMIT,
    DASHBOARD_TASK_PRIORITY_RANK,
    can_access_channel,
    date_key as _date_key,
    load_courses_summary,
    load_calendar_summary,
    load_message_rooms,
    load_recent_files,
    load_recent_notes,
    load_tasks_summary,
    sort_key as _sort_key,
    task_is_complete,
    task_list_payload,
    task_payload,
    task_priority_rank,
)
from services.dashboard_layout import (
    DASHBOARD_TILE_IDS,
    DEFAULT_DASHBOARD_TILE_ORDER,
    DASHBOARD_DEFAULT_TILE_SIZES,
    DASHBOARD_ALLOWED_TILE_SIZES,
    DASHBOARD_LAYOUT_VERSION,
    DASHBOARD_CALENDAR_VIEWS,
    DASHBOARD_DEFAULT_CALENDAR_VIEW,
    DASHBOARD_TILE_LIMIT,
    DASHBOARD_DUPLICATE_TILE_LIMIT,
    DASHBOARD_DUPLICATE_TILE_TYPES,
    DASHBOARD_ITEM_LIMITS,
    DASHBOARD_DENSITIES,
    DASHBOARD_CALENDAR_UPCOMING_DAYS,
    DASHBOARD_TASK_DEADLINE_DAYS,
    DASHBOARD_TASK_PRIORITIES,
    DASHBOARD_TITLE_MAX_LENGTH,
    _default_tile_size,
    _layout_version,
    _normalize_tile_size,
    _normalize_calendar_view,
    _normalize_task_list_ids,
    _legacy_instance_id,
    _normalized_choice,
    _normalized_item_limit,
    _layout_tile_payload,
    _coerce_layout,
    _coerce_layout_order,
    _ordered_tile_layout,
    _validated_tile_size,
    _validated_calendar_view,
    save_dashboard_layout,
)
from services.dashboard_context import (
    is_emory_or_oxford_user,
    load_user_settings,
    theme_from_settings as _theme_from_settings,
    user_payload,
)
from services.row_utils import row_id as _row_id
from services.toasts import pop_toasts
from services import note_store

dashboard_bp = Blueprint("dashboard", __name__)
logger = logging.getLogger(__name__)


def _is_emory_or_oxford_user():
    return is_emory_or_oxford_user(current_user)


def _default_courses_campus():
    school = " ".join([
        str(getattr(current_user, "school", "") or ""),
        str(getattr(current_user, "school_key", "") or ""),
    ]).lower()
    return "oxford" if "oxford" in school else "atlanta"

DASHBOARD_QUOTE_ERROR_REASONS = {
    "fetch_failed",
    "http_error",
    "invalid_payload",
    "cache_read_failed",
    "cache_write_failed",
    "visibility_storage_failed",
    "unknown",
}
DASHBOARD_QUOTE_ERROR_FIELDS = ("status", "dateKey", "quoteUrl", "phase")
DASHBOARD_QUOTE_ERROR_MAX_MESSAGE_LENGTH = 500
DASHBOARD_QUOTE_ERROR_MAX_FIELD_LENGTH = 160


def _trimmed_text(value, max_length):
    text = str(value or "").strip()
    return text[:max_length]


def _daily_quote_error_metadata(payload):
    reason = str(payload.get("reason") or "").strip()
    if reason not in DASHBOARD_QUOTE_ERROR_REASONS:
        reason = "unknown"

    metadata = {
        "reason": reason,
        "message": _trimmed_text(payload.get("message"), DASHBOARD_QUOTE_ERROR_MAX_MESSAGE_LENGTH),
    }
    for field in DASHBOARD_QUOTE_ERROR_FIELDS:
        value = payload.get(field)
        if value is None:
            continue
        metadata[field] = _trimmed_text(value, DASHBOARD_QUOTE_ERROR_MAX_FIELD_LENGTH)
    return metadata


def _user_payload():
    return user_payload(current_user, emory_predicate=_is_emory_or_oxford_user)


def _load_user_settings():
    return load_user_settings(
        current_user,
        g,
        first_row_fn=first_row,
        error_logger=logger,
    )


def _settings_row_id(settings):
    return settings.get("$id") or settings.get("id") if settings else None


def _ensure_user_settings(user_id):
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [str(user_id)])],
    )
    if settings:
        return settings

    from services.settings_defaults import settings_defaults as _settings_defaults

    return create_row_safe(
        COLLECTIONS["user_settings"],
        row_id=str(user_id),
        data={**_settings_defaults(str(user_id)), "updated_at": format_datetime(datetime.now(timezone.utc))},
    )


def _task_calendar_events_for_user(user_id, range_start=None, range_end=None):
    from services.task_calendar import task_calendar_events_for_user as service_fn

    return service_fn(
        user_id,
        range_start,
        range_end,
        list_rows_fn=list_rows_all,
    )


def _resolve_calendar_share_by_code(share_code, active_only=True):
    from services.calendar_events import (
        _resolve_calendar_share_by_code as resolve_calendar_share_by_code,
    )

    return resolve_calendar_share_by_code(
        share_code,
        active_only,
        first_calendar_row_fn=first_calendar_row,
    )


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
    return load_calendar_summary(
        user_id,
        user_settings,
        list_calendar_rows_all=list_calendar_rows_all,
        load_calendar_feed_metadata=_load_calendar_feed_metadata,
        load_calendar_preferences=_load_calendar_preferences,
        load_event_overrides=_load_event_overrides,
        load_local_calendar_sources=_load_local_calendar_sources,
        logger=logger,
        task_calendar_events_for_user=_task_calendar_events_for_user,
    )


def _task_is_complete(task):
    return task_is_complete(task)


def _task_payload(row, now):
    return task_payload(row, now)


def _task_list_payload(row):
    return task_list_payload(row)


def _task_priority_rank(row):
    return task_priority_rank(row)


def _load_tasks_summary(user_id, selected_list_ids=None):
    return load_tasks_summary(
        user_id,
        selected_list_ids,
        list_rows_all=list_rows_all,
        logger=logger,
    )


def _load_recent_files(user_id):
    return load_recent_files(user_id, list_rows_all=list_rows_all,
        logger=logger,
        url_for=url_for)


def _load_recent_notes(user_id):
    return load_recent_notes(user_id, list_rows_all=list_rows_all,
        logger=logger,
        url_for=url_for)


def _load_message_rooms(user_id):
    return load_message_rooms(user_id, can_access_channel=_dashboard_can_access_channel,
        list_rows_all=list_rows_all,
        list_rows_safe=list_rows_safe,
        logger=logger,
        url_for=url_for)


def _dashboard_can_access_channel(channel):
    return can_access_channel(channel, current_user)


def _load_courses_summary(user_id):
    return load_courses_summary(
        user_id,
        _is_emory_or_oxford_user(),
        list_rows_all=list_rows_all,
        logger=logger,
    )


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
        "tile_layout_version": DASHBOARD_LAYOUT_VERSION,
        "tile_layout": tile_layout,
        "tile_order": [tile["type"] for tile in tile_layout],
        "dashboard_layout": {
            "version": DASHBOARD_LAYOUT_VERSION,
            "daily_quote_visible": saved_layout.get("daily_quote_visible"),
            "tiles": tile_layout,
        },
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


@dashboard_bp.route("/api/toasts")
def drain_toasts():
    """Return leftover session toasts. HTML pages consume the queue first.

    Kept as a fallback for responses that omit the embedded JSON payload.
    Must not be cached: a cached GET would re-show consumed toasts.
    """
    response = jsonify(pop_toasts())
    response.headers["Cache-Control"] = "no-store"
    return response


@dashboard_bp.route("/api/dashboard/summary")
@login_required
def dashboard_summary():
    """Return bounded morning-brief data for the dashboard."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403
    return jsonify(_dashboard_summary_payload())


@dashboard_bp.route("/api/dashboard/quote/today")
@login_required
def dashboard_quote_today():
    """Return today's UTC daily quote from Appwrite, falling back server-side."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403
    quote = get_daily_quote_payload()
    return jsonify({"quote": quote, "dateKey": quote.get("date")})


@dashboard_bp.route("/api/dashboard/quote/error", methods=["POST"])
@login_required
def report_dashboard_quote_error():
    """Record client-side daily quote failures without proxying the quote API."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403

    payload = request.get_json(silent=True) or {}
    metadata = _daily_quote_error_metadata(payload)
    user_id = str(current_user.id)
    actor = getattr(current_user, "email", None) or user_id
    log_metadata = {**metadata, "user_id": user_id}

    logger.warning("Daily quote error reported", extra={"daily_quote_error": log_metadata})
    try:
        emit_server_log_event(
            "Daily Quote Error",
            actor=actor,
            target="Dashboard Daily Quote",
            metadata=log_metadata,
            color="yellow",
        )
    except Exception:
        logger.exception(
            "Failed to emit daily quote error to Discord server log for user %s",
            current_user.id,
        )

    return jsonify({"status": "ok", "reason": metadata["reason"]})


@dashboard_bp.route("/api/dashboard/layout", methods=["PATCH"])
@login_required
def update_dashboard_layout():
    """Persist a validated v4 dashboard layout draft."""
    if not current_user.onboarding_complete:
        return jsonify({"error": "Onboarding is required."}), 403
    payload, status = save_dashboard_layout(
        str(current_user.id),
        request.get_json(silent=True) or {},
        list_rows_all_fn=list_rows_all,
        ensure_user_settings_fn=_ensure_user_settings,
        update_row_fn=update_row_safe,
    )
    response = jsonify(payload)
    return response if status == 200 else (response, status)


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
        calendar_buffer_days = int(
            runtime_environment_config().calendar_date_buffer_days_raw
        )
    except (TypeError, ValueError):
        calendar_buffer_days = 7
    
    return render_template(
        "calendar.html",
        user=_user_payload(),
        preferred_calendar_view=preferred_calendar_view,
        theme_preference=interface_theme,
        calendar_buffer_days=calendar_buffer_days,
        calendar_asset_version=_calendar_asset_version(),
    )


@dashboard_bp.route("/calendar/share/<share_code>")
def public_calendar_share(share_code):
    """Render a public read-only shared calendar page."""
    try:
        share = _resolve_calendar_share_by_code(share_code, active_only=True)
    except AppwriteException:
        logger.exception("Failed to resolve public calendar share")
        share = None

    theme_preference = None
    if current_user.is_authenticated:
        theme_preference = _theme_from_settings(_load_user_settings())

    try:
        calendar_buffer_days = int(
            runtime_environment_config().calendar_date_buffer_days_raw
        )
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
            calendar_asset_version=_calendar_asset_version(),
        ), 404

    context = _public_calendar_share_context(share)
    return render_template(
        "calendar_share.html",
        share_found=True,
        preferred_calendar_view="month",
        theme_preference=theme_preference,
        calendar_buffer_days=calendar_buffer_days,
        calendar_asset_version=_calendar_asset_version(),
        **context,
    )


@dashboard_bp.route("/courses")
@login_required
def courses():
    """Render the Emory-only course planning page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))
    if not _is_emory_or_oxford_user():
        return redirect(url_for("dashboard.dashboard"))

    user_settings = _load_user_settings()
    return render_template(
        "courses.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(user_settings),
        default_term=DEFAULT_TERM,
        default_campus=_default_courses_campus(),
        atlas_srcdb=get_atlas_term_srcdb(),
        general_ed_requirements=get_starred_general_ed_requirements(),
        general_ed_requirement_aliases=get_general_ed_requirement_aliases(),
        general_ed_composite_requirements=get_general_ed_composite_requirements(),
    )


@dashboard_bp.route("/notes")
@login_required
def notes():
    """Render the notes page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = _load_user_settings()
    
    return render_template(
        "notes.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(user_settings),
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


def _shared_notes_page_context(resource, access, *, page_state="ready"):
    viewer_authenticated = current_user.is_authenticated
    user = _user_payload() if viewer_authenticated else None
    theme_preference = "system-match"
    if viewer_authenticated:
        theme_preference = _theme_from_settings(_load_user_settings()) or "system-match"
    owner = note_store.get_safe_user(resource.get("user_id")) if resource else None
    if access.get("source") in {"folder_user", "folder_public"} and access.get("source_id"):
        back_url = url_for("dashboard.shared_note_folder", folder_id=access["source_id"])
        back_label = "Shared folder"
    elif viewer_authenticated and access.get("role") == "viewer":
        back_url = url_for("dashboard.notes", view="shared")
        back_label = "Shared with me"
    elif viewer_authenticated:
        back_url = url_for("dashboard.notes")
        back_label = "Notes"
    else:
        back_url = url_for("auth.index")
        back_label = "Nest.APStudy"
    return {
        "user": user,
        "viewer_authenticated": viewer_authenticated,
        "access": access,
        "owner": owner,
        "page_state": page_state,
        "theme_preference": theme_preference,
        "login_url": url_for("auth.login", next=request.path),
        "back_url": back_url,
        "back_label": back_label,
    }


@dashboard_bp.route("/notes/editor")
def legacy_notes_editor_root():
    return redirect(url_for("dashboard.notes"), code=308)


@dashboard_bp.route("/notes/editor/<note_id>")
def legacy_notes_editor(note_id):
    return redirect(url_for("dashboard.note_document", note_id=note_id, **request.args), code=308)


@dashboard_bp.route("/notes/<note_id>")
def note_document(note_id):
    """Render an owned or shared note at its canonical URL."""
    note = note_store.get_note(note_id)
    if not note:
        context = _shared_notes_page_context(None, note_store.resolve_note_access(None), page_state="unavailable")
        return render_template("notes_editor.html", note_id=note_id, **context), 404

    viewer_id = str(current_user.id) if current_user.is_authenticated else None
    access = note_store.resolve_note_access(note, viewer_id)
    if not access["can_view"]:
        page_state = "login_required" if not current_user.is_authenticated else "unavailable"
        context = _shared_notes_page_context(None, access, page_state=page_state)
        status = 401 if page_state == "login_required" else 404
        return render_template("notes_editor.html", note_id=note_id, **context), status

    if current_user.is_authenticated and not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))
    context = _shared_notes_page_context(note, access)
    return render_template("notes_editor.html", note_id=note_id, **context)


@dashboard_bp.route("/notes/folders/<folder_id>")
def shared_note_folder(folder_id):
    """Render an owned or shared note folder at its stable URL."""
    folder = note_store.get_folder(folder_id)
    if not folder:
        context = _shared_notes_page_context(None, note_store.resolve_folder_access(None), page_state="unavailable")
        return render_template("notes_shared_folder.html", folder=None, notes=[], **context), 404

    viewer_id = str(current_user.id) if current_user.is_authenticated else None
    access = note_store.resolve_folder_access(folder, viewer_id)
    if not access["can_view"]:
        page_state = "login_required" if not current_user.is_authenticated else "unavailable"
        context = _shared_notes_page_context(None, access, page_state=page_state)
        status = 401 if page_state == "login_required" else 404
        return render_template("notes_shared_folder.html", folder=None, notes=[], **context), status

    if current_user.is_authenticated and not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))
    context = _shared_notes_page_context(folder, access)
    if access.get("role") == "owner":
        context["back_url"] = url_for("dashboard.notes", folder=folder_id)
        context["back_label"] = "My Notes"
    elif current_user.is_authenticated:
        context["back_url"] = url_for("dashboard.notes", view="shared")
        context["back_label"] = "Shared with me"
    else:
        context["back_url"] = url_for("auth.index")
        context["back_label"] = "Nest.APStudy"
    notes = note_store.list_notes_in_folder(folder_id)
    return render_template("notes_shared_folder.html", folder=folder, notes=notes, **context)


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
        discord_invite_url=runtime_environment_config().discord_invite_url,
    )
