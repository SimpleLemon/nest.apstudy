"""Non-HTTP orchestration for chat delivery routes.

The chat blueprint owns request parsing, authentication, CSRF, response
construction, and status mapping.  This module owns the ordered persistence
and side-effect workflows behind those adapters.  Persistence, authorization and transport alternatives remain explicit ports.
"""
import json
import re
from dataclasses import dataclass
from datetime import datetime
from logging import Logger
from typing import Any, Callable, Mapping
from appwrite.query import Query
from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime
from services.time_utils import utcnow
from services.row_utils import row_id
from services.chat_attachments import AttachmentError
from services.chat_threads import thread_participant_ids
from services.chat_read_state import message_timestamp
from services.chat_discord_formatting import discord_message_row_id, discord_message_external_id
from services.chat_formatting import extract_links, fetch_link_preview, render_markdown, url_hash
from services.chat_contracts import AttachmentBytes, BindAttachments, CreateRow, EmitChatEvent, FirstRow, GetRow, InsertRow, NotifyChatUser, SendChatWebhook, UpdateRow
from services.database import RowMapping
from services.storage_backend import chat_attachments_enabled, require_mutations_enabled
from services.storage_errors import StorageError
DISCORD_SMALL_ATTACHMENT_LIMIT = 10 * 1024 * 1024

class DiscordDeliveryError(RuntimeError):
    """A Discord webhook operation failed and should map to HTTP 502."""

class MessagePersistenceError(RuntimeError):
    """A channel message could not be persisted or finalized."""

class AttachmentBindingError(RuntimeError):
    """A message attachment could not be bound after message creation."""

class DirectMessagePersistenceError(RuntimeError):
    """A DM message failed after its media payload was accepted."""

class MessageNotFoundError(LookupError):
    pass

class MessageOwnershipError(PermissionError):
    pass

class MessageExpiredError(PermissionError):
    pass

class DirectMessageBlockedError(PermissionError):
    pass

class PendingAttachmentNotFoundError(LookupError):
    pass

class AttachmentOwnershipError(PermissionError):
    pass

class AttachmentUnavailableError(LookupError):
    pass

@dataclass(frozen=True)
class MessageAuthor:
    id: str
    name: str | None
    username: str | None
    picture_url: str | None

@dataclass(frozen=True)
class MessageMedia:
    content: str
    attachment_ids: list[str]
    gif: Mapping[str, Any] | None

@dataclass
class ChannelDelivery:
    """External operations needed by this workflow."""
    get_row_fn: GetRow
    create_row_fn: CreateRow
    insert_row_ignore_fn: InsertRow
    delete_row_fn: Callable[[str, object], None]
    get_attachment_fn: Callable[[str], RowMapping | None]
    attachment_bytes_fn: AttachmentBytes
    bind_pending_fn: BindAttachments
    emit_chat_event_fn: EmitChatEvent
    find_discord_message_row_fn: Callable[[str | None, str | None], RowMapping | None]
    prune_discord_fn: Callable[[str], None]
    execute_chat_webhook_fn: SendChatWebhook
    notification_fn: NotifyChatUser
    invite_activation_fn: Callable[[str, str], RowMapping | None]
    first_row_fn: FirstRow
    logger: Logger
    attachment_base_url: str

@dataclass
class DirectDelivery:
    """External operations needed by this workflow."""
    first_row_fn: FirstRow
    create_row_fn: CreateRow
    update_row_fn: UpdateRow
    delete_row_fn: Callable[[str, object], None]
    bind_pending_fn: BindAttachments
    delete_message_attachments_fn: Callable[[str], None]
    emit_chat_event_fn: EmitChatEvent
    notification_fn: NotifyChatUser
    invite_activation_fn: Callable[[str, str], RowMapping | None]
    is_blocked_between_fn: Callable[[str, str], bool]
    logger: Logger

@dataclass
class MessageDeletion:
    """External operations needed by this workflow."""
    get_row_fn: GetRow
    update_row_fn: UpdateRow
    delete_message_attachments_fn: Callable[[str], None]
    emit_chat_event_fn: EmitChatEvent
    delete_webhook_message_fn: Callable[[str | None, str], bool]
    logger: Logger
    delete_window_seconds: int
    audit_delete_fn: Callable[[Mapping[str, Any], str], None]

@dataclass
class BlockManagement:
    """External operations needed by this workflow."""
    create_row_fn: CreateRow
    delete_row_fn: Callable[[str, object], None]
    emit_chat_event_fn: EmitChatEvent
    first_row_fn: FirstRow
    threads_for_current_user_fn: Callable[[], list[Mapping[str, Any]]]
    logger: Logger

def list_room_messages(scope_type, scope_id, before, after, after_message_id, *, before_message_id=None, list_messages_fn, page_size, history_limited=False):
    """Load a channel/DM page and preserve the cursor pagination contract."""
    cursor_options = {'after_message_id': after_message_id}
    if before_message_id:
        cursor_options['before_message_id'] = before_message_id
    rows = list_messages_fn(scope_type, scope_id, before, after, **cursor_options)
    has_more = not after and (not after_message_id) and (not history_limited) and (len(rows) == page_size)
    return (rows, has_more)

def list_threads_for_current_user(user_id, *, list_rows_all_fn, query_cls, threads_collection, appwrite_exception, error_logger):
    """List both participant directions and de-duplicate thread rows."""
    try:
        rows_a = list_rows_all_fn(threads_collection, [query_cls.equal('participant_a', [user_id])])
        rows_b = list_rows_all_fn(threads_collection, [query_cls.equal('participant_b', [user_id])])
    except appwrite_exception:
        error_logger.exception('Failed to list DM threads')
        return []
    return list({str(row.get('$id') or row.get('id')): row for row in rows_a + rows_b}.values())

def list_thread_payloads(threads, *, thread_payload_fn):
    payload = []
    for thread in threads:
        item = thread_payload_fn(thread)
        if item:
            payload.append(item)
    payload.sort(key=lambda item: item.get('last_message_at') or '', reverse=True)
    return payload

def search_direct_message_users(query, *, current_user_id, list_rows_all_fn, query_cls, users_collection, row_id_fn, public_user_fn, appwrite_exception, error_logger):
    """Search the same user fields and apply the same result cap as before."""
    if len(query) < 2:
        return []
    try:
        users = list_rows_all_fn(users_collection, [query_cls.order_desc('created_at')], limit=100)
    except appwrite_exception:
        error_logger.exception('Failed to search DM users')
        return []
    results = []
    for user in users:
        if row_id_fn(user) == current_user_id:
            continue
        haystack = ' '.join([user.get('name') or '', user.get('username') or '', user.get('school') or '', user.get('major') or '', user.get('graduation_year') or '', user.get('class_year') or '']).lower()
        if query in haystack:
            results.append(public_user_fn(user))
        if len(results) >= 20:
            break
    return results

def create_direct_thread(other_user_id, *, get_or_create_thread_fn, current_user_id, emit_chat_event_fn=None, row_id_fn, thread_participant_ids_fn):
    thread = get_or_create_thread_fn(other_user_id)
    thread_id = row_id_fn(thread)
    if emit_chat_event_fn is not None:
        emit_chat_event_fn('thread', thread_id, 'thread_updated', thread_id=thread_id, actor_id=current_user_id, readable_user_ids=thread_participant_ids_fn(thread))
    return thread

def attachment_scope_access(scope_type, scope_id, *, get_row_fn, collections, can_access_channel_fn, thread_for_user_fn):
    if scope_type == 'channel':
        channel = get_row_fn(collections['chat_channels'], str(scope_id), allow_missing=True)
        return bool(can_access_channel_fn(channel))
    if scope_type == 'thread':
        return bool(thread_for_user_fn(str(scope_id)))
    return False

def can_access_attachment(row, *, current_user_id, attachment_scope_access_fn):
    if not row:
        return False
    if row.get('status') == 'pending':
        return str(row.get('user_id') or '') == current_user_id and attachment_scope_access_fn(row.get('scope_type'), row.get('scope_id'))
    return row.get('status') == 'active' and attachment_scope_access_fn(row.get('scope_type'), row.get('scope_id'))

def create_chat_attachment(*, user_id, scope_type, scope_id, uploaded_file, entitlements, original_size, upload_encoding, create_attachment_fn):
    return create_attachment_fn(user_id=user_id, scope_type=scope_type, scope_id=scope_id, uploaded_file=uploaded_file, entitlements=entitlements, original_size=original_size, upload_encoding=upload_encoding)

def cancel_pending_attachment(attachment_id, *, get_attachment_fn, current_user_id, delete_attachment_fn):
    row = get_attachment_fn(attachment_id)
    if not row or row.get('status') != 'pending':
        raise PendingAttachmentNotFoundError
    if str(row.get('user_id') or '') != current_user_id:
        raise AttachmentOwnershipError
    delete_attachment_fn(row)

def read_attachment(attachment_id, *, preview, get_attachment_fn, can_access_attachment_fn, attachment_bytes_fn):
    row = get_attachment_fn(attachment_id)
    if not can_access_attachment_fn(row):
        raise AttachmentUnavailableError
    row = dict(row)
    if preview and row.get('kind') not in {'image', 'pdf'}:
        raise AttachmentUnavailableError
    use_preview_file = preview and row.get('kind') == 'pdf'
    if use_preview_file:
        data = attachment_bytes_fn(row, preview=True)
    else:
        data = attachment_bytes_fn(row)
    if preview and (not data) or (not preview and data is None):
        raise AttachmentUnavailableError
    fresh = get_attachment_fn(attachment_id)
    if not fresh or not can_access_attachment_fn(fresh):
        raise AttachmentUnavailableError
    for field in ('user_id', 'scope_type', 'scope_id', 'storage_backend', 'storage_bucket_id', 'storage_file_id', 'preview_file_id', 'kind', 'mime_type', 'compression_encoding', 'original_size_bytes', 'stored_size_bytes', 'preview_size_bytes', 'sha256'):
        if row.get(field) != fresh.get(field):
            raise AttachmentUnavailableError
    return (row, data)

def _user_display_name(user):
    return user.name or user.username or 'Nest User'

def _channel_mentions(content, *, author, dependencies, channel_id, message_id):
    mentioned = {match.lower() for match in re.findall('(?<![\\w@])@([A-Za-z0-9._-]{2,64})', content)}
    for username in mentioned:
        try:
            recipient = dependencies.first_row_fn(COLLECTIONS['users'], [Query.equal('username', [username])])
            recipient_id = row_id(recipient)
            if recipient_id and recipient_id != author.id:
                user = author
                dependencies.notification_fn(recipient_id, 'chat_mention', f'{user.name or user.username} mentioned you', content, f'/chat?channel={channel_id}&message={message_id}', source_ref=message_id, dedupe_key=f'mention:{message_id}:{recipient_id}', tag=f'mention:{channel_id}', actor_user_id=author.id)
        except Exception:
            dependencies.logger.exception('Failed to dispatch channel mention notification')

def send_channel_message(channel_id: str, channel: RowMapping, *, author: MessageAuthor, media: MessageMedia, dependencies: ChannelDelivery) -> tuple[RowMapping, bool]:
    """Persist a channel message, including Discord and attachment workflows."""
    content, attachment_ids, gif = (media.content, media.attachment_ids, media.gif)
    if attachment_ids:
        require_mutations_enabled()
        if not chat_attachments_enabled():
            raise AttachmentError('Chat attachments are disabled.')
    now = format_datetime(utcnow())
    previews = previews_for_content(content, dependencies=dependencies)
    if gif:
        previews.append(gif)
    user = author
    user_id = author.id
    base_payload = {'channel_id': channel_id, 'user_id': user_id, 'author_name': _user_display_name(user), 'author_username': user.username or '', 'author_avatar_url': user.picture_url or '', 'content': content, 'rendered_html': render_markdown(content), 'link_preview_json': json.dumps(previews), 'updated_at': now}
    message_source = 'appwrite'
    message_created_at = now
    if channel.get('kind') == 'discord':
        bridge_files = []
        bridge_links = []
        for attachment_id in attachment_ids:
            attachment = dependencies.get_attachment_fn(attachment_id)
            if not attachment or attachment.get('status') != 'pending' or str(attachment.get('user_id') or '') != user_id or (attachment.get('scope_type') != 'channel') or (str(attachment.get('scope_id') or '') != str(channel_id)):
                raise AttachmentError('An attachment is unavailable or belongs to a different conversation.')
            if int(attachment.get('original_size_bytes') or 0) <= DISCORD_SMALL_ATTACHMENT_LIMIT:
                bridge_files.append({'filename': attachment.get('original_filename') or 'attachment', 'mime_type': attachment.get('mime_type') or 'application/octet-stream', 'data': dependencies.attachment_bytes_fn(attachment)})
            else:
                bridge_links.append(f"{attachment.get('original_filename') or 'Attachment'}: {f"{dependencies.attachment_base_url}/{attachment_id}/download"}")
        bridge_content = content
        if gif:
            bridge_content = '\n'.join((value for value in (bridge_content, gif.get('url')) if value))
        if bridge_links:
            bridge_content = '\n'.join((value for value in (bridge_content, *bridge_links) if value))
        if attachment_ids:
            require_mutations_enabled()
            if not chat_attachments_enabled():
                raise AttachmentError('Chat attachments are disabled.')
        try:
            discord_message, webhook = dependencies.execute_chat_webhook_fn(bridge_content, _user_display_name(user), user.picture_url, files=bridge_files)
        except Exception as exc:
            dependencies.logger.exception('Failed to send Discord webhook message')
            raise DiscordDeliveryError from exc
        message_source = 'discord'
        message_created_at = discord_message.get('timestamp') or now
        base_payload.update({'external_id': discord_message_external_id(channel, discord_message.get('id')), 'discord_message_id': discord_message.get('id'), 'discord_webhook_id': discord_message.get('webhook_id') or webhook.get('id')})
    base_payload['source'] = message_source
    base_payload['created_at'] = message_created_at
    insert_id = None
    if channel.get('kind') == 'discord' and base_payload.get('discord_message_id'):
        insert_id = discord_message_row_id(channel, base_payload.get('discord_message_id'))
    created = False
    if insert_id:
        inserted = dependencies.insert_row_ignore_fn(COLLECTIONS['chat_messages'], row_id=insert_id, data=base_payload)
        if inserted:
            row = dependencies.get_row_fn(COLLECTIONS['chat_messages'], insert_id)
            created = True
        else:
            existing = dependencies.find_discord_message_row_fn(insert_id, base_payload.get('external_id'))
            if not existing:
                dependencies.logger.error('Failed to persist channel message after duplicate insert race row_id=%s', insert_id)
                raise MessagePersistenceError
            row = existing
    else:
        try:
            row = dependencies.create_row_fn(COLLECTIONS['chat_messages'], row_id=ID.unique(), data=base_payload)
            created = True
        except AppwriteException as exc:
            dependencies.logger.exception('Failed to persist channel message')
            raise MessagePersistenceError from exc
    message_id = row_id(row)
    if not message_id:
        dependencies.logger.error('Persisted channel message has no identifier')
        raise MessagePersistenceError
    try:
        if attachment_ids:
            dependencies.bind_pending_fn(attachment_ids, user_id=user_id, scope_type='channel', scope_id=channel_id, message_id=message_id)
    except (AttachmentError, AppwriteException, StorageError) as exc:
        dependencies.logger.exception('Failed to bind channel message attachments')
        if created:
            try:
                dependencies.delete_row_fn(COLLECTIONS['chat_messages'], message_id)
            except AppwriteException:
                dependencies.logger.exception('Failed to roll back channel message')
        if isinstance(exc, StorageError):
            raise
        raise AttachmentBindingError(str(exc) or 'Unable to attach files.') from exc
    try:
        if channel.get('kind') == 'discord':
            dependencies.prune_discord_fn(channel_id)
        if created:
            dependencies.emit_chat_event_fn('channel', channel_id, 'message_created', message_id=message_id, channel_id=channel_id, actor_id=user_id, channel=channel)
            _channel_mentions(content, author=author, dependencies=dependencies, channel_id=channel_id, message_id=message_id)
    except AppwriteException as exc:
        dependencies.logger.exception('Failed to finalize channel message')
        raise MessagePersistenceError from exc
    if created:
        try:
            dependencies.invite_activation_fn(user_id, 'chat_message')
        except Exception:
            dependencies.logger.exception('Failed to record invite activation for channel message')
    return (row, created)

def send_direct_message(thread_id: str, thread: RowMapping, other: RowMapping, *, author: MessageAuthor, media: MessageMedia, dependencies: DirectDelivery) -> RowMapping:
    """Create a DM after applying blocking, attachment binding, and side effects."""
    user_id = author.id
    recipient_id = str(other.get('id') or other.get('$id') or '')
    if dependencies.is_blocked_between_fn(user_id, recipient_id):
        raise DirectMessageBlockedError
    content, attachment_ids, gif = (media.content, media.attachment_ids, media.gif)
    if attachment_ids:
        require_mutations_enabled()
        if not chat_attachments_enabled():
            raise AttachmentError('Chat attachments are disabled.')
    now = format_datetime(utcnow())
    previews = previews_for_content(content, dependencies=dependencies)
    if gif:
        previews.append(gif)
    user = author
    row = None
    try:
        row = dependencies.create_row_fn(COLLECTIONS['chat_messages'], row_id=ID.unique(), data={'thread_id': thread_id, 'source': 'appwrite', 'user_id': user_id, 'author_name': _user_display_name(user), 'author_username': user.username or '', 'author_avatar_url': user.picture_url or '', 'content': content, 'rendered_html': render_markdown(content), 'link_preview_json': json.dumps(previews), 'created_at': now, 'updated_at': now})
        message_id = row_id(row)
        if not message_id:
            dependencies.logger.error('Persisted direct message has no identifier')
            raise DirectMessagePersistenceError
        if attachment_ids:
            dependencies.bind_pending_fn(attachment_ids, user_id=user_id, scope_type='thread', scope_id=thread_id, message_id=message_id)
        dependencies.update_row_fn(COLLECTIONS['chat_dm_threads'], thread_id, {'last_message_at': now, 'updated_at': now})
        dependencies.emit_chat_event_fn('thread', thread_id, 'message_created', message_id=message_id, thread_id=thread_id, actor_id=user_id, readable_user_ids=thread_participant_ids(thread))
        if recipient_id:
            try:
                dependencies.notification_fn(recipient_id, 'chat_dm', user.name or user.username or 'New direct message', content or ('Sent a GIF' if gif else 'Sent an attachment'), f'/chat?thread={thread_id}&message={message_id}', source_ref=message_id, dedupe_key=f'chat:{message_id}', tag=f'dm:{thread_id}', actor_user_id=user_id)
            except Exception:
                dependencies.logger.exception('Failed to dispatch DM notification')
    except (AppwriteException, AttachmentError, StorageError) as exc:
        dependencies.logger.exception('Failed to save DM')
        if row:
            remove_message = False
            try:
                dependencies.delete_message_attachments_fn(row_id(row))
                remove_message = True
            except (AppwriteException, AttachmentError, StorageError):
                dependencies.logger.exception('Failed to roll back DM attachments')
            if remove_message:
                try:
                    dependencies.delete_row_fn(COLLECTIONS['chat_messages'], row_id(row))
                except AppwriteException:
                    dependencies.logger.exception('Failed to roll back DM message')
        if isinstance(exc, StorageError):
            raise
        raise DirectMessagePersistenceError from exc
    try:
        dependencies.invite_activation_fn(user_id, 'chat_message')
    except Exception:
        dependencies.logger.exception('Failed to record invite activation for direct message')
    return row

def get_message_for_current_user(message_id, *, message_for_current_user_fn, serialize_message_fn):
    row = message_for_current_user_fn(message_id)
    if not row:
        raise MessageNotFoundError
    return serialize_message_fn(row)

def delete_chat_message(message_id, *, user_id: str, dependencies: MessageDeletion):
    """Delete a message while preserving ownership, time-window, and side effects."""
    row = dependencies.get_row_fn(COLLECTIONS['chat_messages'], message_id, allow_missing=True)
    if not row or row.get('deleted_at'):
        raise MessageNotFoundError
    if str(row.get('user_id') or '') != user_id:
        raise MessageOwnershipError
    created = message_timestamp(row)
    if not row.get('delete_requested_at') and (utcnow() - created).total_seconds() > dependencies.delete_window_seconds:
        raise MessageExpiredError
    require_mutations_enabled()
    if row.get('source') == 'discord' and row.get('discord_message_id'):
        try:
            dependencies.delete_webhook_message_fn(row.get('discord_webhook_id'), row.get('discord_message_id'))
        except Exception as exc:
            dependencies.logger.exception('Failed to delete Discord webhook message')
            raise DiscordDeliveryError from exc
    try:
        deleted_at = format_datetime(utcnow())
        dependencies.delete_message_attachments_fn(message_id)
        dependencies.update_row_fn(COLLECTIONS['chat_messages'], message_id, {'deleted_at': deleted_at, 'deleted_by': user_id, 'updated_at': deleted_at})
        if row.get('channel_id'):
            channel = dependencies.get_row_fn(COLLECTIONS['chat_channels'], row.get('channel_id'), allow_missing=True)
            dependencies.emit_chat_event_fn('channel', row.get('channel_id'), 'message_deleted', message_id=message_id, channel_id=row.get('channel_id'), actor_id=user_id, channel=channel)
        elif row.get('thread_id'):
            thread = dependencies.get_row_fn(COLLECTIONS['chat_dm_threads'], row.get('thread_id'), allow_missing=True)
            dependencies.emit_chat_event_fn('thread', row.get('thread_id'), 'message_deleted', message_id=message_id, thread_id=row.get('thread_id'), actor_id=user_id, readable_user_ids=thread_participant_ids(thread or {}))
        dependencies.audit_delete_fn(row, deleted_at)
    except AppwriteException as exc:
        dependencies.logger.exception('Failed to delete chat message')
        raise MessagePersistenceError from exc
    return deleted_at

def update_block(target_id, *, method, user_id: str, dependencies: BlockManagement):
    """Create/delete one directional block and notify affected DM threads."""
    key = f'{user_id}:{target_id}'
    try:
        if method == 'DELETE':
            row = dependencies.first_row_fn(COLLECTIONS['chat_blocks'], [Query.equal('block_key', [key])])
            if row:
                dependencies.delete_row_fn(COLLECTIONS['chat_blocks'], row_id(row))
            blocked = False
        else:
            existing = dependencies.first_row_fn(COLLECTIONS['chat_blocks'], [Query.equal('block_key', [key])])
            if not existing:
                dependencies.create_row_fn(COLLECTIONS['chat_blocks'], row_id=ID.unique(), data={'blocker_id': user_id, 'blocked_id': target_id, 'block_key': key, 'created_at': format_datetime(utcnow())})
            blocked = True
        for thread in dependencies.threads_for_current_user_fn():
            if target_id in thread_participant_ids(thread):
                thread_id = row_id(thread)
                dependencies.emit_chat_event_fn('thread', thread_id, 'block_updated', thread_id=thread_id, actor_id=user_id, readable_user_ids=thread_participant_ids(thread))
    except AppwriteException:
        if method == 'DELETE':
            dependencies.logger.exception('Failed to unblock user')
        else:
            dependencies.logger.exception('Failed to block user')
        raise
    return blocked

def preview_for_url(url, *, dependencies):
    key = url_hash(url)
    try:
        cached = dependencies.first_row_fn(COLLECTIONS['chat_link_previews'], [Query.equal('url_hash', [key])])
    except AppwriteException:
        cached = None
    if cached:
        return {'url': cached.get('url'), 'title': cached.get('title') or '', 'description': cached.get('description') or '', 'image_url': cached.get('image_url') or '', 'site_name': cached.get('site_name') or '', 'content_type': cached.get('content_type') or ''}
    try:
        preview = fetch_link_preview(url)
    except Exception:
        dependencies.logger.exception('Failed to fetch link preview')
        return None
    if not preview:
        return None
    now = format_datetime(utcnow())
    try:
        dependencies.create_row_fn(COLLECTIONS['chat_link_previews'], row_id=ID.unique(), data={'url_hash': key, 'url': preview.get('url') or url, 'title': preview.get('title') or None, 'description': preview.get('description') or None, 'image_url': preview.get('image_url') or None, 'site_name': preview.get('site_name') or None, 'content_type': preview.get('content_type') or None, 'created_at': now, 'updated_at': now})
    except AppwriteException:
        dependencies.logger.exception('Failed to cache link preview')
    return preview

def previews_for_content(content, *, dependencies):
    previews = []
    for link in extract_links(content, limit=2):
        preview = preview_for_url(link, dependencies=dependencies)
        if preview:
            previews.append(preview)
    return previews
