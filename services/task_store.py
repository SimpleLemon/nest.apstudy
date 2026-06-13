import json
import uuid

from appwrite.exception import AppwriteException

from services import database


def _query(method, attribute=None, values=None):
    payload = {"method": method}
    if attribute is not None:
        payload["attribute"] = attribute
    if values is not None:
        payload["values"] = values
    return json.dumps(payload)


def _now():
    return database.utcnow_iso()


def _id():
    return uuid.uuid4().hex


def _owned_row(table_id, row_id, user_id):
    row = database.get_row(table_id, row_id, allow_missing=True)
    if not row or str(row.get("user_id")) != str(user_id):
        raise AppwriteException("Row not found", 404)
    return row


def get_task_lists(user_id, include_hidden=True):
    queries = [_query("equal", "user_id", [str(user_id)]), _query("orderAsc", "order")]
    if not include_hidden:
        queries.insert(1, _query("equal", "hidden", [False]))
    return database.list_rows_all("task_lists", queries)


def create_task_list(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("task_lists", row_id=(data or {}).get("id") or _id(), data=payload)


def update_task_list(list_id, user_id, data):
    _owned_row("task_lists", list_id, user_id)
    return database.update_row("task_lists", list_id, {**(data or {}), "updated_at": _now()})


def delete_task_list(list_id, user_id):
    _owned_row("task_lists", list_id, user_id)
    database.delete_row("task_lists", list_id)


def get_tasks(user_id, filters=None):
    filters = filters or {}
    queries = [_query("equal", "user_id", [str(user_id)])]
    if filters.get("list_id"):
        queries.append(_query("equal", "list_id", [str(filters["list_id"])]))
    if "completed" in filters:
        queries.append(_query("equal", "completed", [bool(filters["completed"])]))
    if "starred" in filters:
        queries.append(_query("equal", "starred", [bool(filters["starred"])]))
    queries.append(_query("orderAsc", filters.get("order_by") or "order"))
    return database.list_rows_all("tasks", queries)


def create_task(user_id, data):
    now = _now()
    payload = {
        **(data or {}),
        "user_id": str(user_id),
        "created_at": (data or {}).get("created_at") or now,
        "updated_at": (data or {}).get("updated_at") or now,
    }
    return database.create_row("tasks", row_id=(data or {}).get("id") or _id(), data=payload)


def update_task(task_id, user_id, data):
    _owned_row("tasks", task_id, user_id)
    return database.update_row("tasks", task_id, {**(data or {}), "updated_at": _now()})


def delete_task(task_id, user_id):
    _owned_row("tasks", task_id, user_id)
    database.delete_row("tasks", task_id)


def get_task_completions(user_id, task_id=None):
    queries = [_query("equal", "user_id", [str(user_id)])]
    if task_id:
        queries.append(_query("equal", "task_id", [str(task_id)]))
    queries.append(_query("orderAsc", "completed_at"))
    return database.list_rows_all("task_completions", queries)


def create_task_completion(user_id, data):
    payload = {**(data or {}), "user_id": str(user_id), "completed_at": (data or {}).get("completed_at") or _now()}
    return database.create_row("task_completions", row_id=(data or {}).get("id") or _id(), data=payload)


def delete_task_completion(completion_id, user_id):
    _owned_row("task_completions", completion_id, user_id)
    database.delete_row("task_completions", completion_id)
