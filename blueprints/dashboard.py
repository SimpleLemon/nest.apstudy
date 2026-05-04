"""
blueprints/dashboard.py

Main dashboard view. Renders the authenticated user's dashboard page.
All data fetching happens client-side via the Atlas and Calendar API blueprints.
"""

import logging

from flask import Blueprint, render_template, redirect, url_for
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import first_document

dashboard_bp = Blueprint("dashboard", __name__)
logger = logging.getLogger(__name__)


@dashboard_bp.route("/dashboard")
@login_required
def dashboard():
    """Render the dashboard with user context for the template header."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    user_settings = None
    try:
        user_settings = first_document(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
    preferred_calendar_view = (
        user_settings.get("preferred_calendar_view")
        if user_settings and user_settings.get("preferred_calendar_view")
        else "week"
    )
    if preferred_calendar_view not in {"week", "month"}:
        preferred_calendar_view = "week"
    interface_theme = user_settings.get("interface_theme") if user_settings else None

    return render_template(
        "dashboard.html",
        user={
            "name": current_user.name,
            "email": current_user.email,
            "picture": current_user.picture_url,
        },
        preferred_calendar_view=preferred_calendar_view,
        theme_preference=interface_theme,
    )