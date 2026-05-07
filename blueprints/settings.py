"""
blueprints/settings.py

Per-user settings and onboarding routes.
Handles Canvas iCal URL configuration, refresh intervals,
.ics token management, and "My Courses" selections.
"""

import json
import os
import secrets
import logging
import shutil
from datetime import datetime
from urllib.parse import urlparse, urlunparse

from flask import Blueprint, render_template, request, jsonify, redirect, url_for
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query
from appwrite.services.users import Users
from appwrite_client import client as appwrite_client
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

THEME_TO_INTERFACE_THEME = {
    "dark": "obsidian-dark",
    "light": "parchment-light",
    "system": "system-match",
}
INTERFACE_THEME_TO_THEME = {
    "obsidian-dark": "dark",
    "nest-dark": "dark",
    "parchment-light": "light",
    "nest-light": "light",
    "system-match": "system",
}


def _normalize_theme_value(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if normalized in THEME_TO_INTERFACE_THEME else None


def _interface_theme_from_value(value):
    if not isinstance(value, str):
        return THEME_TO_INTERFACE_THEME["dark"]
    normalized = value.strip().lower()
    if normalized in THEME_TO_INTERFACE_THEME:
        return THEME_TO_INTERFACE_THEME[normalized]
    return normalized if normalized in INTERFACE_THEME_TO_THEME else THEME_TO_INTERFACE_THEME["dark"]


def _theme_from_interface_theme(value):
    if not isinstance(value, str):
        return "dark"
    normalized = value.strip().lower()
    return INTERFACE_THEME_TO_THEME.get(normalized, "dark")


def _normalize_sidebar_default(value):
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    if normalized in {"expanded", "collapsed"}:
        return normalized
    return None


def _normalize_timezone(value):
    if not isinstance(value, str):
        return ""
    return value.strip()


def _normalize_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return default


def _profile_doc_payload():
    return {
        "id": str(current_user.id),
        "name": current_user.name,
        "email": current_user.email,
        "picture_url": current_user.picture_url,
        "school": current_user.school,
        "major": current_user.major,
        "graduation_year": current_user.graduation_year,
        "education_level": current_user.education_level,
        "class_year": current_user.class_year,
        "created_at": format_datetime(current_user.created_at),
    }


def _settings_defaults(user_id):
    return {
        "user_id": user_id,
        "ics_secret_token": secrets.token_urlsafe(32),
        "feed_refresh_minutes": 15,
        "preferred_calendar_view": "week",
        "interface_theme": "obsidian-dark",
        "theme": "dark",
        "sidebar_default": "expanded",
        "email_notifications": True,
        "product_updates": True,
        "language": "en",
        "timezone": "",
        "created_at": format_datetime(datetime.utcnow()),
    }


def _settings_payload(settings):
    if not settings:
        return {
            "theme": "dark",
            "sidebar_default": "expanded",
            "email_notifications": True,
            "product_updates": True,
            "language": "en",
            "timezone": "",
            "interface_theme": "obsidian-dark",
            "preferred_calendar_view": "week",
            "feed_refresh_minutes": 15,
        }
    return {
        "theme": _theme_from_interface_theme(settings.get("interface_theme") or settings.get("theme")),
        "sidebar_default": (settings.get("sidebar_default") or "expanded").strip().lower(),
        "email_notifications": bool(settings.get("email_notifications", True)),
        "product_updates": bool(settings.get("product_updates", True)),
        "language": settings.get("language") or "en",
        "timezone": settings.get("timezone") or "",
        "interface_theme": settings.get("interface_theme") or _interface_theme_from_value(settings.get("theme") or "dark"),
        "preferred_calendar_view": settings.get("preferred_calendar_view") or "week",
        "feed_refresh_minutes": settings.get("feed_refresh_minutes") or 15,
    }


def _load_user_settings(user_id):
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
        return None
    return settings


def _load_user_courses(user_id):
    try:
        return list_rows_all(
            COLLECTIONS["user_courses"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("term"),
                Query.order_asc("subject"),
                Query.order_asc("catalog"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load user courses")
        return []


def _storage_usage_bytes(user_id):
    try:
        files = list_rows_all(
            COLLECTIONS["shared_files"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to calculate storage usage")
        return 0

    total = 0
    for file_row in files:
        try:
            total += int(file_row.get("file_size_bytes") or 0)
        except (TypeError, ValueError):
            continue
    return total


def _delete_user_artifacts(user_id):
    rows_to_delete = [
        COLLECTIONS["user_settings"],
        COLLECTIONS["user_courses"],
        COLLECTIONS["calendar_cache"],
        COLLECTIONS["user_calendar_preferences"],
        COLLECTIONS["user_events"],
        COLLECTIONS["shared_files"],
    ]

    for table_id in rows_to_delete:
        try:
            rows = list_rows_all(
                table_id,
                [Query.equal("user_id", [user_id])],
            )
        except AppwriteException:
            logger.exception("Failed to list rows for deletion: %s", table_id)
            continue

        for row in rows:
            row_id = row.get("$id") or row.get("id")
            if not row_id:
                continue
            try:
                delete_row_safe(table_id, row_id)
            except AppwriteException:
                logger.exception("Failed to delete %s row %s", table_id, row_id)

            if table_id == COLLECTIONS["shared_files"]:
                stored_path = row.get("stored_path")
                if not stored_path:
                    continue
                absolute_path = os.path.abspath(os.path.join("uploads", "file_share", stored_path))
                try:
                    if os.path.exists(absolute_path):
                        os.remove(absolute_path)
                except OSError:
                    logger.exception("Failed to remove stored file %s", absolute_path)

    user_upload_root = os.path.abspath(os.path.join("uploads", "file_share", user_id))
    if os.path.isdir(user_upload_root):
        try:
            shutil.rmtree(user_upload_root)
        except OSError:
            logger.exception("Failed to remove upload directory %s", user_upload_root)


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

    user_settings = _load_user_settings(str(current_user.id))

    return render_template("settings.html", user={
        "name": current_user.name or current_user.email,
        "email": current_user.email,
        "picture": current_user.picture_url,
        "emory_student": current_user.emory_student,
        "school": current_user.school,
        "major": current_user.major,
        "graduation_year": current_user.graduation_year,
        "member_since": current_user.created_at.strftime("%b %d, %Y"),
    }, settings=user_settings, theme_preference=(user_settings.get("interface_theme") if user_settings and user_settings.get("interface_theme") else "obsidian-dark"))


@settings_bp.route("/api/bootstrap", methods=["GET"])
@login_required
def bootstrap_settings():
    user_id = str(current_user.id)
    user_settings = _load_user_settings(user_id)
    user_settings_payload = _settings_payload(user_settings)
    return jsonify({
        "profile": _profile_doc_payload(),
        "settings": user_settings_payload,
        "user_settings_doc": user_settings,
        "storage_usage_bytes": _storage_usage_bytes(user_id),
        "connected_services": [],
        "other_calendar_urls": _load_other_calendar_urls(user_settings),
        "member_since": current_user.created_at.strftime("%b %d, %Y") if current_user.created_at else None,
    })


# ── API routes (called by settings page JavaScript) ──────────────────────────

@settings_bp.route("/api/profile", methods=["POST"])
@login_required
def update_profile():
    """Update editable profile fields for the authenticated user."""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    picture_url = (data.get("picture_url") or "").strip() or None
    school = (data.get("school") or "").strip() or None
    major = (data.get("major") or "").strip() or None
    graduation_year = (data.get("graduation_year") or "").strip() or None

    if not name:
        return jsonify({"error": "Name is required."}), 400

    if graduation_year and (len(graduation_year) != 4 or not graduation_year.isdigit()):
        return jsonify({"error": "Graduation year must be a 4-digit year."}), 400

    updates = {
        "name": name,
        "picture_url": picture_url,
        "school": school,
        "major": major,
        "graduation_year": graduation_year,
    }
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
    current_user.picture_url = picture_url
    current_user.school = school
    current_user.major = major
    current_user.graduation_year = graduation_year
    if updates.get("created_at"):
        current_user.created_at = datetime.utcnow()

    return jsonify({
        "status": "ok",
        "name": current_user.name,
        "picture_url": current_user.picture_url,
        "school": current_user.school,
        "major": current_user.major,
        "graduation_year": current_user.graduation_year,
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
            settings = create_row_safe(COLLECTIONS["user_settings"], row_id=user_id, data={**_settings_defaults(user_id), **payload})
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
    theme = _normalize_theme_value(data.get("theme"))
    interface_theme = (data.get("interface_theme") or "").strip() or None
    sidebar_default = _normalize_sidebar_default(data.get("sidebar_default"))
    language = (data.get("language") or "").strip() or None
    timezone = _normalize_timezone(data.get("timezone")) if "timezone" in data else None
    email_notifications = _normalize_bool(data.get("email_notifications"), True) if "email_notifications" in data else None
    product_updates = _normalize_bool(data.get("product_updates"), True) if "product_updates" in data else None

    valid_interface_themes = {"obsidian-dark", "parchment-light", "system-match", "nest-light", "nest-dark"}
    if preferred_calendar_view and preferred_calendar_view not in {"week", "month"}:
        return jsonify({"error": "Preferred calendar view must be weekly or monthly."}), 400
    if interface_theme and interface_theme not in valid_interface_themes:
        return jsonify({"error": "Interface theme is not valid."}), 400
    if theme is None and interface_theme:
        theme = _theme_from_interface_theme(interface_theme)
    if theme is None:
        theme = None
    if timezone is not None and len(timezone) > 64:
        return jsonify({"error": "Timezone is too long."}), 400

    user_id = str(current_user.id)
    try:
        settings = _load_user_settings(user_id)
    except AppwriteException:
        logger.exception("Failed to load settings")
        return jsonify({"error": "Unable to update preferences."}), 500

    updates = {"updated_at": format_datetime(datetime.utcnow())}
    if preferred_calendar_view:
        updates["preferred_calendar_view"] = preferred_calendar_view
    if theme is not None:
        updates["theme"] = theme
        updates["interface_theme"] = _interface_theme_from_value(theme)
    elif interface_theme:
        updates["interface_theme"] = interface_theme
        updates["theme"] = _theme_from_interface_theme(interface_theme)
    if sidebar_default:
        updates["sidebar_default"] = sidebar_default
    if email_notifications is not None:
        updates["email_notifications"] = email_notifications
    if product_updates is not None:
        updates["product_updates"] = product_updates
    if language:
        updates["language"] = language
    if timezone is not None:
        updates["timezone"] = timezone

    try:
        if not settings:
            settings = create_row_safe(COLLECTIONS["user_settings"], row_id=user_id, data={**_settings_defaults(user_id), **updates})
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
        "theme": settings.get("theme") or _theme_from_interface_theme(settings.get("interface_theme")),
        "sidebar_default": settings.get("sidebar_default") or "expanded",
        "email_notifications": settings.get("email_notifications", True),
        "product_updates": settings.get("product_updates", True),
        "language": settings.get("language") or "en",
        "timezone": settings.get("timezone") or "",
    })


@settings_bp.route("/api/export", methods=["GET"])
@login_required
def export_user_data():
    user_id = str(current_user.id)
    user_settings = _load_user_settings(user_id)
    export_payload = {
        "exported_at": format_datetime(datetime.utcnow()),
        "profile": _profile_doc_payload(),
        "settings": _settings_payload(user_settings),
        "courses": _load_user_courses(user_id),
        "other_calendar_urls": _load_other_calendar_urls(user_settings),
        "storage_usage_bytes": _storage_usage_bytes(user_id),
    }
    return jsonify(export_payload)


@settings_bp.route("/api/account/delete", methods=["POST"])
@login_required
def delete_account():
    user_id = str(current_user.id)
    users_service = Users(appwrite_client)

    try:
        users_service.delete(user_id)
    except Exception:
        logger.exception("Failed to delete Appwrite auth account")
        return jsonify({"error": "Unable to delete account."}), 500

    _delete_user_artifacts(user_id)
    return jsonify({"status": "ok"})


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