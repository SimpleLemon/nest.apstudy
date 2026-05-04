"""
blueprints/settings.py

Per-user settings and onboarding routes.
Handles Canvas iCal URL configuration, refresh intervals,
.ics token management, and "My Courses" selections.
"""

import json
import secrets
import logging
from datetime import datetime
from urllib.parse import urlparse, urlunparse

from flask import Blueprint, render_template, request, jsonify, redirect, url_for
from flask_login import login_required, current_user

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
from services.atlas_client import DEFAULT_TERM

settings_bp = Blueprint("settings", __name__)
logger = logging.getLogger(__name__)

CANVAS_CALENDAR_HOST_PREFIX = "canvas."
CANVAS_CALENDAR_HOST_SUFFIX = ".edu"
CANVAS_CALENDAR_PATH_PREFIXES = ("/feeds/calendar", "/feeds/calendars")
MAX_OTHER_CALENDAR_URLS = 10


def _normalize_calendar_url(url):
    """Return a normalized URL string for duplicate checks, or None if invalid."""
    if not isinstance(url, str):
        return None

    raw = url.strip()
    if not raw:
        return None

    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme == "webcal":
        scheme = "https"

    if scheme not in {"http", "https"}:
        return None

    if not parsed.netloc:
        return None

    normalized_path = (parsed.path or "").rstrip("/")
    normalized = urlunparse((
        scheme,
        parsed.netloc.lower(),
        normalized_path,
        "",
        parsed.query,
        "",
    ))
    return normalized


def _normalize_canvas_calendar_url(url):
    """Return a normalized Canvas calendar URL, or None if invalid."""
    if not isinstance(url, str):
        return None

    raw = url.strip()
    if not raw:
        return None

    if "://" not in raw:
        raw = f"https://{raw}"

    parsed = urlparse(raw)
    if parsed.scheme.lower() != "https":
        return None

    host = parsed.netloc.lower()
    if not (host.startswith(CANVAS_CALENDAR_HOST_PREFIX) and host.endswith(CANVAS_CALENDAR_HOST_SUFFIX)):
        return None

    path = parsed.path or ""
    if not path.startswith(CANVAS_CALENDAR_PATH_PREFIXES):
        return None

    normalized_path = path.rstrip("/")
    return urlunparse((
        "https",
        host,
        normalized_path,
        "",
        parsed.query,
        "",
    ))


def _load_other_calendar_urls(settings):
    """Load and sanitize persisted optional calendar URLs from JSON text."""
    if not settings or not settings.get("other_ical_urls_json"):
        return []

    try:
        parsed = json.loads(settings.get("other_ical_urls_json"))
    except json.JSONDecodeError:
        return []

    if not isinstance(parsed, list):
        return []

    urls = []
    for item in parsed:
        if isinstance(item, str) and item.strip():
            urls.append(item.strip())
    return urls[:MAX_OTHER_CALENDAR_URLS]


def _validate_other_calendar_urls(other_urls, canvas_url):
    """Validate optional external calendar links and prevent duplicates."""
    if other_urls is None:
        return []
    if not isinstance(other_urls, list):
        raise ValueError("other_ical_urls must be a list.")

    cleaned = []
    seen = set()
    normalized_canvas = _normalize_calendar_url(canvas_url)

    for raw in other_urls:
        if not isinstance(raw, str):
            raise ValueError("Each calendar URL must be a string.")

        value = raw.strip()
        if not value:
            continue

        normalized = _normalize_calendar_url(value)
        if not normalized:
            raise ValueError(
                "Each optional calendar link must be a valid http(s) or webcal URL."
            )

        if normalized_canvas and normalized == normalized_canvas:
            raise ValueError("Optional calendar links cannot duplicate the Nest Canvas calendar.")

        if normalized in seen:
            raise ValueError("Duplicate optional calendar links are not allowed.")

        seen.add(normalized)
        cleaned.append(value)

    if len(cleaned) > MAX_OTHER_CALENDAR_URLS:
        raise ValueError(f"You can add up to {MAX_OTHER_CALENDAR_URLS} optional calendar links.")

    return cleaned


EDUCATION_LEVELS = {
    "High School",
    "Undergraduate",
    "Graduate",
    "Other",
}


def _normalize_education_level(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized if normalized in EDUCATION_LEVELS else None


def _normalize_emory_student(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"yes", "true", "1"}:
            return True
        if normalized in {"no", "false", "0"}:
            return False
    return None


def _normalize_emory_email(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if not normalized:
        return None
    if not normalized.endswith("@emory.edu"):
        raise ValueError("Please enter a valid @emory.edu email address.")
    return normalized


def _onboarding_courses():
    try:
        return list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [str(current_user.id)]),
                Query.equal("source", ["onboarding"]),
                Query.order_asc("added_at"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load onboarding courses")
        return []


def _onboarding_context():
    return {
        "user": {
            "name": current_user.name,
            "email": current_user.email,
            "picture": current_user.picture_url,
        },
        "first_name": (current_user.name or current_user.email or "Student").split()[0],
        "step": current_user.onboarding_step or 1,
        "education_level": current_user.education_level,
        "class_year": current_user.class_year,
        "emory_student": current_user.emory_student,
        "emory_email": current_user.emory_email,
        "courses": [
            {
                "id": course.get("$id"),
                "course_code": f"{course.get('subject')} {course.get('catalog')}",
                "course_name": course.get("course_name"),
                "section_number": course.get("section_number"),
                "instructor_name": course.get("instructor_name"),
                "term": course.get("term"),
            }
            for course in _onboarding_courses()
        ],
        "default_term": DEFAULT_TERM,
    }


# ── Page routes ───────────────────────────────────────────────────────────────

@settings_bp.route("/onboarding")
@login_required
def onboarding():
    """
    First-login onboarding page.
    Prompts the user to paste their Canvas iCal feed URL.
    Redirected here from auth.py if no feed URL is configured.
    """
    if current_user.onboarding_complete:
        return redirect(url_for("dashboard.dashboard"))

    return render_template("onboarding.html", **_onboarding_context())


@settings_bp.route("/onboarding", methods=["POST"])
@login_required
def save_onboarding():
    """Persist each onboarding step and advance the user's progress."""
    payload = request.get_json(silent=True) or request.form.to_dict(flat=True)
    step = int(payload.get("step", current_user.onboarding_step or 1))
    action = payload.get("action", "continue")
    user_id = str(current_user.id)

    if step == 1:
        next_step = max(current_user.onboarding_step or 1, 2)
        try:
            update_row_safe(
                COLLECTIONS["users"],
                user_id,
                {"onboarding_step": next_step},
            )
        except AppwriteException:
            logger.exception("Failed to update onboarding step")
            return jsonify({"error": "Unable to save onboarding."}), 500
        current_user.onboarding_step = next_step
        return jsonify({"status": "ok", "next_step": 2})

    if step == 2:
        education_level = _normalize_education_level(payload.get("education_level"))
        if not education_level:
            return jsonify({"error": "Select an education level before continuing."}), 400

        class_year = (payload.get("class_year") or "").strip() or None
        emory_student = _normalize_emory_student(payload.get("emory_student"))
        emory_email = payload.get("emory_email")

        if education_level in {"High School", "Undergraduate"}:
            if not class_year or len(class_year) != 4 or not class_year.isdigit():
                return jsonify({"error": "Enter a valid 4-digit class year."}), 400
        else:
            class_year = None

        if education_level == "Undergraduate":
            if emory_student is None:
                return jsonify({"error": "Select whether you are an Emory University student."}), 400
            if emory_student:
                try:
                    emory_email = _normalize_emory_email(emory_email)
                except ValueError as error:
                    return jsonify({"error": str(error)}), 400
            else:
                emory_email = None
        else:
            emory_student = None
            emory_email = None

        next_step = 3 if education_level == "Undergraduate" and emory_student else 4

        try:
            update_row_safe(
                COLLECTIONS["users"],
                user_id,
                {
                    "education_level": education_level,
                    "class_year": class_year,
                    "emory_student": emory_student,
                    "emory_email": emory_email,
                    "onboarding_step": next_step,
                },
            )
        except AppwriteException:
            logger.exception("Failed to update onboarding profile")
            return jsonify({"error": "Unable to save onboarding."}), 500
        current_user.education_level = education_level
        current_user.class_year = class_year
        current_user.emory_student = emory_student
        current_user.emory_email = emory_email
        current_user.onboarding_step = next_step
        return jsonify({"status": "ok", "next_step": next_step})

    if step == 3:
        if action == "add_course":
            course_code = (payload.get("course_code") or "").strip().upper()
            course_name = (payload.get("course_name") or "").strip() or None
            section_number = (payload.get("section_number") or "").strip() or None
            instructor_name = (payload.get("instructor_name") or "").strip() or None
            term = (payload.get("term") or DEFAULT_TERM).strip() or DEFAULT_TERM

            subject = (payload.get("subject") or "").strip().upper()
            catalog = (payload.get("catalog") or "").strip()

            if course_code and (not subject or not catalog):
                parts = course_code.split()
                if len(parts) >= 2:
                    subject = parts[0].upper()
                    catalog = parts[1]

            if not subject or not catalog:
                return jsonify({"error": "Course code is required."}), 400

            try:
                candidates = list_rows_all(
                    COLLECTIONS["user_courses"],
                    [
                        Query.equal("user_id", [user_id]),
                        Query.equal("term", [term]),
                        Query.equal("subject", [subject]),
                        Query.equal("catalog", [catalog]),
                        Query.equal("source", ["onboarding"]),
                    ],
                )
            except AppwriteException:
                logger.exception("Failed to check onboarding course")
                return jsonify({"error": "Unable to save course."}), 500

            existing = next(
                (doc for doc in candidates if not doc.get("crn")),
                None,
            )
            if existing:
                return jsonify({"error": "Course already added."}), 409

            try:
                course = create_row_safe(
                    COLLECTIONS["user_courses"],
                    row_id=ID.unique(),
                    data={
                        "user_id": user_id,
                        "term": term,
                        "subject": subject,
                        "catalog": catalog,
                        "course_name": course_name,
                        "section_number": section_number,
                        "instructor_name": instructor_name,
                        "source": "onboarding",
                        "added_at": format_datetime(datetime.utcnow()),
                    },
                )
            except AppwriteException:
                logger.exception("Failed to add onboarding course")
                return jsonify({"error": "Unable to save course."}), 500

            return jsonify({
                "status": "ok",
                "course": {
                    "id": course.get("$id"),
                    "course_code": f"{subject} {catalog}",
                    "course_name": course_name,
                    "section_number": section_number,
                    "instructor_name": instructor_name,
                    "term": term,
                },
            }), 201

        if action in {"advance", "continue", "review"}:
            try:
                update_row_safe(
                    COLLECTIONS["users"],
                    user_id,
                    {"onboarding_step": 4},
                )
            except AppwriteException:
                logger.exception("Failed to update onboarding step")
                return jsonify({"error": "Unable to save onboarding."}), 500
            current_user.onboarding_step = 4
            return jsonify({"status": "ok", "next_step": 4})

        if action == "complete":
            try:
                update_row_safe(
                    COLLECTIONS["users"],
                    user_id,
                    {
                        "onboarding_step": 4,
                        "onboarding_complete": True,
                    },
                )
            except AppwriteException:
                logger.exception("Failed to complete onboarding")
                return jsonify({"error": "Unable to save onboarding."}), 500
            current_user.onboarding_step = 4
            current_user.onboarding_complete = True
            return jsonify({"status": "ok", "redirect_url": url_for("dashboard.dashboard")})

    if step in {4, 5}:
        try:
            update_row_safe(
                COLLECTIONS["users"],
                user_id,
                {
                    "onboarding_complete": True,
                    "onboarding_step": 4,
                },
            )
        except AppwriteException:
            logger.exception("Failed to complete onboarding")
            return jsonify({"error": "Unable to save onboarding."}), 500
        current_user.onboarding_complete = True
        current_user.onboarding_step = 4
        return jsonify({"status": "ok", "redirect_url": url_for("dashboard.dashboard")})

    return jsonify({"error": "Invalid onboarding step."}), 400


@settings_bp.route("/")
@login_required
def settings_page():
    """Render the settings page with current user configuration."""
    if not current_user.onboarding_complete:
        return redirect(url_for("settings.onboarding"))

    if not current_user.created_at:
        try:
            update_row_safe(
                COLLECTIONS["users"],
                str(current_user.id),
                {"created_at": format_datetime(datetime.utcnow())},
            )
        except AppwriteException:
            logger.exception("Failed to set user created_at")
        current_user.created_at = datetime.utcnow()

    try:
        user_settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
        user_settings = None
    other_calendar_urls = _load_other_calendar_urls(user_settings)

    try:
        courses = list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [str(current_user.id)]),
                Query.order_asc("term"),
                Query.order_asc("subject"),
                Query.order_asc("catalog"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load user courses")
        courses = []

    return render_template("settings.html", user={
        "name": current_user.name or current_user.email,
        "email": current_user.email,
        "picture": current_user.picture_url,
        "member_since": current_user.created_at.strftime("%b %d, %Y"),
    }, settings=user_settings, courses=courses, other_calendar_urls=other_calendar_urls, theme_preference=user_settings.get("interface_theme") if user_settings else None)


# ── API routes (called by settings page JavaScript) ──────────────────────────

@settings_bp.route("/api/profile", methods=["POST"])
@login_required
def update_profile():
    """Update editable profile fields for the authenticated user."""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()

    if not name:
        return jsonify({"error": "Name is required."}), 400

    updates = {"name": name}
    if not current_user.created_at:
        updates["created_at"] = format_datetime(datetime.utcnow())

    try:
        update_row_safe(
            COLLECTIONS["users"],
            str(current_user.id),
            updates,
        )
    except AppwriteException:
        logger.exception("Failed to update profile")
        return jsonify({"error": "Unable to update profile."}), 500

    current_user.name = name
    if updates.get("created_at"):
        current_user.created_at = datetime.utcnow()

    return jsonify({
        "status": "ok",
        "name": current_user.name,
        "member_since": current_user.created_at.strftime("%b %d, %Y"),
    })

@settings_bp.route("/api/feed-url", methods=["POST"])
@login_required
def update_feed_url():
    """
    POST /settings/api/feed-url
        Body: {
            "canvas_ical_url": "https://canvas.nest.edu/feeds/calendars/...",
            "other_ical_urls": ["https://calendar.google.com/...", "webcal://..."]
        }

    Saves or updates the user's Canvas iCal feed URL.
    Used by both the onboarding page and the settings page.
    """
    data = request.get_json(silent=True) or {}
    if "canvas_ical_url" not in data and "other_ical_urls" not in data:
        return jsonify({"error": "Missing calendar payload"}), 400

    raw_url = (data.get("canvas_ical_url") or "").strip()
    url = None
    if raw_url:
        url = _normalize_canvas_calendar_url(raw_url)
        if not url:
            return jsonify({
                "error": "Canvas calendar must use https://canvas.<school>.edu/feeds/calendar..."
            }), 400

    try:
        if "other_ical_urls" in data:
            other_ical_urls = _validate_other_calendar_urls(
                data.get("other_ical_urls"),
                url,
            )
        else:
            try:
                existing = first_row(
                    COLLECTIONS["user_settings"],
                    [Query.equal("user_id", [str(current_user.id)])],
                )
            except AppwriteException:
                logger.exception("Failed to load settings")
                return jsonify({"error": "Unable to save feed URL."}), 500
            other_ical_urls = _load_other_calendar_urls(existing)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load settings")
        return jsonify({"error": "Unable to save feed URL."}), 500

    payload = {
        "canvas_ical_url": url,
        "other_ical_urls_json": json.dumps(other_ical_urls),
        "updated_at": format_datetime(datetime.utcnow()),
    }

    try:
        if not settings:
            settings = create_row_safe(
                COLLECTIONS["user_settings"],
                row_id=user_id,
                data={
                    "user_id": user_id,
                    "ics_secret_token": secrets.token_urlsafe(32),
                    "feed_refresh_minutes": 15,
                    "preferred_calendar_view": "week",
                    "interface_theme": "system-match",
                    "created_at": format_datetime(datetime.utcnow()),
                    **payload,
                },
            )
        else:
            settings = update_row_safe(
                COLLECTIONS["user_settings"],
                settings.get("$id"),
                payload,
            )
    except AppwriteException:
        logger.exception("Failed to save feed URL")
        return jsonify({"error": "Unable to save feed URL."}), 500

    return jsonify({
        "status": "ok",
        "message": "Feed URL saved.",
        "other_ical_urls": other_ical_urls,
    })


@settings_bp.route("/api/refresh-interval", methods=["POST"])
@login_required
def update_refresh_interval():
    """
    POST /settings/api/refresh-interval
    Body: { "minutes": 15 }

    Updates how frequently the user's Canvas feed is re-fetched.
    """
    data = request.get_json()
    minutes = data.get("minutes") if data else None

    if not isinstance(minutes, int) or minutes < 5 or minutes > 1440:
        return jsonify({
            "error": "Refresh interval must be between 5 and 1440 minutes."
        }), 400

    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load settings")
        return jsonify({"error": "Unable to update refresh interval."}), 500
    if not settings:
        return jsonify({"error": "No settings found. Complete onboarding first."}), 404

    try:
        update_row_safe(
            COLLECTIONS["user_settings"],
            settings.get("$id"),
            {
                "feed_refresh_minutes": minutes,
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to update refresh interval")
        return jsonify({"error": "Unable to update refresh interval."}), 500

    return jsonify({"status": "ok", "refresh_interval_minutes": minutes})


@settings_bp.route("/api/interface-preferences", methods=["POST"])
@login_required
def update_interface_preferences():
    """Persist interface-level preferences such as the default dashboard calendar view."""
    data = request.get_json(silent=True) or {}
    preferred_calendar_view = (data.get("preferred_calendar_view") or "").strip().lower() or None
    interface_theme = (data.get("interface_theme") or "").strip() or None

    valid_themes = {"obsidian-dark", "parchment-light", "system-match", "nest-light", "nest-dark"}
    if preferred_calendar_view and preferred_calendar_view not in {"week", "month"}:
        return jsonify({"error": "Preferred calendar view must be weekly or monthly."}), 400
    if interface_theme and interface_theme not in valid_themes:
        return jsonify({"error": "Interface theme is not valid."}), 400

    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load settings")
        return jsonify({"error": "Unable to update preferences."}), 500

    updates = {"updated_at": format_datetime(datetime.utcnow())}
    if preferred_calendar_view:
        updates["preferred_calendar_view"] = preferred_calendar_view
    if interface_theme:
        updates["interface_theme"] = interface_theme

    try:
        if not settings:
            settings = create_row_safe(
                COLLECTIONS["user_settings"],
                row_id=user_id,
                data={
                    "user_id": user_id,
                    "ics_secret_token": secrets.token_urlsafe(32),
                    "feed_refresh_minutes": 15,
                    "preferred_calendar_view": "week",
                    "interface_theme": "system-match",
                    "created_at": format_datetime(datetime.utcnow()),
                    **updates,
                },
            )
        else:
            settings = update_row_safe(
                COLLECTIONS["user_settings"],
                settings.get("$id"),
                updates,
            )
    except AppwriteException:
        logger.exception("Failed to update interface preferences")
        return jsonify({"error": "Unable to update preferences."}), 500

    return jsonify({
        "status": "ok",
        "preferred_calendar_view": settings.get("preferred_calendar_view"),
        "interface_theme": settings.get("interface_theme"),
    })


@settings_bp.route("/api/regenerate-token", methods=["POST"])
@login_required
def regenerate_ics_token():
    """
    POST /settings/api/regenerate-token

    Generates a new .ics subscription token. Invalidates the old one,
    so the user must re-subscribe in Apple Calendar with the new URL.
    """
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [str(current_user.id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load settings")
        return jsonify({"error": "Unable to regenerate token."}), 500
    if not settings:
        return jsonify({"error": "No settings found."}), 404

    new_token = secrets.token_urlsafe(32)
    try:
        settings = update_row_safe(
            COLLECTIONS["user_settings"],
            settings.get("$id"),
            {
                "ics_secret_token": new_token,
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to regenerate token")
        return jsonify({"error": "Unable to regenerate token."}), 500

    return jsonify({
        "status": "ok",
        "message": "Token regenerated. Update your calendar subscription URL.",
        "new_subscription_url": url_for(
            "calendar.ics_feed",
            token=new_token,
            _external=True,
        ),
    })


# ── My Courses ────────────────────────────────────────────────────────────────

@settings_bp.route("/api/courses", methods=["GET"])
@login_required
def list_my_courses():
    """
    GET /settings/api/courses

    Returns the user's saved course selections.
    """
    try:
        courses = list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [str(current_user.id)]),
                Query.order_asc("term"),
                Query.order_asc("subject"),
                Query.order_asc("catalog"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to list courses")
        return jsonify({"error": "Unable to load courses."}), 500

    return jsonify({
        "count": len(courses),
        "courses": [
            {
                "id": c.get("$id"),
                "term": c.get("term"),
                "subject": c.get("subject"),
                "catalog": c.get("catalog"),
                "crn": c.get("crn"),
                "course_code": f"{c.get('subject')} {c.get('catalog')}",
            }
            for c in courses
        ],
    })


@settings_bp.route("/api/courses", methods=["POST"])
@login_required
def add_course():
    """
    POST /settings/api/courses
    Body: { "term": "Fall_2026", "subject": "CHEM", "catalog": "150", "crn": "1700" }

    Adds a course to the user's "My Courses" list. CRN is optional.
    """
    data = request.get_json()
    if not data:
        return jsonify({"error": "Missing request body"}), 400

    term = data.get("term", "").strip()
    subject = data.get("subject", "").strip().upper()
    catalog = data.get("catalog", "").strip()
    crn = data.get("crn", "").strip() or None

    if not term or not subject or not catalog:
        return jsonify({"error": "term, subject, and catalog are required."}), 400

    # Check for duplicates
    user_id = str(current_user.id)
    try:
        candidates = list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [user_id]),
                Query.equal("term", [term]),
                Query.equal("subject", [subject]),
                Query.equal("catalog", [catalog]),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to check existing course")
        return jsonify({"error": "Unable to add course."}), 500

    existing = next(
        (doc for doc in candidates if (doc.get("crn") or None) == crn),
        None,
    )
    if existing:
        return jsonify({"error": "Course already in your list."}), 409

    try:
        course = create_row_safe(
            COLLECTIONS["user_courses"],
            row_id=ID.unique(),
            data={
                "user_id": user_id,
                "term": term,
                "subject": subject,
                "catalog": catalog,
                "crn": crn,
                "source": "settings",
                "added_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to add course")
        return jsonify({"error": "Unable to add course."}), 500

    return jsonify({
        "status": "ok",
        "course": {
            "id": course.get("$id"),
            "term": term,
            "subject": subject,
            "catalog": catalog,
            "crn": crn,
            "course_code": f"{subject} {catalog}",
        },
    }), 201


@settings_bp.route("/api/courses/<course_id>", methods=["DELETE"])
@login_required
def remove_course(course_id):
    """
    DELETE /settings/api/courses/42

    Removes a course from the user's "My Courses" list.
    """
    try:
        course = get_row_safe(COLLECTIONS["user_courses"], course_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "Course not found."}), 404
        logger.exception("Failed to load course")
        return jsonify({"error": "Unable to remove course."}), 500

    if course.get("user_id") != str(current_user.id):
        return jsonify({"error": "Course not found."}), 404

    try:
        delete_row_safe(COLLECTIONS["user_courses"], course_id)
    except AppwriteException:
        logger.exception("Failed to delete course")
        return jsonify({"error": "Unable to remove course."}), 500

    return jsonify({"status": "ok", "message": "Course removed."})