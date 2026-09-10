"""Account-bound personal mirrors and explicit conflict decisions."""

import json

from services.calendar_events import (
    _canvas_now, _canvas_hash, _canvas_json, _canvas_link_payload,
    _canvas_writeback_payload, _require_canvas_source, _canvas_source_consent,
)
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError


def personal_target(connection, user_id, event_ref):
    from services.extension_write_validation import personal_kind
    personal_kind(event_ref)
    parts = event_ref.split(":")
    table, scope = ("user_events", "personal_events_write") if parts[0] == "user" else ("tasks", "planner_items_write")
    row = connection.execute(f"SELECT * FROM {table} WHERE id = ? AND user_id = ?", [parts[1], user_id]).fetchone()
    if row is None:
        raise ExtensionContractError("personal_item_not_found", "The personal Nest item was not found.")
    return table, scope, dict(row)


def _bound_writeback(connection, user_id, source_ref, writeback_id):
    source = _require_canvas_source(connection, user_id, source_ref, include_archived=True)
    row = connection.execute("SELECT * FROM calendar_writebacks WHERE id=? AND user_id=? AND source_id=? AND account_key=?",
                             [writeback_id, user_id, source["source_id"], source["account_key"]]).fetchone()
    if row is None:
        raise ExtensionContractError("writeback_not_found", "Writeback was not found.")
    return source, row


def _snapshot(connection, user_id, row):
    _, _, nest = personal_target(connection, user_id, row["event_ref"])
    nest.pop("user_id", None)
    stored = connection.execute("SELECT * FROM extension_bridge_conflicts WHERE writeback_id=?", [row["id"]]).fetchone()
    canvas = json.loads(stored["snapshot_json"]) if stored else None
    revision = stored["canvas_revision"] if stored else row["result_revision"]
    token = _canvas_hash(_canvas_json({"nest": nest, "canvas": canvas, "revision": revision, "state": row["state"]}))
    return {"writeback": _canvas_writeback_payload(row), "nestSnapshot": nest,
            "canvasSnapshot": canvas, "canvas_revision": revision, "expected_revision": token,
            "choices": ["keep_canvas", "keep_nest", "delete_nest_copy"]}


def inspect_conflict(user_id, source_ref, writeback_id, refresh=None):
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source, row = _bound_writeback(connection, user_id, source_ref, writeback_id)
        _, scope, _ = personal_target(connection, user_id, row["event_ref"])
        _canvas_source_consent(connection, source, version=2, scopes=(scope,))
        if refresh is not None:
            if row["state"] != "conflict":
                raise ExtensionContractError("writeback_not_conflicted", "Only conflicts accept refreshed snapshots.")
            revision = refresh.get("canvas_revision")
            snapshot = refresh.get("canvas_snapshot")
            if not isinstance(revision, str) or not revision or len(revision) > 255 or not isinstance(snapshot, dict):
                raise ExtensionContractError("invalid_snapshot", "Canvas revision and snapshot are required.")
            allowed = {"title", "description", "start", "end", "is_all_day", "deadline_at", "completed", "deleted"}
            if set(snapshot) - allowed:
                raise ExtensionContractError("invalid_snapshot", "Snapshot contains unsupported fields.")
            for key, value in snapshot.items():
                if key in {"deleted", "completed", "is_all_day"}:
                    if not isinstance(value, bool):
                        raise ExtensionContractError("invalid_snapshot", "Snapshot flags must be booleans.")
                elif value is not None and not isinstance(value, str):
                    raise ExtensionContractError("invalid_snapshot", "Snapshot values must be text.")
            connection.execute("INSERT INTO extension_bridge_conflicts VALUES (?,?,?,?) ON CONFLICT(writeback_id) DO UPDATE SET canvas_revision=excluded.canvas_revision,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
                               [writeback_id, revision, _canvas_json(snapshot, max_bytes=16384), _canvas_now()])
        return _snapshot(connection, user_id, row)


def resolve_conflict(user_id, source_ref, writeback_id, payload):
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source, row = _bound_writeback(connection, user_id, source_ref, writeback_id)
        table, scope, nest = personal_target(connection, user_id, row["event_ref"])
        _canvas_source_consent(connection, source, version=2, scopes=(scope,))
        view = _snapshot(connection, user_id, row)
        if row["state"] != "conflict" or payload.get("expected_revision") != view["expected_revision"]:
            raise ExtensionContractError("revision_conflict", "Inspect the current conflict before deciding.")
        choice = payload.get("choice")
        if choice not in view["choices"]:
            raise ExtensionContractError("invalid_choice", "Choose Keep Canvas, Keep Nest, or delete Nest copy.")
        snapshot = view["canvasSnapshot"]
        if choice != "delete_nest_copy" and snapshot is None:
            raise ExtensionContractError("snapshot_required", "Refresh the Canvas snapshot before deciding.")
        now = _canvas_now()
        if choice == "delete_nest_copy":
            if payload.get("confirm_delete") is not True:
                raise ExtensionContractError("delete_confirmation_required", "Confirm deletion of the Nest copy.")
            connection.execute(f"DELETE FROM {table} WHERE id=? AND user_id=?", [nest["id"], user_id])
            if table == "tasks":
                connection.execute("DELETE FROM task_completions WHERE task_id=? AND user_id=?", [nest["id"], user_id])
        elif choice == "keep_canvas" and not snapshot.get("deleted"):
            allowed = {"title", "description", "start", "end", "is_all_day"} if table == "user_events" else {"title", "deadline_at", "completed"}
            updates = {key: value for key, value in snapshot.items() if key in allowed}
            if updates:
                if table == "tasks" and updates.get("deadline_at"):
                    from services.extension_mirrors import planner_deadline
                    updates["deadline_at"] = planner_deadline(nest, str(updates["deadline_at"])[:10])
                updates["updated_at"] = now
                connection.execute(f"UPDATE {table} SET " + ",".join(f"{key}=?" for key in updates) + " WHERE id=? AND user_id=?", [*updates.values(), nest["id"], user_id])
        if choice == "keep_nest":
            # An ambiguous create has no safely identified remote item to overwrite.
            if row["operation"] == "create" or snapshot.get("deleted"):
                raise ExtensionContractError("relink_required", "Unlink this item and select a new mirror after reviewing Canvas.")
            values = json.loads(row["payload_json"])
            if row["operation"] == "update":
                from services.extension_mirrors import _fields
                fields = _fields(table, nest)
                values["payload"] = fields
            values["expected_revision"] = view["canvas_revision"]
            encoded = _canvas_json(values)
            connection.execute("UPDATE calendar_writebacks SET payload_json=?,payload_hash=?,result_revision=NULL WHERE id=?",
                               [encoded, _canvas_hash(encoded), writeback_id])
        if choice in {"keep_canvas", "keep_nest"} and not snapshot.get("deleted"):
            from services.extension_mirrors import _fields
            from services.extension_mirror_sync import fields_hash
            current_item = dict(connection.execute(f"SELECT * FROM {table} WHERE id=? AND user_id=?", [nest["id"], user_id]).fetchone())
            baseline = fields_hash(_fields(table, current_item)) if choice == "keep_canvas" else None
            connection.execute("UPDATE calendar_event_links SET source_revision=?,source_hash=?,updated_at=? WHERE user_id=? AND source_id=? AND event_ref=? AND archived_at IS NULL", [view["canvas_revision"], baseline, now, user_id, source["source_id"], row["event_ref"]])
        state = "queued" if choice == "keep_nest" else "cancelled"
        connection.execute("UPDATE calendar_writebacks SET state=?,expected_revision=?,error_code=?,error_message=NULL,updated_at=?,cancelled_at=?,next_retry_at=NULL WHERE id=?",
                           [state, view["canvas_revision"], None if state == "queued" else choice, now, now if state == "cancelled" else None, writeback_id])
        if choice == "delete_nest_copy" or (choice == "keep_canvas" and snapshot.get("deleted")):
            _unlink(connection, user_id, source["source_id"], row["event_ref"], now)
        updated = connection.execute("SELECT * FROM calendar_writebacks WHERE id=?", [writeback_id]).fetchone()
        return {"choice": choice, "writeback": _canvas_writeback_payload(updated), "copiesRetained": choice != "delete_nest_copy"}


def _unlink(connection, user_id, source_id, event_ref, now):
    connection.execute("UPDATE calendar_event_links SET archived_at=?,updated_at=?,mirror_state='cancelled' WHERE user_id=? AND source_id=? AND event_ref=? AND archived_at IS NULL", [now, now, user_id, source_id, event_ref])
    connection.execute("UPDATE calendar_writebacks SET state='cancelled',cancelled_at=?,updated_at=? WHERE user_id=? AND source_id=? AND event_ref=? AND state NOT IN ('applied','cancelled')", [now, now, user_id, source_id, event_ref])


def unlink_event(user_id, source_ref, link_id):
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_ref, include_archived=True)
        link = connection.execute("SELECT * FROM calendar_event_links WHERE id=? AND user_id=? AND source_id=?", [link_id, user_id, source["source_id"]]).fetchone()
        if link is None:
            raise ExtensionContractError("event_link_not_found", "Event link was not found.")
        _unlink(connection, user_id, source["source_id"], link["event_ref"], _canvas_now())
        return {**_canvas_link_payload(connection.execute("SELECT * FROM calendar_event_links WHERE id=?", [link_id]).fetchone()), "copiesRetained": True}
