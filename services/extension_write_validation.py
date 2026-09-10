"""Validate personal Canvas write data before it enters the durable queue."""
import re
from datetime import date, datetime
from services.extension_contract import ExtensionContractError

PERSONAL_REF = re.compile(r"(user|task):[A-Za-z0-9._-]{1,150}\Z")
CANVAS_ID = re.compile(r"[1-9][0-9]{0,19}\Z")
PERSONAL_CONTEXT = re.compile(r"user_[1-9][0-9]{0,19}\Z")
EVENT_FIELDS = {"title", "description", "start_at", "end_at", "all_day", "location_name", "location_address"}
TASK_FIELDS = {"title", "details", "todo_date"}


def personal_kind(event_ref):
    match = PERSONAL_REF.fullmatch(event_ref) if isinstance(event_ref, str) else None
    if not match:
        raise ExtensionContractError("personal_item_required", "Choose a personal Nest event or planner item.")
    return match[1]


def validate_fields(event_ref, operation, fields):
    kind = personal_kind(event_ref)
    allowed = EVENT_FIELDS if kind == "user" else TASK_FIELDS
    if not isinstance(fields, dict) or set(fields) - allowed or (operation == "delete" and fields):
        raise ExtensionContractError("invalid_writeback_fields", "Write fields must contain only supported personal item fields.")
    for key, value in fields.items():
        if key == "all_day":
            if type(value) is not bool:
                raise ExtensionContractError("invalid_writeback_fields", "all_day must be a boolean.")
            continue
        if not isinstance(value, str) or len(value) > (8192 if key in {"description", "details"} else 512):
            raise ExtensionContractError("invalid_writeback_fields", "Write fields must contain bounded text values.")
        if key in {"start_at", "end_at", "todo_date"}:
            try:
                if key == "todo_date":
                    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
                        raise ValueError()
                    date.fromisoformat(value)
                else:
                    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?", value):
                        raise ValueError()
                    if len(value) > 10 and int(value[11:13]) > 23:
                        raise ValueError()
                    datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                raise ExtensionContractError("invalid_writeback_fields", "Write dates must be valid ISO dates or timestamps.") from None
        if key == "title" and not value.strip():
            raise ExtensionContractError("invalid_writeback_fields", "Add a title before writing this item.")
    if operation == "create" and (not fields.get("title") or not fields.get("start_at" if kind == "user" else "todo_date")):
        raise ExtensionContractError("invalid_writeback_fields", "New personal items require a title and date.")
    return fields


def validate_personal_identity(event_ref, identity):
    kind = personal_kind(event_ref)
    if (identity["canvas_item_type"] != ("calendar_event" if kind == "user" else "planner_note")
            or not CANVAS_ID.fullmatch(identity["canvas_item_id"] or "")
            or not PERSONAL_CONTEXT.fullmatch(identity["canvas_context_id"] or "")
            or identity["canvas_calendar_id"] != identity["canvas_context_id"]
            or identity["canvas_occurrence_id"] is not None):
        raise ExtensionContractError("personal_item_required", "Link a single personal Canvas item with matching personal calendar and context.")


def personal_calendar(source, target=None):
    """Bind a personal destination to the stored Canvas provider identity."""
    provider = source["provider_user_id"]
    if not isinstance(provider, str) or not CANVAS_ID.fullmatch(provider):
        raise ExtensionContractError("invalid_provider_identity", "Reconnect a Canvas account with a valid personal identity.")
    calendar = "user_" + provider
    if target is not None and target != calendar:
        raise ExtensionContractError("source_account_mismatch", "The personal calendar must belong to the connected Canvas account.")
    return calendar
