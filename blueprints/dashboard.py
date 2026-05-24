"""
blueprints/dashboard.py

Main dashboard view. Renders the authenticated user's dashboard page.
All data fetching happens client-side via the Atlas and Calendar API blueprints.
"""

import logging
import os

from flask import Blueprint, render_template, redirect, request, url_for
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS, DATABASE_ID
from appwrite_helpers import first_row
from services.atlas_client import DEFAULT_TERM

dashboard_bp = Blueprint("dashboard", __name__)
logger = logging.getLogger(__name__)


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


def _theme_from_settings(user_settings):
    return user_settings.get("interface_theme") if user_settings else None


@dashboard_bp.route("/dashboard")
@login_required
def dashboard():
    """Render the blank dashboard page."""
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
