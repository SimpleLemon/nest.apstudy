import logging
from datetime import datetime

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query

from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    first_row,
    format_datetime,
    get_row_safe,
    list_rows_all,
    update_row_safe,
)
from services.atlas_client import (
    build_section_id,
    fetch_live_section_status,
    get_sections_by_ids,
    get_sections_index,
    is_section_trackable,
    parse_section_id,
)
from services.course_catalog import get_course_catalog_metadata


courses_bp = Blueprint("courses", __name__)
logger = logging.getLogger(__name__)


def _current_user_id():
    return str(current_user.id)


def _require_emory_student():
    if not bool(getattr(current_user, "emory_student", False)):
        return jsonify({"error": "Courses are only available to Emory students."}), 403
    return None


def _get_section_by_id(section_id):
    parsed = parse_section_id(section_id)
    if not parsed:
        return None

    result = get_sections_by_ids([section_id], include_cancelled=True)
    sections = result.get("sections") or []
    if sections:
        return sections[0]

    fallback = get_sections_index(term=parsed["term"], include_cancelled=True)
    for section in fallback.get("sections", []):
        if section.get("id") == section_id:
            return section
    return None


def _find_section_for_course(course, index_cache):
    term = course.get("term")
    subject = str(course.get("subject") or "").upper()
    catalog = str(course.get("catalog") or "")
    crn = str(course.get("crn") or "")
    section_number = str(course.get("section_number") or "")
    if not term or not subject or not catalog:
        return None

    if crn and section_number:
        section_id = build_section_id(term, subject, catalog, crn, section_number)
        section = _get_section_by_id(section_id)
        if section:
            return section

    if term not in index_cache:
        index_cache[term] = get_sections_index(term=term, include_cancelled=True).get("sections", [])

    best_match = None
    for section in index_cache[term]:
        if section.get("term") != term:
            continue
        if str(section.get("subject") or "").upper() != subject:
            continue
        if str(section.get("catalog_number") or "") != catalog:
            continue
        if crn and str(section.get("crn") or "") == crn:
            return section
        if section_number and str(section.get("section_number") or "") == section_number:
            return section
        if best_match is None:
            best_match = section
    return best_match


def _serialize_course(course, section=None):
    section = section or {}
    subject = course.get("subject") or section.get("subject")
    catalog = course.get("catalog") or section.get("catalog_number")
    course_code = section.get("course_code") or f"{subject} {catalog}".strip()
    return {
        "id": course.get("$id") or course.get("id"),
        "section_id": section.get("id"),
        "term": course.get("term") or section.get("term"),
        "subject": subject,
        "catalog": catalog,
        "catalog_number": catalog,
        "crn": course.get("crn") or section.get("crn"),
        "section_number": course.get("section_number") or section.get("section_number"),
        "course_code": course_code,
        "course_title": course.get("course_name") or section.get("course_title"),
        "course_name": course.get("course_name") or section.get("course_title"),
        "instructor": course.get("instructor_name") or section.get("instructor"),
        "instructor_name": course.get("instructor_name") or section.get("instructor"),
        "instructors": section.get("instructors") or [],
        "location": section.get("location"),
        "schedule_type": section.get("schedule_type"),
        "schedule_display": section.get("schedule_display"),
        "meetings": section.get("meetings") or [],
        "date_range": section.get("date_range"),
        "credit_hours": section.get("credit_hours"),
        "requirement_designation": section.get("requirement_designation"),
        "course_description": section.get("course_description"),
        "course_notes": section.get("course_notes"),
        "enrollment_status": section.get("enrollment_status"),
        "enrollment_count": section.get("enrollment_count"),
        "seats_available": section.get("seats_available"),
        "is_cancelled": section.get("is_cancelled", False),
    }


def _track_for_section(user_id, section):
    return first_row(
        COLLECTIONS["course_seat_tracks"],
        [
            Query.equal("user_id", [user_id]),
            Query.equal("term", [section.get("term")]),
            Query.equal("subject", [section.get("subject")]),
            Query.equal("catalog", [section.get("catalog_number")]),
            Query.equal("crn", [section.get("crn") or ""]),
        ],
    )


def _serialize_track(track):
    return {
        "id": track.get("$id") or track.get("id"),
        "section_id": track.get("section_id"),
        "term": track.get("term"),
        "subject": track.get("subject"),
        "catalog": track.get("catalog"),
        "crn": track.get("crn"),
        "course_code": track.get("course_code"),
        "course_title": track.get("course_title"),
        "enabled": bool(track.get("enabled", False)),
        "last_status": track.get("last_status"),
        "last_seats_available": track.get("last_seats_available"),
        "last_checked_at": track.get("last_checked_at"),
        "last_notified_at": track.get("last_notified_at"),
    }


def _merge_live_section(section):
    timestamp = format_datetime(datetime.utcnow())
    catalog_info = get_course_catalog_metadata(section.get("subject"), section.get("catalog_number"))
    enriched_section = dict(section)
    for key, value in catalog_info.items():
        if value not in (None, "", []) and enriched_section.get(key) in (None, "", []):
            enriched_section[key] = value

    result = fetch_live_section_status(
        enriched_section.get("term"),
        enriched_section.get("subject"),
        enriched_section.get("catalog_number"),
        crn=enriched_section.get("crn"),
        section_number=enriched_section.get("section_number"),
    )
    if "error" in result:
        enriched_section["live_updated_at"] = timestamp
        return enriched_section, result["error"], timestamp
    live_section = result.get("section") or {}
    merged = dict(enriched_section)
    for key, value in live_section.items():
        if value not in (None, "", []):
            merged[key] = value
    merged["live_updated_at"] = timestamp
    return merged, None, timestamp


@courses_bp.route("/saved", methods=["GET"])
@login_required
def list_saved_courses():
    forbidden = _require_emory_student()
    if forbidden:
        return forbidden

    try:
        courses = list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [_current_user_id()]),
                Query.order_asc("term"),
                Query.order_asc("subject"),
                Query.order_asc("catalog"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to list user courses")
        return jsonify({"error": "Unable to load courses."}), 500

    index_cache = {}
    serialized = [
        _serialize_course(course, _find_section_for_course(course, index_cache))
        for course in courses
    ]
    return jsonify({"count": len(serialized), "courses": serialized})


@courses_bp.route("/saved", methods=["POST"])
@login_required
def add_saved_course():
    forbidden = _require_emory_student()
    if forbidden:
        return forbidden

    payload = request.get_json(silent=True) or {}
    section_id = payload.get("section_id")
    section = _get_section_by_id(section_id)
    if not section:
        return jsonify({"error": "Course section not found."}), 404
    if section.get("is_cancelled"):
        return jsonify({"error": "Cancelled sections cannot be added."}), 400

    user_id = _current_user_id()
    try:
        candidates = list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [user_id]),
                Query.equal("term", [section.get("term")]),
                Query.equal("subject", [section.get("subject")]),
                Query.equal("catalog", [section.get("catalog_number")]),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to check existing course")
        return jsonify({"error": "Unable to add course."}), 500

    existing = next(
        (doc for doc in candidates if str(doc.get("crn") or "") == str(section.get("crn") or "")),
        None,
    )
    if existing:
        return jsonify({"status": "ok", "course": _serialize_course(existing, section)})

    try:
        course = create_row_safe(
            COLLECTIONS["user_courses"],
            row_id=ID.unique(),
            data={
                "user_id": user_id,
                "term": section.get("term"),
                "subject": section.get("subject"),
                "catalog": section.get("catalog_number"),
                "crn": section.get("crn") or "",
                "course_name": section.get("course_title") or "",
                "section_number": section.get("section_number") or "",
                "instructor_name": section.get("instructor") or "",
                "source": "courses",
                "added_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to add course")
        return jsonify({"error": "Unable to add course."}), 500

    return jsonify({"status": "ok", "course": _serialize_course(course, section)}), 201


@courses_bp.route("/saved/<course_id>", methods=["DELETE"])
@login_required
def remove_saved_course(course_id):
    forbidden = _require_emory_student()
    if forbidden:
        return forbidden

    try:
        course = get_row_safe(COLLECTIONS["user_courses"], course_id)
    except AppwriteException as exc:
        if getattr(exc, "code", None) == 404:
            return jsonify({"error": "Course not found."}), 404
        logger.exception("Failed to load course")
        return jsonify({"error": "Unable to remove course."}), 500

    if course.get("user_id") != _current_user_id():
        return jsonify({"error": "Course not found."}), 404

    try:
        delete_row_safe(COLLECTIONS["user_courses"], course_id)
    except AppwriteException:
        logger.exception("Failed to delete course")
        return jsonify({"error": "Unable to remove course."}), 500

    return jsonify({"status": "ok"})


@courses_bp.route("/tracks", methods=["GET"])
@login_required
def list_tracks():
    forbidden = _require_emory_student()
    if forbidden:
        return forbidden

    try:
        tracks = list_rows_all(
            COLLECTIONS["course_seat_tracks"],
            [Query.equal("user_id", [_current_user_id()])],
        )
    except AppwriteException:
        logger.exception("Failed to list course tracks")
        return jsonify({"error": "Unable to load course tracking."}), 500

    serialized = [_serialize_track(track) for track in tracks]
    return jsonify({
        "count": len(serialized),
        "tracks": serialized,
        "tracks_by_section": {
            track["section_id"]: track
            for track in serialized
            if track.get("section_id")
        },
    })


@courses_bp.route("/tracks", methods=["POST"])
@login_required
def upsert_track():
    forbidden = _require_emory_student()
    if forbidden:
        return forbidden

    payload = request.get_json(silent=True) or {}
    section_id = payload.get("section_id")
    enabled = bool(payload.get("enabled", True))
    section = _get_section_by_id(section_id)
    if not section:
        return jsonify({"error": "Course section not found."}), 404

    live_error = None
    last_updated_at = None
    if enabled:
        section, live_error, last_updated_at = _merge_live_section(section)
        if not is_section_trackable(section):
            return jsonify({
                "error": "This section is not closed/full right now.",
                "section": section,
                "live_error": live_error,
                "last_updated_at": last_updated_at,
            }), 400

    user_id = _current_user_id()
    now = format_datetime(datetime.utcnow())
    data = {
        "user_id": user_id,
        "term": section.get("term"),
        "subject": section.get("subject"),
        "catalog": section.get("catalog_number"),
        "crn": section.get("crn") or "",
        "section_id": section.get("id") or section_id,
        "course_code": section.get("course_code") or "",
        "course_title": section.get("course_title") or "",
        "last_status": section.get("enrollment_status"),
        "last_seats_available": section.get("seats_available"),
        "enabled": enabled,
        "updated_at": now,
    }

    try:
        existing = _track_for_section(user_id, section)
        if existing:
            track = update_row_safe(
                COLLECTIONS["course_seat_tracks"],
                existing.get("$id") or existing.get("id"),
                data,
            )
        else:
            data["created_at"] = now
            track = create_row_safe(
                COLLECTIONS["course_seat_tracks"],
                row_id=ID.unique(),
                data=data,
            )
    except AppwriteException:
        logger.exception("Failed to update course track")
        return jsonify({"error": "Unable to update course tracking."}), 500

    return jsonify({
        "status": "ok",
        "track": _serialize_track(track),
        "section": section,
        "live_error": live_error,
        "last_updated_at": last_updated_at,
    })


@courses_bp.route("/section-status", methods=["POST"])
@login_required
def section_status():
    forbidden = _require_emory_student()
    if forbidden:
        return forbidden

    payload = request.get_json(silent=True) or {}
    section_id = payload.get("section_id")
    section = _get_section_by_id(section_id)
    if not section:
        return jsonify({"error": "Course section not found."}), 404

    section, live_error, last_updated_at = _merge_live_section(section)
    return jsonify({
        "section": section,
        "trackable": is_section_trackable(section),
        "live_error": live_error,
        "last_updated_at": last_updated_at,
    })
