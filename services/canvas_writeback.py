"""Personal Canvas event links and durable idempotent writeback lifecycle."""

import json
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError, validate_account_key
import sqlite3
import uuid
from services.calendar_constants import (
    CANVAS_MIRROR_SCOPE,
    CANVAS_MIRROR_STATES,
    CANVAS_RUN_ID_PATTERN,
    CANVAS_WRITEBACK_CREATE_STATES,
    CANVAS_WRITEBACK_STATES,
)
from services.canvas_domain import (
    normalize_canvas_request,
    _canvas_hash,
    _canvas_id,
    _canvas_idempotency_key,
    _canvas_item_type,
    _canvas_json,
    _canvas_link_payload,
    _canvas_now,
    _canvas_optional_id,
    _canvas_reject_credentials,
    _canvas_result_error,
    _canvas_source_account,
    _canvas_timestamp,
    _canvas_user_id,
    _canvas_writeback_payload,
)
from services.canvas_sources import (
    _canvas_source_consent,
    _require_canvas_source,
)


LINK_ALIASES = (
    ("eventKind", "event_kind"), ("nestEventId", "nest_event_id"),
    ("projectionEventId", "projection_event_id"), ("sourceRevision", "source_revision"),
    ("sourceHash", "source_hash"), ("mirrorState", "mirror_state"),
    ("context_id", "canvas_context_id"), ("contextId", "canvas_context_id"),
    ("calendar_id", "canvas_calendar_id"), ("calendarId", "canvas_calendar_id"),
    ("item_type", "canvas_item_type"), ("itemType", "canvas_item_type"),
    ("item_id", "canvas_item_id"), ("itemId", "canvas_item_id"),
    ("occurrence_id", "canvas_occurrence_id"), ("occurrenceId", "canvas_occurrence_id"),
)
WRITEBACK_ALIASES = (
    ("eventRef", "event_ref"), ("expectedRevision", "expected_revision"),
    ("idempotencyKey", "idempotency_key"), ("targetAccount", "target_account"),
    ("targetCalendar", "target_calendar"),
)
RESULT_ALIASES = (
    ("expectedRevision", "expected_revision"), ("sourceRevision", "source_revision"),
    ("sourceHash", "source_hash"), ("errorMessage", "error_message"),
    ("mirroredAt", "mirrored_at"), ("resultRevision", "result_revision"),
    ("nextRetryAt", "next_retry_at"),
)


def _canvas_event_link_identity(payload):
    """Normalize canonical Canvas identity for the unique link index."""
    identity = {
        field: _canvas_optional_id(payload.get(field), field=field)
        for field in ("canvas_context_id", "canvas_calendar_id", "canvas_item_id", "canvas_occurrence_id")
    }
    item_type = payload.get("canvas_item_type")
    identity["canvas_item_type"] = _canvas_item_type(item_type) if item_type is not None else None
    if identity["canvas_item_id"] and not all(
        identity[key] for key in ("canvas_context_id", "canvas_calendar_id", "canvas_item_type")
    ):
        raise ExtensionContractError(
            "invalid_event_link",
            "Canvas identity requires context, calendar, and item type.",
        )
    return identity


def _canvas_event_link_lookup(connection, user_id, source_id, event_ref=None, *, link_id=None, include_archived=False):
    clauses = ["user_id = ?", "source_id = ?"]
    params = [user_id, source_id]
    if link_id is not None:
        clauses.append("id = ?")
        params.append(link_id)
    elif event_ref is not None:
        clauses.append("event_ref = ?")
        params.append(event_ref)
    if not include_archived:
        clauses.append("archived_at IS NULL")
    return connection.execute(
        f"SELECT * FROM calendar_event_links WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT 1",
        params,
    ).fetchone()


def create_canvas_event_link(user_id, source_id, payload):
    """Create or replay an active Canvas-to-Nest event link from one request."""
    values = normalize_canvas_request(payload, LINK_ALIASES)
    account_key = values.get("account_key")
    event_kind = values.get("event_kind")
    nest_event_id = values.get("nest_event_id")
    projection_event_id = values.get("projection_event_id")
    event_ref = values.get("event_ref")
    source_revision = values.get("source_revision")
    source_hash = values.get("source_hash")
    mirror_state = values.get("mirror_state")
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    event_kind = str(event_kind or "projection").strip().lower()
    if event_kind not in {"native", "projection", "feed"}:
        raise ExtensionContractError("invalid_event_kind", "event_kind must be native, projection, or feed.")
    event_ref = _canvas_optional_id(event_ref, field="event_ref")
    nest_event_id = _canvas_optional_id(nest_event_id, field="nest_event_id")
    projection_event_id = _canvas_optional_id(projection_event_id, field="projection_event_id")
    source_revision = _canvas_optional_id(source_revision, field="source_revision")
    source_hash = _canvas_optional_id(source_hash, field="source_hash")
    mirror_state = str(mirror_state or "not_requested").strip().lower()
    if mirror_state not in CANVAS_MIRROR_STATES:
        raise ExtensionContractError("invalid_mirror_state", "mirror_state is not an approved Canvas mirror state.")
    identity = _canvas_event_link_identity(values)
    from services.extension_write_validation import validate_personal_identity
    validate_personal_identity(event_ref, identity)
    if not event_ref and not identity["canvas_item_id"]:
        raise ExtensionContractError("invalid_event_link", "event_ref or a Canvas item identity is required.")
    now = _canvas_now()

    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id)
        account_key = _canvas_source_account(source, account_key)
        source_id = source["source_id"]
        from services.extension_bridge import personal_target
        personal_target(connection, user_id, event_ref)
        from services.extension_write_validation import personal_calendar
        personal_calendar(source, identity["canvas_context_id"])
        _canvas_source_consent(connection, source, version=2, scopes=(CANVAS_MIRROR_SCOPE,))
        if identity["canvas_item_type"] not in {"calendar_event", "planner_note"}:
            raise ExtensionContractError("personal_item_required", "Only personal Canvas events and planner notes can be linked.")
        existing = _canvas_event_link_lookup(connection, user_id, source_id, event_ref)
        if existing is None and identity["canvas_item_id"]:
            existing = connection.execute(
                """SELECT * FROM calendar_event_links
                   WHERE user_id = ? AND source_id = ? AND account_key = ?
                     AND canvas_context_id = ? AND canvas_calendar_id = ?
                     AND canvas_item_type = ? AND canvas_item_id = ?
                     AND IFNULL(canvas_occurrence_id, '') = IFNULL(?, '')
                     AND archived_at IS NULL
                   LIMIT 1""",
                [user_id, source_id, account_key, identity["canvas_context_id"],
                 identity["canvas_calendar_id"], identity["canvas_item_type"],
                 identity["canvas_item_id"], identity["canvas_occurrence_id"]],
            ).fetchone()
        if existing:
            same = all(existing[field] == value for field, value in {
                "account_key": account_key, "event_kind": event_kind,
                "nest_event_id": nest_event_id, "projection_event_id": projection_event_id,
                "event_ref": event_ref, **identity, "source_revision": source_revision,
                "source_hash": source_hash, "mirror_state": mirror_state,
            }.items())
            if not same:
                raise ExtensionContractError("event_link_conflict", "The active Canvas event link already exists.")
            return _canvas_link_payload(existing, idempotent=True)
        link_id = uuid.uuid4().hex
        try:
            connection.execute(
                """INSERT INTO calendar_event_links
                   (id, user_id, source_id, account_key, event_kind, nest_event_id,
                    projection_event_id, event_ref, canvas_context_id, canvas_calendar_id,
                    canvas_item_id, canvas_occurrence_id, canvas_item_type, source_revision,
                    source_hash, mirror_state, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [link_id, user_id, source_id, account_key, event_kind, nest_event_id,
                 projection_event_id, event_ref, identity["canvas_context_id"],
                 identity["canvas_calendar_id"], identity["canvas_item_id"],
                 identity["canvas_occurrence_id"], identity["canvas_item_type"],
                 source_revision, source_hash, mirror_state, now, now],
            )
        except sqlite3.IntegrityError as exc:
            raise ExtensionContractError("event_link_conflict", "The active Canvas event link already exists.") from exc
        created = connection.execute("SELECT * FROM calendar_event_links WHERE id = ?", [link_id]).fetchone()
    return _canvas_link_payload(created)


def get_canvas_event_link(user_id, source_id, event_ref=None, *, link_id=None, include_archived=False):
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    if event_ref is None and link_id is None:
        raise ExtensionContractError("invalid_event_link", "event_ref or link_id is required.")
    if event_ref is not None:
        event_ref = _canvas_id(event_ref, field="event_ref")
    if link_id is not None:
        link_id = _canvas_id(link_id, field="link_id")
    with calendar_connection() as connection:
        source_id = _require_canvas_source(connection, user_id, source_id, include_archived=True)["source_id"]
        row = _canvas_event_link_lookup(
            connection, user_id, source_id, event_ref, link_id=link_id, include_archived=include_archived
        )
    return _canvas_link_payload(row)


def record_canvas_event_link_result(user_id, source_id, payload, *, event_ref=None, link_id=None):
    """Record a mirror result with optimistic revision control."""
    values = normalize_canvas_request(payload, RESULT_ALIASES + (("state", "mirror_state"),))
    mirror_state = values.get("mirror_state")
    expected_revision = values.get("expected_revision")
    source_revision = values.get("source_revision")
    source_hash = values.get("source_hash")
    error_code, error_message = values.get("error_code"), values.get("error_message")
    mirrored_at = values.get("mirrored_at")
    mirror_state = str(mirror_state or "queued").strip().lower()
    if mirror_state not in CANVAS_MIRROR_STATES:
        raise ExtensionContractError("invalid_mirror_state", "mirror_state is not an approved Canvas mirror state.")
    expected_revision = _canvas_optional_id(expected_revision, field="expected_revision")
    source_revision = _canvas_optional_id(source_revision, field="source_revision")
    source_hash = _canvas_optional_id(source_hash, field="source_hash")
    error_code, error_message = _canvas_result_error(error_code, error_message)
    mirrored_at = _canvas_timestamp(mirrored_at, field="mirrored_at", required=False) or _canvas_now()
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        _require_canvas_source(connection, user_id, source_id, include_archived=True)
        row = _canvas_event_link_lookup(
            connection, user_id, source_id, event_ref, link_id=link_id, include_archived=True
        )
        if not row:
            raise ExtensionContractError("event_link_not_found", "Canvas event link was not found.")
        if expected_revision is not None and row["source_revision"] != expected_revision:
            raise ExtensionContractError("revision_conflict", "The Canvas event link revision is no longer current.")
        if row["archived_at"] is not None:
            raise ExtensionContractError("event_link_archived", "The Canvas event link is archived.")
        if row["mirror_state"] == mirror_state and row["source_revision"] == source_revision and row["source_hash"] == source_hash:
            return _canvas_link_payload(row, idempotent=True)
        connection.execute(
            """UPDATE calendar_event_links
               SET mirror_state = ?, mirror_error_code = ?, mirror_error_message = ?,
                   source_revision = ?, source_hash = ?, mirrored_at = ?, updated_at = ?
               WHERE id = ? AND user_id = ? AND source_id = ? AND archived_at IS NULL""",
            [mirror_state, error_code, error_message, source_revision, source_hash,
             mirrored_at if mirror_state == "applied" else None, _canvas_now(),
             row["id"], user_id, source_id],
        )
        updated = connection.execute("SELECT * FROM calendar_event_links WHERE id = ?", [row["id"]]).fetchone()
    return _canvas_link_payload(updated)


def _canonical_writeback_values(payload):
    values = normalize_canvas_request(payload, WRITEBACK_ALIASES)
    values["operation"] = str(values.get("operation") or "").strip().lower()
    return values


def _canvas_writeback_request(payload):
    values = _canonical_writeback_values(payload)
    operation = values.get("operation")
    event_ref = values.get("event_ref")
    expected_revision = values.get("expected_revision")
    idempotency_key = values.get("idempotency_key")
    target_account = values.get("target_account")
    target_calendar = values.get("target_calendar")
    operation = str(operation or "").strip().lower()
    if operation not in {"create", "update", "delete"}:
        raise ExtensionContractError("invalid_operation", "operation must be create, update, or delete.")
    event_ref = _canvas_optional_id(event_ref, field="event_ref")
    expected_revision = _canvas_optional_id(expected_revision, field="expected_revision")
    idempotency_key = _canvas_idempotency_key(idempotency_key, field="idempotency_key")
    target_account = validate_account_key(target_account)
    target_calendar = _canvas_optional_id(target_calendar, field="target_calendar")
    from services.extension_write_validation import validate_fields, PERSONAL_CONTEXT
    allowed = {"account_key", "operation", "event_ref", "eventRef", "expected_revision", "expectedRevision",
               "idempotency_key", "idempotencyKey", "target_account", "targetAccount", "target_calendar",
               "targetCalendar", "payload", "state"}
    if set(values) - allowed:
        raise ExtensionContractError("invalid_writeback_fields", "Writeback request contains unsupported fields.")
    validate_fields(event_ref, operation, values.get("payload", {}))
    if target_calendar is not None and not PERSONAL_CONTEXT.fullmatch(target_calendar):
        raise ExtensionContractError("personal_item_required", "Choose a personal Canvas calendar.")
    _canvas_reject_credentials(values)
    payload_json = _canvas_json(values, field="payload", max_bytes=64 * 1024)
    return operation, event_ref, expected_revision, idempotency_key, target_account, target_calendar, payload_json


def create_canvas_writeback(user_id, source_id, payload):
    """Queue or replay one consented request; old durable intents remain intact."""
    values = _canonical_writeback_values(payload)
    account_key = values.get("account_key")
    state = values.get("state", "waiting_for_canvas_session")
    state = str(state or "waiting_for_canvas_session").strip().lower()
    if state not in CANVAS_WRITEBACK_CREATE_STATES:
        raise ExtensionContractError("invalid_writeback_state", "A new writeback must be waiting or queued.")
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    account_key = validate_account_key(account_key)
    (operation, event_ref, expected_revision, idempotency_key, target_account,
     target_calendar, payload_json) = _canvas_writeback_request(values)
    payload_hash = _canvas_hash(payload_json)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id)
        _canvas_source_account(source, account_key)
        source_id = source["source_id"]
        from services.extension_bridge import personal_target
        _, scope, _ = personal_target(connection, user_id, event_ref)
        from services.extension_write_validation import personal_calendar
        personal_calendar(source, target_calendar)
        _canvas_source_consent(connection, source, version=2, scopes=(scope,))
        if target_account != account_key:
            raise ExtensionContractError("source_account_mismatch", "Writeback target must match the source account.")
        if operation == "create":
            _canvas_source_consent(connection, source, version=2, scopes=(CANVAS_MIRROR_SCOPE,))
        if operation in {"update", "delete"} and expected_revision is None:
            raise ExtensionContractError("expected_revision_required", "update and delete require expected_revision.")
        if expected_revision is not None and event_ref:
            link = _canvas_event_link_lookup(connection, user_id, source_id, event_ref)
            cache = connection.execute(
                """SELECT canvas_source_revision FROM calendar_cache
                   WHERE user_id = ? AND canvas_source_id = ? AND canvas_account_key = ?
                     AND canvas_event_ref = ? AND canvas_soft_deleted = 0 LIMIT 1""",
                [user_id, source_id, account_key, event_ref],
            ).fetchone()
            current_revision = link["source_revision"] if link and link["source_revision"] is not None else (cache["canvas_source_revision"] if cache else None)
            if current_revision is not None and current_revision != expected_revision:
                raise ExtensionContractError("revision_conflict", "The Canvas event revision is no longer current.")
        existing = connection.execute(
            """SELECT * FROM calendar_writebacks
               WHERE user_id = ? AND source_id = ? AND idempotency_key = ?""",
            [user_id, source_id, idempotency_key],
        ).fetchone()
        if existing:
            # Alias normalization must not invalidate intents queued before this
            # contract. Compare meaning without rewriting their payload/hash.
            same_payload = existing["payload_hash"] == payload_hash
            if not same_payload:
                try:
                    same_payload = _canonical_writeback_values(json.loads(existing["payload_json"])) == values
                except (ValueError, TypeError):
                    same_payload = False
            if not same_payload or existing["operation"] != operation or existing["expected_revision"] != expected_revision:
                raise ExtensionContractError("idempotency_conflict", "The writeback idempotency key was already used with different parameters.")
            return _canvas_writeback_payload(existing, idempotent=True)
        now = _canvas_now()
        writeback_id = uuid.uuid4().hex
        try:
            connection.execute(
                """INSERT INTO calendar_writebacks
                   (id, user_id, source_id, account_key, operation, event_ref, expected_revision,
                    payload_hash, idempotency_key, target_account, target_calendar, payload_json,
                    state, retry_count, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
                [writeback_id, user_id, source_id, account_key, operation, event_ref, expected_revision,
                 payload_hash, idempotency_key, target_account, target_calendar, payload_json, state, now, now],
            )
        except sqlite3.IntegrityError as exc:
            raise ExtensionContractError("writeback_conflict", "The Canvas writeback could not be created.") from exc
        created = connection.execute("SELECT * FROM calendar_writebacks WHERE id = ?", [writeback_id]).fetchone()
    return _canvas_writeback_payload(created)


def list_canvas_writebacks(user_id, source_id, *, account_key=None, event_ref=None, states=None, limit=100):
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ExtensionContractError("invalid_limit", "limit must be between 1 and 100.")
    if isinstance(states, str):
        states = [states]
    elif states is not None and not isinstance(states, (list, tuple, set)):
        raise ExtensionContractError("invalid_writeback_state", "states must be an array.")
    if states is not None:
        states = [str(value).strip().lower() for value in states]
        if any(value not in CANVAS_WRITEBACK_STATES for value in states):
            raise ExtensionContractError("invalid_writeback_state", "states contains an unapproved state.")
    if account_key is not None:
        account_key = validate_account_key(account_key)
    if event_ref is not None:
        event_ref = _canvas_id(event_ref, field="event_ref")
    with calendar_connection() as connection:
        source = _require_canvas_source(connection, user_id, source_id, include_archived=True)
        if account_key is not None:
            _canvas_source_account(source, account_key)
        source_id = source["source_id"]
        clauses = ["user_id = ?", "source_id = ?"]
        params = [user_id, source_id]
        if account_key is not None:
            clauses.append("account_key = ?")
            params.append(account_key)
        if event_ref is not None:
            clauses.append("event_ref = ?")
            params.append(event_ref)
        if states:
            clauses.append("state IN (" + ",".join("?" for _ in states) + ")")
            params.extend(states)
        rows = connection.execute(
            f"SELECT * FROM calendar_writebacks WHERE {' AND '.join(clauses)} ORDER BY created_at ASC LIMIT ?",
            [*params, limit],
        ).fetchall()
    return [_canvas_writeback_payload(row) for row in rows]


def get_canvas_writeback_result(user_id, source_id, writeback_id, *, include_archived=True):
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    writeback_id = _canvas_id(writeback_id, field="writeback_id")
    with calendar_connection() as connection:
        source_id = _require_canvas_source(connection, user_id, source_id, include_archived=True)["source_id"]
        row = connection.execute(
            "SELECT * FROM calendar_writebacks WHERE id = ? AND user_id = ? AND source_id = ?",
            [writeback_id, user_id, source_id],
        ).fetchone()
        if row and not include_archived and row["state"] == "cancelled":
            row = None
    return _canvas_writeback_payload(row)


def record_canvas_writeback_result(user_id, source_id, writeback_id, payload):
    """Apply one approved result request, once, to an owned row."""
    values = normalize_canvas_request(payload, RESULT_ALIASES + (("status", "state"),))
    state = values.get("state")
    expected_revision = values.get("expected_revision")
    result_revision = values.get("result_revision")
    error_code, error_message = values.get("error_code"), values.get("error_message")
    retry_count, next_retry_at = values.get("retry_count"), values.get("next_retry_at")
    state = str(state or "retryable_failed").strip().lower()
    if state not in CANVAS_WRITEBACK_STATES:
        raise ExtensionContractError("invalid_writeback_state", "state is not an approved Canvas writeback state.")
    expected_revision = _canvas_optional_id(expected_revision, field="expected_revision")
    result_revision = _canvas_optional_id(result_revision, field="result_revision")
    error_code, error_message = _canvas_result_error(error_code, error_message)
    if retry_count is not None and (isinstance(retry_count, bool) or not isinstance(retry_count, int) or retry_count < 0):
        raise ExtensionContractError("invalid_retry_count", "retry_count must be a non-negative integer.")
    next_retry_at = _canvas_timestamp(next_retry_at, field="next_retry_at", required=False)
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id, include_archived=True)
        source_id = source["source_id"]
        row = connection.execute(
            "SELECT * FROM calendar_writebacks WHERE id = ? AND user_id = ? AND source_id = ?",
            [writeback_id, user_id, source_id],
        ).fetchone()
        if not row:
            raise ExtensionContractError("writeback_not_found", "Canvas writeback was not found.")
        scope = "personal_events_write" if row["event_ref"].startswith("user:") else "planner_items_write"
        _canvas_source_consent(connection, source, version=2, scopes=(scope,))
        if expected_revision is not None and row["expected_revision"] != expected_revision:
            raise ExtensionContractError("revision_conflict", "The Canvas writeback revision is no longer current.")
        if row["state"] in {"applied", "unsupported", "forbidden", "conflict", "cancelled"}:
            if row["state"] == state and row["result_revision"] == result_revision and row["error_code"] == error_code:
                return _canvas_writeback_payload(row, idempotent=True)
            raise ExtensionContractError("writeback_terminal", "The Canvas writeback already has a terminal result.")
        from services.extension_bridge import personal_target
        personal_target(connection, user_id, row["event_ref"])
        if state == "applied":
            from services.extension_mirrors import finish_delete
            if not finish_delete(connection, user_id, row):
                state, error_code = "conflict", "nest_changed_after_canvas_delete"
                connection.execute("INSERT INTO extension_bridge_conflicts VALUES (?,?,?,?) ON CONFLICT(writeback_id) DO UPDATE SET canvas_revision=excluded.canvas_revision,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
                                   [writeback_id, "deleted", _canvas_json({"deleted": True}), _canvas_now()])
        if state == "applied":
            from services.extension_mirror_sync import acknowledge
            acknowledge(connection, user_id, row, result_revision)
        now = _canvas_now()
        applied_at = now if state == "applied" else None
        cancelled_at = now if state == "cancelled" else None
        next_retry_at = next_retry_at if state == "retryable_failed" else None
        connection.execute(
            """UPDATE calendar_writebacks
               SET state = ?, retry_count = COALESCE(?, retry_count), last_attempt_at = ?,
                   next_retry_at = ?, result_revision = ?, error_code = ?, error_message = ?,
                   updated_at = ?, applied_at = ?, cancelled_at = ?
               WHERE id = ? AND user_id = ? AND source_id = ?""",
            [state, retry_count, now, next_retry_at, result_revision, error_code, error_message,
             now, applied_at, cancelled_at, writeback_id, user_id, source_id],
        )
        updated = connection.execute("SELECT * FROM calendar_writebacks WHERE id = ?", [writeback_id]).fetchone()
    return _canvas_writeback_payload(updated)


create_canvas_event_link_result = record_canvas_event_link_result


create_canvas_writeback_result = record_canvas_writeback_result
