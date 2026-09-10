"""Extension envelopes for authenticated, consented Nest calendar operations."""

import json

from flask import Blueprint, make_response, request
from flask_login import current_user

from blueprints import calendar_api as calendar
from blueprints import courses as course_routes
from blueprints.extension_api import (
    _auth_or_response, _error_response, _handle_extension_error,
    _phase2_response, _require_capabilities, extension_response_contract,
)
from services.calendar_events import canvas_consent_status
from services.atlas_client import get_sections_by_ids, get_sections_index, get_terms
from services.extension_contract import ExtensionContractError

extension_calendar_bp = Blueprint("extension_calendar", __name__)
extension_calendar_bp.after_request(extension_response_contract)
EXTENSION_AUX_ITEMS_MAX_BYTES = 96 * 1024


def _call(handler, *, read_only=False, capabilities=("calendar_read",), consent_scopes=(), **kwargs):
    unauthorized = _auth_or_response()
    if unauthorized:
        return unauthorized
    try:
        _require_capabilities(*capabilities)
        if consent_scopes:
            account_key = request.headers.get("X-Canvas-Account-Key")
            canvas_consent_status(str(current_user.id), account_key,
                                  required_scopes=tuple(consent_scopes), version=1)
        if request.method != "GET" and not read_only:
            _require_capabilities("calendar_two_way_writeback")
            body = request.get_json(silent=True) or {}
            account_key = request.headers.get("X-Canvas-Account-Key") or body.get("account_key")
            canvas_consent_status(str(current_user.id), account_key,
                                  required_scopes=("personal_events_write",), version=2)
        response = make_response(handler(**kwargs))
        body = response.get_json() or {}
        body.pop("user_id", None)
        if "calendar_sources" in body:
            body["sources"] = body["calendar_sources"]
        if response.status_code >= 400:
            return _error_response("calendar_request_failed", body.get("error", "Calendar request failed."), response.status_code)
        return _phase2_response(**body)
    except Exception as exc:
        return _handle_extension_error(exc)


def _bounded_int(name, default, minimum, maximum):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        raise ExtensionContractError("invalid_request", f"{name} must be an integer.")
    if value < minimum or value > maximum:
        raise ExtensionContractError("invalid_request", f"{name} is outside the supported range.")
    return value


def _text(value, limit):
    value = str(value or "").strip()
    return value[:limit]


def _bounded_items(items, budget=EXTENSION_AUX_ITEMS_MAX_BYTES):
    output = []
    used = 2
    for item in items:
        encoded = json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        next_size = used + len(encoded) + (1 if output else 0)
        if next_size > budget:
            break
        output.append(item)
        used = next_size
    return output


def _slim_section(section):
    section = section if isinstance(section, dict) else {}
    section_id = _text(section.get("id") or section.get("section_id"), 160)
    if not section_id:
        return None
    output = {"id": section_id, "is_cancelled": bool(section.get("is_cancelled"))}
    for key, limit in {
        "term": 64, "subject": 32, "course_code": 64, "course_title": 512,
        "catalog_number": 32, "section_number": 32, "instructor": 256, "type": 64,
    }.items():
        value = _text(section.get(key), limit)
        if value:
            output[key] = value
    instructors = section.get("instructors_unique") or section.get("instructors") or []
    if isinstance(instructors, list):
        output["instructors_unique"] = [_text(item, 256) for item in instructors[:16] if _text(item, 256)]
    date_range = section.get("date_range")
    if isinstance(date_range, dict):
        output["date_range"] = {key: _text(date_range.get(key), 10) for key in ("start", "end")}
    meetings = []
    for meeting in section.get("meetings") or []:
        if not isinstance(meeting, dict):
            continue
        item = {key: _text(meeting.get(key), 256 if key == "location" else 16) for key in ("day", "start", "end", "location")}
        if item["day"] and item["start"] and item["end"]:
            meetings.append(item)
        if len(meetings) == 32:
            break
    output["meetings"] = meetings
    return output


def _course_search_payload():
    if len(str(request.args.get("q") or "")) > 120 or len(str(request.args.get("term") or "")) > 64:
        raise ExtensionContractError("invalid_request", "Course search text is too long.")
    query = _text(request.args.get("q"), 120)
    term = _text(request.args.get("term"), 64)
    limit = _bounded_int("limit", 50, 1, 100)
    offset = _bounded_int("offset", 0, 0, 5000)
    result = get_sections_index(term=term or None, query=query or None, include_cancelled=True, limit=limit, offset=offset)
    if "error" in result:
        raise ExtensionContractError("invalid_request", str(result["error"]))
    all_sections = [item for item in (_slim_section(row) for row in result.get("sections") or []) if item]
    sections = _bounded_items(all_sections)
    total = max(len(all_sections) + offset, int(result.get("total") or 0))
    terms = get_terms().get("terms") or []
    return {"terms": [_text(item, 64) for item in terms[:64]], "sections": sections,
            "count": len(sections), "total": total, "offset": offset, "limit": limit,
            "has_more": len(sections) < len(all_sections) or offset + len(sections) < total}


@extension_calendar_bp.route("/courses", methods=["GET"])
def courses():
    return _call(_course_search_payload, consent_scopes=("ongoing_read",))


def _selected_sections_payload():
    raw_ids = request.args.get("ids")
    section_ids = raw_ids.split(",") if isinstance(raw_ids, str) and raw_ids else None
    if not isinstance(section_ids, list) or len(section_ids) > 100 or any(not item or len(item) > 160 for item in section_ids):
        raise ExtensionContractError("invalid_request", "section_ids must contain at most 100 bounded identifiers.")
    result = get_sections_by_ids(section_ids=list(dict.fromkeys(section_ids)), include_cancelled=True)
    if "error" in result:
        raise ExtensionContractError("invalid_request", str(result["error"]))
    sections = _bounded_items([item for item in (_slim_section(row) for row in result.get("sections") or []) if item])
    return {"sections": sections, "count": len(sections)}


@extension_calendar_bp.route("/course-sections", methods=["GET"])
def course_sections():
    return _call(_selected_sections_payload, consent_scopes=("ongoing_read",))


def _saved_courses_payload():
    response = make_response(course_routes.list_saved_courses())
    if response.status_code == 403:
        return {"courses": [], "count": 0, "supported": False}
    body = response.get_json() or {}
    if response.status_code >= 400:
        raise RuntimeError(body.get("error") or "Unable to load saved courses.")
    courses = _bounded_items([item for item in (_slim_section(row) for row in body.get("courses") or []) if item][:100])
    return {"courses": courses, "count": len(courses), "supported": True}


@extension_calendar_bp.route("/saved-courses", methods=["GET"])
def saved_courses():
    return _call(_saved_courses_payload, consent_scopes=("ongoing_read",))


def _shares_payload():
    response = make_response(calendar.list_calendar_shares())
    body = response.get_json() or {}
    if response.status_code >= 400:
        raise RuntimeError(body.get("error") or "Unable to load calendar shares.")
    shares = body.get("shares") if isinstance(body.get("shares"), list) else []
    shares = _bounded_items(shares[:100])
    return {"shares": shares, "count": len(shares)}


@extension_calendar_bp.route("/shares", methods=["GET"])
def shares():
    return _call(_shares_payload, capabilities=("calendar_read", "calendar_shares_ics"),
                 consent_scopes=("ongoing_read", "shares_ics_inclusion"))


@extension_calendar_bp.route("/preferences", methods=["GET", "POST"])
def preferences():
    if request.method == "GET":
        return _call(calendar.get_calendar_preferences)
    body = request.get_json(silent=True) or {}
    handler = calendar.update_calendar_preferences_batch if isinstance(body, dict) and "preferences" in body else calendar.update_calendar_preferences
    return _call(handler)


@extension_calendar_bp.route("/events", methods=["GET", "POST"])
def events():
    return _call(calendar.get_events if request.method == "GET" else calendar.create_event)


@extension_calendar_bp.route("/events/<event_id>", methods=["GET", "PUT", "DELETE"])
def event(event_id):
    # Native handlers load user_events and check user_id before any mutation.
    if event_id.startswith("user:"):
        event_id = event_id[5:]
    return _call({"GET": calendar.get_single_event, "PUT": calendar.update_event,
                  "DELETE": calendar.delete_event}[request.method], event_id=event_id)


@extension_calendar_bp.route("/event-overrides", methods=["POST"])
def override():
    return _call(calendar.upsert_event_override)


@extension_calendar_bp.route("/event-overrides/hide", methods=["POST"])
def hide():
    return _call(calendar.hide_event_override)


@extension_calendar_bp.route("/refresh", methods=["POST"])
def refresh():
    return _call(calendar.refresh_feed)
