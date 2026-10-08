"""Discord persistence and synchronization, composed at their service owner."""
from dataclasses import dataclass
from datetime import datetime
from logging import Logger
from typing import Callable, Mapping, Protocol
from appwrite.query import Query
from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime, parse_datetime
from services.row_utils import row_id as persisted_row_id
from services.time_utils import utcnow
from services.chat_discord_formatting import discord_message_row_id, discord_message_external_id
from services.chat_read_state import message_timestamp
from config import EnvironmentConfig
from services.chat_contracts import CreateRow, EmitChatEvent, FirstRow, GetRow, InsertRow, ListAllRows, UpdateRow
from services.database import RowMapping
from services.storage_backend import require_mutations_enabled
from services.storage_errors import StorageError
DISCORD_SYNC_COMPARE_FIELDS = ('channel_id', 'source', 'external_id', 'author_name', 'author_username', 'author_avatar_url', 'content', 'rendered_html', 'link_preview_json', 'discord_message_id', 'discord_webhook_id', 'created_at')

class DiscordMessagePayload(Protocol):

    def __call__(self, channel: RowMapping, message: RowMapping, *, partial: bool=False) -> RowMapping | None:
        ...

@dataclass(frozen=True)
class DiscordSyncDependencies:
    runtime_environment_config_fn: Callable[[], EnvironmentConfig]
    get_row_fn: GetRow
    first_row_fn: FirstRow
    create_row_fn: CreateRow
    insert_row_ignore_fn: InsertRow
    update_row_fn: UpdateRow
    delete_row_fn: Callable[[str, object], None]
    list_rows_all_fn: ListAllRows
    emit_chat_event_fn: EmitChatEvent
    delete_message_attachments_fn: Callable[[str], None]
    fetch_channel_messages_fn: Callable[[str, int], list[RowMapping]]
    discord_message_payload_fn: DiscordMessagePayload
    logger: Logger
    discord_message_limit: int
    partial_create_required_fields: tuple[str, ...]

def ensure_discord_channel(row_id, name, label, channel_id, read_only, *, dependencies: DiscordSyncDependencies):
    now = format_datetime(utcnow())
    existing = dependencies.get_row_fn(COLLECTIONS['chat_channels'], row_id, allow_missing=True)
    stable_payload = {'kind': 'discord', 'name': name, 'label': label, 'section': 'nest', 'discord_channel_id': channel_id, 'read_only': read_only, 'approved': True}
    if existing:
        if all((existing.get(key) == value for key, value in stable_payload.items())):
            return existing
        return dependencies.update_row_fn(COLLECTIONS['chat_channels'], row_id, {**stable_payload, 'updated_at': now})
    return dependencies.create_row_fn(COLLECTIONS['chat_channels'], row_id=row_id, data={**stable_payload, 'created_at': now, 'updated_at': now})

def default_channels(*, dependencies: DiscordSyncDependencies):
    channels = []
    configured = dependencies.runtime_environment_config_fn()
    announcements_id = (configured.discord_announcements_channel_id or '').strip()
    chat_id = (configured.discord_chat_channel_id or '').strip()
    try:
        if announcements_id:
            channels.append(ensure_discord_channel('nest_announcements', 'nest-announcements', 'Nest Announcements', announcements_id, True, dependencies=dependencies))
        if chat_id:
            channels.append(ensure_discord_channel('nest_chat', 'chat', 'Chat', chat_id, False, dependencies=dependencies))
    except AppwriteException:
        dependencies.logger.exception('Failed to ensure default chat channels')
    return channels

def discord_message_changes(existing, payload, *, compare_fields: tuple[str, ...]=DISCORD_SYNC_COMPARE_FIELDS):
    changes = {}
    for key in compare_fields:
        if key not in payload:
            continue
        incoming = payload.get(key)
        if existing.get(key) != incoming:
            changes[key] = incoming
    if changes:
        changes['updated_at'] = payload.get('updated_at')
    return changes

def find_discord_message_row(row_id, external_id, *, dependencies: DiscordSyncDependencies):
    existing = None
    if row_id:
        existing = dependencies.get_row_fn(COLLECTIONS['chat_messages'], row_id, allow_missing=True)
    if not existing and external_id:
        existing = dependencies.first_row_fn(COLLECTIONS['chat_messages'], [Query.equal('external_id', [external_id])])
    return existing

def apply_discord_message_changes(existing, payload, message, *, partial=False, emit_event=False, channel=None, dependencies: DiscordSyncDependencies):
    channel_id = payload.get('channel_id')
    row_id = persisted_row_id(existing)
    changes = discord_message_changes(existing, payload)
    if existing.get('user_id'):
        for field in ('content', 'rendered_html', 'link_preview_json', 'author_name', 'author_username', 'author_avatar_url'):
            changes.pop(field, None)
    if partial and (not changes) and message.get('edited_timestamp'):
        changes = {'updated_at': payload.get('updated_at')}
    if not changes:
        return (existing, False)
    try:
        row = dependencies.update_row_fn(COLLECTIONS['chat_messages'], row_id, changes)
    except AppwriteException:
        return (existing, False)
    if emit_event:
        dependencies.emit_chat_event_fn('channel', channel_id, 'message_updated', message_id=row_id, channel_id=channel_id, channel=channel)
    return (row, False)

def log_discord_upsert_failure(row_id, external_id, discord_id, changes, *, logger):
    logger.error('Failed to upsert Discord message row_id=%s external_id=%s discord_message_id=%s changed_fields=%s value_lengths=%s', row_id, external_id, discord_id, sorted((changes or {}).keys()), {key: len(value) if isinstance(value, str) else None for key, value in (changes or {}).items()})

def upsert_discord_message(channel, message, emit_event=False, *, partial=False, dependencies: DiscordSyncDependencies):
    payload = dependencies.discord_message_payload_fn(channel, message, partial=partial)
    if not payload:
        return (None, False)
    channel_id = payload.get('channel_id')
    external_id = payload.get('external_id')
    discord_id = payload.get('discord_message_id')
    row_id = discord_message_row_id(channel, discord_id)
    existing = find_discord_message_row(row_id, external_id, dependencies=dependencies)
    if existing:
        return apply_discord_message_changes(existing, payload, message, partial=partial, emit_event=emit_event, channel=channel, dependencies=dependencies)
    if partial and any((key not in payload for key in dependencies.partial_create_required_fields)):
        dependencies.logger.info('Skipping partial Discord message update for unknown message %s', discord_id)
        return (None, False)
    insert_id = row_id or ID.unique()
    inserted = dependencies.insert_row_ignore_fn(COLLECTIONS['chat_messages'], row_id=insert_id, data=payload)
    if inserted:
        row = dependencies.get_row_fn(COLLECTIONS['chat_messages'], insert_id)
        if emit_event:
            dependencies.emit_chat_event_fn('channel', channel_id, 'message_created', message_id=persisted_row_id(row), channel_id=channel_id, channel=channel)
        return (row, True)
    existing = find_discord_message_row(insert_id, external_id, dependencies=dependencies)
    if existing:
        return apply_discord_message_changes(existing, payload, message, partial=partial, emit_event=emit_event, channel=channel, dependencies=dependencies)
    log_discord_upsert_failure(row_id, external_id, discord_id, payload, logger=dependencies.logger)
    return (None, False)

def soft_delete_discord_message(channel, discord_message_id, *, emit_event=False, dependencies: DiscordSyncDependencies):
    if not channel or not discord_message_id:
        return None
    channel_id = persisted_row_id(channel)
    external_id = discord_message_external_id(channel, discord_message_id)
    row_id = discord_message_row_id(channel, discord_message_id)
    try:
        require_mutations_enabled()
        row = None
        if row_id:
            row = dependencies.get_row_fn(COLLECTIONS['chat_messages'], row_id, allow_missing=True)
        if not row and external_id:
            row = dependencies.first_row_fn(COLLECTIONS['chat_messages'], [Query.equal('external_id', [external_id])])
        if not row:
            row = dependencies.first_row_fn(COLLECTIONS['chat_messages'], [Query.equal('channel_id', [channel_id]), Query.equal('discord_message_id', [str(discord_message_id)])])
        if not row or row.get('deleted_at'):
            return row
        deleted_at = format_datetime(utcnow())
        dependencies.delete_message_attachments_fn(persisted_row_id(row))
        dependencies.update_row_fn(COLLECTIONS['chat_messages'], persisted_row_id(row), {'deleted_at': deleted_at, 'deleted_by': 'discord', 'updated_at': deleted_at})
        if emit_event:
            dependencies.emit_chat_event_fn('channel', channel_id, 'message_deleted', message_id=persisted_row_id(row), channel_id=channel_id, actor_id='discord', channel=channel)
        return row
    except (AppwriteException, StorageError):
        dependencies.logger.exception('Failed to soft-delete Discord message %s', discord_message_id)
        return None

def reconcile_discord_deletes(channel, discord_messages, *, emit_events=False, dependencies: DiscordSyncDependencies):
    if not channel or not discord_messages:
        return 0
    channel_id = persisted_row_id(channel)
    discord_ids = {str(message.get('id')) for message in discord_messages if message.get('id')}
    oldest_ts = None
    for message in discord_messages:
        timestamp = message.get('timestamp')
        if not timestamp:
            continue
        parsed = parse_datetime(timestamp)
        if parsed and (oldest_ts is None or parsed < oldest_ts):
            oldest_ts = parsed
    if oldest_ts is None:
        return 0
    try:
        rows = dependencies.list_rows_all_fn(COLLECTIONS['chat_messages'], [Query.equal('channel_id', [channel_id])])
    except AppwriteException:
        dependencies.logger.exception('Failed to list Discord chat messages for delete reconciliation')
        return 0
    deleted_count = 0
    for row in rows:
        if row.get('deleted_at'):
            continue
        if (row.get('source') or '') != 'discord':
            continue
        discord_message_id = row.get('discord_message_id')
        if not discord_message_id:
            continue
        if str(discord_message_id) in discord_ids:
            continue
        created = message_timestamp(row)
        if created < oldest_ts:
            continue
        result = soft_delete_discord_message(channel, discord_message_id, emit_event=emit_events, dependencies=dependencies)
        if result is not None and (not result.get('deleted_at')):
            deleted_count += 1
    return deleted_count

def sync_discord_channel(channel, emit_events=False, emit_delete_events=None, *, dependencies: DiscordSyncDependencies):
    discord_channel_id = channel.get('discord_channel_id')
    if not discord_channel_id:
        return (0, 0)
    if emit_delete_events is None:
        emit_delete_events = emit_events
    messages = dependencies.fetch_channel_messages_fn(discord_channel_id, dependencies.discord_message_limit)
    created_count = 0
    for message in messages:
        _, created = upsert_discord_message(channel, message, emit_event=emit_events, dependencies=dependencies)
        if created:
            created_count += 1
    deleted_count = reconcile_discord_deletes(channel, messages, emit_events=emit_delete_events, dependencies=dependencies)
    prune_discord_messages(persisted_row_id(channel), dependencies=dependencies)
    return (created_count, deleted_count)

def sync_discord_channels(emit_events=True, emit_delete_events=None, *, dependencies: DiscordSyncDependencies):
    default_channels(dependencies=dependencies)
    try:
        channels = dependencies.list_rows_all_fn(COLLECTIONS['chat_channels'], [Query.equal('kind', ['discord'])])
    except AppwriteException:
        dependencies.logger.exception('Failed to list Discord chat channels for sync')
        return (0, 0)
    created_count = 0
    deleted_count = 0
    for channel in channels:
        if not can_sync_discord_channel(channel):
            continue
        created, deleted = sync_discord_channel(channel, emit_events=emit_events, emit_delete_events=emit_delete_events, dependencies=dependencies)
        created_count += created
        deleted_count += deleted
    return (created_count, deleted_count)

def ingest_discord_gateway_message(message, *, event_type='create', dependencies: DiscordSyncDependencies):
    channel = discord_channel_for_discord_id((message or {}).get('channel_id'), dependencies=dependencies)
    if not can_sync_discord_channel(channel):
        return (None, False)
    partial = event_type == 'update'
    row, created = upsert_discord_message(channel, message, emit_event=True, partial=partial, dependencies=dependencies)
    if row:
        prune_discord_messages(persisted_row_id(channel), dependencies=dependencies)
    return (row, created)

def delete_discord_gateway_message(discord_channel_id, discord_message_id, *, dependencies: DiscordSyncDependencies):
    channel = discord_channel_for_discord_id(discord_channel_id, dependencies=dependencies)
    if not can_sync_discord_channel(channel):
        return None
    row = soft_delete_discord_message(channel, discord_message_id, emit_event=True, dependencies=dependencies)
    if row is None:
        dependencies.logger.warning('Discord delete received for channel %s message %s but no matching chat row was found.', discord_channel_id, discord_message_id)
    return row

def delete_discord_gateway_messages(discord_channel_id, discord_message_ids, *, dependencies: DiscordSyncDependencies):
    deleted = 0
    for message_id in discord_message_ids or []:
        row = delete_discord_gateway_message(discord_channel_id, message_id, dependencies=dependencies)
        if row:
            deleted += 1
    return deleted

def can_sync_discord_channel(channel):
    return bool(channel and channel.get('kind') == 'discord' and channel.get('discord_channel_id'))

def discord_channel_for_discord_id(discord_channel_id, *, dependencies: DiscordSyncDependencies):
    if not discord_channel_id:
        return None
    try:
        channel = dependencies.first_row_fn(COLLECTIONS['chat_channels'], [Query.equal('discord_channel_id', [str(discord_channel_id)])])
        if channel:
            return channel
        default_channels(dependencies=dependencies)
        return dependencies.first_row_fn(COLLECTIONS['chat_channels'], [Query.equal('discord_channel_id', [str(discord_channel_id)])])
    except AppwriteException:
        dependencies.logger.exception('Failed to resolve Discord chat channel %s', discord_channel_id)
        return None

def prune_discord_messages(channel_id, *, dependencies: DiscordSyncDependencies):
    try:
        require_mutations_enabled()
        rows = dependencies.list_rows_all_fn(COLLECTIONS['chat_messages'], [Query.equal('channel_id', [channel_id]), Query.order_desc('created_at')])
    except (AppwriteException, StorageError):
        return
    for row in rows[dependencies.discord_message_limit:]:
        try:
            dependencies.delete_message_attachments_fn(persisted_row_id(row))
            dependencies.delete_row_fn(COLLECTIONS['chat_messages'], persisted_row_id(row))
        except (AppwriteException, StorageError):
            dependencies.logger.exception('Failed to prune old Discord message')
