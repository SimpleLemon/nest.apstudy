"""Atomic Canvas batch ingestion, duplicate detection, and cache reconciliation."""

from collections.abc import Mapping
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError
import uuid
from services.calendar_constants import (
    CANVAS_BATCH_BYTES_LIMIT,
    CANVAS_BATCH_ITEM_LIMIT,
    CANVAS_READ_SCOPES,
    CANVAS_RUN_ID_PATTERN,
)
from services.canvas_domain import (
    _canvas_batch_payload,
    _canvas_completion,
    _canvas_completion_source,
    _canvas_decode_json,
    _canvas_generation,
    _canvas_hash,
    _canvas_id,
    _canvas_idempotency_key,
    _canvas_item_type,
    _canvas_json,
    _canvas_now,
    _canvas_reject_credentials,
    _canvas_source_item_key,
    _canvas_text,
    _canvas_timestamp,
    _canvas_user_id,
    canvas_event_ref_for_item,
)
from services.canvas_sources import (
    _canvas_source_consent,
    _require_canvas_source,
)
from services.canvas_sync_runs import (
    _require_current_active_run,
)


def _canvas_item_value(item, *keys, default=None):
    for key in keys:
        if key in item:
            return item[key]
    return default


def _canvas_bool(value, *, field, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, int) and value in {0, 1}:
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    raise ExtensionContractError(f"invalid_{field}", f"{field} must be a boolean.")


def _normalize_canvas_item(item, *, source_id, account_key):
    if not isinstance(item, Mapping):
        raise ExtensionContractError("item_quarantined", "Canvas item must be a JSON object.")
    _canvas_reject_credentials(item)
    context_id = _canvas_id(
        _canvas_item_value(item, "context_id", "contextId", "context"),
        field="context_id",
    )
    calendar_id = _canvas_id(
        _canvas_item_value(item, "calendar_id", "calendarId", "calendar"),
        field="calendar_id",
    )
    item_type = _canvas_item_type(_canvas_item_value(item, "item_type", "itemType", "type"))
    item_id = _canvas_id(
        _canvas_item_value(item, "item_id", "itemId", "id"),
        field="item_id",
    )
    occurrence_id = _canvas_id(
        _canvas_item_value(item, "occurrence_id", "occurrenceId"),
        field="occurrence_id",
        required=False,
    )
    is_all_day = _canvas_bool(
        _canvas_item_value(item, "is_all_day", "all_day", "allDay"),
        field="is_all_day",
        default=False,
    )
    start = _canvas_timestamp(
        _canvas_item_value(item, "start", "start_at", "startAt", "event_start", "due_at", "dueAt"),
        field="start",
    )
    end = _canvas_timestamp(
        _canvas_item_value(item, "end", "end_at", "endAt", "event_end"),
        field="end",
        required=False,
    ) or start
    if end < start:
        raise ExtensionContractError("item_quarantined", "Canvas item end must not be before its start.")

    title = _canvas_text(
        _canvas_item_value(item, "title", "summary", "name", default=item_type),
        field="title",
        max_length=500,
        required=True,
    )
    description = _canvas_text(
        _canvas_item_value(item, "description", "raw_description", default=""),
        field="description",
        max_length=64 * 1024,
    )
    completion_status = _canvas_completion(
        _canvas_item_value(item, "completion_status", "completionStatus", default="incomplete")
    )
    completion_source = _canvas_completion_source(
        _canvas_item_value(item, "completion_source", "completionSource", default="canvas")
    )
    source_revision = _canvas_id(
        _canvas_item_value(item, "source_revision", "sourceRevision", "revision"),
        field="source_revision",
        required=False,
    )
    source_hash = _canvas_id(
        _canvas_item_value(item, "source_hash", "sourceHash", "content_hash", "contentHash"),
        field="source_hash",
        required=False,
    )
    course_name = _canvas_text(
        _canvas_item_value(item, "course_name", "courseName", "context_name", "contextName", default=""),
        field="course_name",
        max_length=255,
    )
    event_ref = canvas_event_ref_for_item(
        source_id,
        account_key,
        context_id,
        calendar_id,
        item_type,
        item_id,
        occurrence_id,
    )
    source_item_key = _canvas_source_item_key(
        source_id,
        account_key,
        context_id,
        calendar_id,
        item_type,
        item_id,
        occurrence_id,
    )
    normalized = {
        "context_id": context_id,
        "calendar_id": calendar_id,
        "item_type": item_type,
        "item_id": item_id,
        "occurrence_id": occurrence_id,
        "event_ref": event_ref,
        "source_item_key": source_item_key,
        "title": title,
        "description": description,
        "start": start,
        "end": end,
        "is_all_day": is_all_day,
        "course_name": course_name,
        "source_revision": source_revision,
        "source_hash": source_hash,
        "completion_status": completion_status,
        "completion_source": completion_source,
    }
    if not source_hash:
        source_hash = _canvas_hash(_canvas_json(normalized, field="item"))
        normalized["source_hash"] = source_hash
    return normalized


_CANVAS_CACHE_OWNED_FIELDS = (
    "event_title", "event_start", "event_end", "is_all_day", "event_type",
    "course_name", "raw_description", "canvas_source_revision", "canvas_source_hash",
    "canvas_completion_status", "canvas_completion_source",
)


def _canvas_cache_row(connection, user_id, source_id, account_key, item):
    occurrence_clause = "canvas_occurrence_id IS NULL" if item["occurrence_id"] is None else "canvas_occurrence_id = ?"
    params = [
        user_id,
        source_id,
        account_key,
        item["context_id"],
        item["calendar_id"],
        item["item_type"],
        item["item_id"],
    ]
    if item["occurrence_id"] is not None:
        params.append(item["occurrence_id"])
    return connection.execute(
        f"""SELECT * FROM calendar_cache
            WHERE user_id = ? AND canvas_source_id = ? AND canvas_account_key = ?
              AND canvas_context_id = ? AND canvas_calendar_id = ?
              AND canvas_item_type = ? AND canvas_item_id = ?
              AND {occurrence_clause}""",
        params,
    ).fetchone()


def _canvas_cache_values(source_id, account_key, item, now, generation, scope_hash):
    return {
        "canvas_source_id": source_id,
        "canvas_account_key": account_key,
        "canvas_source_item_key": item["source_item_key"],
        "canvas_event_ref": item["event_ref"],
        "canvas_context_id": item["context_id"],
        "canvas_calendar_id": item["calendar_id"],
        "canvas_item_id": item["item_id"],
        "canvas_occurrence_id": item["occurrence_id"],
        "canvas_item_type": item["item_type"],
        "canvas_source_revision": item["source_revision"],
        "canvas_source_hash": item["source_hash"],
        "canvas_completion_status": item["completion_status"],
        "canvas_completion_source": item["completion_source"],
        "canvas_last_seen_at": now,
        "canvas_last_seen_generation": generation,
        "canvas_last_seen_scope_hash": scope_hash,
        "event_uid": item["source_item_key"],
        "event_title": item["title"],
        "event_start": item["start"],
        "event_end": item["end"],
        "is_all_day": item["is_all_day"],
        "event_type": item["item_type"],
        "course_name": item["course_name"],
        "raw_description": item["description"],
        "fetched_at": now,
        "canvas_soft_deleted": 0,
        "canvas_deleted_at": None,
    }


def _canvas_cache_is_changed(row, values):
    if row["canvas_soft_deleted"]:
        return True
    for field in _CANVAS_CACHE_OWNED_FIELDS:
        if row[field] != values[field]:
            return True
    return False


def _canvas_insert_cache(connection, user_id, values):
    data = {
        "id": uuid.uuid4().hex,
        "user_id": user_id,
        "feed_url": None,
        "feed_url_hash": None,
        **values,
    }
    columns = list(data)
    placeholders = ", ".join("?" for _ in columns)
    connection.execute(
        f"INSERT INTO calendar_cache ({', '.join(columns)}) VALUES ({placeholders})",
        [data[column] for column in columns],
    )
    return connection.execute("SELECT * FROM calendar_cache WHERE id = ?", [data["id"]]).fetchone()


def _canvas_update_cache(connection, row, values):
    mutable = dict(values)
    assignments = ", ".join(f"{field} = ?" for field in mutable)
    connection.execute(
        f"UPDATE calendar_cache SET {assignments} WHERE id = ?",
        [*mutable.values(), row["id"]],
    )
    return connection.execute("SELECT * FROM calendar_cache WHERE id = ?", [row["id"]]).fetchone()


def _canvas_parse_batch_request(items, *, generation, lease_token, idempotency_key, checkpoint, payload):
    if payload is not None:
        if not isinstance(payload, Mapping):
            raise ExtensionContractError("invalid_json", "Sync batch payload must be a JSON object.")
        if items is None:
            items = payload.get("items")
        if generation is None:
            generation = payload.get("generation")
        if lease_token is None:
            lease_token = payload.get("lease_token", payload.get("leaseToken"))
        if idempotency_key is None:
            idempotency_key = payload.get("idempotency_key", payload.get("idempotencyKey"))
        if checkpoint is None:
            checkpoint = payload.get("checkpoint")
    if not isinstance(items, list):
        raise ExtensionContractError("invalid_items", "items must be an array.")
    if len(items) > CANVAS_BATCH_ITEM_LIMIT:
        raise ExtensionContractError("batch_too_large", "A Canvas batch may contain at most 100 items.")
    _canvas_reject_credentials(items)
    items_json = _canvas_json(items, field="items", max_bytes=CANVAS_BATCH_BYTES_LIMIT)
    idempotency_key = _canvas_idempotency_key(idempotency_key, field="batch_idempotency_key")
    generation = _canvas_generation(generation, required=False)
    checkpoint_json = None
    if checkpoint is not None:
        _canvas_reject_credentials(checkpoint)
        checkpoint_json = _canvas_json(checkpoint, field="checkpoint", max_bytes=64 * 1024)
    return items, items_json, generation, lease_token, idempotency_key, checkpoint_json


def ingest_canvas_sync_batch(
    user_id,
    source_id,
    run_id,
    items=None,
    *,
    generation=None,
    lease_token=None,
    idempotency_key=None,
    checkpoint=None,
    payload=None,
):
    """Validate and atomically ingest one idempotent Canvas batch."""
    user_id = _canvas_user_id(user_id)
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    (
        items,
        items_json,
        generation,
        lease_token,
        idempotency_key,
        checkpoint_json,
    ) = _canvas_parse_batch_request(
        items,
        generation=generation,
        lease_token=lease_token,
        idempotency_key=idempotency_key,
        checkpoint=checkpoint,
        payload=payload,
    )
    payload_hash = _canvas_hash(items_json)
    if not isinstance(lease_token, str) or not lease_token.strip():
        raise ExtensionContractError("invalid_lease_token", "lease_token is required.")
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
        _canvas_source_consent(
            connection,
            source,
            version=run["consent_version"],
            scopes=CANVAS_READ_SCOPES,
        )
        receipt = connection.execute(
            """SELECT * FROM calendar_sync_batches
               WHERE user_id = ? AND source_id = ? AND idempotency_key = ?""",
            [user_id, source_id, idempotency_key],
        ).fetchone()
        if receipt:
            if receipt["payload_hash"] != payload_hash or receipt["run_id"] != run_id or (
                generation is not None and receipt["generation"] != generation
            ):
                raise ExtensionContractError(
                    "idempotency_conflict",
                    "The batch idempotency key was already used with different parameters.",
                )
            return _canvas_batch_payload(receipt, idempotent=True)

        scope = _canvas_decode_json(run["scope_json"], {})
        counters = _canvas_decode_json(run["counters_json"], {})
        counters = {
            "accepted": int(counters.get("accepted", 0)),
            "updated": int(counters.get("updated", 0)),
            "unchanged": int(counters.get("unchanged", 0)),
            "quarantined": int(counters.get("quarantined", 0)),
        }
        batch_counts = {key: 0 for key in counters}
        now = _canvas_now()
        accepted_items = []
        for raw_item in items:
            try:
                item = _normalize_canvas_item(
                    raw_item,
                    source_id=source_id,
                    account_key=source["account_key"],
                )
            except ExtensionContractError as exc:
                if exc.code == "credentials_not_allowed":
                    raise
                batch_counts["quarantined"] += 1
                continue
            values = _canvas_cache_values(
                source_id,
                source["account_key"],
                item,
                now,
                run["generation"],
                run["scope_hash"],
            )
            existing = _canvas_cache_row(
                connection,
                user_id,
                source_id,
                source["account_key"],
                item,
            )
            if existing is None:
                _canvas_insert_cache(connection, user_id, values)
                batch_counts["accepted"] += 1
            else:
                changed = _canvas_cache_is_changed(existing, values)
                _canvas_update_cache(connection, existing, values)
                batch_counts["updated" if changed else "unchanged"] += 1
                batch_counts["accepted"] += 1
            accepted_items.append(item["event_ref"])

        for key, value in batch_counts.items():
            counters[key] += value
        result = {
            **batch_counts,
            "accepted_event_refs": accepted_items,
            "batch_size": len(items),
            "payload_hash": payload_hash,
        }
        connection.execute(
            """INSERT INTO calendar_sync_batches
               (id, user_id, source_id, run_id, generation, idempotency_key,
                payload_hash, checkpoint_json, result_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                uuid.uuid4().hex,
                user_id,
                source_id,
                run_id,
                run["generation"],
                idempotency_key,
                payload_hash,
                checkpoint_json,
                _canvas_json(result, field="batch_result"),
                now,
            ],
        )
        checkpoint_value = _canvas_decode_json(checkpoint_json, None)
        if checkpoint_json is None:
            checkpoint_json = run["checkpoint_json"]
            checkpoint_value = _canvas_decode_json(checkpoint_json, None)
        cursor = checkpoint_value.get("cursor") if isinstance(checkpoint_value, dict) else None
        connection.execute(
            """UPDATE calendar_sync_runs
               SET counters_json = ?, checkpoint_json = ?, cursor = ?, updated_at = ?
               WHERE id = ? AND state = 'active'""",
            [
                _canvas_json(counters, field="counters"),
                checkpoint_json,
                cursor,
                now,
                run["id"],
            ],
        )
        receipt = connection.execute(
            """SELECT * FROM calendar_sync_batches
               WHERE user_id = ? AND source_id = ? AND idempotency_key = ?""",
            [user_id, source_id, idempotency_key],
        ).fetchone()
    return _canvas_batch_payload(receipt)
