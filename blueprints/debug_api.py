import logging

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from services.discord_audit import format_actor, queue_browser_console_lines

logger = logging.getLogger(__name__)

debug_api_bp = Blueprint("debug_api", __name__)

MAX_LINES_PER_REQUEST = 200
MAX_LINE_CHARS = 4000


def _normalize_console_lines(payload):
    raw_lines = payload.get("lines")
    if not isinstance(raw_lines, list):
        return []

    lines = []
    for entry in raw_lines[:MAX_LINES_PER_REQUEST]:
        if entry is None:
            continue
        if isinstance(entry, dict):
            text = entry.get("text") or entry.get("message") or ""
        else:
            text = str(entry)
        text = " ".join(str(text).split())
        if not text:
            continue
        lines.append(text[:MAX_LINE_CHARS])
    return lines


@debug_api_bp.route("/api/debug/console", methods=["POST"])
@login_required
def report_browser_console():
    """Forward batched browser console output to Discord server logs."""
    payload = request.get_json(silent=True) or {}
    lines = _normalize_console_lines(payload)
    if not lines:
        return jsonify({"status": "ignored", "reason": "empty"}), 202

    page = str(payload.get("page") or request.path or "/")[:500]
    actor = format_actor(current_user)
    queued = queue_browser_console_lines(
        actor=actor,
        page=page,
        lines=lines,
    )
    if not queued:
        return jsonify({"status": "disabled"}), 202

    return jsonify({"status": "ok", "lines": len(lines)}), 202
