"""Refresh explicitly linked personal items against their last acknowledged fields."""
import json
import re
from services.calendar_store import calendar_connection
from services.calendar_events import (_require_canvas_source, _canvas_source_consent, _canvas_now,
    _canvas_json, _canvas_hash, _canvas_link_payload)
from services.extension_contract import ExtensionContractError
from services.extension_mirrors import _fields, _queue, planner_deadline
from services.extension_bridge import personal_target
from services.extension_write_validation import personal_calendar, validate_fields, validate_personal_identity


def fields_hash(fields):
    return _canvas_hash(_canvas_json(fields))


def _access(connection, source, event_ref):
    _, scope, _ = personal_target(connection, source["user_id"], event_ref)
    _canvas_source_consent(connection, source, version=1, scopes=("ongoing_read",))
    _canvas_source_consent(connection, source, version=2, scopes=(scope, "selected_item_mirroring"))
    personal_calendar(source)


def _current(connection, user_id, link):
    table, _, item = personal_target(connection, user_id, link["event_ref"])
    fields = _fields(table, item)
    token = fields_hash({"link": dict(link), "fields": fields})
    return table, item, fields, token


def _pending(connection, user_id, link):
    return connection.execute("SELECT 1 FROM calendar_writebacks WHERE user_id=? AND source_id=? AND event_ref=? AND state NOT IN ('applied','cancelled') LIMIT 1", [user_id, link["source_id"], link["event_ref"]]).fetchone()


def prepare(user_id, source_ref):
    observations = []
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_ref)
        links = connection.execute("SELECT l.* FROM calendar_event_links l WHERE l.user_id=? AND l.source_id=? AND l.archived_at IS NULL AND l.source_hash IS NOT NULL AND l.source_revision IS NOT NULL AND NOT EXISTS (SELECT 1 FROM calendar_writebacks w WHERE w.user_id=l.user_id AND w.source_id=l.source_id AND w.event_ref=l.event_ref AND w.state NOT IN ('applied','cancelled')) ORDER BY l.updated_at,l.id LIMIT 50", [user_id, source["source_id"]]).fetchall()
        for link in links:
            try:
                _access(connection, source, link["event_ref"])
                validate_personal_identity(link["event_ref"], link)
                personal_calendar(source, link["canvas_context_id"])
                if not link["source_hash"] or not link["source_revision"] or _pending(connection, user_id, link):
                    continue
                _, _, fields, token = _current(connection, user_id, link)
                if fields_hash(fields) != link["source_hash"]:
                    _queue(connection, user_id, source, link["event_ref"], "update", fields, link["source_revision"])
                else:
                    observations.append({**_canvas_link_payload(link), "expected_revision": token})
            except ExtensionContractError:
                # One invalid or revoked item must not stop other selected mirrors.
                continue
    return observations


def observe(user_id, source_ref, payload):
    if not isinstance(payload, dict) or set(payload) != {"link_id", "expected_revision", "canvas_revision", "canvas_snapshot"}:
        raise ExtensionContractError("invalid_snapshot", "A bound mirror observation is required.")
    if not isinstance(payload["link_id"], str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", payload["link_id"]) or not isinstance(payload["expected_revision"], str) or not re.fullmatch(r"[a-f0-9]{64}", payload["expected_revision"]):
        raise ExtensionContractError("invalid_snapshot", "A valid mirror identity and revision token are required.")
    revision = payload["canvas_revision"]
    snapshot = payload["canvas_snapshot"]
    if not isinstance(revision, str) or not revision or len(revision) > 255 or not isinstance(snapshot, dict):
        raise ExtensionContractError("invalid_snapshot", "A bounded Canvas revision and snapshot are required.")
    with calendar_connection() as connection:
        connection.execute("BEGIN IMMEDIATE")
        source = _require_canvas_source(connection, user_id, source_ref)
        link = connection.execute("SELECT * FROM calendar_event_links WHERE id=? AND user_id=? AND source_id=? AND archived_at IS NULL", [payload["link_id"], user_id, source["source_id"]]).fetchone()
        if link is None:
            raise ExtensionContractError("event_link_not_found", "The active mirror was not found.")
        _access(connection, source, link["event_ref"])
        validate_personal_identity(link["event_ref"], link)
        personal_calendar(source, link["canvas_context_id"])
        table, item, fields, token = _current(connection, user_id, link)
        if payload["expected_revision"] != token or fields_hash(fields) != link["source_hash"] or _pending(connection, user_id, link):
            raise ExtensionContractError("revision_conflict", "The mirror changed while Canvas was being checked.")
        now = _canvas_now()
        if revision == link["source_revision"]:
            connection.execute("UPDATE calendar_event_links SET updated_at=? WHERE id=?", [now, link["id"]])
            return {"state": "unchanged"}
        if snapshot == {"deleted": True}:
            operation_id = _queue(connection, user_id, source, link["event_ref"], "update", fields, link["source_revision"])
            connection.execute("UPDATE calendar_writebacks SET state='conflict',result_revision=?,error_code='CANVAS_ITEM_MISSING' WHERE id=?", [revision, operation_id])
            connection.execute("INSERT INTO extension_bridge_conflicts VALUES (?,?,?,?)", [operation_id, revision, _canvas_json(snapshot), now])
            return {"state": "conflict"}
        if table == "user_events":
            if set(snapshot) != {"title", "description", "start", "end", "is_all_day"}:
                raise ExtensionContractError("invalid_snapshot", "A complete personal event snapshot is required.")
            remote = {"title": snapshot["title"], "description": snapshot["description"], "start_at": snapshot["start"], "end_at": snapshot["end"] or snapshot["start"], "all_day": snapshot["is_all_day"]}
            updates = {"title": remote["title"], "description": remote["description"], "start": remote["start_at"], "end": remote["end_at"], "is_all_day": remote["all_day"]}
        else:
            if set(snapshot) != {"title", "deadline_at"}:
                raise ExtensionContractError("invalid_snapshot", "A complete personal planner snapshot is required.")
            remote = {"title": snapshot["title"], "todo_date": str(snapshot["deadline_at"] or "")[:10]}
            updates = {"title": remote["title"], "deadline_at": planner_deadline(item, remote["todo_date"])}
        validate_fields(link["event_ref"], "create", remote)
        updates["updated_at"] = now
        connection.execute(f"UPDATE {table} SET " + ",".join(f"{key}=?" for key in updates) + " WHERE id=? AND user_id=?", [*updates.values(), item["id"], user_id])
        connection.execute("UPDATE calendar_event_links SET source_revision=?,source_hash=?,mirror_state='applied',updated_at=?,mirrored_at=? WHERE id=?", [revision, fields_hash(remote), now, now, link["id"]])
        return {"state": "applied"}


def acknowledge(connection, user_id, row, revision):
    if row["operation"] == "delete":
        connection.execute("UPDATE calendar_event_links SET archived_at=?,updated_at=?,mirror_state='cancelled' WHERE user_id=? AND source_id=? AND event_ref=? AND archived_at IS NULL", [_canvas_now(), _canvas_now(), user_id, row["source_id"], row["event_ref"]])
        return
    fields = json.loads(row["payload_json"]).get("payload", {})
    required = {"title", "description", "start_at", "end_at", "all_day"} if row["event_ref"].startswith("user:") else {"title", "todo_date"}
    # Partial legacy writes cannot establish a complete synchronization baseline.
    baseline = fields_hash(fields) if set(fields) == required else None
    connection.execute("UPDATE calendar_event_links SET source_revision=?,source_hash=?,mirror_state='applied',updated_at=?,mirrored_at=? WHERE user_id=? AND source_id=? AND event_ref=? AND archived_at IS NULL", [revision, baseline, _canvas_now(), _canvas_now(), user_id, row["source_id"], row["event_ref"]])
