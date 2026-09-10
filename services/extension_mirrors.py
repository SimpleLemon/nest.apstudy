"""Explicit, reviewed per-item Canvas mirror selection. No client-authored item fields."""
import json
import re
import uuid
from datetime import date, datetime, time, timezone

from services.calendar_store import calendar_connection
from services.calendar_events import (
    _canvas_hash, _canvas_json, _canvas_now, _canvas_source_ref,
    _canvas_source_consent, _require_canvas_source,
)
from services.extension_bridge import personal_target, _unlink
from services.extension_contract import ExtensionContractError
from services.extension_write_validation import personal_calendar


def _target(connection, user_id, event_ref):
    if not isinstance(event_ref, str) or not re.fullmatch(r"(user|task):[A-Za-z0-9._-]{1,150}", event_ref):
        raise ExtensionContractError("personal_item_required", "Choose a personal event or task.")
    return personal_target(connection, user_id, event_ref)


def planner_deadline(item, date_value):
    """Apply a Canvas calendar date without discarding Nest's local due time."""
    from services.task_schedule import _local_parts
    _, due_time, zone = _local_parts(item)
    try:
        local_date = date.fromisoformat(date_value)
    except (TypeError, ValueError):
        raise ExtensionContractError("invalid_snapshot", "A valid planner date is required.") from None
    local = datetime.combine(local_date, due_time or time.min, tzinfo=zone)
    return local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _fields(table, item):
    if item.get("recurrence_json") not in (None, "", "null", "{}"):
        raise ExtensionContractError("unsupported_recurrence", "Mirror a single task without recurrence.")
    if table == "user_events":
        if item.get("recurrence_rule") or item.get("rrule"):
            raise ExtensionContractError("unsupported_recurrence", "Mirror a single event without recurrence.")
        fields = {"title": item["title"], "description": item.get("description") or "",
                  "start_at": item["start"], "end_at": item.get("end") or item["start"],
                  "all_day": bool(item.get("is_all_day"))}
    else:
        from services.task_schedule import _local_parts
        local_date, _, _ = _local_parts(item)
        deadline = local_date.isoformat() if local_date else ""
        try:
            date.fromisoformat(deadline)
        except ValueError:
            raise ExtensionContractError("task_date_required", "Add a due date before mirroring this task.")
        fields = {"title": item["title"], "todo_date": deadline}
    for key, value in fields.items():
        if key == "all_day":
            continue
        if not isinstance(value, str) or len(value) > (8192 if key == "description" else 512):
            raise ExtensionContractError("invalid_personal_item", "This item's text is too long to mirror to Canvas.")
    if not fields["title"].strip():
        raise ExtensionContractError("invalid_personal_item", "Add a title before mirroring this item.")
    from services.extension_write_validation import validate_fields
    return validate_fields("user:item" if table == "user_events" else "task:item", "create", fields)


def _view(connection, user_id, event_ref):
    table, scope, item = _target(connection, user_id, event_ref)
    sources = connection.execute("SELECT * FROM calendar_import_sources WHERE user_id=? AND provider='canvas' AND status='active' ORDER BY id", [user_id]).fetchall()
    choices = []
    for raw in sources:
        source = dict(raw)
        link = connection.execute("SELECT * FROM calendar_event_links WHERE user_id=? AND source_id=? AND event_ref=? AND archived_at IS NULL", [user_id, source["source_id"], event_ref]).fetchone()
        pending = connection.execute("SELECT * FROM calendar_writebacks WHERE user_id=? AND source_id=? AND event_ref=? AND state NOT IN ('applied','cancelled') ORDER BY created_at DESC,id DESC LIMIT 1", [user_id, source["source_id"], event_ref]).fetchone()
        allowed = True
        try:
            personal_calendar(source)
            _canvas_source_consent(connection, source, version=1, scopes=("ongoing_read",))
            _canvas_source_consent(connection, source, version=2, scopes=(scope, "selected_item_mirroring"))
        except ExtensionContractError:
            allowed = False
        choices.append({"source_ref": _canvas_source_ref(source), "label": source["label"],
                        "destination": "Personal Canvas calendar" if table == "user_events" else "Canvas planner notes",
                        "allowed": allowed, "linked": bool(link), "link_id": link["id"] if link else None,
                        "state": pending["state"] if pending else (link["mirror_state"] if link else "not_selected"),
                        "pending_id": pending["id"] if pending else None,
                        "revision": link["source_revision"] if link else None})
    token = _canvas_hash(_canvas_json({"item": item, "sources": choices}))
    return {"event_ref": event_ref, "title": item["title"], "sources": choices, "expected_revision": token}, (table, scope, item)


def inspect_item(user_id, event_ref):
    with calendar_connection() as connection:
        return _view(connection, user_id, event_ref)[0]


def _queue(connection, user_id, source, event_ref, operation, fields, revision, *, delete_hash=None):
    personal_calendar(source)
    key = uuid.uuid4().hex
    values = {"operation": operation, "event_ref": event_ref, "idempotency_key": key,
              "target_account": source["account_key"], "payload": fields,
              "expected_revision": revision}
    if delete_hash:
        values["mirror_delete_nest_hash"] = delete_hash
    encoded = _canvas_json(values)
    now = _canvas_now()
    connection.execute("""INSERT INTO calendar_writebacks
        (id,user_id,source_id,account_key,operation,event_ref,expected_revision,payload_hash,
         idempotency_key,target_account,payload_json,state,retry_count,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',0,?,?)""",
        [key,user_id,source["source_id"],source["account_key"],operation,event_ref,revision,
         _canvas_hash(encoded),key,source["account_key"],encoded,now,now])
    return key


def change_item(user_id, payload):
    if not isinstance(payload, dict) or set(payload) - {"event_ref", "source_ref", "action", "expected_revision"}:
        raise ExtensionContractError("invalid_mirror_request", "Mirror request contains unsupported fields.")
    event_ref, action = payload.get("event_ref"), payload.get("action")
    if action not in {"mirror", "unlink", "delete_local", "delete_both"}:
        raise ExtensionContractError("invalid_mirror_action", "Choose mirror, unlink, or a deletion option.")
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        view, (table, scope, item) = _view(connection, user_id, event_ref)
        if payload.get("expected_revision") != view["expected_revision"]:
            raise ExtensionContractError("revision_conflict", "This item changed. Refresh and review it again.")
        choice = next((row for row in view["sources"] if row["source_ref"] == payload.get("source_ref")), None)
        if action == "delete_local":
            for entry in view["sources"]:
                source = _require_canvas_source(connection, user_id, entry["source_ref"])
                _unlink(connection, user_id, source["source_id"], event_ref, _canvas_now())
            _delete_local(connection, user_id, table, item["id"])
            return {"state": "deleted_local", "copiesRetained": True}
        if not choice:
            raise ExtensionContractError("source_not_found", "Choose one of your connected Canvas accounts.")
        source = _require_canvas_source(connection, user_id, choice["source_ref"])
        if action == "unlink":
            _unlink(connection, user_id, source["source_id"], event_ref, _canvas_now())
            return {"state": "unlinked", "copiesRetained": True}
        _canvas_source_consent(connection, source, version=1, scopes=("ongoing_read",))
        _canvas_source_consent(connection, source, version=2, scopes=(scope, "selected_item_mirroring"))
        if choice["pending_id"]:
            raise ExtensionContractError("mirror_pending", "Resolve the existing operation before making another change.")
        if action == "mirror":
            if choice["linked"]:
                raise ExtensionContractError("mirror_exists", "This item is already linked to this account.")
            operation_id = _queue(connection, user_id, source, event_ref, "create", _fields(table, item), None)
        else:
            if not choice["linked"] or not choice["revision"]:
                raise ExtensionContractError("mirror_not_ready", "Wait for this item's Canvas copy before deleting both copies.")
            if sum(bool(row["linked"] or row["pending_id"]) for row in view["sources"]) != 1:
                raise ExtensionContractError("multiple_mirrors", "Unlink other Canvas copies before deleting both copies here.")
            operation_id = _queue(connection, user_id, source, event_ref, "delete", {}, choice["revision"], delete_hash=_canvas_hash(_canvas_json(item)))
        return {"state": "queued", "operation_id": operation_id}


def _delete_local(connection, user_id, table, item_id):
    if table == "tasks":
        connection.execute("DELETE FROM task_completions WHERE task_id=? AND user_id=?", [item_id,user_id])
    connection.execute(f"DELETE FROM {table} WHERE id=? AND user_id=?", [item_id,user_id])


def finish_delete(connection, user_id, row):
    """Called in the result transaction after an acknowledged Canvas deletion."""
    values = json.loads(row["payload_json"])
    reviewed_hash = values.get("mirror_delete_nest_hash")
    if not reviewed_hash or row["operation"] != "delete":
        return True
    table, _, item = _target(connection, user_id, row["event_ref"])
    if _canvas_hash(_canvas_json(item)) != reviewed_hash:
        return False
    _delete_local(connection, user_id, table, item["id"])
    connection.execute("UPDATE calendar_event_links SET archived_at=?,updated_at=?,mirror_state='cancelled' WHERE user_id=? AND source_id=? AND event_ref=? AND archived_at IS NULL", [_canvas_now(),_canvas_now(),user_id,row["source_id"],row["event_ref"]])
    return True


def has_mirror_work(user_id, event_ref):
    with calendar_connection() as connection:
        return bool(connection.execute("SELECT 1 FROM calendar_event_links WHERE user_id=? AND event_ref=? AND archived_at IS NULL LIMIT 1", [user_id,event_ref]).fetchone()
            or connection.execute("SELECT 1 FROM calendar_writebacks WHERE user_id=? AND event_ref=? AND state NOT IN ('applied','cancelled') LIMIT 1", [user_id,event_ref]).fetchone())
