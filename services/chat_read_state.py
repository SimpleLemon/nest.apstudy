"""Chat read-state, visibility and unread workflows with persistence and authorization ports."""
from dataclasses import dataclass
from datetime import datetime, timezone
from logging import Logger
from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime, parse_datetime
from services.row_utils import row_id
from services.time_utils import utcnow
from typing import Callable, Mapping, Protocol
from appwrite.query import Query
from services.chat_contracts import CreateRow, FirstRow, GetRow, ListRows, UpdateRow
from services.database import RowMapping

@dataclass(frozen=True)
class ChatReadStateDependencies:
    current_user_id_fn: Callable[[], str]
    get_row_fn: GetRow
    first_row_fn: FirstRow
    create_row_fn: CreateRow
    update_row_fn: UpdateRow
    delete_row_fn: Callable[[str, object], None]
    list_rows_fn: ListRows
    blocked_user_ids_fn: Callable[[str], set[str]]
    thread_for_user_fn: Callable[[str], RowMapping | None]
    can_access_channel_fn: Callable[[RowMapping | None], bool]
    error_logger: Logger
    summary_scan_limit: int
    unread_cap: int

def read_key(user_id: str, scope_type: str, scope_id: str) -> str:
    return f'{user_id}:{scope_type}:{scope_id}'

def initialize_new_user_discord_read_states(
    user_id: str, *, default_channels_fn, list_rows_all_fn,
    dependencies: ChatReadStateDependencies,
) -> None:
    user_id = str(user_id or '').strip()
    if not user_id:
        return
    default_channels_fn()
    try:
        channels = list_rows_all_fn(COLLECTIONS['chat_channels'], [Query.equal('kind', ['discord'])])
    except AppwriteException:
        dependencies.error_logger.exception('Failed to list Discord channels for onboarding read init')
        return
    for channel in channels:
        channel_id = row_id(channel)
        if not channel_id:
            continue
        latest = latest_visible_message('channel', channel_id, dependencies=dependencies)
        if latest:
            persist_read_state(user_id, 'channel', channel_id, latest, dependencies=dependencies)

def read_state_for_scope(user_id: str, scope_type: str, scope_id: str, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    try:
        return dependencies.first_row_fn(COLLECTIONS['chat_read_states'], [Query.equal('read_key', [read_key(user_id, scope_type, scope_id)])])
    except AppwriteException:
        dependencies.error_logger.exception('Failed to load chat read state')
        return None

def latest_visible_message(scope_type: str, scope_id: str, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    field = message_scope_field(scope_type)
    try:
        rows = dependencies.list_rows_fn(COLLECTIONS['chat_messages'], [Query.equal(field, [scope_id]), Query.order_desc('created_at'), Query.limit(10)])['rows']
    except AppwriteException:
        dependencies.error_logger.exception('Failed to load latest chat message')
        return None
    for row in rows:
        if not row.get('deleted_at'):
            return row
    return None

def message_scope_field(scope_type: str) -> str:
    return 'channel_id' if scope_type == 'channel' else 'thread_id'

def message_in_scope(row: RowMapping | None, scope_type: str, scope_id: str) -> bool:
    return bool(row and row.get(message_scope_field(scope_type)) == scope_id)

def message_for_current_user(message_id: str | None, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    row = dependencies.get_row_fn(COLLECTIONS['chat_messages'], message_id, allow_missing=True)
    if not row or row.get('deleted_at'):
        return None
    channel_id = row.get('channel_id')
    thread_id = row.get('thread_id')
    if channel_id:
        channel = dependencies.get_row_fn(COLLECTIONS['chat_channels'], channel_id, allow_missing=True)
        if not dependencies.can_access_channel_fn(channel):
            return None
    elif thread_id:
        if not dependencies.thread_for_user_fn(thread_id):
            return None
        if str(row.get('user_id') or '') in dependencies.blocked_user_ids_fn(dependencies.current_user_id_fn()):
            return None
    else:
        return None
    return row

def message_visible_for_user(row: RowMapping | None, scope_type: str, blocked_user_ids: set[str] | None=None) -> bool:
    if not row or row.get('deleted_at'):
        return False
    if scope_type == 'thread' and str(row.get('user_id') or '') in (blocked_user_ids or set()):
        return False
    return True

def message_can_be_unread_target(row: RowMapping | None, scope_type: str, user_id: str, blocked_user_ids: set[str] | None=None) -> bool:
    if not message_visible_for_user(row, scope_type, blocked_user_ids):
        return False
    return str(row.get('user_id') or '') != str(user_id)

def persist_read_state(user_id: str, scope_type: str, scope_id: str, latest: RowMapping | None, *, fallback_to_now=True, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    read_key_value = read_key(user_id, scope_type, scope_id)
    last_read_at = latest.get('created_at') if latest else format_datetime(utcnow()) if fallback_to_now else None
    payload = {'user_id': user_id, 'scope_type': scope_type, 'scope_id': scope_id, 'read_key': read_key_value, 'last_read_message_id': row_id(latest) if latest else None, 'last_read_at': last_read_at}
    try:
        existing = dependencies.first_row_fn(COLLECTIONS['chat_read_states'], [Query.equal('read_key', [read_key_value])])
        if existing:
            return dependencies.update_row_fn(COLLECTIONS['chat_read_states'], row_id(existing), payload)
        return dependencies.create_row_fn(COLLECTIONS['chat_read_states'], row_id=ID.unique(), data=payload)
    except AppwriteException:
        dependencies.error_logger.exception('Failed to persist chat read state')
        return None

def mark_read(scope_type: str, scope_id: str, message_id: str | None=None, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    user_id = dependencies.current_user_id_fn()
    latest = None
    if message_id:
        try:
            latest = dependencies.get_row_fn(COLLECTIONS['chat_messages'], message_id, allow_missing=True)
        except AppwriteException:
            latest = None
        if latest:
            if not message_in_scope(latest, scope_type, scope_id) or latest.get('deleted_at'):
                latest = None
    server_latest = latest_visible_message(scope_type, scope_id, dependencies=dependencies)
    if server_latest:
        if not latest or message_timestamp(server_latest) > message_timestamp(latest):
            latest = server_latest
    elif not latest:
        latest = None
    return persist_read_state(user_id, scope_type, scope_id, latest, dependencies=dependencies)

def latest_unread_target(scope_type: str, scope_id: str, user_id: str, blocked_user_ids: set[str] | None, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    field = message_scope_field(scope_type)
    offset = 0
    while True:
        try:
            rows = dependencies.list_rows_fn(COLLECTIONS['chat_messages'], [Query.equal(field, [scope_id]), Query.order_desc('created_at'), Query.limit(dependencies.summary_scan_limit), Query.offset(offset)])['rows']
        except AppwriteException:
            dependencies.error_logger.exception('Failed to load latest unread chat target')
            return None
        for row in rows:
            if message_can_be_unread_target(row, scope_type, user_id, blocked_user_ids):
                return row
        if len(rows) < dependencies.summary_scan_limit:
            return None
        offset += dependencies.summary_scan_limit

def previous_visible_message(scope_type: str, scope_id: str, target: RowMapping, blocked_user_ids: set[str] | None, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    created_at = target.get('created_at') if target else None
    if not created_at:
        return None
    field = message_scope_field(scope_type)
    offset = 0
    while True:
        try:
            rows = dependencies.list_rows_fn(COLLECTIONS['chat_messages'], [Query.equal(field, [scope_id]), Query.less_than('created_at', created_at), Query.order_desc('created_at'), Query.limit(dependencies.summary_scan_limit), Query.offset(offset)])['rows']
        except AppwriteException:
            dependencies.error_logger.exception('Failed to load previous chat read boundary')
            return None
        for row in rows:
            if message_visible_for_user(row, scope_type, blocked_user_ids):
                return row
        if len(rows) < dependencies.summary_scan_limit:
            return None
        offset += dependencies.summary_scan_limit

def clear_read_state(user_id: str, scope_type: str, scope_id: str, *, dependencies: ChatReadStateDependencies):
    read_key_value = read_key(user_id, scope_type, scope_id)
    try:
        existing = dependencies.first_row_fn(COLLECTIONS['chat_read_states'], [Query.equal('read_key', [read_key_value])])
        if existing:
            dependencies.delete_row_fn(COLLECTIONS['chat_read_states'], row_id(existing))
    except AppwriteException:
        dependencies.error_logger.exception('Failed to clear chat read state')
    return None

def mark_unread(scope_type: str, scope_id: str, message_id: str | None=None, *, dependencies: ChatReadStateDependencies) -> RowMapping | None:
    user_id = dependencies.current_user_id_fn()
    blocked_user_ids = dependencies.blocked_user_ids_fn(user_id) if scope_type == 'thread' else set()
    target = None
    if message_id:
        try:
            candidate = dependencies.get_row_fn(COLLECTIONS['chat_messages'], message_id, allow_missing=True)
        except AppwriteException:
            candidate = None
        if message_in_scope(candidate, scope_type, scope_id) and message_can_be_unread_target(candidate, scope_type, user_id, blocked_user_ids):
            target = candidate
    if not target:
        target = latest_unread_target(scope_type, scope_id, user_id, blocked_user_ids, dependencies=dependencies)
    if not target:
        return read_state_for_scope(user_id, scope_type, scope_id, dependencies=dependencies)
    previous = previous_visible_message(scope_type, scope_id, target, blocked_user_ids, dependencies=dependencies)
    if previous:
        return persist_read_state(user_id, scope_type, scope_id, previous, fallback_to_now=False, dependencies=dependencies)
    clear_read_state(user_id, scope_type, scope_id, dependencies=dependencies)
    return {}

def unread_count(scope_type: str, scope_id: str, user_id: str, last_read_at: str | None, *, dependencies: ChatReadStateDependencies) -> tuple[int, bool]:
    field = message_scope_field(scope_type)
    offset = 0
    blocked_user_ids = dependencies.blocked_user_ids_fn(user_id) if scope_type == 'thread' else set()
    count = 0
    while True:
        queries = [Query.equal(field, [scope_id]), Query.order_desc('created_at'), Query.limit(dependencies.summary_scan_limit), Query.offset(offset)]
        if last_read_at:
            queries.insert(1, Query.greater_than('created_at', last_read_at))
        try:
            rows = dependencies.list_rows_fn(COLLECTIONS['chat_messages'], queries)['rows']
        except AppwriteException:
            dependencies.error_logger.exception('Failed to count unread chat messages')
            return (0, False)
        for row in rows:
            if row.get('deleted_at'):
                continue
            message_user_id = str(row.get('user_id') or '')
            if message_user_id == str(user_id):
                continue
            if message_user_id in blocked_user_ids:
                continue
            count += 1
            if count >= dependencies.unread_cap:
                return (dependencies.unread_cap, True)
        if len(rows) < dependencies.summary_scan_limit:
            return (count, False)
        offset += dependencies.summary_scan_limit

def message_timestamp(row: RowMapping | None) -> datetime:
    value = parse_datetime(row.get('created_at')) or datetime.min.replace(tzinfo=timezone.utc)
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
