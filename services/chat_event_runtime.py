"""Stateless helpers for reading and projecting chat events.

The chat blueprint supplies persistence, authorization, and identity callbacks.
Keeping those dependencies at the boundary makes event queries directly
testable without moving the SSE listener lifecycle out of the blueprint.
"""


from services.chat_contracts import ListRows
from services.database import RowMapping


def event_visible_for_user(
    event,
    *,
    current_user_fn,
    current_user_id_fn,
    get_row_fn,
    channels_collection,
    can_access_channel_fn,
    thread_accessible_by_user_fn,
    school_payload_fn,
):
    scope_type = (event or {}).get("scope_type")
    scope_id = (event or {}).get("scope_id")
    if not scope_type or not scope_id:
        return False

    user_id = current_user_id_fn()
    if scope_type == "channel":
        channel = get_row_fn(channels_collection, scope_id, allow_missing=True)
        return can_access_channel_fn(channel)
    if scope_type == "thread":
        return thread_accessible_by_user_fn(scope_id, user_id)
    if scope_type == "university":
        current_user = current_user_fn()
        school = school_payload_fn(current_user.school)
        user_school_key = school.get("school_key") or getattr(current_user, "school_key", None)
        return bool(user_school_key) and user_school_key == scope_id
    return False


def serialize_chat_event(row, *, row_id_fn):
    event_id = row_id_fn(row)
    return {
        "$id": event_id,
        "id": event_id,
        "scope_type": row.get("scope_type"),
        "scope_id": row.get("scope_id"),
        "event_type": row.get("event_type"),
        "message_id": row.get("message_id"),
        "thread_id": row.get("thread_id"),
        "channel_id": row.get("channel_id"),
        "actor_id": row.get("actor_id"),
        "created_at": row.get("created_at"),
    }


class ChatEventPage(list[RowMapping]):
    """Visible events and the last examined cursor, including hidden rows."""

    def __init__(self, rows=(), *, scan_cursor: tuple[str, str] | None = None):
        super().__init__(rows)
        self.scan_cursor = scan_cursor


def list_chat_events_after(
    since: str | None = None,
    after_id: str | None = None,
    *,
    limit: int,
    max_limit: int,
    scan_multiplier: int,
    max_scan: int,
    query_cls,
    list_rows_fn: ListRows,
    events_collection: str,
    appwrite_exception: type[Exception],
    error_logger,
    event_visible_for_user_fn,
    row_id_fn,
) -> ChatEventPage:
    limit = min(max(int(limit), 1), max_limit)
    scan_budget = min(max(limit * scan_multiplier, limit), max_scan)
    visible = []
    seen_ids = set()
    visibility_cache = {}
    scanned = 0
    scan_cursor = (since, after_id) if since and after_id else None
    if since and after_id:
        query_stages = [
            [query_cls.equal("created_at", [since]), query_cls.greater_than("$id", after_id)],
            [query_cls.greater_than("created_at", since)],
        ]
    elif since:
        query_stages = [[query_cls.greater_than_equal("created_at", since)]]
    else:
        query_stages = [[]]

    for constraints in query_stages:
        offset = 0
        while scanned < scan_budget and len(visible) < limit:
            batch_limit = min(limit, scan_budget - scanned)
            queries = [*constraints, query_cls.order_asc("created_at"), query_cls.order_asc("$id"), query_cls.limit(batch_limit)]
            if offset:
                queries.append(query_cls.offset(offset))
            try:
                rows = list_rows_fn(
                    events_collection,
                    queries,
                )["rows"]
            except appwrite_exception:
                error_logger.exception("Failed to list chat events")
                return ChatEventPage(visible, scan_cursor=scan_cursor)
            if not rows:
                break
            scanned_before_batch = scanned
            for row in rows:
                row_id = row_id_fn(row)
                if not row_id or row_id in seen_ids:
                    continue
                seen_ids.add(row_id)
                scanned += 1
                created_at = row.get("created_at") or ""
                candidate_cursor = (created_at, row_id)
                if scan_cursor is None or candidate_cursor > scan_cursor:
                    scan_cursor = candidate_cursor
                if since and created_at == since and after_id and row_id <= after_id:
                    continue
                scope_key = (row.get("scope_type"), row.get("scope_id"))
                if all(scope_key):
                    if scope_key not in visibility_cache:
                        visibility_cache[scope_key] = event_visible_for_user_fn(row)
                    row_visible = visibility_cache[scope_key]
                else:
                    row_visible = event_visible_for_user_fn(row)
                if row_visible:
                    visible.append(row)
                    if len(visible) >= limit:
                        break
            if scanned == scanned_before_batch or len(rows) < batch_limit or len(visible) >= limit:
                break
            offset += len(rows)
    return ChatEventPage(visible, scan_cursor=scan_cursor)
