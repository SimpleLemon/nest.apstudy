"""
blueprints/calendar_api.py

Per-user calendar data endpoints.
Fetches, caches, and serves Canvas iCal feed data.
Also provides a token-authenticated .ics subscription endpoint.
"""
import json
import logging
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, Response
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
    list_rows_safe,
    parse_datetime,
    update_row_safe,
)

calendar_bp = Blueprint("calendar", __name__)
logger = logging.getLogger(__name__)


def _serialize_datetime(dt_value, is_all_day=False):
    """
    Serialize a datetime for the API response.

    All-day events are serialized as date-only strings ("2026-04-24")
    WITHOUT a trailing Z, so the browser parses them as local calendar
    dates with no UTC conversion.

    Timed events are serialized as full ISO-8601 with trailing Z
    ("2026-04-24T20:00:00Z"), so the browser correctly converts from
    UTC to the user's local timezone.
    """
    if dt_value is None:
        return None

    if is_all_day:
        return dt_value.strftime("%Y-%m-%d")

    if dt_value.tzinfo is None:
        dt_value = dt_value.replace(tzinfo=timezone.utc)
    else:
        dt_value = dt_value.astimezone(timezone.utc)
    return dt_value.isoformat().replace("+00:00", "Z")


def _span_metadata(start_dt, end_dt, is_all_day=False):
    """
    Compute multi-day flags for calendar rendering metadata.

    For all-day events, iCal DTEND is exclusive: an event on April 24
    has DTSTART=20260424, DTEND=20260425. The span is the day difference.

    For timed events, span counts distinct calendar dates touched
    (start and end dates inclusive).
    """
    if not start_dt or not end_dt:
        return False, 1

    if end_dt <= start_dt:
        return False, 1

    start_date = start_dt.date() if hasattr(start_dt, "date") else start_dt
    end_date = end_dt.date() if hasattr(end_dt, "date") else end_dt

    if is_all_day:
        span_days = max(1, (end_date - start_date).days)
    else:
        span_days = max(1, (end_date - start_date).days + 1)

    return span_days > 1, span_days


def _serialize_event(doc):
    """Serialize a calendar_cache row for API response."""
    is_all_day = bool(doc.get("is_all_day", False))
    event_start = parse_datetime(doc.get("event_start"))
    event_end = parse_datetime(doc.get("event_end"))
    fetched_at = parse_datetime(doc.get("fetched_at"))
    is_multi_day, span_days = _span_metadata(event_start, event_end, is_all_day)

    return {
        "uid": doc.get("event_uid"),
        "title": doc.get("event_title"),
        "start": _serialize_datetime(event_start, is_all_day),
        "end": _serialize_datetime(event_end, is_all_day),
        "type": doc.get("event_type"),
        "course": doc.get("course_name"),
        "description": doc.get("raw_description"),
        "fetched_at": fetched_at.isoformat() if fetched_at else None,
        "is_multi_day": is_multi_day,
        "span_days": span_days,
        "is_all_day": is_all_day,
    }


def _serialize_user_event(doc):
    """Serialize a user_events row for API response."""
    start = parse_datetime(doc.get("start"))
    end = parse_datetime(doc.get("end"))
    created_at = parse_datetime(doc.get("created_at"))
    updated_at = parse_datetime(doc.get("updated_at"))
    is_all_day = bool(doc.get("is_all_day", False))
    return {
        "id": doc.get("$id"),
        "title": doc.get("title"),
        "description": doc.get("description"),
        "start": _serialize_datetime(start, is_all_day),
        "end": _serialize_datetime(end, is_all_day),
        "is_all_day": is_all_day,
        "color": doc.get("color"),
        "created_at": created_at.isoformat() if created_at else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def _configured_feed_urls(settings):
    """Return all configured calendar feed URLs for a user."""
    if not settings:
        return []
    urls = []
    canvas_url = settings.get("canvas_ical_url")
    if canvas_url:
        urls.append(canvas_url.strip())
    other_urls = settings.get("other_ical_urls_json")
    if other_urls:
        try:
            extras = json.loads(other_urls)
            if isinstance(extras, list):
                for item in extras:
                    if isinstance(item, str) and item.strip():
                        urls.append(item.strip())
        except json.JSONDecodeError:
            pass
    return urls


@calendar_bp.route("/events")
@login_required
def get_events():
    """
    GET /api/calendar/events
    Returns cached calendar events for the authenticated user.
    """
    user_id = str(current_user.id)
    try:
        cache_events = list_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("event_start"),
            ],
        )
        created_events = list_rows_all(
            COLLECTIONS["user_events"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_asc("start"),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar events")
        return jsonify({"error": "Unable to load calendar events."}), 500

    serialized = [_serialize_event(e) for e in cache_events] + [
        _serialize_user_event(e) for e in created_events
    ]

    return jsonify({
        "user_id": current_user.id,
        "count": len(serialized),
        "events": serialized,
    })


def _parse_iso_like(s):
    """Parse ISO-ish datetime or date strings into a naive UTC datetime for storage.

    Accepts date-only strings (YYYY-MM-DD) and full ISO strings that may end with Z.
    Returns a naive datetime in UTC for timed events, and local-midnight datetime for all-day.
    """
    if not s:
        return None

    s = str(s)
    # date-only -> treat as local midnight (all-day semantics)
    import re
    from datetime import datetime, timezone

    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        parts = s.split("-")
        return datetime(int(parts[0]), int(parts[1]), int(parts[2]), 0, 0, 0)

    # replace trailing Z with +00:00 for fromisoformat
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"

    try:
        return datetime.fromisoformat(s)
    except Exception:
        return None


@calendar_bp.route("/events", methods=["POST"])
@login_required
def create_event():
    """POST /api/calendar/events - create a user event"""
    data = request.get_json() or {}
    title = (data.get("title") or "").strip()
    description = data.get("description")
    start_raw = data.get("start_date") or data.get("start")
    end_raw = data.get("end_date") or data.get("end")
    all_day = bool(data.get("all_day", False))
    color = data.get("color")

    if not title:
        return jsonify({"error": "title is required"}), 400

    start_dt = _parse_iso_like(start_raw)
    end_dt = _parse_iso_like(end_raw)

    if not start_dt or not end_dt:
        return jsonify({"error": "start_date and end_date must be valid ISO datetimes"}), 400

    if end_dt <= start_dt:
        return jsonify({"error": "end_date must be after start_date"}), 400

    try:
        ev = create_row_safe(
            COLLECTIONS["user_events"],
            row_id=ID.unique(),
            data={
                "user_id": str(current_user.id),
                "title": title,
                "description": description,
                "start": format_datetime(start_dt),
                "end": format_datetime(end_dt),
                "is_all_day": all_day,
                "color": color,
                "created_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to create user event")
        return jsonify({"error": "Unable to create event."}), 500

    return jsonify({"success": True, "event": _serialize_user_event(ev)})


@calendar_bp.route("/events/<event_id>", methods=["GET"])
@login_required
def get_single_event(event_id):
    try:
        ev = get_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "not found"}), 404
        logger.exception("Failed to load user event")
        return jsonify({"error": "Unable to load event."}), 500

    if ev.get("user_id") != str(current_user.id):
        return jsonify({"error": "not found"}), 404
    return jsonify({"event": _serialize_user_event(ev)})


@calendar_bp.route("/events/<event_id>", methods=["PUT"])
@login_required
def update_event(event_id):
    try:
        ev = get_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "not found"}), 404
        logger.exception("Failed to load user event")
        return jsonify({"error": "Unable to load event."}), 500

    if ev.get("user_id") != str(current_user.id):
        return jsonify({"error": "not found"}), 404

    data = request.get_json() or {}
    title = data.get("title")
    description = data.get("description")
    start_raw = data.get("start_date") or data.get("start")
    end_raw = data.get("end_date") or data.get("end")
    all_day = data.get("all_day")
    color = data.get("color")

    updates = {"updated_at": format_datetime(datetime.utcnow())}
    if title is not None:
        updates["title"] = title
    if description is not None:
        updates["description"] = description
    if start_raw is not None:
        parsed = _parse_iso_like(start_raw)
        if parsed:
            updates["start"] = format_datetime(parsed)
    if end_raw is not None:
        parsed = _parse_iso_like(end_raw)
        if parsed:
            updates["end"] = format_datetime(parsed)
    if all_day is not None:
        updates["is_all_day"] = bool(all_day)
    if color is not None:
        updates["color"] = color

    try:
        ev = update_row_safe(
            COLLECTIONS["user_events"],
            event_id,
            updates,
        )
    except AppwriteException:
        logger.exception("Failed to update user event")
        return jsonify({"error": "Unable to update event."}), 500

    return jsonify({"success": True, "event": _serialize_user_event(ev)})


@calendar_bp.route("/events/<event_id>", methods=["DELETE"])
@login_required
def delete_event(event_id):
    try:
        ev = get_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return jsonify({"error": "not found"}), 404
        logger.exception("Failed to load user event")
        return jsonify({"error": "Unable to delete event."}), 500

    if ev.get("user_id") != str(current_user.id):
        return jsonify({"error": "not found"}), 404

    try:
        delete_row_safe(COLLECTIONS["user_events"], event_id)
    except AppwriteException:
        logger.exception("Failed to delete user event")
        return jsonify({"error": "Unable to delete event."}), 500

    return jsonify({"success": True})


@calendar_bp.route("/refresh", methods=["POST"])
@login_required
def refresh_feed():
    """
    POST /api/calendar/refresh
    Triggers an immediate re-fetch of all configured user calendar feeds.
    """
    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load user settings")
        return jsonify({"error": "Unable to refresh calendar feeds."}), 500

    feed_urls = _configured_feed_urls(settings)

    if not feed_urls:
        return jsonify({
            "error": "No calendar feed URLs configured. Visit Settings to add one."
        }), 400

    from services.feed_fetcher import fetch_and_cache_feeds

    try:
        count = fetch_and_cache_feeds(user_id, feed_urls)
        update_row_safe(
            COLLECTIONS["user_settings"],
            settings.get("$id"),
            {"updated_at": format_datetime(datetime.utcnow())},
        )
        return jsonify({"status": "ok", "events_cached": count})
    except AppwriteException:
        logger.exception("Failed to update settings after refresh")
        return jsonify({"error": "Unable to refresh calendar feeds."}), 500
    except Exception as e:
        logger.exception(
            "Calendar refresh failed",
            extra={"user_id": user_id, "feed_count": len(feed_urls)},
        )
        return jsonify({"error": f"Feed fetch failed: {str(e)}"}), 500


@calendar_bp.route("/status")
@login_required
def feed_status():
    """
    GET /api/calendar/status
    """
    user_id = str(current_user.id)
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [user_id])],
        )
        feed_urls = _configured_feed_urls(settings)

        latest_event = first_row(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_desc("fetched_at"),
            ],
        )

        count_response = list_rows_safe(
            COLLECTIONS["calendar_cache"],
            [Query.equal("user_id", [user_id]), Query.limit(1)],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar status")
        return jsonify({"error": "Unable to load calendar status."}), 500

    last_fetched = None
    if latest_event and latest_event.get("fetched_at"):
        parsed = parse_datetime(latest_event.get("fetched_at"))
        if parsed:
            last_fetched = parsed.isoformat()

    return jsonify({
        "feed_configured": bool(feed_urls),
        "configured_feed_count": len(feed_urls),
        "refresh_interval_minutes": settings.get("feed_refresh_minutes") if settings else None,
        "last_fetched": last_fetched,
        "cached_event_count": count_response.get("total", 0),
    })


@calendar_bp.route("/preferences", methods=["GET"])
@login_required
def get_calendar_preferences():
    """
    GET /api/calendar/preferences
    """
    user_id = str(current_user.id)
    try:
        prefs = list_rows_all(
            COLLECTIONS["user_calendar_preferences"],
            [Query.equal("user_id", [user_id])],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar preferences")
        return jsonify({"error": "Unable to load calendar preferences."}), 500

    return jsonify({
        "preferences": [
            {
                "calendar_name": p.get("calendar_name"),
                "color_hex": p.get("color_hex"),
                "visible": p.get("visible"),
            }
            for p in prefs
        ]
    })


@calendar_bp.route("/preferences", methods=["POST"])
@login_required
def update_calendar_preferences():
    """
    POST /api/calendar/preferences
    """
    data = request.get_json() or {}
    calendar_name = data.get("calendar_name")
    color_hex = data.get("color_hex")
    visible = data.get("visible")

    if not calendar_name:
        return jsonify({"error": "calendar_name is required"}), 400

    user_id = str(current_user.id)
    try:
        pref = first_row(
            COLLECTIONS["user_calendar_preferences"],
            [
                Query.equal("user_id", [user_id]),
                Query.equal("calendar_name", [calendar_name]),
            ],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar preference")
        return jsonify({"error": "Unable to update preferences."}), 500

    updates = {"updated_at": format_datetime(datetime.utcnow())}
    if color_hex:
        updates["color_hex"] = color_hex
    if visible is not None:
        updates["visible"] = bool(visible)

    try:
        if not pref:
            pref = create_row_safe(
                COLLECTIONS["user_calendar_preferences"],
                row_id=ID.unique(),
                data={
                    "user_id": user_id,
                    "calendar_name": calendar_name,
                    "color_hex": color_hex or "#6366f1",
                    "visible": bool(True if visible is None else visible),
                    "created_at": format_datetime(datetime.utcnow()),
                    **updates,
                },
            )
        else:
            pref = update_row_safe(
                COLLECTIONS["user_calendar_preferences"],
                pref.get("$id"),
                updates,
            )
    except AppwriteException:
        logger.exception("Failed to update calendar preference")
        return jsonify({"error": "Unable to update preferences."}), 500

    return jsonify({
        "status": "ok",
        "calendar_name": calendar_name,
        "color_hex": pref.get("color_hex"),
        "visible": pref.get("visible"),
    })


@calendar_bp.route("/feed.ics")
def ics_feed():
    """
    GET /api/calendar/feed.ics?token=USER_SPECIFIC_TOKEN
    """
    token = request.args.get("token")
    if not token:
        return Response("Missing token", status=401, mimetype="text/plain")

    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("ics_secret_token", [token])],
        )
    except AppwriteException:
        logger.exception("Failed to resolve calendar token")
        return Response("Feed lookup failed", status=500, mimetype="text/plain")
    if not settings:
        return Response("Invalid token", status=403, mimetype="text/plain")

    from services.ics_builder import build_ics_for_user

    try:
        ics_content = build_ics_for_user(settings.get("user_id"))
        return Response(
            ics_content,
            status=200,
            mimetype="text/calendar",
            headers={
                "Content-Disposition": "attachment; filename=nest_apstudy.ics",
            },
        )
    except Exception as e:
        return Response(
            f"Feed generation failed: {str(e)}",
            status=500,
            mimetype="text/plain",
        )
