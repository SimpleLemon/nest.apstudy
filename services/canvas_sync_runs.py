"""Canvas sync generations, leases, checkpoints, cancellation, and finalization."""

from datetime import datetime, timedelta
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError
import hmac
import secrets
import uuid
from services.calendar_constants import (
    CANVAS_LEASE_MINUTES,
    CANVAS_READ_SCOPES,
    CANVAS_RUN_ID_PATTERN,
)
from services.canvas_domain import (
    normalize_canvas_request,
    _canvas_generation,
    _canvas_id,
    _canvas_idempotency_key,
    _canvas_json,
    _canvas_now,
    _canvas_scope_matches,
    _canvas_sync_run_payload,
    _canvas_text,
    _canvas_timestamp,
    _canvas_user_id,
    _normalize_canvas_scope,
)
from services.canvas_sources import (
    _canvas_source_consent,
    _require_canvas_source,
)


def _canvas_current_generation(connection, user_id, source_id):
    row = connection.execute(
        "SELECT MAX(generation) AS generation FROM calendar_sync_runs WHERE user_id = ? AND source_id = ?",
        [user_id, source_id],
    ).fetchone()
    return int(row["generation"] or 0)


def _canvas_run_row(connection, user_id, source_id, run_id):
    return connection.execute(
        "SELECT * FROM calendar_sync_runs WHERE user_id = ? AND source_id = ? AND run_id = ?",
        [user_id, source_id, run_id],
    ).fetchone()


def _canvas_mark_run_expired(connection, row, now):
    if row["state"] != "active":
        return row
    connection.execute(
        """UPDATE calendar_sync_runs
           SET state = 'expired', error_code = 'lease_expired',
               error_message = 'The sync lease expired.', updated_at = ?, completed_at = ?
           WHERE id = ? AND state = 'active'""",
        [now, now, row["id"]],
    )
    return connection.execute("SELECT * FROM calendar_sync_runs WHERE id = ?", [row["id"]]).fetchone()


def _require_current_active_run(
    connection,
    user_id,
    source_id,
    run_id,
    *,
    generation=None,
    lease_token=None,
    now=None,
):
    now = now or _canvas_now()
    run_id = _canvas_id(run_id, field="run_id", pattern=CANVAS_RUN_ID_PATTERN)
    row = _canvas_run_row(connection, user_id, source_id, run_id)
    if not row:
        raise ExtensionContractError("run_not_found", "Canvas sync run was not found.")
    expected_generation = _canvas_generation(generation, required=False)
    current_generation = _canvas_current_generation(connection, user_id, source_id)
    if row["generation"] != current_generation or (
        expected_generation is not None and row["generation"] != expected_generation
    ):
        raise ExtensionContractError("stale_run", "Only the current Canvas sync generation may mutate this run.")
    if lease_token is not None and (
        not isinstance(lease_token, str)
        or not isinstance(row["lease_token"], str)
        or not hmac.compare_digest(lease_token, row["lease_token"])
    ):
        raise ExtensionContractError("lease_token_mismatch", "The Canvas sync lease token is invalid.")
    if row["state"] != "active":
        raise ExtensionContractError("run_not_active", "The Canvas sync run is not active.")
    if row["lease_expires_at"] <= now:
        _canvas_mark_run_expired(connection, row, now)
        # Expiration is a state transition, not part of the rejected mutation.
        # Commit it before surfacing the client error so callers cannot keep
        # using a lease that the service has already invalidated.
        connection.commit()
        raise ExtensionContractError("lease_expired", "The Canvas sync lease has expired.")
    return row


def _canvas_update_source_after_run(connection, source, *, state, now, error_code=None, error_message=None):
    connection.execute(
        """UPDATE calendar_import_sources
           SET sync_state = ?, updated_at = ?, last_error_code = ?, last_error_message = ?
           WHERE user_id = ? AND source_id = ?""",
        [state, now, error_code, error_message, source["user_id"], source["source_id"]],
    )


def _canvas_parse_run_request(payload):
    values = normalize_canvas_request(payload, (("version", "consent_version"),))
    scope = values.get("scope")
    consent_version = values.get("consent_version")
    idempotency_key = values.get("idempotency_key")
    run_id = values.get("run_id")
    normalized_scope, scope_json, scope_hash = _normalize_canvas_scope(scope)
    idempotency_key = _canvas_idempotency_key(idempotency_key)
    if run_id is None:
        run_id = uuid.uuid4().hex
    run_id = _canvas_id(run_id, field="run_id", pattern=CANVAS_RUN_ID_PATTERN)
    return normalized_scope, scope_json, scope_hash, consent_version, idempotency_key, run_id


def begin_canvas_sync_run(user_id, source_id, payload):
    """Begin or return an idempotent, leased Canvas sync generation."""
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    (
        normalized_scope,
        scope_json,
        scope_hash,
        consent_version,
        idempotency_key,
        run_id,
    ) = _canvas_parse_run_request(payload)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id)
        consent, consent_version = _canvas_source_consent(
            connection,
            source,
            version=consent_version,
            scopes=CANVAS_READ_SCOPES,
        )
        existing = connection.execute(
            """SELECT * FROM calendar_sync_runs
               WHERE user_id = ? AND source_id = ? AND idempotency_key = ?""",
            [user_id, source_id, idempotency_key],
        ).fetchone()
        if existing:
            if existing["scope_hash"] != scope_hash or int(existing["consent_version"]) != consent_version:
                raise ExtensionContractError(
                    "idempotency_conflict",
                    "The sync idempotency key was already used with different parameters.",
                )
            return _canvas_sync_run_payload(existing, idempotent=True)

        generation = _canvas_current_generation(connection, user_id, source_id) + 1
        now = _canvas_now()
        lease_expires_at = _canvas_timestamp(
            datetime.fromisoformat(now[:-1] + "+00:00") + timedelta(minutes=CANVAS_LEASE_MINUTES),
            field="lease_expires_at",
        )
        lease_token = secrets.token_urlsafe(32)
        connection.execute(
            """UPDATE calendar_sync_runs
               SET state = 'superseded', error_code = 'new_generation',
                   error_message = 'A newer sync generation was started.', updated_at = ?
               WHERE user_id = ? AND source_id = ? AND state = 'active'""",
            [now, user_id, source_id],
        )
        connection.execute(
            """INSERT INTO calendar_sync_runs
               (id, user_id, source_id, run_id, generation, lease_token,
                lease_expires_at, lease_renewed_at, scope_json, scope_hash,
                consent_version, checkpoint_json, cursor, counters_json, state,
                started_at, updated_at, idempotency_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'active', ?, ?, ?)""",
            [
                uuid.uuid4().hex,
                user_id,
                source_id,
                run_id,
                generation,
                lease_token,
                lease_expires_at,
                now,
                scope_json,
                scope_hash,
                consent_version,
                _canvas_json({"accepted": 0, "updated": 0, "unchanged": 0, "quarantined": 0}, field="counters"),
                now,
                now,
                idempotency_key,
            ],
        )
        _canvas_update_source_after_run(connection, source, state="active", now=now)
        created = _canvas_run_row(connection, user_id, source_id, run_id)
    return _canvas_sync_run_payload(created)


def get_canvas_sync_run(user_id, source_id, run_id=None, *, generation=None):
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    generation = _canvas_generation(generation, required=False)
    with calendar_connection() as connection:
        _require_canvas_source(connection, user_id, source_id, include_archived=True)
        if run_id is not None:
            run_id = _canvas_id(run_id, field="run_id", pattern=CANVAS_RUN_ID_PATTERN)
            row = _canvas_run_row(connection, user_id, source_id, run_id)
        elif generation is not None:
            row = connection.execute(
                "SELECT * FROM calendar_sync_runs WHERE user_id = ? AND source_id = ? AND generation = ?",
                [user_id, source_id, generation],
            ).fetchone()
        else:
            row = connection.execute(
                """SELECT * FROM calendar_sync_runs
                   WHERE user_id = ? AND source_id = ?
                   ORDER BY generation DESC LIMIT 1""",
                [user_id, source_id],
            ).fetchone()
    return _canvas_sync_run_payload(row)


def renew_canvas_sync_run(user_id, source_id, run_id, *, generation=None, lease_token=None):
    """Renew only an active lease held by the source's current generation."""
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id)
        row = _require_current_active_run(
            connection,
            user_id,
            source_id,
            run_id,
            generation=generation,
            lease_token=lease_token,
        )
        now = _canvas_now()
        lease_expires_at = _canvas_timestamp(
            datetime.fromisoformat(now[:-1] + "+00:00") + timedelta(minutes=CANVAS_LEASE_MINUTES),
            field="lease_expires_at",
        )
        connection.execute(
            """UPDATE calendar_sync_runs
               SET lease_expires_at = ?, lease_renewed_at = ?, updated_at = ?
               WHERE id = ? AND generation = ? AND state = 'active'""",
            [lease_expires_at, now, now, row["id"], row["generation"]],
        )
        renewed = connection.execute("SELECT * FROM calendar_sync_runs WHERE id = ?", [row["id"]]).fetchone()
        _canvas_update_source_after_run(connection, source, state="active", now=now)
    return _canvas_sync_run_payload(renewed)


def resume_canvas_sync_run(user_id, source_id, run_id, *, generation=None, lease_token=None):
    """Resume the current generation after an expired lease with a fresh lease."""
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id)
        run_id = _canvas_id(run_id, field="run_id", pattern=CANVAS_RUN_ID_PATTERN)
        row = _canvas_run_row(connection, user_id, source_id, run_id)
        if not row:
            raise ExtensionContractError("run_not_found", "Canvas sync run was not found.")
        expected_generation = _canvas_generation(generation, required=False)
        if row["generation"] != _canvas_current_generation(connection, user_id, source_id) or (
            expected_generation is not None and row["generation"] != expected_generation
        ):
            raise ExtensionContractError("stale_run", "Only the current Canvas sync generation may resume.")
        if lease_token is not None and row["lease_token"] != lease_token:
            raise ExtensionContractError("lease_token_mismatch", "The Canvas sync lease token is invalid.")
        if row["state"] not in {"active", "expired"}:
            raise ExtensionContractError("run_not_resumable", "The Canvas sync run is not resumable.")
        now = _canvas_now()
        next_token = row["lease_token"] if row["state"] == "active" else secrets.token_urlsafe(32)
        lease_expires_at = _canvas_timestamp(
            datetime.fromisoformat(now[:-1] + "+00:00") + timedelta(minutes=CANVAS_LEASE_MINUTES),
            field="lease_expires_at",
        )
        connection.execute(
            """UPDATE calendar_sync_runs
               SET state = 'active', lease_token = ?, lease_expires_at = ?,
                   lease_renewed_at = ?, updated_at = ?, error_code = NULL,
                   error_message = NULL, completed_at = NULL
               WHERE id = ?""",
            [next_token, lease_expires_at, now, now, row["id"]],
        )
        resumed = connection.execute("SELECT * FROM calendar_sync_runs WHERE id = ?", [row["id"]]).fetchone()
        _canvas_update_source_after_run(connection, source, state="active", now=now)
    return _canvas_sync_run_payload(resumed)


def cancel_canvas_sync_run(user_id, source_id, run_id, *, generation=None, lease_token=None, reason=None):
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    reason = _canvas_text(reason or "Cancelled by the caller.", field="reason", max_length=500, required=True)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id, include_archived=True)
        row = _canvas_run_row(connection, user_id, source_id, run_id)
        if not row:
            raise ExtensionContractError("run_not_found", "Canvas sync run was not found.")
        expected_generation = _canvas_generation(generation, required=False)
        if row["generation"] != _canvas_current_generation(connection, user_id, source_id) or (
            expected_generation is not None and row["generation"] != expected_generation
        ):
            raise ExtensionContractError("stale_run", "Only the current Canvas sync generation may be cancelled.")
        if lease_token is not None and row["lease_token"] != lease_token:
            raise ExtensionContractError("lease_token_mismatch", "The Canvas sync lease token is invalid.")
        if row["state"] == "cancelled":
            return _canvas_sync_run_payload(row, idempotent=True)
        if row["state"] != "active":
            raise ExtensionContractError("run_not_active", "Only an active Canvas sync run may be cancelled.")
        now = _canvas_now()
        connection.execute(
            """UPDATE calendar_sync_runs
               SET state = 'cancelled', error_code = 'cancelled', error_message = ?,
                   cancelled_at = ?, updated_at = ?, completed_at = ?
               WHERE id = ? AND state = 'active'""",
            [reason, now, now, now, row["id"]],
        )
        cancelled = connection.execute("SELECT * FROM calendar_sync_runs WHERE id = ?", [row["id"]]).fetchone()
        if source["status"] != "archived":
            _canvas_update_source_after_run(connection, source, state="cancelled", now=now)
    return _canvas_sync_run_payload(cancelled)


def _canvas_finalize_status(value):
    normalized = str(value or "complete").strip().lower().replace("-", "_")
    if normalized in {"completed", "complete", "done"}:
        return "complete"
    if normalized in {"partial", "incomplete"}:
        return "partial"
    raise ExtensionContractError("invalid_run_status", "A sync run may finalize only as complete or partial.")


def finalize_canvas_sync_run(
    user_id,
    source_id,
    run_id,
    *,
    scope=None,
    generation=None,
    lease_token=None,
    status="complete",
    complete=None,
):
    """Close the current run; only an exact complete scope may tombstone."""
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    run_id = _canvas_id(run_id, field="run_id", pattern=CANVAS_RUN_ID_PATTERN)
    if complete is not None:
        if not isinstance(complete, bool):
            raise ExtensionContractError("invalid_run_status", "complete must be a boolean.")
        status = "complete" if complete else "partial"
    status = _canvas_finalize_status(status)
    normalized_scope, scope_json, scope_hash = _normalize_canvas_scope(scope)
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_id)
        run = _require_current_active_run(
            connection,
            user_id,
            source_id,
            run_id,
            generation=generation,
            lease_token=lease_token,
        )
        if run["scope_hash"] != scope_hash or run["scope_json"] != scope_json:
            raise ExtensionContractError(
                "scope_mismatch",
                "Finalization scope must exactly match the normalized begin scope.",
            )
        now = _canvas_now()
        tombstoned = 0
        if status == "complete":
            rows = connection.execute(
                """SELECT * FROM calendar_cache
                   WHERE user_id = ? AND canvas_source_id = ? AND canvas_account_key = ?""",
                [user_id, source_id, source["account_key"]],
            ).fetchall()
            for cache_row in rows:
                if not _canvas_scope_matches(cache_row, normalized_scope):
                    continue
                if (
                    cache_row["canvas_last_seen_generation"] == run["generation"]
                    and cache_row["canvas_last_seen_scope_hash"] == run["scope_hash"]
                ):
                    continue
                connection.execute(
                    """UPDATE calendar_cache
                       SET canvas_soft_deleted = 1, canvas_deleted_at = ?, canvas_last_seen_at = ?
                       WHERE id = ? AND canvas_soft_deleted = 0""",
                    [now, now, cache_row["id"]],
                )
                tombstoned += connection.execute("SELECT changes() AS count").fetchone()["count"]

        error_code = "partial" if status == "partial" else None
        error_message = "The sync completed without a full snapshot." if status == "partial" else None
        connection.execute(
            """UPDATE calendar_sync_runs
               SET state = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
               WHERE id = ? AND state = 'active'""",
            [status, error_code, error_message, now, now, run["id"]],
        )
        _canvas_update_source_after_run(
            connection,
            source,
            state=status,
            now=now,
            error_code=error_code,
            error_message=error_message,
        )
        completed = connection.execute("SELECT * FROM calendar_sync_runs WHERE id = ?", [run["id"]]).fetchone()
    return _canvas_sync_run_payload(completed, tombstoned=tombstoned)
