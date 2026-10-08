"""Saved course loading, matching, and public serialization without HTTP handlers."""

import json
import logging
import random
from datetime import datetime
from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime, list_rows_all, update_row_safe
from services.atlas_client import build_section_id, parse_section_id, get_sections_by_ids, get_sections_index
from services.course_live_snapshots import merge_snapshots_into_sections
from services.professor_ratings import enrich_sections_with_professor_ratings

logger = logging.getLogger(__name__)

COURSE_COLOR_KEYS = tuple(f"course-color-{index:02d}" for index in range(1, 17))
COURSE_OVERRIDE_STRING_FIELDS = {
    "course_code": 64,
    "course_title": 255,
    "course_name": 255,
    "section_number": 64,
    "instructor": 255,
    "instructor_name": 255,
    "schedule_type": 64,
    "schedule_display": 255,
    "location": 255,
    "campus": 64,
    "campus_description": 255,
    "credit_hours": 64,
    "requirement_designation": 255,
    "course_description": 4000,
    "course_notes": 4000,
}
COURSE_OVERRIDE_FIELDS = set(COURSE_OVERRIDE_STRING_FIELDS) | {"meetings"}


def _get_section_by_id(section_id, *, parse_id=None, get_sections=None, get_index=None, merge_snapshots=None):
    parse_id = parse_id or parse_section_id
    get_sections = get_sections or get_sections_by_ids
    get_index = get_index or get_sections_index
    merge_snapshots = merge_snapshots or merge_snapshots_into_sections
    parsed = parse_id(section_id)
    if not parsed:
        return None

    result = get_sections([section_id], include_cancelled=True)
    sections = result.get("sections") or []
    if sections:
        return merge_snapshots(sections)[0]

    fallback = get_index(term=parsed["term"], include_cancelled=True)
    for section in fallback.get("sections", []):
        if section.get("id") == section_id:
            return merge_snapshots([section])[0]
    return None

def _course_row_id(course):
    return course.get("$id") or course.get("id")

def _parse_course_overrides(course):
    raw = course.get("course_overrides_json")
    if not raw:
        return {}
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}

def _used_color_keys(courses, term=None, exclude_course_id=None):
    used = set()
    for course in courses:
        if term and course.get("term") != term:
            continue
        if exclude_course_id and _course_row_id(course) == exclude_course_id:
            continue
        color_key = course.get("color_key")
        if color_key in COURSE_COLOR_KEYS:
            used.add(color_key)
    return used

def _choose_course_color(courses, term, exclude_course_id=None):
    used = _used_color_keys(courses, term=term, exclude_course_id=exclude_course_id)
    available = [key for key in COURSE_COLOR_KEYS if key not in used]
    return random.choice(available or list(COURSE_COLOR_KEYS))

def _ensure_course_colors(user_id, courses, *, choose_color=None, update_row=None):
    choose_color = choose_color or _choose_course_color
    update_row = update_row or update_row_safe
    changed = []
    now = format_datetime(datetime.utcnow())
    for course in courses:
        if course.get("color_key") in COURSE_COLOR_KEYS:
            continue
        row_id = _course_row_id(course)
        if not row_id:
            continue
        color_key = choose_color(courses, course.get("term"), exclude_course_id=row_id)
        try:
            updated = update_row(
                COLLECTIONS["user_courses"],
                row_id,
                {"color_key": color_key, "updated_at": now},
            )
        except AppwriteException:
            logger.exception("Failed to assign course color")
            continue
        course.update(updated)
        changed.append(row_id)
    return changed

def _merge_course_overrides(serialized, overrides):
    for key, value in overrides.items():
        if key not in COURSE_OVERRIDE_FIELDS:
            continue
        if key == "course_name":
            serialized["course_name"] = value
            serialized["course_title"] = value
            continue
        if key == "course_title":
            serialized["course_title"] = value
            serialized["course_name"] = value
            continue
        if key == "instructor_name":
            serialized["instructor_name"] = value
            serialized["instructor"] = value
            continue
        if key == "instructor":
            serialized["instructor"] = value
            serialized["instructor_name"] = value
            continue
        serialized[key] = value
    return serialized

def _find_section_for_course(course, index_cache, *, get_section=None, get_index=None):
    get_section = get_section or _get_section_by_id
    get_index = get_index or get_sections_index
    term = course.get("term")
    subject = str(course.get("subject") or "").upper()
    catalog = str(course.get("catalog") or "")
    crn = str(course.get("crn") or "")
    section_number = str(course.get("section_number") or "")
    if not term or not subject or not catalog:
        return None

    if crn and section_number:
        section_id = build_section_id(term, subject, catalog, crn, section_number)
        section = get_section(section_id)
        if section:
            return section

    if term not in index_cache:
        index_cache[term] = get_index(term=term, include_cancelled=True).get("sections", [])

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
    # Resolve against Atlas identity before applying the owner's display edits.
    professor_ratings = enrich_sections_with_professor_ratings([section])[0].get("professor_ratings", [])
    overrides = _parse_course_overrides(course)
    subject = course.get("subject") or section.get("subject")
    catalog = course.get("catalog") or section.get("catalog_number")
    course_code = section.get("course_code") or f"{subject} {catalog}".strip()
    serialized = {
        "id": _course_row_id(course),
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
        "professor_ratings": professor_ratings,
        "location": section.get("location"),
        "schedule_type": section.get("schedule_type"),
        "schedule_display": section.get("schedule_display"),
        "meetings": section.get("meetings") or [],
        "date_range": section.get("date_range"),
        "credit_hours": section.get("credit_hours"),
        "requirement_designation": section.get("requirement_designation"),
        "requirements": section.get("requirements") or [],
        "course_description": section.get("course_description"),
        "course_notes": section.get("course_notes"),
        "enrollment_status": section.get("enrollment_status"),
        "enrollment_count": section.get("enrollment_count"),
        "seats_available": section.get("seats_available"),
        "enrollment_capacity": section.get("enrollment_capacity"),
        "waitlist_total": section.get("waitlist_total"),
        "waitlist_capacity": section.get("waitlist_capacity"),
        "live_updated_at": section.get("live_updated_at"),
        "live_snapshot_available": section.get("live_snapshot_available", False),
        "live_stale": section.get("live_stale", True),
        "is_cancelled": section.get("is_cancelled", False),
        "color_key": course.get("color_key"),
        "overrides": overrides,
        "updated_at": course.get("updated_at"),
    }
    return _merge_course_overrides(serialized, overrides)


def list_saved_courses_for_user(user_id, *, list_rows=None, ensure_colors=None, find_section=None, serialize=None):
    """Return persisted courses enriched with Atlas sections and owner overrides."""
    list_rows = list_rows or list_rows_all
    ensure_colors = ensure_colors or _ensure_course_colors
    find_section = find_section or _find_section_for_course
    serialize = serialize or _serialize_course
    courses = list_rows(COLLECTIONS["user_courses"], [
        Query.equal("user_id", [str(user_id)]), Query.order_asc("term"),
        Query.order_asc("subject"), Query.order_asc("catalog"),
    ])
    ensure_colors(str(user_id), courses)
    index_cache = {}
    return [serialize(course, find_section(course, index_cache)) for course in courses]
