"""SQLite-backed todo storage for the authenticated APStudyCanvas extension."""

from __future__ import annotations

import hashlib
import json
import math
import uuid
from datetime import date, datetime, time, timedelta, timezone
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from services import database
from services.time_utils import utcnow_iso


SOURCE_KEY = "apstudycanvas"
SOURCE_LIST_NAME = "APStudyCanvas To-Do"
DEFAULT_LIMIT = 100
MAX_LIMIT = 100
PRIORITIES = frozenset({"none", "low", "medium", "high"})
TODO_TYPES = frozenset({"assignment", "quiz", "discussion"})
RECEIPT_RETENTION_DAYS = 30


class TodoServiceError(Exception):
    """An expected, safe-to-return todo API error."""

    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code = code
        self.status = status


class TodoValidationError(TodoServiceError):
    pass


class TodoConflictError(TodoServiceError):
    def __init__(self, message="The idempotency key was already used with a different payload."):
        super().__init__("idempotency_conflict", message, 409)


class TodoNotFoundError(TodoServiceError):
    def __init__(self, message="Todo was not found."):
        super().__init__("todo_not_found", message, 404)


def _invalid(field, message):
    raise TodoValidationError(f"invalid_{field}", message)


def _value(payload, names, *, default=None):
    present = [name for name in names if name in payload]
    if not present:
        return default
    first = payload[present[0]]
    for name in present[1:]:
        if payload[name] != first:
            _invalid("request", f"{present[0]} and {name} must match.")
    return first


def _clean_text(value, field, max_length, *, required=False):
    if value is None:
        if required:
            _invalid(field, f"{field} is required.")
        return None
    if not isinstance(value, str):
        _invalid(field, f"{field} must be a string.")
    normalized = value.strip()
    if required and not normalized:
        _invalid(field, f"{field} is required.")
    if len(normalized) > max_length:
        _invalid(field, f"{field} must be {max_length} characters or fewer.")
    return normalized


def _optional_identifier(value, field, max_length=255):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        _invalid(field, f"{field} must be a string or integer.")
    return _clean_text(str(value), field, max_length)


def _normalize_link(value):
    if value is None:
        return None
    if not isinstance(value, str):
        _invalid("link", "link must be a string.")
    normalized = value.strip()
    if len(normalized) > 2048:
        _invalid("link", "link must be 2048 characters or fewer.")
    try:
        parsed = urlsplit(normalized)
    except ValueError:
        _invalid("link", "link must be a valid HTTPS URL.")
    if (
        parsed.scheme.lower() != "https"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.hostname is None
    ):
        _invalid("link", "link must be an HTTPS URL without embedded credentials.")
    return normalized


def _normalize_timezone(value):
    value = "UTC" if value in (None, "") else value
    if not isinstance(value, str):
        _invalid("timezone", "timezone must be a valid IANA timezone.")
    normalized = value.strip()
    try:
        ZoneInfo(normalized)
    except (ZoneInfoNotFoundError, ValueError):
        _invalid("timezone", "timezone must be a valid IANA timezone.")
    return normalized


def _parse_datetime(value, timezone_name):
    if not isinstance(value, str):
        _invalid("due", "due must be an ISO date or datetime.")
    text = value.strip()
    if not text:
        _invalid("due", "due must be an ISO date or datetime.")
    try:
        parsed = datetime.fromisoformat(text[:-1] + "+00:00" if text.endswith("Z") else text)
    except ValueError:
        _invalid("due", "due must be an ISO date or datetime.")
    zone = ZoneInfo(timezone_name)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    local = parsed.astimezone(zone)
    utc_value = parsed.astimezone(timezone.utc)
    return (
        utc_value.isoformat().replace("+00:00", "Z"),
        local.strftime("%H:%M"),
        local.date().isoformat(),
    )


def _normalize_due(value, timezone_name):
    if value in (None, ""):
        return None, None, None
    if not isinstance(value, str):
        _invalid("due", "due must be an ISO date or datetime.")
    text = value.strip()
    try:
        date_value = date.fromisoformat(text)
    except ValueError:
        date_value = None
    if date_value is not None and len(text) == 10:
        local = datetime.combine(date_value, time.min, tzinfo=ZoneInfo(timezone_name))
        utc_value = local.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return utc_value, None, date_value.isoformat()
    return _parse_datetime(text, timezone_name)


def _normalize_points(value, field):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _invalid(field, f"{field} must be null or a finite nonnegative number.")
    normalized = float(value)
    if not math.isfinite(normalized) or normalized < 0:
        _invalid(field, f"{field} must be null or a finite nonnegative number.")
    return normalized


def _source_parts(payload):
    source_value = _value(payload, ("source_identity", "source"))
    source_key = _optional_identifier(
        _value(payload, ("source_key", "sourceKey")), "source_key", 512
    )
    source_item_key = _optional_identifier(
        _value(payload, ("source_item_key", "sourceItemKey", "canvas_source_item_key")),
        "source_item_key",
        512,
    )
    source_event_ref = _optional_identifier(
        _value(payload, ("source_event_ref", "sourceEventRef", "canvas_event_ref")),
        "source_event_ref",
        512,
    )
    if isinstance(source_value, dict):
        if len(json.dumps(source_value, ensure_ascii=False)) > 4096:
            _invalid("source_identity", "source_identity is too large.")
        source_key = source_key or _optional_identifier(
            source_value.get("source_key", source_value.get("sourceKey")), "source_key", 512
        )
        source_item_key = source_item_key or _optional_identifier(
            source_value.get("source_item_key", source_value.get("item_key", source_value.get("itemKey"))),
            "source_item_key",
            512,
        )
        source_event_ref = source_event_ref or _optional_identifier(
            source_value.get("source_event_ref", source_value.get("event_ref", source_value.get("eventRef"))),
            "source_event_ref",
            512,
        )
        stored_identity = json.dumps(source_value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        identity = source_value
    elif source_value is None:
        identity = None
        stored_identity = None
    elif isinstance(source_value, str):
        identity = source_value.strip()
        if not identity or len(identity) > 1024:
            _invalid("source_identity", "source_identity must be a non-empty string of 1024 characters or fewer.")
        stored_identity = json.dumps(identity, ensure_ascii=False)
        source_item_key = source_item_key or identity
    else:
        _invalid("source_identity", "source_identity must be a string or object.")
    return identity, stored_identity, source_key, source_item_key, source_event_ref


def _normalize_idempotency_key(value):
    if not isinstance(value, str):
        _invalid("idempotency_key", "idempotency_key is required and must be a string.")
    normalized = value.strip()
    if not normalized or len(normalized) > 160 or any(char in normalized for char in "\r\n"):
        _invalid("idempotency_key", "idempotency_key must be 1-160 characters without line breaks.")
    return normalized


def normalize_todo_payload(payload):
    """Validate and canonicalize an extension create payload."""
    if not isinstance(payload, dict):
        _invalid("request", "Request body must be a JSON object.")

    title = _clean_text(payload.get("title"), "title", 255, required=True)
    description = _clean_text(payload.get("description"), "description", 1000) or ""
    link = _normalize_link(_value(payload, ("link", "url", "source_url")))
    timezone_name = _normalize_timezone(_value(payload, ("timezone", "time_zone")))
    priority = str(payload.get("priority", "none") or "none").strip().lower()
    if priority not in PRIORITIES:
        _invalid("priority", "priority must be one of none, low, medium, or high.")
    due_value = _value(payload, ("due", "due_at", "deadline_at", "due_date"))
    deadline_at, deadline_time, due_date = _normalize_due(due_value, timezone_name)
    identity, stored_identity, source_key, source_item_key, source_event_ref = _source_parts(payload)
    type_value = _value(payload, ("type",))
    normalized_type = None
    if type_value not in (None, ""):
        if not isinstance(type_value, str):
            _invalid("type", "type must be one of assignment, quiz, or discussion.")
        normalized_type = type_value.strip().lower()
        if normalized_type not in TODO_TYPES:
            _invalid("type", "type must be one of assignment, quiz, or discussion.")

    normalized = {
        "title": title,
        "description": description,
        "link": link,
        "timezone": timezone_name,
        "priority": priority,
        "due": due_date if deadline_time is None and due_date else deadline_at,
        "deadline_at": deadline_at,
        "deadline_time": deadline_time,
        "canvas_account_key": _optional_identifier(
            _value(payload, ("canvas_account_key", "canvasAccountKey", "account_key")),
            "canvas_account_key",
        ),
        "canvas_course_id": _optional_identifier(
            _value(payload, ("canvas_course_id", "canvasCourseId", "course_id")),
            "canvas_course_id",
        ),
        "canvas_course_label": _clean_text(
            _value(payload, ("canvas_course_label", "canvasCourseLabel", "course_label")),
            "canvas_course_label",
            255,
        ),
        "type_label": (
            _clean_text(_value(payload, ("type_label", "typeLabel")), "type_label", 255)
            or normalized_type
        ),
        "points_earned": _normalize_points(
            payload.get("points_earned", payload.get("pointsEarned")), "points_earned"
        ),
        "points_possible": _normalize_points(
            payload.get("points_possible", payload.get("pointsPossible")), "points_possible"
        ),
        "source_identity": identity,
        "source_identity_storage": stored_identity,
        "source_key": source_key,
        "source_item_key": source_item_key,
        "source_event_ref": source_event_ref,
        "idempotency_key": _normalize_idempotency_key(
            _value(payload, ("idempotency_key", "idempotencyKey"))
        ),
    }
    return normalized


def _payload_hash(normalized):
    comparable = {key: value for key, value in normalized.items() if key != "idempotency_key"}
    encoded = json.dumps(comparable, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _list_payload(row):
    if row is None:
        return None
    return {
        "$id": row["id"],
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "source_key": row["source_key"],
        "order": row["order"] or 0,
        "collapsed": bool(row["collapsed"]),
        "hidden": bool(row["hidden"]),
        "sort_mode": row["sort_mode"] or "default",
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _decode_identity(value):
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value


def _task_due(row):
    deadline_at = row["deadline_at"]
    if not deadline_at:
        return None
    if not row["deadline_time"]:
        try:
            parsed = datetime.fromisoformat(str(deadline_at).replace("Z", "+00:00"))
            return parsed.astimezone(ZoneInfo(row["timezone"] or "UTC")).date().isoformat()
        except (ValueError, TypeError, ZoneInfoNotFoundError):
            return str(deadline_at)
    return deadline_at


def _task_payload(row):
    identity = _decode_identity(row["source_identity"])
    link = row["link"]
    return {
        "$id": row["id"],
        "id": row["id"],
        "list_id": row["list_id"],
        "title": row["title"],
        "description": row["description"] or "",
        "link": link,
        "url": link,
        "priority": row["priority"] or "none",
        "due": _task_due(row),
        "deadline_at": row["deadline_at"],
        "deadline_time": row["deadline_time"],
        "timezone": row["timezone"] or "UTC",
        "reminder_minutes": row["reminder_minutes"],
        "completed": bool(row["completed"]),
        "completed_at": row["completed_at"],
        "starred": bool(row["starred"]),
        "canvas_account_key": row["canvas_account_key"],
        "canvas_course_id": row["canvas_course_id"],
        "canvas_course_label": row["canvas_course_label"],
        "type_label": row["type_label"],
        "points_earned": row["points_earned"],
        "points_possible": row["points_possible"],
        "source_identity": identity,
        "source_key": row["source_key"],
        "source_item_key": row["source_item_key"],
        "source_event_ref": row["source_event_ref"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _source_list(conn, user_id):
    return conn.execute(
        "SELECT * FROM task_lists WHERE user_id = ? AND source_key = ? LIMIT 1",
        [str(user_id), SOURCE_KEY],
    ).fetchone()


def _ensure_source_list(conn, user_id):
    existing = _source_list(conn, user_id)
    if existing:
        return existing
    now = utcnow_iso()
    list_id = uuid.uuid4().hex
    conn.execute(
        """INSERT INTO task_lists
           (id, user_id, name, description, source_key, "order", collapsed, hidden,
            sort_mode, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [list_id, str(user_id), SOURCE_LIST_NAME, "", SOURCE_KEY, 0, 0, 0, "default", now, now],
    )
    return conn.execute("SELECT * FROM task_lists WHERE id = ?", [list_id]).fetchone()


def create_todo(user_id, payload):
    """Ensure the source list and create/replay one idempotent todo atomically."""
    normalized = normalize_todo_payload(payload)
    payload_hash = _payload_hash(normalized)
    user_id = str(user_id)
    with database.db_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        source_list = _ensure_source_list(conn, user_id)
        receipt = conn.execute(
            """SELECT payload_hash, response_json FROM task_idempotency_receipts
               WHERE user_id = ? AND idempotency_key = ?""",
            [user_id, normalized["idempotency_key"]],
        ).fetchone()
        if receipt:
            if receipt["payload_hash"] != payload_hash:
                raise TodoConflictError()
            replay = json.loads(receipt["response_json"])
            replay["idempotent"] = True
            return replay, 200

        now = utcnow_iso()
        task_id = uuid.uuid4().hex
        conn.execute(
            """INSERT INTO tasks
               (id, user_id, list_id, title, priority, deadline_at, deadline_time, timezone,
                reminder_minutes, completed, completed_at, starred, created_at, updated_at, description, link,
                canvas_account_key, canvas_course_id, canvas_course_label, type_label,
                points_earned, points_possible, source_identity, source_key, source_item_key,
                source_event_ref)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                task_id,
                user_id,
                source_list["id"],
                normalized["title"],
                normalized["priority"],
                normalized["deadline_at"],
                normalized["deadline_time"],
                normalized["timezone"],
                10 if normalized["deadline_time"] else -1,
                0,
                None,
                0,
                now,
                now,
                normalized["description"],
                normalized["link"],
                normalized["canvas_account_key"],
                normalized["canvas_course_id"],
                normalized["canvas_course_label"],
                normalized["type_label"],
                normalized["points_earned"],
                normalized["points_possible"],
                normalized["source_identity_storage"],
                normalized["source_key"],
                normalized["source_item_key"],
                normalized["source_event_ref"],
            ],
        )
        task = conn.execute("SELECT * FROM tasks WHERE id = ?", [task_id]).fetchone()
        response = {
            "todo": _task_payload(task),
            "list": _list_payload(source_list),
            "idempotent": False,
        }
        conn.execute(
            """INSERT INTO task_idempotency_receipts
               (id, user_id, idempotency_key, payload_hash, task_id, response_json, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            [
                uuid.uuid4().hex,
                user_id,
                normalized["idempotency_key"],
                payload_hash,
                task_id,
                json.dumps(response, sort_keys=True, separators=(",", ":"), ensure_ascii=False),
                now,
            ],
        )
        return response, 201


def prune_idempotency_receipts(retention_days=RECEIPT_RETENTION_DAYS):
    """Delete idempotency receipts older than the retention window.

    Receipts store a full response snapshot, so the periodic scheduler prunes
    them daily to keep the table bounded. The user_id/created_at index keeps
    the delete cheap.
    """
    retention_days = int(retention_days)
    if retention_days < 0:
        raise ValueError("retention_days must be nonnegative.")
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=retention_days)
    ).isoformat().replace("+00:00", "Z")
    with database.db_connection() as conn:
        cursor = conn.execute(
            "DELETE FROM task_idempotency_receipts WHERE created_at < ?",
            [cutoff],
        )
        return cursor.rowcount


def _task_due_date(row):
    if not row["deadline_at"]:
        return None
    try:
        parsed = datetime.fromisoformat(str(row["deadline_at"]).replace("Z", "+00:00"))
        return parsed.astimezone(ZoneInfo(row["timezone"] or "UTC")).date()
    except (TypeError, ValueError, ZoneInfoNotFoundError):
        return None


def _normalize_bound(value, field):
    if value in (None, ""):
        return None
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if not isinstance(value, str):
        _invalid(field, f"{field} must be an ISO calendar date.")
    try:
        return date.fromisoformat(value)
    except ValueError:
        _invalid(field, f"{field} must be an ISO calendar date.")


def list_todos(
    user_id,
    *,
    limit=DEFAULT_LIMIT,
    offset=0,
    start_date=None,
    end_date=None,
    completed=None,
    undated="include",
):
    """Read only the user's source list and return a deterministic page."""
    try:
        limit = int(limit)
        offset = int(offset)
    except (TypeError, ValueError):
        _invalid("pagination", "limit and offset must be integers.")
    if not 1 <= limit <= MAX_LIMIT:
        _invalid("limit", f"limit must be between 1 and {MAX_LIMIT}.")
    if offset < 0:
        _invalid("offset", "offset must be nonnegative.")
    start_date = _normalize_bound(start_date, "start")
    end_date = _normalize_bound(end_date, "end")
    if start_date and end_date and start_date > end_date:
        _invalid("date_range", "start must be on or before end.")
    if completed not in (None, True, False):
        _invalid("completed", "completed must be true, false, or all.")
    if undated not in {"include", "exclude", "only"}:
        _invalid("undated", "undated must be include, exclude, or only.")

    with database.db_connection() as conn:
        source_list = _source_list(conn, str(user_id))
        if source_list is None:
            filtered = []
        else:
            rows = conn.execute(
                """SELECT * FROM tasks
                   WHERE user_id = ? AND list_id = ?
                   ORDER BY CASE WHEN deadline_at IS NULL THEN 1 ELSE 0 END,
                            deadline_at ASC, created_at ASC, id ASC""",
                [str(user_id), source_list["id"]],
            ).fetchall()
            filtered = []
            for row in rows:
                if completed is not None and bool(row["completed"]) is not completed:
                    continue
                due_date = _task_due_date(row)
                if due_date is None:
                    if undated == "exclude":
                        continue
                    if undated == "only":
                        filtered.append(row)
                        continue
                    # An explicitly included undated item is independent of
                    # the bounded date window.
                    filtered.append(row)
                    continue
                elif undated == "only":
                    continue
                if start_date and (due_date is None or due_date < start_date):
                    continue
                if end_date and (due_date is None or due_date > end_date):
                    continue
                filtered.append(row)
        total = len(filtered)
        page = filtered[offset : offset + limit]
        next_offset = offset + limit if offset + limit < total else None
        return {
            "todos": [_task_payload(row) for row in page],
            "list": _list_payload(source_list),
            "pagination": {
                "limit": limit,
                "offset": offset,
                "total": total,
                "has_more": next_offset is not None,
                "next_offset": next_offset,
            },
        }


def complete_todo(user_id, task_id, completed):
    if type(completed) is not bool:
        _invalid("completed", "completed must be a boolean.")
    task_id = str(task_id or "").strip()
    if not task_id:
        raise TodoNotFoundError()
    with database.db_connection() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM tasks WHERE id = ? AND user_id = ? LIMIT 1",
            [task_id, str(user_id)],
        ).fetchone()
        source_list = _source_list(conn, str(user_id))
        if row is None or source_list is None or row["list_id"] != source_list["id"]:
            # The todos endpoint only manages tasks on the integration list;
            # everything else is indistinguishable from a cross-user miss.
            raise TodoNotFoundError()
        now = utcnow_iso()
        conn.execute(
            "UPDATE tasks SET completed = ?, completed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?",
            [1 if completed else 0, now if completed else None, now, task_id, str(user_id)],
        )
        updated = conn.execute("SELECT * FROM tasks WHERE id = ?", [task_id]).fetchone()
        source_list = conn.execute("SELECT * FROM task_lists WHERE id = ?", [updated["list_id"]]).fetchone()
        return {"todo": _task_payload(updated), "list": _list_payload(source_list)}
