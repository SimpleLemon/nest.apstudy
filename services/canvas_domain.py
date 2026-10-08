"""Canvas input validation, normalized sync scopes, identities, and result payloads."""

from collections.abc import Mapping
from datetime import datetime, timezone
from services.extension_contract import (
    EXTENSION_SOURCE_REF_PREFIX,
    ExtensionContractError,
    validate_account_key,
)
from services.time_utils import utcnow_iso
from urllib.parse import urlsplit
import hashlib
import json
import re
from services.calendar_constants import (
    CANVAS_ALLOWED_ITEM_TYPES,
    CANVAS_COMPLETION_SOURCES,
    CANVAS_COMPLETION_STATUSES,
    CANVAS_CREDENTIAL_KEYS,
    CANVAS_IDEMPOTENCY_PATTERN,
    CANVAS_REJECTED_ITEM_TYPES,
    CANVAS_RUN_ID_PATTERN,
    CANVAS_SAFE_ID_PATTERN,
    CANVAS_SCOPE_ARRAY_KEYS,
    CANVAS_SOURCE_REF_PATTERN,
)


def normalize_canvas_request(payload, aliases=()):
    """Copy one mapping request, rejecting conflicting names for the same field."""
    if not isinstance(payload, Mapping):
        raise ExtensionContractError("invalid_json", "Canvas request must be a JSON object.")
    values = dict(payload)
    for alias, canonical in aliases:
        if alias not in values:
            continue
        if canonical in values and values[canonical] != values[alias]:
            raise ExtensionContractError("conflicting_alias", f"{alias} conflicts with {canonical}.")
        values[canonical] = values.pop(alias)
    return values


def _canvas_now():
    return utcnow_iso()


def _canvas_user_id(user_id):
    normalized = str(user_id or "").strip()
    if not normalized:
        raise ExtensionContractError("invalid_user", "Authenticated user id is required.")
    return normalized


def _canvas_json(value, *, field="value", max_bytes=64 * 1024):
    try:
        encoded = json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
    except (TypeError, ValueError) as exc:
        raise ExtensionContractError("invalid_json", f"{field} must be JSON serializable.") from exc
    if len(encoded.encode("utf-8")) > max_bytes:
        raise ExtensionContractError("payload_too_large", f"{field} exceeds the allowed size.")
    return encoded


def _canvas_hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canvas_text(value, *, field, max_length, required=False):
    if not isinstance(value, str):
        value = "" if value is None else str(value)
    value = " ".join(value.strip().split()) if field not in {"description", "payload"} else value.strip()
    if required and not value:
        raise ExtensionContractError(f"invalid_{field}", f"{field} is required.")
    if len(value) > max_length:
        raise ExtensionContractError(f"invalid_{field}", f"{field} exceeds the allowed length.")
    return value


def _canvas_id(value, *, field, required=True, pattern=CANVAS_SAFE_ID_PATTERN):
    normalized = _canvas_text(value, field=field, max_length=255, required=required)
    if not normalized:
        return None
    if not pattern.fullmatch(normalized):
        raise ExtensionContractError(f"invalid_{field}", f"{field} contains unsupported characters.")
    return normalized


def _canvas_idempotency_key(value, *, field="idempotency_key"):
    return _canvas_id(value, field=field, pattern=CANVAS_IDEMPOTENCY_PATTERN)


def _canvas_reject_credentials(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).strip().lower() in CANVAS_CREDENTIAL_KEYS:
                raise ExtensionContractError(
                    "credentials_not_allowed",
                    "Canvas credentials, cookies, and tokens are not accepted by this API.",
                )
            _canvas_reject_credentials(child)
    elif isinstance(value, list):
        for child in value:
            _canvas_reject_credentials(child)


def normalize_canvas_origin(value):
    """Normalize a Canvas origin without accepting a feed path or credentials."""
    if not isinstance(value, str) or not value.strip():
        raise ExtensionContractError("invalid_origin", "origin must be an HTTPS Canvas origin.")
    raw = value.strip()
    parsed = urlsplit(raw)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise ExtensionContractError("invalid_origin", "origin must be an HTTPS Canvas origin.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ExtensionContractError("invalid_origin", "origin has an invalid port.") from exc
    if parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ExtensionContractError("invalid_origin", "origin must not include a path, query, fragment, or credentials.")
    hostname = parsed.hostname.lower().rstrip(".")
    if not hostname or ".." in hostname or any(not part for part in hostname.split(".")):
        raise ExtensionContractError("invalid_origin", "origin must contain a valid hostname.")
    normalized_port = "" if port in {None, 443} else f":{port}"
    return f"https://{hostname}{normalized_port}"


def _canvas_completion(value):
    if not isinstance(value, str):
        raise ExtensionContractError("invalid_completion_status", "completion_status is required.")
    normalized = value.strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "complete": "completed",
        "done": "completed",
        "graded": "completed",
        "excused": "completed",
        "submitted": "completed",
        "in_progress": "incomplete",
        "not_started": "incomplete",
        "unsubmitted": "incomplete",
        "missing": "incomplete",
        "late": "incomplete",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized not in CANVAS_COMPLETION_STATUSES:
        raise ExtensionContractError(
            "invalid_completion_status",
            "completion_status must normalize to incomplete or completed.",
        )
    return normalized


def _canvas_completion_source(value):
    normalized = str(value or "").strip().lower()
    if normalized == "nest":
        normalized = "extension"
    if normalized not in CANVAS_COMPLETION_SOURCES:
        raise ExtensionContractError(
            "invalid_completion_source",
            "completion_source must be canvas or extension.",
        )
    return normalized


def _canvas_item_type(value):
    normalized = str(value or "").strip().lower().replace(" ", "_")
    if normalized in CANVAS_REJECTED_ITEM_TYPES:
        raise ExtensionContractError("item_quarantined", "This Canvas item type is not importable.")
    if normalized not in CANVAS_ALLOWED_ITEM_TYPES:
        raise ExtensionContractError("item_quarantined", "Unknown Canvas item type is not importable.")
    return normalized


def _canvas_source_reference(value):
    normalized = _canvas_text(value, field="source_ref", max_length=160, required=True)
    if normalized.startswith(EXTENSION_SOURCE_REF_PREFIX):
        if not CANVAS_SOURCE_REF_PATTERN.fullmatch(normalized):
            raise ExtensionContractError("invalid_source_ref", "source_ref is invalid.")
        return "row_id", normalized[len(EXTENSION_SOURCE_REF_PREFIX):]
    return "source_id", _canvas_id(normalized, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)


def _canvas_source_ref(row):
    if not row or not row["id"]:
        return None
    row_id = _canvas_text(row["id"], field="source_ref", max_length=128, required=True)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", row_id):
        raise ExtensionContractError("invalid_source_ref", "Stored source reference is invalid.")
    return f"{EXTENSION_SOURCE_REF_PREFIX}{row_id}"


def _canvas_timestamp(value, *, field, required=True):
    """Normalize a JSON timestamp to an explicit UTC ISO value."""
    if value is None or value == "":
        if required:
            raise ExtensionContractError(f"invalid_{field}", f"{field} is required.")
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            if required:
                raise ExtensionContractError(f"invalid_{field}", f"{field} is required.")
            return None
        if candidate.endswith("Z"):
            candidate = candidate[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError as exc:
            raise ExtensionContractError(
                f"invalid_{field}", f"{field} must be an ISO-8601 date or timestamp."
            ) from exc
    else:
        raise ExtensionContractError(f"invalid_{field}", f"{field} must be a date or timestamp.")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    normalized = parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return normalized


def _canvas_generation(value, *, required=True):
    if value is None and not required:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ExtensionContractError("invalid_generation", "generation must be a positive integer.")
    return value


def _canvas_optional_id(value, *, field):
    return _canvas_id(value, field=field, required=False)


def _canvas_normalized_value(value, *, key=None):
    if isinstance(value, Mapping):
        normalized = {}
        for raw_key, child in value.items():
            if not isinstance(raw_key, str) or not raw_key.strip():
                raise ExtensionContractError("invalid_json", "JSON object keys must be non-empty strings.")
            normalized_key = raw_key.strip()
            if normalized_key in normalized:
                raise ExtensionContractError("invalid_json", "JSON object keys must be unique after normalization.")
            normalized[normalized_key] = _canvas_normalized_value(child, key=normalized_key)
        return {name: normalized[name] for name in sorted(normalized)}
    if isinstance(value, list):
        children = [_canvas_normalized_value(child, key=key) for child in value]
        if key in CANVAS_SCOPE_ARRAY_KEYS:
            deduped = []
            for child in children:
                if child not in deduped:
                    deduped.append(child)
            return sorted(deduped, key=lambda child: json.dumps(child, sort_keys=True, ensure_ascii=False))
        return children
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value.strip() if isinstance(value, str) else value
    raise ExtensionContractError("invalid_json", "Payload contains an unsupported JSON value.")


def _normalize_canvas_scope(scope):
    if scope is None:
        scope = {}
    if not isinstance(scope, Mapping):
        raise ExtensionContractError("invalid_scope", "scope must be a JSON object.")
    _canvas_reject_credentials(scope)
    normalized = _canvas_normalized_value(scope)
    aliases = {
        "contextIds": "context_ids",
        "calendarIds": "calendar_ids",
        "itemTypes": "item_types",
        "start_at": "start",
        "end_at": "end",
    }
    canonical = {}
    for key, value in normalized.items():
        canonical_key = aliases.get(key, key)
        if canonical_key in canonical and canonical[canonical_key] != value:
            raise ExtensionContractError("invalid_scope", "scope contains conflicting aliases.")
        canonical[canonical_key] = value

    for key in CANVAS_SCOPE_ARRAY_KEYS:
        if key not in canonical:
            continue
        values = canonical[key]
        if not isinstance(values, list):
            raise ExtensionContractError("invalid_scope", f"{key} must be an array.")
        if key in {"contexts", "context_ids", "calendars", "calendar_ids"}:
            canonical[key] = [
                _canvas_id(value, field=key.rstrip("s") + "_id") for value in values
            ]
        else:
            canonical[key] = [_canvas_item_type(value) for value in values]

    for key in ("start", "end"):
        if key in canonical:
            canonical[key] = _canvas_timestamp(canonical[key], field=key)
    if canonical.get("start") and canonical.get("end"):
        if canonical["start"] > canonical["end"]:
            raise ExtensionContractError("invalid_scope", "scope start must not be after scope end.")

    encoded = _canvas_json(canonical, field="scope", max_bytes=64 * 1024)
    return canonical, encoded, _canvas_hash(encoded)


def _canvas_scope_matches(row, scope):
    context_ids = set(scope.get("context_ids", [])) | set(scope.get("contexts", []))
    calendar_ids = set(scope.get("calendar_ids", [])) | set(scope.get("calendars", []))
    item_types = set(scope.get("item_types", []))
    if context_ids and row["canvas_context_id"] not in context_ids:
        return False
    if calendar_ids and row["canvas_calendar_id"] not in calendar_ids:
        return False
    if item_types and row["canvas_item_type"] not in item_types:
        return False
    event_start = row["event_start"]
    if scope.get("start") and (not event_start or event_start < scope["start"]):
        return False
    if scope.get("end") and (not event_start or event_start > scope["end"]):
        return False
    return True


def _canvas_decode_json(raw_value, default):
    try:
        decoded = json.loads(raw_value) if raw_value else default
    except (TypeError, json.JSONDecodeError):
        return default
    return decoded


def _canvas_sync_run_payload(row, *, idempotent=False, tombstoned=0):
    if not row:
        return None
    payload = dict(row)
    payload["scope"] = _canvas_decode_json(payload.pop("scope_json", None), {})
    payload["checkpoint"] = _canvas_decode_json(payload.pop("checkpoint_json", None), None)
    payload["counters"] = _canvas_decode_json(payload.pop("counters_json", None), {})
    payload["idempotent"] = bool(idempotent)
    if tombstoned:
        payload["tombstoned"] = tombstoned
    return payload


def _canvas_batch_payload(row, *, idempotent=False):
    if not row:
        return None
    result = _canvas_decode_json(row["result_json"], {})
    if not isinstance(result, dict):
        result = {}
    result.update({
        "id": row["id"],
        "run_id": row["run_id"],
        "generation": row["generation"],
        "idempotent": bool(idempotent),
        "checkpoint": _canvas_decode_json(row["checkpoint_json"], None),
    })
    return result


def _canvas_writeback_payload(row, *, idempotent=False):
    if not row:
        return None
    payload = dict(row)
    payload["payload"] = _canvas_decode_json(payload.pop("payload_json", None), {})
    payload["idempotent"] = bool(idempotent)
    return payload


def _canvas_link_payload(row, *, idempotent=False):
    if not row:
        return None
    payload = dict(row)
    payload["idempotent"] = bool(idempotent)
    return payload


def _canvas_result_error(code=None, message=None):
    """Return bounded, credential-free error fields for provider results."""
    if code is None and message is None:
        return None, None
    normalized_code = _canvas_text(
        code or "provider_error",
        field="error_code",
        max_length=80,
        required=True,
    ).lower().replace(" ", "_")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.:-]{0,79}", normalized_code):
        raise ExtensionContractError("invalid_error_code", "error_code contains unsupported characters.")
    if isinstance(message, Mapping):
        raise ExtensionContractError("invalid_error", "error_message must be text.")
    normalized_message = _canvas_text(
        message or "The Canvas operation failed.",
        field="error_message",
        max_length=500,
    )
    _canvas_reject_credentials({"message": normalized_message})
    return normalized_code, normalized_message


def _canvas_source_account(source, account_key):
    account_key = validate_account_key(account_key)
    if source["account_key"] != account_key:
        raise ExtensionContractError(
            "source_account_mismatch",
            "The Canvas account does not belong to this import source.",
        )
    return account_key


def canvas_event_ref_for_item(
    source_id,
    account_key,
    context_id,
    calendar_id,
    item_type,
    item_id,
    occurrence_id=None,
):
    """Return the stable identity used by imported Canvas calendar items.

    Feed references deliberately continue to use their historical URL/UID
    hash.  Canvas references are scoped by user-owned source and account so a
    provider item can never alias another user's or another account's item.
    """
    source_id = _canvas_id(source_id, field="source_id", pattern=CANVAS_RUN_ID_PATTERN)
    account_key = validate_account_key(account_key)
    context_id = _canvas_id(context_id, field="context_id")
    calendar_id = _canvas_id(calendar_id, field="calendar_id")
    item_type = _canvas_item_type(item_type)
    item_id = _canvas_id(item_id, field="item_id")
    occurrence_id = _canvas_id(occurrence_id, field="occurrence_id", required=False)
    identity = {
        "account_key": account_key,
        "calendar_id": calendar_id,
        "context_id": context_id,
        "item_id": item_id,
        "item_type": item_type,
        "occurrence_id": occurrence_id or "",
        "source_id": source_id,
    }
    identity_json = json.dumps(identity, separators=(",", ":"), sort_keys=True)
    return f"canvas:{source_id}:{_canvas_hash(identity_json)}"


def _canvas_source_item_key(
    source_id,
    account_key,
    context_id,
    calendar_id,
    item_type,
    item_id,
    occurrence_id=None,
):
    """Return a compact stable source-item key for cache provenance."""
    return canvas_event_ref_for_item(
        source_id,
        account_key,
        context_id,
        calendar_id,
        item_type,
        item_id,
        occurrence_id,
    ).removeprefix("canvas:")
