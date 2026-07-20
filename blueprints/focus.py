"""Focus Mode page and account-synced API routes."""

import logging
import sqlite3

from flask import Blueprint, jsonify, render_template, request
from flask_login import current_user, login_required

from blueprints.dashboard import _load_user_settings, _theme_from_settings, _user_payload
from services import focus_mode


focus_bp = Blueprint("focus", __name__)
logger = logging.getLogger(__name__)


def _error_response(error):
    if isinstance(error, LookupError):
        return jsonify({"error": str(error)}), 404
    if isinstance(error, RuntimeError):
        return jsonify({"error": str(error)}), 409
    if isinstance(error, (ValueError, TypeError)):
        return jsonify({"error": str(error)}), 400
    logger.exception("Focus Mode request failed")
    return jsonify({"error": "Focus Mode could not save that change. Try again."}), 500


@focus_bp.get("/focus")
@login_required
def focus_page():
    if not current_user.onboarding_complete:
        from flask import redirect, url_for
        return redirect(url_for("settings.onboarding"))
    settings = _load_user_settings()
    return render_template(
        "focus.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(settings),
    )


@focus_bp.get("/api/focus")
@login_required
def get_focus_state():
    try:
        return jsonify(focus_mode.snapshot(current_user.id))
    except (ValueError, sqlite3.Error) as error:
        return _error_response(error)


@focus_bp.get("/api/focus/status")
@login_required
def get_focus_status():
    try:
        return jsonify({"active": focus_mode.is_focus_mode_active(current_user.id)})
    except sqlite3.Error as error:
        return _error_response(error)


@focus_bp.post("/api/focus/routines")
@login_required
def create_focus_routine():
    try:
        routine = focus_mode.save_routine(current_user.id, request.get_json(silent=True) or {})
        return jsonify({"routine": routine}), 201
    except (ValueError, LookupError, sqlite3.Error) as error:
        return _error_response(error)


@focus_bp.patch("/api/focus/routines/<routine_id>")
@login_required
def update_focus_routine(routine_id):
    try:
        routine = focus_mode.save_routine(
            current_user.id,
            request.get_json(silent=True) or {},
            routine_id=routine_id,
        )
        return jsonify({"routine": routine})
    except (ValueError, LookupError, sqlite3.Error) as error:
        return _error_response(error)


@focus_bp.delete("/api/focus/routines/<routine_id>")
@login_required
def delete_focus_routine(routine_id):
    try:
        if not focus_mode.delete_routine(current_user.id, routine_id):
            raise LookupError("Focus routine not found.")
        return jsonify({"deleted": True})
    except (LookupError, sqlite3.Error) as error:
        return _error_response(error)


@focus_bp.post("/api/focus/sessions")
@login_required
def start_focus_session():
    try:
        session = focus_mode.start_session(current_user.id, request.get_json(silent=True) or {})
        return jsonify({"session": session}), 201
    except (ValueError, LookupError, RuntimeError, sqlite3.Error) as error:
        return _error_response(error)


@focus_bp.patch("/api/focus/sessions/<session_id>")
@login_required
def update_focus_session(session_id):
    payload = request.get_json(silent=True) or {}
    try:
        session = focus_mode.update_session(current_user.id, session_id, payload.get("action"))
        return jsonify({"session": session, "active": session["state"] in focus_mode.ACTIVE_STATES})
    except (ValueError, LookupError, sqlite3.Error) as error:
        return _error_response(error)
