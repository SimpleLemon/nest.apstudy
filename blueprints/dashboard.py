"""
blueprints/dashboard.py

Main dashboard view. Renders the authenticated user's dashboard page.
All data fetching happens client-side via the Atlas and Calendar API blueprints.
"""

import logging
import os

from flask import Blueprint, render_template, redirect, url_for
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import first_row
from services.atlas_client import DEFAULT_TERM

dashboard_bp = Blueprint("dashboard", __name__)
logger = logging.getLogger(__name__)


def _user_payload():
    return {
        "name": current_user.name,
        "email": current_user.email,
        "picture": current_user.picture_url,
        "emory_student": current_user.emory_student,
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


@dashboard_bp.route("/notes/editor", defaults={"note_id": None})
@dashboard_bp.route("/notes/editor/<note_id>")
@login_required
def notes_editor(note_id):
    """Render the note editor page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    return render_template(
        "notes_editor.html",
        user=_user_payload(),
        note_id=note_id,
    )


@dashboard_bp.route("/chat")
@login_required
def chat():
    """Render the chat page."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))
    
    return render_template(
        "chat.html",
        user=_user_payload(),
    )
