"""Canvas account source registration, read/write consent, and archival cleanup."""

from services.calendar_store import calendar_connection
from services.extension_contract import (
    CANVAS_LEGACY_SOURCE_KEY,
    ExtensionContractError,
    canonical_canvas_source_key,
    validate_account_key,
    validate_version,
)
import json
import uuid
from services.calendar_constants import (
    CANVAS_PROVIDER,
    CANVAS_READ_SCOPES,
    CANVAS_RUN_ID_PATTERN,
)
from services.canvas_domain import (
    _canvas_id,
    _canvas_now,
    _canvas_reject_credentials,
    _canvas_source_ref,
    _canvas_source_reference,
    _canvas_text,
    _canvas_user_id,
    normalize_canvas_origin,
)


def _canvas_source_row(connection, user_id, source_reference, *, include_archived=False):
    reference_kind, reference_value = _canvas_source_reference(source_reference)
    status_clause = "" if include_archived else " AND status != 'archived'"
    column = "id" if reference_kind == "row_id" else "source_id"
    query = (
        f"SELECT * FROM calendar_import_sources WHERE user_id = ? AND {column} = ?{status_clause}"
    )
    row = connection.execute(query, [_canvas_user_id(user_id), reference_value]).fetchone()
    return dict(row) if row else None


def _canvas_source_internal_payload(row):
    return dict(row) if row else None


def _canvas_source_payload(row):
    if not row:
        return None
    return {
        "id": row["id"],
        "source_ref": _canvas_source_ref(row),
        # Keep the legacy source_id for clients released before source_ref.
        # It is never used as the account binding; all lookups remain user-scoped.
        "source_id": row["source_id"],
        "provider": row["provider"],
        "label": row["label"],
        "status": row["status"],
        "default_mirror_calendar": row["default_mirror_calendar"],
        "sync_state": row["sync_state"],
        "last_sync_started_at": row["last_sync_started_at"],
        "last_sync_completed_at": row["last_sync_completed_at"],
        "last_seen_at": row["last_seen_at"],
        "last_error_code": row["last_error_code"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "archived_at": row["archived_at"],
    }


def _canvas_routing_payload(row, source=None, *, idempotent=False):
    if not row:
        return None
    payload = {
        "id": row["id"],
        "source_id": row["source_id"],
        "source_ref": _canvas_source_ref(source) if source else None,
        "state": row["state"],
        "destination_calendar_id": row["destination_calendar_id"],
        "fallback_calendar_id": row["fallback_calendar_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    if idempotent:
        payload["idempotent"] = True
    return payload


def _canvas_consent_from_connection(connection, user_id, account_key, required_scopes=(), version=None):
    user_id = _canvas_user_id(user_id)
    account_key = validate_account_key(account_key)
    if version is not None:
        validate_version(version)
    canonical_key = canonical_canvas_source_key(account_key)
    params = [user_id, canonical_key, account_key]
    version_clause = ""
    if version is not None:
        version_clause = " AND version = ?"
        params.append(int(version))
    rows = connection.execute(
        "SELECT * FROM calendar_integration_consents "
        f"WHERE nest_user_id = ? AND source_key = ? AND account_key = ?{version_clause} "
        "ORDER BY version ASC",
        params,
    ).fetchall()
    # One-release compatibility for rows created by the old global-looking
    # source key.  The account predicate remains mandatory, and a canonical
    # row (including a revoked one) always wins so revocation cannot be
    # bypassed through the legacy fallback.
    if not rows:
        legacy_params = [user_id, CANVAS_LEGACY_SOURCE_KEY, account_key]
        if version is not None:
            legacy_params.append(int(version))
        rows = connection.execute(
            "SELECT * FROM calendar_integration_consents "
            f"WHERE nest_user_id = ? AND source_key = ? AND account_key = ?{version_clause} "
            "ORDER BY version ASC",
            legacy_params,
        ).fetchall()
    row = None
    for candidate in rows:
        if candidate["state"] != "active":
            continue
        try:
            candidate_scopes = json.loads(candidate["scopes_json"] or "{}")
        except (TypeError, json.JSONDecodeError) as exc:
            raise ExtensionContractError("consent_unavailable", "Stored Canvas consent is invalid.") from exc
        if not isinstance(candidate_scopes, dict):
            raise ExtensionContractError("consent_unavailable", "Stored Canvas consent is invalid.")
        if all(bool(candidate_scopes.get(scope)) for scope in required_scopes):
            row = candidate
            scopes = candidate_scopes
            break
    if not row or row["state"] != "active":
        raise ExtensionContractError("consent_required", "Active Canvas consent is required.")
    if version is not None and int(row["version"]) != int(version):
        raise ExtensionContractError("consent_version_mismatch", "Consent version is no longer current.")
    missing = [scope for scope in required_scopes if not bool(scopes.get(scope))]
    if missing:
        raise ExtensionContractError(
            "scope_required",
            "Required Canvas consent scope is not granted.",
        )
    return dict(row)


def canvas_consent_status(user_id, account_key, required_scopes=(), version=None):
    with calendar_connection() as connection:
        row = _canvas_consent_from_connection(
            connection,
            user_id,
            account_key,
            required_scopes,
            version,
        )
    return row


def register_canvas_import_source(user_id, payload):
    """Register an extension-owned Canvas account without accepting credentials."""
    _canvas_reject_credentials(payload)
    if not isinstance(payload, dict):
        raise ExtensionContractError("invalid_json", "Request body must be a JSON object.")
    user_id = _canvas_user_id(user_id)
    account_key = validate_account_key(payload.get("account_key"))
    consent_version = payload.get("consent_version", payload.get("version"))
    if consent_version is not None:
        validate_version(consent_version)
    source_id = _canvas_id(payload.get("source_id"), field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    origin = normalize_canvas_origin(payload.get("origin"))
    provider_user_id = _canvas_text(
        payload.get("provider_user_id", payload.get("canvas_user_id")),
        field="provider_user_id",
        max_length=255,
        required=True,
    )
    label = _canvas_text(payload.get("label") or "Canvas", field="label", max_length=120, required=True)
    default_calendar = payload.get(
        "default_mirror_calendar",
        payload.get("default_calendar_id", payload.get("defaultMirrorCalendar")),
    )
    default_calendar = _canvas_id(
        default_calendar,
        field="default_mirror_calendar",
        required=False,
    )
    now = _canvas_now()

    with calendar_connection() as connection:
        _canvas_consent_from_connection(
            connection,
            user_id,
            account_key,
            CANVAS_READ_SCOPES,
            consent_version,
        )
        by_account = connection.execute(
            "SELECT * FROM calendar_import_sources "
            "WHERE user_id = ? AND provider = 'canvas' AND account_key = ?",
            [user_id, account_key],
        ).fetchone()
        by_source = connection.execute(
            "SELECT * FROM calendar_import_sources WHERE user_id = ? AND source_id = ?",
            [user_id, source_id],
        ).fetchone()
        if by_account and by_account["source_id"] != source_id:
            raise ExtensionContractError(
                "source_account_conflict",
                "This Canvas account is already registered under another source_id.",
            )
        if by_source and by_source["account_key"] != account_key:
            raise ExtensionContractError(
                "source_id_conflict",
                "This source_id belongs to another Canvas account.",
            )

        if by_account and (by_account["origin"] != origin or by_account["provider_user_id"] != provider_user_id):
            raise ExtensionContractError("source_account_mismatch", "An existing Canvas account cannot change its provider identity.")

        if by_account:
            connection.execute(
                """UPDATE calendar_import_sources
                   SET nest_user_id = ?, origin = ?, provider_user_id = ?, label = ?,
                       status = 'active', default_mirror_calendar = ?, archived_at = NULL,
                       updated_at = ?, last_error_code = NULL, last_error_message = NULL
                   WHERE id = ?""",
                [user_id, origin, provider_user_id, label, default_calendar, now, by_account["id"]],
            )
            row_id = by_account["id"]
        else:
            row_id = uuid.uuid4().hex
            connection.execute(
                """INSERT INTO calendar_import_sources
                   (id, user_id, nest_user_id, provider, origin, provider_user_id,
                    account_key, source_id, label, status, default_mirror_calendar,
                    sync_state, created_at, updated_at)
                   VALUES (?, ?, ?, 'canvas', ?, ?, ?, ?, ?, 'active', ?, 'idle', ?, ?)""",
                [
                    row_id,
                    user_id,
                    user_id,
                    origin,
                    provider_user_id,
                    account_key,
                    source_id,
                    label,
                    default_calendar,
                    now,
                    now,
                ],
            )
        row = connection.execute(
            "SELECT * FROM calendar_import_sources WHERE id = ?", [row_id]
        ).fetchone()
    return _canvas_source_payload(row)


def list_canvas_import_sources(user_id, *, include_archived=True):
    user_id = _canvas_user_id(user_id)
    query = (
        "SELECT * FROM calendar_import_sources WHERE user_id = ? ORDER BY created_at ASC"
        if include_archived
        else "SELECT * FROM calendar_import_sources WHERE user_id = ? AND status != 'archived' ORDER BY created_at ASC"
    )
    with calendar_connection() as connection:
        rows = connection.execute(query, [user_id]).fetchall()
    return [_canvas_source_payload(dict(row)) for row in rows]


def get_canvas_import_source(user_id, source_id, *, include_archived=True):
    with calendar_connection() as connection:
        row = _canvas_source_row(connection, user_id, source_id, include_archived=include_archived)
    return _canvas_source_payload(row)


def get_canvas_import_source_context(user_id, source_reference, *, include_archived=True):
    """Load a source's private account context for server-side checks only."""
    with calendar_connection() as connection:
        row = _canvas_source_row(
            connection,
            user_id,
            source_reference,
            include_archived=include_archived,
        )
    return _canvas_source_internal_payload(row)


def _archive_canvas_source_in_connection(connection, user_id, source_id, *, now=None, reason="source_archived"):
    now = now or _canvas_now()
    source = _canvas_source_row(connection, user_id, source_id, include_archived=True)
    if not source:
        return {"source": None, "events_archived": 0, "runs_cancelled": 0, "writebacks_cancelled": 0}
    connection.execute(
        """UPDATE calendar_import_sources
           SET status = 'archived', sync_state = 'idle', archived_at = ?, updated_at = ?
           WHERE user_id = ? AND source_id = ?""",
        [now, now, user_id, source_id],
    )
    cache_result = connection.execute(
        """UPDATE calendar_cache
           SET canvas_soft_deleted = 1, canvas_deleted_at = ?, canvas_last_seen_at = ?
           WHERE user_id = ? AND canvas_source_id = ? AND canvas_soft_deleted = 0""",
        [now, now, user_id, source_id],
    )
    run_result = connection.execute(
        """UPDATE calendar_sync_runs
           SET state = 'cancelled', error_code = ?, error_message = ?,
               cancelled_at = ?, updated_at = ?
           WHERE user_id = ? AND source_id = ? AND state = 'active'""",
        [reason, "Canvas source is no longer active.", now, now, user_id, source_id],
    )
    writeback_result = connection.execute(
        """UPDATE calendar_writebacks
           SET state = 'cancelled', error_code = ?, error_message = ?,
               cancelled_at = ?, updated_at = ?
           WHERE user_id = ? AND source_id = ?
             AND state IN ('waiting_for_canvas_session', 'queued', 'retryable_failed')""",
        [reason, "Canvas source is no longer active.", now, now, user_id, source_id],
    )
    connection.execute(
        """UPDATE calendar_event_links
           SET mirror_state = 'cancelled', mirror_error_code = ?,
               mirror_error_message = ?, archived_at = ?, updated_at = ?
           WHERE user_id = ? AND source_id = ? AND archived_at IS NULL""",
        [reason, "Canvas source is no longer active.", now, now, user_id, source_id],
    )
    updated = connection.execute(
        "SELECT * FROM calendar_import_sources WHERE user_id = ? AND source_id = ?",
        [user_id, source_id],
    ).fetchone()
    return {
        "source": _canvas_source_payload(dict(updated)) if updated else None,
        "events_archived": cache_result.rowcount,
        "runs_cancelled": run_result.rowcount,
        "writebacks_cancelled": writeback_result.rowcount,
    }


def revoke_canvas_consent_in_connection(connection, user_id, account_key, *, now=None):
    """Archive all active outputs for one Canvas account in the consent transaction."""
    user_id = _canvas_user_id(user_id)
    account_key = validate_account_key(account_key)
    source_rows = connection.execute(
        """SELECT source_id FROM calendar_import_sources
           WHERE user_id = ? AND provider = 'canvas' AND account_key = ?
             AND status != 'archived'""",
        [user_id, account_key],
    ).fetchall()
    result = {"sources_archived": 0, "events_archived": 0, "runs_cancelled": 0, "writebacks_cancelled": 0}
    for row in source_rows:
        archived = _archive_canvas_source_in_connection(
            connection,
            user_id,
            row["source_id"],
            now=now,
            reason="consent_revoked",
        )
        result["sources_archived"] += 1
        result["events_archived"] += archived["events_archived"]
        result["runs_cancelled"] += archived["runs_cancelled"]
        result["writebacks_cancelled"] += archived["writebacks_cancelled"]
    return result


def archive_canvas_import_source(user_id, source_id):
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    with calendar_connection() as connection:
        result = _archive_canvas_source_in_connection(connection, _canvas_user_id(user_id), source_id)
    return result


def canvas_purge_preflight(user_id, source_id):
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    user_id = _canvas_user_id(user_id)
    with calendar_connection() as connection:
        source = _canvas_source_row(connection, user_id, source_id, include_archived=True)
        if not source:
            return None
        counts = {}
        for table in (
            "calendar_cache", "calendar_sync_runs", "calendar_sync_batches",
            "calendar_import_routing", "calendar_event_links", "calendar_writebacks",
        ):
            column = "canvas_source_id" if table == "calendar_cache" else "source_id"
            counts[table] = connection.execute(
                f"SELECT COUNT(*) FROM {table} WHERE user_id = ? AND {column} = ?",
                [user_id, source_id],
            ).fetchone()[0]
    return {
        "source": _canvas_source_payload(source),
        "purge_supported": False,
        "destructive_purge_requires_phase_5": True,
        "counts": counts,
    }


def _require_canvas_source(connection, user_id, source_id, *, include_archived=False):
    user_id = _canvas_user_id(user_id)
    source = _canvas_source_row(
        connection,
        user_id,
        source_id,
        include_archived=include_archived,
    )
    if not source:
        raise ExtensionContractError("source_not_found", "Canvas import source was not found.")
    if source["provider"] != CANVAS_PROVIDER:
        raise ExtensionContractError("source_not_canvas", "The import source is not Canvas.")
    if not include_archived and source["status"] != "active":
        raise ExtensionContractError("source_inactive", "Canvas import source is not active.")
    return source


def _canvas_source_consent(connection, source, *, version=None, scopes=()):
    if version is not None:
        validate_version(version)
    consent = _canvas_consent_from_connection(
        connection,
        source["user_id"],
        source["account_key"],
        scopes,
        version,
    )
    return consent, int(consent["version"])
