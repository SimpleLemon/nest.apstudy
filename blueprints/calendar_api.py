"""
blueprints/calendar_api.py

Per-user calendar data endpoints.
Fetches, caches, and serves Canvas iCal feed data.
Also provides a token-authenticated .ics subscription endpoint.
"""
import logging
import secrets
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request, Response
from flask_login import login_required, current_user

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    first_row,
    format_datetime,
    update_row_safe,
)
from services.calendar_urls import (
    normalize_calendar_url as _normalize_calendar_url,
)
from services.settings_defaults import settings_defaults as _settings_defaults
from services.calendar_feed_sources import _validate_other_calendar_urls, _normalize_canvas_calendar_url
from services import calendar_personal_events as personal_events
from services import calendar_preferences as preferences
from services import calendar_read_operations as read_operations
from services.calendar_events import (
    CANVAS_SOURCE_ID,
    FEED_SOURCE_PREFIX,
    LOCAL_SOURCE_PREFIX,
    DEFAULT_LOCAL_SOURCE_ID,
    DEFAULT_LOCAL_SOURCE_NAME,
    DEFAULT_CALENDAR_COLOR,
    SIMULATED_CALENDAR_NAME,
    CALENDAR_SHARE_CODE_LENGTH,
    CALENDAR_SHARE_CODE_CHARS,
    CALENDAR_SHARE_DATE_SCOPES,
    CALENDAR_SHARE_MIN_ROLLING_DAYS,
    CALENDAR_SHARE_MAX_ROLLING_DAYS,
    PREFERENCES_BATCH_LIMIT,
    TIMED_EVENT_REMINDERS,
    ALL_DAY_EVENT_REMINDERS,
    _canonical_feed_url,
    _raw_feed_url_hash,
    _feed_url_hash,
    _feed_source_id,
    _legacy_feed_source_id,
    _normalize_display_name,
    _normalize_source_label,
    _url_fallback_label,
    _source_id_for_feed_url,
    _event_ref_for_cache_event,
    _event_ref_for_user_event,
    _normalize_color,
    _default_reminder_minutes,
    _normalize_reminder_minutes,
    _serialized_reminder_minutes,
    _calendar_preference_updates,
    _calendar_preference_unchanged,
    _normalize_calendar_id,
    _serialize_datetime,
    _span_metadata,
    _serialize_event,
    _serialize_user_event,
    _coerce_utc,
    _parse_range_param,
    _event_overlaps_range,
    _resolve_last_fetched,
    _configured_feed_urls,
    _load_calendar_feed_metadata as _load_calendar_feed_metadata_service,
    _configured_feed_sources,
    _load_local_calendar_sources as _load_local_calendar_sources_service,
    _configured_local_sources,
    _configured_calendar_sources,
    _task_calendar_payload,
    _append_task_calendar_source,
    _ensure_user_settings,
    _ensure_local_calendar_source,
    _load_event_overrides as _load_event_overrides_service,
    _apply_event_override,
    _api_event_overlaps_range,
    _project_canvas_calendar_events,
    _filter_configured_cache_events,
    _feed_needs_initial_fetch,
    _initial_fetch_feed_urls,
    _refresh_initial_feed_cache,
    _delete_cache_rows_for_feed,
    _update_local_calendar_source_payload,
    _update_url_calendar_source_payload,
    _load_calendar_preferences as _load_calendar_preferences_service,
    _upsert_calendar_preference,
    _upsert_event_override,
    _settings_payload_for_source_update,
    _calendar_shares_collection,
    _share_url,
    _generate_calendar_share_code as _generate_calendar_share_code_service,
    _parse_json_list,
    _normalize_share_calendar_ids,
    _parse_date_start,
    _fixed_end_display_date,
    _normalize_calendar_share_payload,
    _calendar_share_scope_label,
    _calendar_share_payload,
    _calendar_share_scope_range,
    _intersect_ranges,
    _range_queries,
    _sanitize_public_event,
    _sanitize_public_sources,
    _resolve_calendar_share_by_code as _resolve_calendar_share_by_code_service,
    _public_calendar_share_context,
    _public_calendar_events_payload as _public_calendar_events_payload_service,
)
from services.calendar_urls import (
    iter_valid_other_calendar_urls,
    load_other_calendar_urls,
)
from services.calendar_projection import (load_serialized_calendar_events, load_events_payload_with_initial_refresh)
from services.discord_audit import emit_creation_event, format_actor
from services.row_utils import row_id as _row_id
from services.calendar_store import (
    create_calendar_row,
    delete_calendar_row,
    first_calendar_row,
    get_calendar_row,
    list_calendar_rows_all,
    list_calendar_rows_safe,
    update_calendar_row,
)
from services.calendar_ics_contract import CalendarIcsFailure
from services.calendar_ics_feed import (
    CalendarIcsFeedError,
    build_calendar_ics_feed,
    if_none_match_matches,
)
from services.calendar_share_service import (
    CalendarIcsResourceError,
    assert_selection_change_allowed,
    creation_ics_fields,
    disable_calendar_ics,
    enable_calendar_ics,
    owner_ics_metadata,
    remove_calendar_ics,
    require_calendar_ics_enabled,
    resolve_calendar_ics_token,
    rotate_calendar_ics,
    update_owned_calendar_share_with_invariants,
)

calendar_bp = Blueprint("calendar", __name__)
logger = logging.getLogger(__name__)


def _load_calendar_feed_metadata(user_id):
    return _load_calendar_feed_metadata_service(user_id, list_calendar_rows_all)


def _load_local_calendar_sources(user_id):
    return _load_local_calendar_sources_service(user_id, list_calendar_rows_all)


def _load_event_overrides(user_id):
    return _load_event_overrides_service(user_id, list_calendar_rows_all)


def _load_calendar_preferences(user_id):
    return _load_calendar_preferences_service(user_id, list_calendar_rows_all)


def _load_serialized_calendar_events(
    user_id,
    settings,
    range_start=None,
    range_end=None,
    *,
    require_shares_ics=False,
):
    """Load feed, native, and consented Canvas events through one projection."""
    return load_serialized_calendar_events(
        user_id,
        settings,
        range_start,
        range_end,
        require_shares_ics=require_shares_ics,
    )


def _load_serialized_calendar_events_for_share(
    user_id,
    settings,
    range_start=None,
    range_end=None,
):
    return _load_serialized_calendar_events(
        user_id,
        settings,
        range_start,
        range_end,
        require_shares_ics=True,
    )


def _generate_calendar_share_code():
    return _generate_calendar_share_code_service(first_calendar_row)


def _resolve_calendar_share_by_code(share_code, active_only=True):
    return _resolve_calendar_share_by_code_service(
        share_code,
        active_only,
        first_calendar_row,
    )


def _calendar_share_dependencies():
    return {
        "append_task_calendar_source": _append_task_calendar_source,
        "calendar_share_payload": _calendar_share_payload,
        "calendar_share_scope_range": _calendar_share_scope_range,
        "configured_calendar_sources": _configured_calendar_sources,
        "configured_feed_urls": _configured_feed_urls,
        "first_row": first_row,
        "intersect_ranges": _intersect_ranges,
        "load_calendar_feed_metadata": _load_calendar_feed_metadata,
        "load_calendar_preferences": _load_calendar_preferences,
        "load_local_calendar_sources": _load_local_calendar_sources,
        "load_serialized_calendar_events_for_share": _load_serialized_calendar_events_for_share,
        "parse_json_list": _parse_json_list,
        "sanitize_public_event": _sanitize_public_event,
        "sanitize_public_sources": _sanitize_public_sources,
        "task_calendar_payload": _task_calendar_payload_for_share,
    }


def _public_calendar_events_payload(
    share,
    requested_start=None,
    requested_end=None,
):
    return _public_calendar_events_payload_service(
        share,
        requested_start,
        requested_end,
        _calendar_share_dependencies(),
    )


def _task_calendar_payload_for_share(user_id, preferences, range_start=None, range_end=None):
    try:
        return _task_calendar_payload(user_id, preferences, range_start, range_end)
    except (AppwriteException, AttributeError):
        logger.exception("Failed to load task events for public calendar share")
        return [], None


@calendar_bp.route("/events")
@login_required
def get_events():
    """Return owner events, refreshing feeds whose caches need initialization."""
    payload, status = load_events_payload_with_initial_refresh(
        str(current_user.id), current_user.id, request.args,
    )
    return jsonify(payload), status


@calendar_bp.route("/shares", methods=["GET"])
@login_required
def list_calendar_shares():
    (payload, status) = read_operations.list_calendar_shares(
        str(current_user.id),
        dependencies={
            'list_calendar_rows_all': list_calendar_rows_all,
            '_calendar_shares_collection': _calendar_shares_collection,
            '_calendar_share_payload': _calendar_share_payload,
        },
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


def _calendar_share_request_payload():
    """Read a share request while preserving the legacy missing-body default."""

    raw_body = request.get_data(cache=True)
    if not raw_body:
        return {}, None, None
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return None, jsonify({
            "error": "Calendar share payload must be a JSON object.",
            "code": "calendar_share_invalid_payload",
        }), 400
    return payload, None, None


@calendar_bp.route("/shares", methods=["POST"])
@login_required
def create_calendar_share():
    user_id = str(current_user.id)
    payload, error_response, error_status = _calendar_share_request_payload()
    if error_response is not None:
        return error_response, error_status
    try:
        config = _normalize_calendar_share_payload(payload)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        ics_fields = creation_ics_fields(user_id, payload, config)
    except CalendarIcsFailure as exc:
        return jsonify(exc.payload()), exc.status

    now = format_datetime(datetime.utcnow())
    try:
        share = create_calendar_row(
            _calendar_shares_collection(),
            row_id=ID.unique(),
            data={
                "user_id": user_id,
                "share_code": _generate_calendar_share_code(),
                "is_active": True,
                "created_at": now,
                "updated_at": now,
                **config,
                **ics_fields,
            },
        )
    except AppwriteException:
        logger.exception("Failed to create calendar share")
        return jsonify({"error": "Unable to create calendar share."}), 500

    emit_creation_event(
        "Calendar Share Created",
        actor=format_actor(current_user),
        target=share.get("$id") or share.get("id"),
        metadata={
            "page_context": "calendar/shares",
            "resource_type": "calendar_share",
            "resource_id": share.get("$id") or share.get("id"),
            "date_scope": config.get("date_scope"),
            "include_all_calendars": config.get("include_all_calendars"),
        },
        color="green",
    )
    return jsonify({"share": _calendar_share_payload(share)}), 201


def _owned_calendar_share_or_none(share_id, user_id):
    share = get_calendar_row(_calendar_shares_collection(), share_id, allow_missing=True)
    if not share or share.get("user_id") != str(user_id):
        return None
    return share


@calendar_bp.route("/shares/<share_id>", methods=["PATCH"])
@login_required
def update_calendar_share(share_id):
    user_id = str(current_user.id)
    try:
        share = _owned_calendar_share_or_none(share_id, user_id)
    except AppwriteException:
        logger.exception("Failed to load calendar share")
        return jsonify({"error": "Unable to load calendar share."}), 500
    if not share:
        return jsonify({"error": "Calendar share not found."}), 404

    payload = request.get_json(silent=True) or {}
    try:
        updates = _normalize_calendar_share_payload(payload, existing=share)
        assert_selection_change_allowed(share, updates)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except CalendarIcsFailure as exc:
        return jsonify(exc.payload()), exc.status
    if "isActive" in payload or "is_active" in payload:
        updates["is_active"] = bool(payload.get("isActive", payload.get("is_active")))
    updates["updated_at"] = format_datetime(datetime.utcnow())

    try:
        updated = update_owned_calendar_share_with_invariants(user_id, share_id, updates)
    except CalendarIcsFailure as exc:
        return jsonify(exc.payload()), exc.status
    except AppwriteException:
        logger.exception("Failed to update calendar share")
        return jsonify({"error": "Unable to update calendar share."}), 500

    return jsonify({"share": _calendar_share_payload(updated)})


@calendar_bp.route("/shares/<share_id>/regenerate", methods=["POST"])
@login_required
def regenerate_calendar_share(share_id):
    user_id = str(current_user.id)
    try:
        share = _owned_calendar_share_or_none(share_id, user_id)
    except AppwriteException:
        logger.exception("Failed to load calendar share")
        return jsonify({"error": "Unable to load calendar share."}), 500
    if not share:
        return jsonify({"error": "Calendar share not found."}), 404

    try:
        updated = update_calendar_row(
            _calendar_shares_collection(),
            _row_id(share),
            {
                "share_code": _generate_calendar_share_code(),
                "is_active": True,
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to regenerate calendar share")
        return jsonify({"error": "Unable to regenerate calendar share."}), 500

    return jsonify({"share": _calendar_share_payload(updated)})


@calendar_bp.route("/shares/<share_id>", methods=["DELETE"])
@login_required
def revoke_calendar_share(share_id):
    user_id = str(current_user.id)
    try:
        share = _owned_calendar_share_or_none(share_id, user_id)
    except AppwriteException:
        logger.exception("Failed to load calendar share")
        return jsonify({"error": "Unable to load calendar share."}), 500
    if not share:
        return jsonify({"error": "Calendar share not found."}), 404

    try:
        updated = update_calendar_row(
            _calendar_shares_collection(),
            _row_id(share),
            {
                "is_active": False,
                "ics_token": None,
                "ics_enabled": False,
                "ics_issued_at": None,
                "ics_rotated_at": None,
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception("Failed to revoke calendar share")
        return jsonify({"error": "Unable to revoke calendar share."}), 500

    return jsonify({"share": _calendar_share_payload(updated)})


def _calendar_ics_lifecycle_response(share_id, action):
    user_id = str(current_user.id)
    actions = {
        "enable": enable_calendar_ics,
        "disable": disable_calendar_ics,
        "rotate": rotate_calendar_ics,
        "remove": remove_calendar_ics,
    }
    try:
        outcome = actions[action](user_id, share_id)
    except CalendarIcsFailure as exc:
        return jsonify(exc.payload()), exc.status
    except AppwriteException:
        logger.exception("Failed to update calendar ICS subscription")
        return jsonify({"error": "Unable to update calendar ICS subscription.", "code": "calendar_ics_unavailable"}), 500
    return jsonify({"share": _calendar_share_payload(outcome.share)})


@calendar_bp.route("/shares/<share_id>/ics", methods=["GET"])
@login_required
def get_calendar_share_ics(share_id):
    user_id = str(current_user.id)
    try:
        require_calendar_ics_enabled(user_id)
        share = _owned_calendar_share_or_none(share_id, user_id)
    except CalendarIcsFailure as exc:
        return jsonify(exc.payload()), exc.status
    except AppwriteException:
        logger.exception("Failed to load calendar ICS subscription")
        return jsonify({"error": "Unable to load calendar ICS subscription.", "code": "calendar_ics_unavailable"}), 500
    if not share:
        return jsonify({"error": "Calendar share not found.", "code": "calendar_ics_not_found"}), 404
    try:
        return jsonify({"ics": owner_ics_metadata(share)})
    except CalendarIcsFailure as exc:
        return jsonify(exc.payload()), exc.status


@calendar_bp.route("/shares/<share_id>/ics", methods=["POST"])
@login_required
def configure_calendar_share_ics(share_id):
    payload = request.get_json(silent=True) or {}
    action = payload.get("action")
    if action is None and "enabled" in payload:
        enabled = payload.get("enabled")
        if isinstance(enabled, str):
            enabled = enabled.strip().lower() in {"1", "true", "yes", "on"}
        action = "enable" if bool(enabled) else "disable"
    if action not in {"enable", "disable", "rotate"}:
        return jsonify({
            "error": "ICS action must be enable, disable, or rotate.",
            "code": "calendar_ics_invalid_action",
        }), 422
    return _calendar_ics_lifecycle_response(share_id, action)


@calendar_bp.route("/shares/<share_id>/ics/enable", methods=["POST"])
@login_required
def enable_calendar_share_ics(share_id):
    return _calendar_ics_lifecycle_response(share_id, "enable")


@calendar_bp.route("/shares/<share_id>/ics/disable", methods=["POST"])
@login_required
def disable_calendar_share_ics(share_id):
    return _calendar_ics_lifecycle_response(share_id, "disable")


@calendar_bp.route("/shares/<share_id>/ics/rotate", methods=["POST"])
@login_required
def rotate_calendar_share_ics(share_id):
    return _calendar_ics_lifecycle_response(share_id, "rotate")


@calendar_bp.route("/shares/<share_id>/ics", methods=["DELETE"])
@login_required
def remove_calendar_share_ics(share_id):
    return _calendar_ics_lifecycle_response(share_id, "remove")


@calendar_bp.route("/share/<share_code>/events")
def get_public_calendar_share_events(share_code):
    range_start = _parse_range_param(request.args.get("start"))
    range_end = _parse_range_param(request.args.get("end"))
    if bool(request.args.get("start")) ^ bool(request.args.get("end")):
        return jsonify({"error": "start and end are required together"}), 400
    if (request.args.get("start") and not range_start) or (
        request.args.get("end") and not range_end
    ):
        return jsonify({"error": "start and end must be valid ISO-8601"}), 400

    try:
        share = _resolve_calendar_share_by_code(share_code, active_only=True)
    except AppwriteException:
        logger.exception("Failed to resolve public calendar share")
        return jsonify({"error": "Unable to load shared calendar."}), 500
    if not share:
        return jsonify({"error": "Shared calendar not found."}), 404

    try:
        payload = _public_calendar_events_payload(share, range_start, range_end)
    except AppwriteException:
        logger.exception("Failed to load public calendar events")
        return jsonify({"error": "Unable to load shared calendar."}), 500

    return jsonify(payload)


_parse_iso_like = personal_events._parse_iso_like


@calendar_bp.route("/events", methods=["POST"])
@login_required
def create_event():
    (payload, status) = personal_events.create_event(
        str(current_user.id),
        request.get_json() or {},
        current_user,
        dependencies={
            'create_calendar_row': create_calendar_row,
            '_ensure_local_calendar_source': _ensure_local_calendar_source,
            '_serialize_user_event': _serialize_user_event,
            'emit_creation_event': emit_creation_event,
            'format_actor': format_actor,
            '_parse_iso_like': _parse_iso_like,
        },
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/events/<event_id>", methods=["GET"])
@login_required
def get_single_event(event_id):
    (payload, status) = personal_events.get_single_event(
        str(current_user.id),
        event_id,
        dependencies={'get_calendar_row': get_calendar_row, '_serialize_user_event': _serialize_user_event},
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/events/<event_id>", methods=["PUT"])
@login_required
def update_event(event_id):
    (payload, status) = personal_events.update_event(
        str(current_user.id),
        event_id,
        request.get_json() or {},
        dependencies={
            'get_calendar_row': get_calendar_row,
            'update_calendar_row': update_calendar_row,
            '_ensure_local_calendar_source': _ensure_local_calendar_source,
            '_serialize_user_event': _serialize_user_event,
            '_parse_iso_like': _parse_iso_like,
        },
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/events/<event_id>", methods=["DELETE"])
@login_required
def delete_event(event_id):
    (payload, status) = personal_events.delete_event(
        str(current_user.id),
        event_id,
        dependencies={'get_calendar_row': get_calendar_row, 'delete_calendar_row': delete_calendar_row},
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/event-overrides", methods=["POST"])
@login_required
def upsert_event_override():
    (payload, status) = personal_events.upsert_event_override(
        str(current_user.id),
        request.get_json(silent=True) or {},
        dependencies={
            '_ensure_local_calendar_source': _ensure_local_calendar_source,
            '_upsert_event_override': _upsert_event_override,
            '_parse_iso_like': _parse_iso_like,
        },
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/event-overrides/hide", methods=["POST"])
@login_required
def hide_event_override():
    (payload, status) = personal_events.hide_event_override(
        str(current_user.id),
        request.get_json(silent=True) or {},
        dependencies={'_upsert_event_override': _upsert_event_override},
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/refresh", methods=["POST"])
@login_required
def refresh_feed():
    (payload, status) = read_operations.refresh_feed(
        str(current_user.id),
        dependencies={'first_row': first_row, 'update_row_safe': update_row_safe},
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


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

        count_response = list_calendar_rows_safe(
            COLLECTIONS["calendar_cache"],
            [Query.equal("user_id", [user_id]), Query.limit(1)],
        )
    except AppwriteException:
        logger.exception("Failed to load calendar status")
        return jsonify({"error": "Unable to load calendar status."}), 500

    return jsonify({
        "feed_configured": bool(feed_urls),
        "configured_feed_count": len(feed_urls),
        "refresh_interval_minutes": settings.get("feed_refresh_minutes") if settings else None,
        "last_fetched": _resolve_last_fetched(user_id),
        "cached_event_count": count_response.get("total", 0),
    })


@calendar_bp.route("/preferences", methods=["GET"])
@login_required
def get_calendar_preferences():
    (payload, status) = preferences.get_calendar_preferences(
        str(current_user.id),
        dependencies={'list_calendar_rows_all': list_calendar_rows_all},
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/preferences", methods=["POST"])
@login_required
def update_calendar_preferences():
    (payload, status) = preferences.update_calendar_preferences(
        str(current_user.id),
        request.get_json() or {},
        dependencies={
            'first_calendar_row': first_calendar_row,
            '_upsert_calendar_preference': _upsert_calendar_preference,
        },
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


@calendar_bp.route("/preferences/batch", methods=["POST"])
@login_required
def update_calendar_preferences_batch():
    (payload, status) = preferences.update_calendar_preferences_batch(
        str(current_user.id),
        request.get_json() or {},
        dependencies={
            'first_calendar_row': first_calendar_row,
            '_upsert_calendar_preference': _upsert_calendar_preference,
        },
    )
    return jsonify(payload) if status == 200 else (jsonify(payload), status)


_SHARE_FEED_SECURITY_HEADERS = {
    "Cache-Control": "no-store, private, no-transform",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow",
}
_SHARE_FEED_SUCCESS_HEADERS = {
    **_SHARE_FEED_SECURITY_HEADERS,
    "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
    "Cache-Control": "no-store, private, no-transform",
}


def _share_feed_error(status, body):
    headers = dict(_SHARE_FEED_SECURITY_HEADERS)
    if status == 503:
        headers["Content-Type"] = "text/plain; charset=utf-8"
    return Response(body, status=status, headers=headers)


@calendar_bp.route("/share-feed.ics", methods=["GET", "HEAD"])
def share_feed_ics():
    """Serve the canonical, token-only share-scoped ICS subscription feed."""
    if set(request.args.keys()) != {"token"}:
        return _share_feed_error(404, "Not Found")
    token_values = request.args.getlist("token")
    if len(token_values) != 1 or not token_values[0]:
        return _share_feed_error(404, "Not Found")

    try:
        share = resolve_calendar_ics_token(token_values[0])
    except CalendarIcsResourceError:
        return _share_feed_error(503, "Calendar temporarily unavailable.")
    except CalendarIcsFailure:
        return _share_feed_error(404, "Not Found")
    if not share:
        return _share_feed_error(404, "Not Found")

    try:
        document, _window = build_calendar_ics_feed(share)
    except CalendarIcsFeedError:
        return _share_feed_error(503, "Calendar temporarily unavailable.")
    except Exception:
        return _share_feed_error(503, "Calendar temporarily unavailable.")

    headers = dict(_SHARE_FEED_SUCCESS_HEADERS)
    headers["ETag"] = document.etag
    headers["Content-Length"] = str(len(document.content))
    if if_none_match_matches(request.headers.get("If-None-Match"), document.etag):
        return Response(status=304, headers=headers)
    body = document.content if request.method == "GET" else b""
    response = Response(body, status=200, headers=headers)
    if request.method == "HEAD":
        response.headers["Content-Length"] = str(len(document.content))
    return response


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
