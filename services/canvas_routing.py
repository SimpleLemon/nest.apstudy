"""Canvas destination routing and consent-aware calendar event projection."""

from collections.abc import Mapping
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError, extension_capability_enabled
import uuid
from services.calendar_constants import (
    CANVAS_PROJECTION_SCOPES,
    CANVAS_READ_SCOPES,
    CANVAS_ROUTE_STATES,
    DEFAULT_LOCAL_SOURCE_ID,
)
from services.calendar_identity import (
    _canvas_truthy,
    _event_ref_for_cache_event,
)
from services.calendar_serialization import (
    _api_event_overlaps_range,
    _apply_event_override,
    _serialize_canvas_event,
)
from services.calendar_sources import (
    extension_calendar_destinations,
)
from services.canvas_domain import (
    normalize_canvas_request,
    _canvas_now,
    _canvas_optional_id,
    _canvas_user_id,
)
from services.canvas_sources import (
    _canvas_consent_from_connection,
    _canvas_routing_payload,
    _canvas_source_consent,
    _canvas_source_internal_payload,
    _require_canvas_source,
)


def get_canvas_import_routing(user_id, source_id, state=None):
    user_id = _canvas_user_id(user_id)
    if state is not None and state not in CANVAS_ROUTE_STATES:
        raise ExtensionContractError("invalid_route_state", "Routing state must be incomplete or completed.")
    with calendar_connection() as connection:
        source = _require_canvas_source(connection, user_id, source_id, include_archived=True)
        if source["status"] != "active":
            return [] if state is None else None
        try:
            _canvas_source_consent(
                connection,
                source,
                scopes=CANVAS_READ_SCOPES,
            )
        except ExtensionContractError as exc:
            # Revocation archives the source, but this also covers a source
            # whose consent was disconnected before cleanup completed. A GET
            # may safely appear empty after revocation.
            if exc.code in {"consent_required", "scope_required", "consent_version_mismatch"}:
                return [] if state is None else None
            raise
        source_id = source["source_id"]
        query = "SELECT * FROM calendar_import_routing WHERE user_id = ? AND source_id = ?"
        params = [user_id, source_id]
        if state is not None:
            query += " AND state = ?"
            params.append(state)
        query += " ORDER BY state ASC"
        rows = connection.execute(query, params).fetchall()
    if state is None:
        return [_canvas_routing_payload(dict(row), source) for row in rows]
    return _canvas_routing_payload(dict(rows[0]), source) if rows else None


def set_canvas_import_routing(user_id, source_id, payload):
    values = normalize_canvas_request(payload, (
        ("destinationCalendarId", "destination_calendar_id"),
        ("fallbackCalendarId", "fallback_calendar_id"),
    ))
    state = values.get("state")
    destination_calendar_id = values.get("destination_calendar_id")
    fallback_calendar_id = values.get("fallback_calendar_id")
    if state not in CANVAS_ROUTE_STATES:
        raise ExtensionContractError("invalid_route_state", "Routing state must be incomplete or completed.")
    destination_calendar_id = _canvas_optional_id(
        destination_calendar_id,
        field="destination_calendar_id",
    )
    fallback_calendar_id = _canvas_optional_id(
        fallback_calendar_id,
        field="fallback_calendar_id",
    )
    user_id = _canvas_user_id(user_id)
    now = _canvas_now()
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id, include_archived=False)
        _canvas_source_consent(
            connection,
            source,
            scopes=CANVAS_READ_SCOPES,
        )
        routing_inventory = {
            destination["id"]
            for destination in extension_calendar_destinations(user_id)
            if destination.get("visible") and destination.get("routing_eligible")
        }
        for field, calendar_id in (
            ("destination_calendar_id", destination_calendar_id),
            ("fallback_calendar_id", fallback_calendar_id),
        ):
            if calendar_id is not None and calendar_id not in routing_inventory:
                raise ExtensionContractError(
                    "routing_destination_unavailable",
                    f"{field} must name a visible, routing-eligible calendar.",
                )
        source_id = source["source_id"]
        existing = connection.execute(
            """SELECT * FROM calendar_import_routing
               WHERE user_id = ? AND source_id = ? AND state = ?""",
            [user_id, source_id, state],
        ).fetchone()
        if existing:
            unchanged = (
                existing["destination_calendar_id"] == destination_calendar_id
                and existing["fallback_calendar_id"] == fallback_calendar_id
            )
            if unchanged:
                return _canvas_routing_payload(dict(existing), source, idempotent=True)
            connection.execute(
                """UPDATE calendar_import_routing
                   SET destination_calendar_id = ?, fallback_calendar_id = ?, updated_at = ?
                   WHERE id = ?""",
                [destination_calendar_id, fallback_calendar_id, now, existing["id"]],
            )
            row_id = existing["id"]
        else:
            row_id = uuid.uuid4().hex
            connection.execute(
                """INSERT INTO calendar_import_routing
                   (id, user_id, source_id, state, destination_calendar_id,
                    fallback_calendar_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                [
                    row_id,
                    user_id,
                    source_id,
                    state,
                    destination_calendar_id,
                    fallback_calendar_id,
                    now,
                    now,
                ],
            )
        row = connection.execute("SELECT * FROM calendar_import_routing WHERE id = ?", [row_id]).fetchone()
    return _canvas_routing_payload(dict(row), source)


def _load_active_canvas_sources(user_id, *, require_shares_ics=False):
    """Load active Canvas sources only when the effective projection gates pass."""
    if not extension_capability_enabled("calendar_read"):
        return []
    if not extension_capability_enabled("calendar_projection"):
        return []
    if require_shares_ics and not extension_capability_enabled("calendar_shares_ics"):
        return []
    with calendar_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM calendar_import_sources
               WHERE user_id = ? AND provider = 'canvas' AND status = 'active'
                 AND archived_at IS NULL
               ORDER BY created_at ASC""",
            [str(user_id)],
        ).fetchall()
        sources = []
        for row in rows:
            source = dict(row)
            try:
                _canvas_consent_from_connection(
                    connection,
                    user_id,
                    source.get("account_key"),
                    CANVAS_PROJECTION_SCOPES,
                )
            except ExtensionContractError:
                continue
            sources.append(_canvas_source_internal_payload(source))
    return sources


def _load_canvas_import_routing_rows(user_id):
    """Load display routing without mutating routes or validating destinations."""
    with calendar_connection() as connection:
        rows = connection.execute(
            """SELECT * FROM calendar_import_routing
               WHERE user_id = ?
               ORDER BY source_id ASC, state ASC""",
            [str(user_id)],
        ).fetchall()
    return [dict(row) for row in rows]


def _visible_calendar_fallback(preferences):
    """Choose the first visible configured calendar, or the legacy local calendar."""
    if isinstance(preferences, Mapping):
        preferences = [preferences]
    for preference in preferences or []:
        calendar_id = preference.get("calendar_name")
        visible = preference.get("visible", True)
        if calendar_id and (visible is None or _canvas_truthy(visible)):
            return calendar_id
    return DEFAULT_LOCAL_SOURCE_ID


def _canvas_route_state(doc):
    status = str(doc.get("canvas_completion_status") or "incomplete").strip().lower()
    return "completed" if status in {"completed", "complete", "done"} else "incomplete"


def _canvas_routed_calendar_id(doc, source, routing_by_key, visible_fallback, override):
    """Resolve display routing in precedence order and report degraded routing."""
    explicit_calendar = (override or {}).get("calendar_id")
    if explicit_calendar:
        return explicit_calendar, False

    source_id = doc.get("canvas_source_id") or source.get("source_id")
    route_state = _canvas_route_state(doc)
    route = routing_by_key.get((source_id, route_state))
    if route and route.get("destination_calendar_id"):
        return route["destination_calendar_id"], False
    if route and route.get("fallback_calendar_id"):
        return route["fallback_calendar_id"], True

    source_default = source.get("default_mirror_calendar")
    if source_default:
        return source_default, True
    return visible_fallback, True


def _project_canvas_calendar_events(
    user_id,
    cache_events,
    overrides_by_ref=None,
    *,
    preferences=None,
    range_start=None,
    range_end=None,
    source_rows=None,
    routing_rows=None,
    apply_event_override=_apply_event_override,
    api_event_overlaps_range=None,
    require_shares_ics=False,
):
    """Return sanitized authenticated Canvas events for the unified calendar feed.

    Loader contract: ``cache_events`` is a read-only sequence of cache rows and the
    helper returns a new list of response dictionaries.  It only reads active,
    consented sources/routes; it never updates cache rows, routes, or overrides.
    """
    source_rows = (
        _load_active_canvas_sources(user_id, require_shares_ics=require_shares_ics)
        if source_rows is None
        else source_rows
    )
    routing_rows = (
        _load_canvas_import_routing_rows(user_id)
        if routing_rows is None
        else routing_rows
    )
    source_by_key = {
        (source.get("source_id"), source.get("account_key")): source
        for source in source_rows
        if (
            source.get("source_id")
            and source.get("status", "active") == "active"
            and not source.get("archived_at")
            and source.get("consent_state", "active") == "active"
            and source.get("consented", True) is not False
        )
    }
    routing_by_key = {
        (row.get("source_id"), row.get("state")): row
        for row in routing_rows
        if row.get("source_id") and row.get("state") in CANVAS_ROUTE_STATES
    }
    overrides_by_ref = overrides_by_ref or {}
    api_event_overlaps_range = api_event_overlaps_range or _api_event_overlaps_range
    visible_fallback = _visible_calendar_fallback(preferences)
    projected = []

    for cache_event in cache_events or []:
        if not (cache_event.get("canvas_source_id") or cache_event.get("canvas_event_ref")):
            continue
        if _canvas_truthy(cache_event.get("canvas_soft_deleted")):
            continue
        source_key = (
            cache_event.get("canvas_source_id"),
            cache_event.get("canvas_account_key"),
        )
        source = source_by_key.get(source_key)
        if not source:
            continue
        event_ref = _event_ref_for_cache_event(cache_event)
        if not event_ref:
            continue
        override = overrides_by_ref.get(event_ref)
        serialized = _serialize_canvas_event(
            cache_event,
            source=source,
            authenticated=True,
        )
        routed_calendar_id, routing_degraded = _canvas_routed_calendar_id(
            cache_event,
            source,
            routing_by_key,
            visible_fallback,
            override,
        )
        serialized["calendar_id"] = routed_calendar_id
        serialized["routing_degraded"] = routing_degraded
        serialized = apply_event_override(serialized, override)
        if not serialized:
            continue
        if range_start and range_end and not api_event_overlaps_range(
            serialized,
            range_start,
            range_end,
        ):
            continue
        projected.append(serialized)
    return projected
