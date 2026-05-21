import calendar
import json
import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from flask import Blueprint, abort, jsonify, request
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    first_row,
    format_datetime,
    get_row_safe,
    list_rows_all,
    parse_datetime,
    update_row_safe,
)


tasks_api_bp = Blueprint("tasks_api", __name__)
logger = logging.getLogger(__name__)

TASK_LISTS_TABLE_ID = COLLECTIONS.get("task_lists", "task_lists")
TASKS_TABLE_ID = COLLECTIONS.get("tasks", "tasks")
TASK_COMPLETIONS_TABLE_ID = COLLECTIONS.get("task_completions", "task_completions")
TASK_CALENDAR_ID = "local:tasks"
TASK_CALENDAR_NAME = "Tasks"
TASK_CALENDAR_COLOR = "#0ea5e9"
PRIORITIES = {"none", "low", "medium", "high"}
RECURRENCE_UNITS = {"day", "week", "month", "year"}
LIST_SORT_MODES = {"default", "date", "deadline", "title"}
MAX_EXPANDED_OCCURRENCES = 1500


def _row_id(row):
    return row.get("$id") or row.get("id") if row else None


def _utcnow():
    return datetime.now(timezone.utc)


def _utcnow_iso():
    return format_datetime(_utcnow())


def _coerce_utc(value):
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_iso_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return _coerce_utc(value)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return _coerce_utc(datetime.fromisoformat(text))
    except ValueError:
        return None


def _parse_date(value):
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _normalize_priority(value):
    priority = str(value or "none").strip().lower()
    return priority if priority in PRIORITIES else "none"


def _normalize_sort_mode(value):
    mode = str(value or "default").strip().lower()
    if mode not in LIST_SORT_MODES:
        raise ValueError("List sort must be default, date, deadline, or title.")
    return mode


def _normalize_deadline_time(value, deadline_dt=None, tz_name=None):
    if isinstance(value, str) and value.strip():
        text = value.strip()
        if len(text) >= 5 and text[2] == ":":
            hour = text[:2]
            minute = text[3:5]
            if hour.isdigit() and minute.isdigit():
                h = int(hour)
                m = int(minute)
                if 0 <= h <= 23 and 0 <= m <= 59:
                    return f"{h:02d}:{m:02d}"

    if not deadline_dt:
        return None
    local_dt = deadline_dt
    if tz_name:
        local_dt = deadline_dt.astimezone(_zoneinfo_or_utc(tz_name))
    return f"{local_dt.hour:02d}:{local_dt.minute:02d}"


def _zoneinfo_or_utc(tz_name):
    try:
        return ZoneInfo(str(tz_name or "UTC"))
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc


def _normalize_timezone(value):
    text = str(value or "").strip()
    if not text:
        return "UTC"
    try:
        ZoneInfo(text)
        return text[:64]
    except (ZoneInfoNotFoundError, ValueError):
        return "UTC"


def _normalize_recurrence(value, default_start=None):
    if value in (None, "", False):
        return None
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("Repeat schedule must be valid JSON.") from exc
    if not isinstance(value, dict):
        raise ValueError("Repeat schedule must be an object.")

    try:
        every = int(value.get("every") or 1)
    except (TypeError, ValueError) as exc:
        raise ValueError("Repeat frequency must be a number.") from exc
    if every < 1 or every > 365:
        raise ValueError("Repeat frequency must be between 1 and 365.")

    unit = str(value.get("unit") or "day").strip().lower()
    if unit.endswith("s"):
        unit = unit[:-1]
    if unit not in RECURRENCE_UNITS:
        raise ValueError("Repeat unit must be day, week, month, or year.")

    start_date = _parse_date(value.get("startDate") or value.get("start_date")) or default_start or date.today()
    end_date = _parse_date(value.get("endDate") or value.get("end_date")) if value.get("endDate") or value.get("end_date") else None
    if end_date and end_date < start_date:
        raise ValueError("Repeat end date must be on or after the start date.")

    return {
        "every": every,
        "unit": unit,
        "startDate": start_date.isoformat(),
        "endDate": end_date.isoformat() if end_date else None,
    }


def _task_recurrence(task):
    raw = task.get("recurrence_json")
    if not raw:
        return None
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        return _normalize_recurrence(parsed)
    except ValueError:
        return None


def _completion_to_payload(row):
    completion_id = _row_id(row)
    return {
        "$id": completion_id,
        "id": completion_id,
        "task_id": row.get("task_id"),
        "occurrence_key": row.get("occurrence_key"),
        "completed_at": row.get("completed_at"),
    }


def _task_to_payload(task, completions=None):
    task_id = _row_id(task)
    recurrence = _task_recurrence(task)
    task_completions = [_completion_to_payload(row) for row in (completions or [])]
    return {
        "$id": task_id,
        "id": task_id,
        "list_id": task.get("list_id"),
        "title": task.get("title") or "",
        "priority": _normalize_priority(task.get("priority")),
        "deadline_at": task.get("deadline_at"),
        "deadline_time": task.get("deadline_time"),
        "timezone": task.get("timezone") or "UTC",
        "recurrence": recurrence,
        "order": task.get("order") or 0,
        "completed": bool(task.get("completed", False)),
        "completed_at": task.get("completed_at"),
        "starred": bool(task.get("starred", False)),
        "completed_occurrences": task_completions,
        "next_occurrence_key": _next_occurrence_key(task),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }


def _list_to_payload(row):
    list_id = _row_id(row)
    return {
        "$id": list_id,
        "id": list_id,
        "name": row.get("name") or "Untitled List",
        "description": row.get("description") or "",
        "order": row.get("order") or 0,
        "collapsed": bool(row.get("collapsed", False)),
        "hidden": bool(row.get("hidden", False)),
        "sort_mode": row.get("sort_mode") or "default",
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


def _load_user_task_payload(user_id):
    lists = list_rows_all(
        TASK_LISTS_TABLE_ID,
        [Query.equal("user_id", [str(user_id)]), Query.order_asc("order")],
    )
    tasks = list_rows_all(
        TASKS_TABLE_ID,
        [Query.equal("user_id", [str(user_id)]), Query.order_asc("order")],
    )
    completions = list_rows_all(
        TASK_COMPLETIONS_TABLE_ID,
        [Query.equal("user_id", [str(user_id)]), Query.order_asc("completed_at")],
    )
    completions_by_task = defaultdict(list)
    for completion in completions:
        completions_by_task[completion.get("task_id")].append(completion)

    return {
        "lists": [_list_to_payload(row) for row in sorted(lists, key=lambda item: item.get("order") or 0)],
        "tasks": [
            _task_to_payload(row, completions_by_task.get(_row_id(row), []))
            for row in sorted(tasks, key=lambda item: ((item.get("list_id") or ""), item.get("order") or 0))
        ],
        "preferences": _task_preferences_for_user(user_id),
    }


def _task_preferences_for_user(user_id):
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [str(user_id)])],
    )
    return {
        "task_sound_enabled": True if settings is None else bool(settings.get("task_sound_enabled", True)),
    }


def _list_owner_or_404(list_id):
    row = get_row_safe(TASK_LISTS_TABLE_ID, list_id, allow_missing=True)
    if not row or row.get("user_id") != str(current_user.id):
        abort(404)
    return row


def _task_owner_or_404(task_id):
    row = get_row_safe(TASKS_TABLE_ID, task_id, allow_missing=True)
    if not row or row.get("user_id") != str(current_user.id):
        abort(404)
    return row


def _max_order(rows):
    return max((int(row.get("order") or 0) for row in rows), default=0)


def _clean_name(value, fallback="Untitled List"):
    return " ".join(str(value or fallback).strip().split())[:120] or fallback


def _clean_title(value):
    return " ".join(str(value or "").strip().split())[:255]


def _clean_description(value):
    return str(value or "").strip()[:1000]


def _task_updates_from_payload(payload, *, creating=False, existing=None):
    updates = {}
    existing = existing or {}

    if creating or "title" in payload:
        title = _clean_title(payload.get("title"))
        if not title:
            raise ValueError("Task title is required.")
        updates["title"] = title

    if creating or "priority" in payload:
        updates["priority"] = _normalize_priority(payload.get("priority"))

    if creating or "deadline_at" in payload or "deadlineAt" in payload:
        raw_deadline = payload.get("deadline_at", payload.get("deadlineAt"))
        deadline_dt = _parse_iso_datetime(raw_deadline)
        if raw_deadline and not deadline_dt:
            raise ValueError("Deadline must be a valid ISO datetime.")
        updates["deadline_at"] = format_datetime(deadline_dt) if deadline_dt else None
    else:
        deadline_dt = parse_datetime(existing.get("deadline_at"))
        deadline_dt = _coerce_utc(deadline_dt) if deadline_dt else None

    timezone_name = _normalize_timezone(payload.get("timezone", existing.get("timezone") or "UTC"))
    if creating or "timezone" in payload:
        updates["timezone"] = timezone_name

    if creating or "deadline_time" in payload or "deadlineTime" in payload or "deadline_at" in updates:
        updates["deadline_time"] = _normalize_deadline_time(
            payload.get("deadline_time", payload.get("deadlineTime")),
            deadline_dt,
            timezone_name,
        )

    if creating or "recurrence" in payload or "repeat" in payload:
        recurrence_value = payload.get("recurrence", payload.get("repeat"))
        default_start = None
        if deadline_dt:
            default_start = deadline_dt.astimezone(_zoneinfo_or_utc(timezone_name)).date()
        recurrence = _normalize_recurrence(recurrence_value, default_start=default_start)
        updates["recurrence_json"] = json.dumps(recurrence) if recurrence else None

    if "completed" in payload:
        completed = bool(payload.get("completed"))
        updates["completed"] = completed
        updates["completed_at"] = _utcnow_iso() if completed else None

    if creating or "starred" in payload:
        updates["starred"] = bool(payload.get("starred", False))

    return updates


@tasks_api_bp.route("/api/tasks", methods=["GET"])
@login_required
def list_tasks():
    try:
        payload = _load_user_task_payload(str(current_user.id))
    except AppwriteException:
        logger.exception("Failed to load tasks")
        return jsonify({"error": "Unable to load tasks."}), 500
    return jsonify(payload)


@tasks_api_bp.route("/api/task-lists", methods=["POST"])
@login_required
def create_task_list():
    payload = request.get_json(silent=True) or {}
    name = _clean_name(payload.get("name"), "New List")
    try:
        sort_mode = _normalize_sort_mode(payload.get("sort_mode", payload.get("sortMode", "default")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    try:
        existing = list_rows_all(TASK_LISTS_TABLE_ID, [Query.equal("user_id", [str(current_user.id)])])
        now = _utcnow_iso()
        created = create_row_safe(
            TASK_LISTS_TABLE_ID,
            row_id=str(uuid.uuid4()),
            data={
                "user_id": str(current_user.id),
                "name": name,
                "description": _clean_description(payload.get("description")),
                "order": _max_order(existing) + 1000,
                "collapsed": False,
                "hidden": bool(payload.get("hidden", False)),
                "sort_mode": sort_mode,
                "created_at": now,
                "updated_at": now,
            },
        )
    except AppwriteException:
        logger.exception("Failed to create task list")
        return jsonify({"error": "Unable to create list."}), 500
    return jsonify({"list": _list_to_payload(created)}), 201


@tasks_api_bp.route("/api/task-lists/<list_id>", methods=["PATCH"])
@login_required
def update_task_list(list_id):
    _list_owner_or_404(list_id)
    payload = request.get_json(silent=True) or {}
    updates = {}
    if "name" in payload:
        updates["name"] = _clean_name(payload.get("name"))
    if "description" in payload:
        updates["description"] = _clean_description(payload.get("description"))
    if "order" in payload:
        updates["order"] = int(payload.get("order") or 0)
    if "collapsed" in payload:
        updates["collapsed"] = bool(payload.get("collapsed"))
    if "hidden" in payload:
        updates["hidden"] = bool(payload.get("hidden"))
    if "sort_mode" in payload or "sortMode" in payload:
        try:
            updates["sort_mode"] = _normalize_sort_mode(payload.get("sort_mode", payload.get("sortMode")))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
    if not updates:
        return jsonify({"error": "No updatable fields were provided."}), 400
    updates["updated_at"] = _utcnow_iso()

    try:
        updated = update_row_safe(TASK_LISTS_TABLE_ID, list_id, updates)
    except AppwriteException:
        logger.exception("Failed to update task list")
        return jsonify({"error": "Unable to update list."}), 500
    return jsonify({"list": _list_to_payload(updated)})


@tasks_api_bp.route("/api/task-lists/<list_id>", methods=["DELETE"])
@login_required
def delete_task_list(list_id):
    _list_owner_or_404(list_id)
    try:
        tasks = list_rows_all(
            TASKS_TABLE_ID,
            [
                Query.equal("user_id", [str(current_user.id)]),
                Query.equal("list_id", [list_id]),
            ],
        )
        for task in tasks:
            task_id = _row_id(task)
            for completion in _completion_rows_for_task(str(current_user.id), task_id):
                delete_row_safe(TASK_COMPLETIONS_TABLE_ID, _row_id(completion))
            delete_row_safe(TASKS_TABLE_ID, task_id)
        delete_row_safe(TASK_LISTS_TABLE_ID, list_id)
    except AppwriteException:
        logger.exception("Failed to delete task list")
        return jsonify({"error": "Unable to delete list."}), 500
    return jsonify({"ok": True})


@tasks_api_bp.route("/api/task-lists/<list_id>/completed-tasks", methods=["DELETE"])
@login_required
def delete_completed_tasks_in_list(list_id):
    _list_owner_or_404(list_id)
    user_id = str(current_user.id)
    deleted_tasks = 0
    cleared_completions = 0

    try:
        tasks = list_rows_all(
            TASKS_TABLE_ID,
            [
                Query.equal("user_id", [user_id]),
                Query.equal("list_id", [list_id]),
            ],
        )
        for task in tasks:
            task_id = _row_id(task)
            completions = _completion_rows_for_task(user_id, task_id)
            recurrence = _task_recurrence(task)
            if recurrence:
                for completion in completions:
                    delete_row_safe(TASK_COMPLETIONS_TABLE_ID, _row_id(completion))
                    cleared_completions += 1
                continue
            if bool(task.get("completed", False)):
                for completion in completions:
                    delete_row_safe(TASK_COMPLETIONS_TABLE_ID, _row_id(completion))
                    cleared_completions += 1
                delete_row_safe(TASKS_TABLE_ID, task_id)
                deleted_tasks += 1
    except AppwriteException:
        logger.exception("Failed to delete completed tasks")
        return jsonify({"error": "Unable to delete completed tasks."}), 500

    return jsonify({
        "ok": True,
        "deleted_tasks": deleted_tasks,
        "cleared_completions": cleared_completions,
    })


@tasks_api_bp.route("/api/tasks", methods=["POST"])
@login_required
def create_task():
    payload = request.get_json(silent=True) or {}
    list_id = str(payload.get("list_id") or "").strip()
    if not list_id:
        return jsonify({"error": "list_id is required."}), 400
    _list_owner_or_404(list_id)

    try:
        updates = _task_updates_from_payload(payload, creating=True)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    try:
        existing = list_rows_all(
            TASKS_TABLE_ID,
            [
                Query.equal("user_id", [str(current_user.id)]),
                Query.equal("list_id", [list_id]),
            ],
        )
        now = _utcnow_iso()
        created = create_row_safe(
            TASKS_TABLE_ID,
            row_id=str(uuid.uuid4()),
            data={
                "user_id": str(current_user.id),
                "list_id": list_id,
                "order": _max_order(existing) + 1000,
                "completed": False,
                "created_at": now,
                "updated_at": now,
                **updates,
            },
        )
    except AppwriteException:
        logger.exception("Failed to create task")
        return jsonify({"error": "Unable to create task."}), 500
    return jsonify({"task": _task_to_payload(created)}), 201


@tasks_api_bp.route("/api/tasks/<task_id>", methods=["PATCH"])
@login_required
def update_task(task_id):
    task = _task_owner_or_404(task_id)
    payload = request.get_json(silent=True) or {}
    updates = {}

    if "list_id" in payload:
        list_id = str(payload.get("list_id") or "").strip()
        if not list_id:
            return jsonify({"error": "list_id cannot be blank."}), 400
        _list_owner_or_404(list_id)
        updates["list_id"] = list_id

    if "order" in payload:
        updates["order"] = int(payload.get("order") or 0)

    try:
        updates.update(_task_updates_from_payload(payload, existing=task))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not updates:
        return jsonify({"error": "No updatable fields were provided."}), 400
    updates["updated_at"] = _utcnow_iso()

    try:
        updated = update_row_safe(TASKS_TABLE_ID, task_id, updates)
    except AppwriteException:
        logger.exception("Failed to update task")
        return jsonify({"error": "Unable to update task."}), 500
    return jsonify({"task": _task_to_payload(updated, _completion_rows_for_task(str(current_user.id), task_id))})


@tasks_api_bp.route("/api/tasks/<task_id>", methods=["DELETE"])
@login_required
def delete_task(task_id):
    _task_owner_or_404(task_id)
    try:
        for completion in _completion_rows_for_task(str(current_user.id), task_id):
            delete_row_safe(TASK_COMPLETIONS_TABLE_ID, _row_id(completion))
        delete_row_safe(TASKS_TABLE_ID, task_id)
    except AppwriteException:
        logger.exception("Failed to delete task")
        return jsonify({"error": "Unable to delete task."}), 500
    return jsonify({"ok": True})


@tasks_api_bp.route("/api/tasks/<task_id>/complete", methods=["POST"])
@login_required
def complete_task(task_id):
    task = _task_owner_or_404(task_id)
    payload = request.get_json(silent=True) or {}
    completed = bool(payload.get("completed", True))
    recurrence = _task_recurrence(task)

    try:
        if recurrence:
            occurrence_key = str(payload.get("occurrence_key") or _next_occurrence_key(task) or "").strip()
            if not occurrence_key:
                return jsonify({"error": "occurrence_key is required for repeating tasks."}), 400
            existing = _completion_for_occurrence(str(current_user.id), task_id, occurrence_key)
            if completed and not existing:
                create_row_safe(
                    TASK_COMPLETIONS_TABLE_ID,
                    row_id=str(uuid.uuid4()),
                    data={
                        "user_id": str(current_user.id),
                        "task_id": task_id,
                        "occurrence_key": occurrence_key,
                        "completed_at": _utcnow_iso(),
                    },
                )
            elif not completed and existing:
                delete_row_safe(TASK_COMPLETIONS_TABLE_ID, _row_id(existing))
            task_payload = _task_to_payload(task, _completion_rows_for_task(str(current_user.id), task_id))
            return jsonify({"task": task_payload})

        updated = update_row_safe(
            TASKS_TABLE_ID,
            task_id,
            {
                "completed": completed,
                "completed_at": _utcnow_iso() if completed else None,
                "updated_at": _utcnow_iso(),
            },
        )
    except AppwriteException:
        logger.exception("Failed to complete task")
        return jsonify({"error": "Unable to update completion."}), 500

    return jsonify({"task": _task_to_payload(updated)})


@tasks_api_bp.route("/api/tasks/reorder", methods=["PATCH"])
@login_required
def reorder_tasks():
    payload = request.get_json(silent=True) or {}
    list_updates = payload.get("lists") or []
    task_updates = payload.get("tasks") or []
    user_id = str(current_user.id)

    try:
        owned_lists = {
            _row_id(row): row
            for row in list_rows_all(TASK_LISTS_TABLE_ID, [Query.equal("user_id", [user_id])])
        }
        owned_tasks = {
            _row_id(row): row
            for row in list_rows_all(TASKS_TABLE_ID, [Query.equal("user_id", [user_id])])
        }
        for item in list_updates:
            list_id = str(item.get("id") or "")
            if list_id not in owned_lists:
                continue
            updates = {"updated_at": _utcnow_iso()}
            if "order" in item:
                updates["order"] = int(item.get("order") or 0)
            if "collapsed" in item:
                updates["collapsed"] = bool(item.get("collapsed"))
            update_row_safe(TASK_LISTS_TABLE_ID, list_id, updates)

        for item in task_updates:
            task_id = str(item.get("id") or "")
            if task_id not in owned_tasks:
                continue
            updates = {"updated_at": _utcnow_iso()}
            if "list_id" in item:
                list_id = str(item.get("list_id") or "")
                if list_id and list_id in owned_lists:
                    updates["list_id"] = list_id
            if "order" in item:
                updates["order"] = int(item.get("order") or 0)
            update_row_safe(TASKS_TABLE_ID, task_id, updates)
    except AppwriteException:
        logger.exception("Failed to reorder tasks")
        return jsonify({"error": "Unable to reorder tasks."}), 500

    return jsonify({"ok": True})


def _completion_rows_for_task(user_id, task_id):
    if not task_id:
        return []
    return list_rows_all(
        TASK_COMPLETIONS_TABLE_ID,
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("task_id", [task_id]),
        ],
    )


def _completion_for_occurrence(user_id, task_id, occurrence_key):
    return first_row(
        TASK_COMPLETIONS_TABLE_ID,
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("task_id", [task_id]),
            Query.equal("occurrence_key", [occurrence_key]),
        ],
    )


def _add_months(source_date, months):
    month_index = (source_date.month - 1) + months
    year = source_date.year + month_index // 12
    month = month_index % 12 + 1
    day = min(source_date.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def _advance_date(source_date, every, unit):
    if unit == "day":
        return source_date + timedelta(days=every)
    if unit == "week":
        return source_date + timedelta(weeks=every)
    if unit == "month":
        return _add_months(source_date, every)
    return _add_months(source_date, every * 12)


def _deadline_local_parts(task):
    deadline_dt = _coerce_utc(parse_datetime(task.get("deadline_at")))
    tz = _zoneinfo_or_utc(task.get("timezone") or "UTC")
    deadline_time = _normalize_deadline_time(task.get("deadline_time"), deadline_dt, task.get("timezone"))
    if not deadline_time:
        return None, None, tz
    hour, minute = [int(part) for part in deadline_time.split(":", 1)]
    local_date = deadline_dt.astimezone(tz).date() if deadline_dt else None
    return local_date, time(hour, minute), tz


def _occurrence_start(task, occurrence_date):
    _local_date, deadline_time, tz = _deadline_local_parts(task)
    if not deadline_time:
        return None
    local_dt = datetime.combine(occurrence_date, deadline_time, tzinfo=tz)
    return local_dt.astimezone(timezone.utc)


def _next_occurrence_key(task, now=None):
    recurrence = _task_recurrence(task)
    if not recurrence:
        return "single"
    local_deadline_date, _deadline_time, tz = _deadline_local_parts(task)
    start_date = _parse_date(recurrence.get("startDate")) or local_deadline_date or date.today()
    end_date = _parse_date(recurrence.get("endDate")) if recurrence.get("endDate") else None
    every = int(recurrence.get("every") or 1)
    unit = recurrence.get("unit") or "day"
    local_now = (now or _utcnow()).astimezone(tz).date()
    current = start_date
    guard = 0
    while current < local_now and guard < MAX_EXPANDED_OCCURRENCES:
        current = _advance_date(current, every, unit)
        guard += 1
    if end_date and current > end_date:
        return None
    return current.isoformat()


def _event_overlaps_range(start_dt, end_dt, range_start, range_end):
    if not range_start or not range_end:
        return True
    return start_dt < range_end and end_dt > range_start


def _completions_by_task_for_rows(completions):
    result = defaultdict(dict)
    for row in completions:
        result[row.get("task_id")][row.get("occurrence_key")] = row
    return result


def build_task_calendar_events(tasks, completions=None, range_start=None, range_end=None):
    completions_by_task = _completions_by_task_for_rows(completions or [])
    events = []
    for task in tasks:
        task_id = _row_id(task)
        if not task_id or not task.get("deadline_at"):
            continue
        recurrence = _task_recurrence(task)
        if not recurrence:
            start_dt = _coerce_utc(parse_datetime(task.get("deadline_at")))
            if not start_dt:
                continue
            end_dt = start_dt + timedelta(minutes=30)
            if not _event_overlaps_range(start_dt, end_dt, range_start, range_end):
                continue
            events.append(_task_event_payload(task, start_dt, end_dt, "single", bool(task.get("completed", False))))
            continue

        local_deadline_date, _deadline_time, tz = _deadline_local_parts(task)
        start_date = _parse_date(recurrence.get("startDate")) or local_deadline_date
        if not start_date:
            continue
        end_date = _parse_date(recurrence.get("endDate")) if recurrence.get("endDate") else None
        every = int(recurrence.get("every") or 1)
        unit = recurrence.get("unit") or "day"
        if range_start:
            range_local_start = range_start.astimezone(tz).date()
        else:
            range_local_start = date.today() - timedelta(days=30)
        if range_end:
            range_local_end = range_end.astimezone(tz).date()
        else:
            range_local_end = range_local_start + timedelta(days=365)

        occurrence_date = start_date
        guard = 0
        while occurrence_date < range_local_start and guard < MAX_EXPANDED_OCCURRENCES:
            occurrence_date = _advance_date(occurrence_date, every, unit)
            guard += 1

        while guard < MAX_EXPANDED_OCCURRENCES:
            if end_date and occurrence_date > end_date:
                break
            if occurrence_date > range_local_end:
                break
            start_dt = _occurrence_start(task, occurrence_date)
            if start_dt:
                end_dt = start_dt + timedelta(minutes=30)
                occurrence_key = occurrence_date.isoformat()
                if _event_overlaps_range(start_dt, end_dt, range_start, range_end):
                    events.append(
                        _task_event_payload(
                            task,
                            start_dt,
                            end_dt,
                            occurrence_key,
                            occurrence_key in completions_by_task.get(task_id, {}),
                        )
                    )
            occurrence_date = _advance_date(occurrence_date, every, unit)
            guard += 1
    return sorted(events, key=lambda event: event.get("start") or "")


def _task_event_payload(task, start_dt, end_dt, occurrence_key, completed):
    task_id = _row_id(task)
    priority = _normalize_priority(task.get("priority"))
    title = task.get("title") or "Untitled Task"
    priority_label = "" if priority == "none" else priority.title()
    description_parts = ["Task"]
    if priority_label:
        description_parts.append(f"Priority: {priority_label}")
    recurrence = _task_recurrence(task)
    if recurrence:
        description_parts.append("Repeating task")
    return {
        "id": f"task:{task_id}:{occurrence_key}",
        "uid": f"task:{task_id}:{occurrence_key}",
        "event_ref": f"task:{task_id}:{occurrence_key}",
        "source_type": "task",
        "editable": False,
        "title": title,
        "description": " | ".join(description_parts),
        "start": format_datetime(start_dt),
        "end": format_datetime(end_dt),
        "type": "task",
        "course": TASK_CALENDAR_NAME,
        "is_multi_day": False,
        "span_days": 1,
        "is_all_day": False,
        "calendar_id": TASK_CALENDAR_ID,
        "original_calendar_id": TASK_CALENDAR_ID,
        "color": None,
        "task_id": task_id,
        "occurrence_key": occurrence_key,
        "priority": priority,
        "completed": bool(completed),
    }


def task_calendar_events_for_user(user_id, range_start=None, range_end=None):
    tasks = list_rows_all(
        TASKS_TABLE_ID,
        [Query.equal("user_id", [str(user_id)]), Query.order_asc("deadline_at")],
    )
    completions = list_rows_all(
        TASK_COMPLETIONS_TABLE_ID,
        [Query.equal("user_id", [str(user_id)])],
    )
    return build_task_calendar_events(tasks, completions, range_start, range_end)


def user_has_tasks(user_id):
    row = first_row(TASKS_TABLE_ID, [Query.equal("user_id", [str(user_id)])])
    return bool(row)


def task_calendar_source(preferences=None):
    preferences = preferences or []
    pref = next((row for row in preferences if row.get("calendar_name") == TASK_CALENDAR_ID), {})
    return {
        "id": TASK_CALENDAR_ID,
        "kind": "local",
        "default_name": TASK_CALENDAR_NAME,
        "display_name": pref.get("display_name") or "",
        "color_hex": pref.get("color_hex") or TASK_CALENDAR_COLOR,
        "url": "",
        "editable": True,
        "source_id": TASK_CALENDAR_ID,
        "legacy_names": [TASK_CALENDAR_NAME],
    }
