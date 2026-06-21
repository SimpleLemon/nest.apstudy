import hashlib
import html
import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Blueprint, Response, jsonify, request, stream_with_context
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.permission import Permission
from appwrite.query import Query
from appwrite.role import Role

from appwrite_client import COLLECTIONS, client as appwrite_client
from appwrite_helpers import (
    create_row_safe,
    delete_row_safe,
    first_row,
    format_datetime,
    get_row_safe,
    list_rows_all,
    list_rows_safe,
    update_row_safe,
    parse_datetime,
)
from appwrite.services.users import Users
from avatar_images import DEFAULT_AVATAR_URL
from services.chat_formatting import extract_links, fetch_link_preview, render_markdown, url_hash
from services.discord_bridge import (
    DiscordBridgeError,
    delete_webhook_message,
    execute_chat_webhook,
    fetch_channel_messages,
    fetch_discord_user,
    fetch_guild_roles,
)
from services.discord_audit import DiscordAuditEvent, emit_audit_event, format_actor
from services.chat_presence import sync_chat_presence_labels_for_user, university_presence_label
from services.universities import normalize_school_key, school_payload, search_universities


chat_api_bp = Blueprint("chat_api", __name__)
logger = logging.getLogger(__name__)

CHAT_EVENTS_POLL_SECONDS = float(os.environ.get("CHAT_EVENTS_POLL_SECONDS", "1"))
CHAT_EVENTS_KEEPALIVE_SECONDS = float(os.environ.get("CHAT_EVENTS_KEEPALIVE_SECONDS", "15"))
CHAT_EVENTS_STREAM_LIMIT = int(os.environ.get("CHAT_EVENTS_STREAM_LIMIT", "50"))

_chat_event_listener_lock = threading.Lock()
_chat_event_listeners = []

DISCORD_MESSAGE_LIMIT = 50
MESSAGE_PAGE_SIZE = 50
DELETE_WINDOW_SECONDS = 5 * 60
DEFAULT_AVATAR = DEFAULT_AVATAR_URL
DEFAULT_BANNER_COLOR = "#fecae1"
DISCORD_IMAGE_EXTENSIONS = {".gif", ".jpeg", ".jpg", ".png", ".webp"}
DISCORD_USER_MENTION_RE = re.compile(r"&lt;@!?(\d+)&gt;")
DISCORD_ROLE_MENTION_RE = re.compile(r"&lt;@(?:&amp;|&)(\d+)&gt;")
DISCORD_CUSTOM_EMOJI_RE = re.compile(r"&lt;(a?):([A-Za-z0-9_]{2,32}):(\d+)&gt;")
DISCORD_INGEST_SECRET_ENV_KEYS = ("DISCORD_CHAT_INGEST_SECRET", "DISCORD_CHAT_SYNC_SECRET", "DISCORD_BRIDGE_SECRET")
CHAT_MESSAGE_STRING_LIMITS = {
    "channel_id": 64,
    "thread_id": 64,
    "source": 32,
    "external_id": 255,
    "user_id": 64,
    "author_name": 120,
    "author_username": 64,
    "author_avatar_url": 2048,
    "discord_message_id": 32,
    "discord_webhook_id": 32,
}
CHAT_MESSAGE_TEXT_LIMIT = 60000
DISCORD_SYNC_COMPARE_FIELDS = (
    "channel_id",
    "source",
    "external_id",
    "author_name",
    "author_username",
    "author_avatar_url",
    "content",
    "rendered_html",
    "link_preview_json",
    "discord_message_id",
    "discord_webhook_id",
    "created_at",
)
DISCORD_PARTIAL_CREATE_REQUIRED_FIELDS = ("content", "timestamp")
CHAT_SUMMARY_SCAN_LIMIT = 50
CHAT_UNREAD_CAP = 99
WELCOME_DM_SENDER_ID = "69f922da37638df6557b"
WELCOME_DM_TEXT = (
    "Welcome to your Nest! If you have any questions, feedback, or run into any issues, "
    "please feel free to message me anytime :)"
)


def _now():
    return datetime.now(timezone.utc)


def _row_id(row):
    return row.get("$id") or row.get("id")


def _bounded_string(value, limit, *, empty_as_none=False):
    if value is None:
        return None
    text = str(value)
    if empty_as_none and not text:
        return None
    return text[:limit]


def _bounded_chat_message_value(key, value):
    limit = CHAT_MESSAGE_STRING_LIMITS.get(key)
    if limit:
        return _bounded_string(value, limit, empty_as_none=key in {"discord_webhook_id"})
    if key in {"content", "rendered_html"} and isinstance(value, str):
        return value[:CHAT_MESSAGE_TEXT_LIMIT]
    return value


def _current_user_id():
    return str(current_user.id)


def _readable_by_users(user_ids=None):
    ids = [str(user_id) for user_id in (user_ids or []) if user_id]
    if ids:
        return [Permission.read(Role.user(user_id)) for user_id in sorted(set(ids))]
    return [Permission.read(Role.users())]


def _presence_read_permissions_for_channel(channel):
    if not channel:
        return []
    if channel.get("kind") == "discord":
        return [Permission.read(Role.users())]
    if channel.get("kind") == "university" and channel.get("approved"):
        label = university_presence_label(channel.get("school_key"))
        return [Permission.read(Role.label(label))] if label else []
    return []


def _presence_read_permissions_for_thread(thread):
    return _readable_by_users(_thread_participant_ids(thread or {}))


def _presence_scope(scope_type, scope_id):
    if not scope_type or not scope_id:
        return None
    return {
        "scope_type": str(scope_type),
        "scope_id": str(scope_id),
        "room_key": f"{scope_type}:{scope_id}",
    }


def _event_read_permissions(scope_type, *, channel=None, readable_user_ids=None):
    if readable_user_ids is not None:
        return _readable_by_users(readable_user_ids)
    if scope_type == "channel" and channel:
        permissions = _presence_read_permissions_for_channel(channel)
        if permissions:
            return permissions
    return [Permission.read(Role.users())]


def _notify_chat_event_waiters():
    with _chat_event_listener_lock:
        listeners = list(_chat_event_listeners)
    for listener in listeners:
        with listener:
            listener.notify_all()


def _thread_accessible_by_user(thread_id, user_id):
    thread = get_row_safe(COLLECTIONS["chat_dm_threads"], thread_id, allow_missing=True)
    if not thread:
        return False
    return user_id in {thread.get("participant_a"), thread.get("participant_b")}


def _event_visible_for_user(event):
    scope_type = (event or {}).get("scope_type")
    scope_id = (event or {}).get("scope_id")
    if not scope_type or not scope_id:
        return False
    user_id = _current_user_id()
    if scope_type == "channel":
        channel = get_row_safe(COLLECTIONS["chat_channels"], scope_id, allow_missing=True)
        return _can_access_channel(channel)
    if scope_type == "thread":
        return _thread_accessible_by_user(scope_id, user_id)
    if scope_type == "university":
        school = school_payload(current_user.school)
        user_school_key = school.get("school_key") or getattr(current_user, "school_key", None)
        return bool(user_school_key) and user_school_key == scope_id
    return False


def _serialize_chat_event(row):
    event_id = _row_id(row)
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


def _list_chat_events_after(since=None, after_id=None, *, limit=CHAT_EVENTS_STREAM_LIMIT):
    queries = [Query.order_asc("created_at"), Query.limit(limit)]
    if since:
        queries.insert(0, Query.greaterThanEqual("created_at", [since]))
    try:
        rows = list_rows_safe(COLLECTIONS["chat_events"], queries).get("rows", [])
    except AppwriteException:
        logger.exception("Failed to list chat events")
        return []
    visible = []
    for row in rows:
        row_id = _row_id(row)
        if since and after_id and row.get("created_at") == since and row_id == after_id:
            continue
        if not _event_visible_for_user(row):
            continue
        visible.append(row)
    return visible


def emit_chat_event(
    scope_type,
    scope_id,
    event_type,
    *,
    message_id=None,
    thread_id=None,
    channel_id=None,
    actor_id=None,
    readable_user_ids=None,
    channel=None,
):
    if not scope_type or not scope_id or not event_type:
        return None
    now = format_datetime(_now())
    event_id = ID.unique()
    data = {
        "scope_type": str(scope_type),
        "scope_id": str(scope_id),
        "event_type": str(event_type),
        "message_id": str(message_id) if message_id else None,
        "thread_id": str(thread_id) if thread_id else None,
        "channel_id": str(channel_id) if channel_id else None,
        "actor_id": str(actor_id) if actor_id else None,
        "created_at": now,
    }
    permissions = _event_read_permissions(
        scope_type,
        channel=channel,
        readable_user_ids=readable_user_ids,
    )
    try:
        row = create_row_safe(
            COLLECTIONS["chat_events"],
            row_id=event_id,
            data=data,
            permissions=permissions,
        )
    except AppwriteException:
        logger.exception("Failed to emit chat event to SQLite")
        return None
    _notify_chat_event_waiters()
    return row


def _message_timestamp(row):
    value = parse_datetime(row.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def _format_member_since(value):
    parsed = parse_datetime(value)
    if parsed:
        return parsed.strftime("%b %d, %Y")
    return str(value) if value else ""


def _normalize_banner_color(value):
    if not isinstance(value, str):
        return DEFAULT_BANNER_COLOR
    normalized = value.strip()
    if not normalized.startswith("#"):
        normalized = f"#{normalized}"
    if len(normalized) != 7:
        return DEFAULT_BANNER_COLOR
    try:
        int(normalized[1:], 16)
    except ValueError:
        return DEFAULT_BANNER_COLOR
    return normalized.lower()


def _profile_handle(name, user_id, username=None):
    if username:
        return f"@{username}"
    base = "".join(char.lower() if char.isalnum() else "-" for char in (name or "")).strip("-")
    base = "-".join(part for part in base.split("-") if part)
    return f"@{base or user_id or 'apstudy-user'}"


def _is_emory_school(value):
    return str(value or "").strip().lower() in {"emory", "emory university"}


def _is_early_member(value):
    created_at = parse_datetime(value)
    if not created_at:
        return False
    if created_at.tzinfo is not None:
        created_at = created_at.replace(tzinfo=None)
    return created_at < datetime(2026, 8, 20)


def _public_user(row):
    if not row:
        return None
    user_id = _row_id(row)
    name = row.get("name") or row.get("username") or "Nest User"
    username = row.get("username") or ""
    return {
        "id": user_id,
        "name": name,
        "username": username,
        "handle": _profile_handle(name, user_id, username),
        "picture_url": row.get("picture_url") or DEFAULT_AVATAR,
        "banner_color": _normalize_banner_color(row.get("banner_color")),
        "school": row.get("school") or "",
        "major": row.get("major") or "",
        "graduation_year": row.get("graduation_year") or row.get("class_year") or "",
        "class_year": row.get("class_year") or "",
        "education_level": row.get("education_level") or "",
        "member_since": _format_member_since(row.get("created_at")),
        "is_emory_school": _is_emory_school(row.get("school")),
        "is_early_member": _is_early_member(row.get("created_at")),
        "profile_url": f"/u/{username}" if username else f"/user/{user_id}",
    }


def _current_user_payload():
    return _public_user({
        "$id": _current_user_id(),
        "name": current_user.name,
        "username": current_user.username,
        "picture_url": current_user.picture_url,
        "banner_color": current_user.banner_color,
        "school": current_user.school,
        "major": current_user.major,
        "graduation_year": current_user.graduation_year,
        "class_year": current_user.class_year,
        "education_level": current_user.education_level,
        "created_at": current_user.created_at,
    })


def _settings_payload():
    try:
        settings = first_row(
            COLLECTIONS["user_settings"],
            [Query.equal("user_id", [_current_user_id()])],
        )
    except AppwriteException:
        logger.exception("Failed to load chat settings")
        settings = None
    return {
        "chat_sound_enabled": bool((settings or {}).get("chat_sound_enabled", True)),
    }


def _ensure_discord_channel(row_id, name, label, channel_id, read_only):
    now = format_datetime(_now())
    existing = get_row_safe(COLLECTIONS["chat_channels"], row_id, allow_missing=True)
    stable_payload = {
        "kind": "discord",
        "name": name,
        "label": label,
        "section": "nest",
        "discord_channel_id": channel_id,
        "read_only": read_only,
        "approved": True,
    }
    if existing:
        if all(existing.get(key) == value for key, value in stable_payload.items()):
            return existing
        return update_row_safe(COLLECTIONS["chat_channels"], row_id, {**stable_payload, "updated_at": now})
    return create_row_safe(
        COLLECTIONS["chat_channels"],
        row_id=row_id,
        data={**stable_payload, "created_at": now, "updated_at": now},
    )


def _default_channels():
    channels = []
    announcements_id = (os.environ.get("DISCORD_ANNOUNCEMENTS_CHANNEL_ID") or "").strip()
    chat_id = (os.environ.get("DISCORD_CHAT_CHANNEL_ID") or "").strip()
    try:
        if announcements_id:
            channels.append(_ensure_discord_channel(
                "nest_announcements",
                "nest-announcements",
                "Nest Announcements",
                announcements_id,
                True,
            ))
        if chat_id:
            channels.append(_ensure_discord_channel(
                "nest_chat",
                "chat",
                "Chat",
                chat_id,
                False,
            ))
    except AppwriteException:
        logger.exception("Failed to ensure default chat channels")
    return channels


def _university_channel_id(school_key):
    return f"uni_{normalize_school_key(school_key)[:56]}"


def _find_university_channel(school_key):
    if not school_key:
        return None
    return first_row(
        COLLECTIONS["chat_channels"],
        [
            Query.equal("kind", ["university"]),
            Query.equal("school_key", [school_key]),
            Query.equal("approved", [True]),
        ],
    )


def create_university_channel(school_key, school_name):
    now = format_datetime(_now())
    channel_id = _university_channel_id(school_key)
    existing = get_row_safe(COLLECTIONS["chat_channels"], channel_id, allow_missing=True)
    payload = {
        "kind": "university",
        "name": school_name or "University",
        "label": school_name or "University",
        "section": "nest",
        "school_key": school_key,
        "school_name": school_name,
        "read_only": False,
        "approved": True,
        "updated_at": now,
    }
    if existing:
        return update_row_safe(COLLECTIONS["chat_channels"], channel_id, payload)
    return create_row_safe(
        COLLECTIONS["chat_channels"],
        row_id=channel_id,
        data={**payload, "created_at": now},
    )


def _university_placeholder_channel(school_key, school_name, status):
    if not school_key or not school_name:
        return None
    return {
        "$id": _university_channel_id(school_key),
        "kind": "university",
        "name": school_name,
        "label": school_name,
        "section": "nest",
        "school_key": school_key,
        "school_name": school_name,
        "read_only": True,
        "approved": False,
        "university_status": status,
        "created_at": format_datetime(_now()),
        "updated_at": format_datetime(_now()),
    }


def _ensure_university_request():
    school = school_payload(current_user.school)
    school_key = school.get("school_key") or getattr(current_user, "school_key", None)
    school_name = school.get("school") or current_user.school
    if not school_key or not school_name:
        return {"status": "none", "channel": None, "request": None}

    try:
        channel = _find_university_channel(school_key)
        if channel:
            return {"status": "approved", "channel": channel, "request": None}

        request_row = first_row(
            COLLECTIONS["admin_requests"],
            [
                Query.equal("request_type", ["uni_channel_approval"]),
                Query.equal("school_key", [school_key]),
            ],
        )
        if request_row and request_row.get("status") == "approved":
            channel = create_university_channel(school_key, school_name)
            return {"status": "approved", "channel": channel, "request": request_row}
        if request_row:
            status = request_row.get("status") or "pending"
            return {
                "status": status,
                "channel": _university_placeholder_channel(school_key, school_name, status),
                "request": request_row,
            }

        now = format_datetime(_now())
        request_row = create_row_safe(
            COLLECTIONS["admin_requests"],
            row_id=ID.unique(),
            data={
                "request_type": "uni_channel_approval",
                "label": "[Uni Channel Approval]",
                "status": "pending",
                "school_key": school_key,
                "school_name": school_name,
                "requested_by": _current_user_id(),
                "request_count": 1,
                "last_requested_at": now,
                "created_at": now,
                "updated_at": now,
            },
        )
        return {
            "status": "pending",
            "channel": _university_placeholder_channel(school_key, school_name, "pending"),
            "request": request_row,
        }
    except AppwriteException:
        logger.exception("Failed to ensure university request")
        return {"status": "error", "channel": None, "request": None}


def _channel_payload(channel, university_status=None):
    if not channel:
        return None
    channel_id = _row_id(channel)
    return {
        "id": channel_id,
        "kind": channel.get("kind"),
        "name": channel.get("name"),
        "label": channel.get("label") or channel.get("name"),
        "school_key": channel.get("school_key"),
        "school_name": channel.get("school_name"),
        "read_only": bool(channel.get("read_only")),
        "approved": bool(channel.get("approved")),
        "active_count": 0,
        "active_users": [],
        "history_limited": channel.get("kind") == "discord",
        "university_status": university_status or channel.get("university_status"),
        "presence_scope": _presence_scope("channel", channel_id),
        "presence_read_permissions": _presence_read_permissions_for_channel(channel),
        "presence_profile_resolve_allowed": bool(channel.get("approved") or channel.get("kind") == "discord"),
    }


def _can_access_channel(channel):
    if not channel:
        return False
    if channel.get("kind") == "discord":
        return True
    if channel.get("kind") == "university":
        current_school = school_payload(current_user.school)
        return bool(channel.get("approved")) and channel.get("school_key") == current_school.get("school_key")
    return False


def _preview_for_url(url):
    key = url_hash(url)
    try:
        cached = first_row(COLLECTIONS["chat_link_previews"], [Query.equal("url_hash", [key])])
    except AppwriteException:
        cached = None
    if cached:
        return {
            "url": cached.get("url"),
            "title": cached.get("title") or "",
            "description": cached.get("description") or "",
            "image_url": cached.get("image_url") or "",
            "site_name": cached.get("site_name") or "",
            "content_type": cached.get("content_type") or "",
        }

    try:
        preview = fetch_link_preview(url)
    except Exception:
        logger.exception("Failed to fetch link preview")
        return None
    if not preview:
        return None

    now = format_datetime(_now())
    try:
        create_row_safe(
            COLLECTIONS["chat_link_previews"],
            row_id=ID.unique(),
            data={
                "url_hash": key,
                "url": preview.get("url") or url,
                "title": preview.get("title") or None,
                "description": preview.get("description") or None,
                "image_url": preview.get("image_url") or None,
                "site_name": preview.get("site_name") or None,
                "content_type": preview.get("content_type") or None,
                "created_at": now,
                "updated_at": now,
            },
        )
    except AppwriteException:
        logger.exception("Failed to cache link preview")
    return preview


def _previews_for_content(content):
    previews = []
    for link in extract_links(content, limit=2):
        preview = _preview_for_url(link)
        if preview:
            previews.append(preview)
    return previews


def _discord_previews(message):
    previews = []
    for embed in message.get("embeds") or []:
        image = embed.get("image") or embed.get("thumbnail") or {}
        previews.append({
            "url": embed.get("url") or "",
            "title": embed.get("title") or "",
            "description": embed.get("description") or "",
            "image_url": image.get("url") or "",
            "site_name": (embed.get("provider") or {}).get("name") or "",
            "content_type": embed.get("type") or "",
        })
    return previews[:2]


def _discord_images(message):
    images = []
    for attachment in message.get("attachments") or []:
        if not _discord_attachment_is_image(attachment):
            continue
        url = attachment.get("url") or attachment.get("proxy_url") or ""
        if not url:
            continue
        images.append({
            "kind": "discord_image",
            "url": url,
            "proxy_url": attachment.get("proxy_url") or "",
            "filename": attachment.get("filename") or "Image",
            "width": attachment.get("width"),
            "height": attachment.get("height"),
            "content_type": attachment.get("content_type") or "",
        })
    return images[:4]


def _discord_attachment_is_image(attachment):
    content_type = str(attachment.get("content_type") or "").split(";", 1)[0].strip().lower()
    if content_type.startswith("image/"):
        return True
    filename = str(attachment.get("filename") or "").lower()
    return any(filename.endswith(extension) for extension in DISCORD_IMAGE_EXTENSIONS)


def _discord_media_json(previews, images):
    media = list(previews or []) + list(images or [])
    compact_media = []
    for item in media:
        if not isinstance(item, dict):
            continue
        compact_media.append({
            key: _bounded_string(value, 2048) if isinstance(value, str) else value
            for key, value in item.items()
            if value not in (None, "")
        })

    while compact_media:
        text = json.dumps(compact_media, separators=(",", ":"))
        if len(text) <= CHAT_MESSAGE_TEXT_LIMIT:
            return text
        compact_media.pop()
    return "[]"


def _discord_message_row_id(channel, discord_message_id):
    discord_channel_id = str(channel.get("discord_channel_id") or "")
    discord_id = str(discord_message_id or "")
    if not discord_channel_id or not discord_id:
        return None
    digest = hashlib.sha1(f"{discord_channel_id}:{discord_id}".encode("utf-8")).hexdigest()[:24]
    return f"discord_{digest}"


def _discord_message_external_id(channel, discord_message_id):
    discord_channel_id = str(channel.get("discord_channel_id") or "")
    discord_id = str(discord_message_id or "")
    if not discord_channel_id or not discord_id:
        return None
    return f"discord:{discord_channel_id}:{discord_id}"


def _discord_message_payload(channel, message, *, partial=False):
    channel_id = _row_id(channel)
    discord_id = str(message.get("id") or "")
    if not discord_id:
        return None
    external_id = _discord_message_external_id(channel, discord_id)
    author = message.get("author") or {}
    payload = {
        "channel_id": channel_id,
        "source": "discord",
        "external_id": external_id,
        "discord_message_id": discord_id,
        "updated_at": format_datetime(_now()),
    }
    if author or not partial:
        payload.update({
            "author_name": author.get("global_name") or author.get("username") or "Discord User",
            "author_username": author.get("username") or "",
            "author_avatar_url": _discord_avatar(author),
        })
    if "content" in message or not partial:
        content = message.get("content") or ""
        payload.update({
            "content": content,
            "rendered_html": _render_discord_content(content, message),
        })
    if any(key in message for key in ("embeds", "attachments")) or not partial:
        payload["link_preview_json"] = _discord_media_json(_discord_previews(message), _discord_images(message))
    if "webhook_id" in message or not partial:
        payload["discord_webhook_id"] = message.get("webhook_id")
    if "timestamp" in message or not partial:
        payload["created_at"] = format_datetime(message.get("timestamp") or _now())
    return {
        key: _bounded_chat_message_value(key, value)
        for key, value in payload.items()
    }


def _discord_message_changes(existing, payload):
    changes = {}
    for key in DISCORD_SYNC_COMPARE_FIELDS:
        if key not in payload:
            continue
        incoming = payload.get(key)
        if existing.get(key) != incoming:
            changes[key] = incoming
    if changes:
        changes["updated_at"] = payload.get("updated_at")
    return changes


def _log_discord_upsert_failure(row_id, external_id, discord_id, changes):
    logger.exception(
        "Failed to upsert Discord message row_id=%s external_id=%s discord_message_id=%s changed_fields=%s value_lengths=%s",
        row_id,
        external_id,
        discord_id,
        sorted((changes or {}).keys()),
        {
            key: len(value) if isinstance(value, str) else None
            for key, value in (changes or {}).items()
        },
    )


def _discord_mention_name(user):
    return (
        user.get("global_name")
        or user.get("nick")
        or user.get("username")
        or "Discord User"
    )


def _discord_user_mentions(message):
    mentions = {}
    for user in message.get("mentions") or []:
        user_id = str(user.get("id") or "")
        if user_id:
            mentions[user_id] = _discord_mention_name(user)
    return mentions


def _discord_user_mention_label(user_id, mentions):
    label = mentions.get(user_id)
    if label:
        return label
    fetched = fetch_discord_user(user_id)
    if fetched:
        return _discord_mention_name(fetched)
    return "Discord User"


def _discord_role_mentions():
    roles = {}
    for role in fetch_guild_roles():
        role_id = str(role.get("id") or "")
        if role_id:
            roles[role_id] = role.get("name") or "Unknown Role"
    return roles


def _mention_span(label, class_name="chat-mention"):
    return f'<span class="{class_name}">{html.escape(label)}</span>'


def _emoji_img(animated, name, emoji_id):
    extension = "gif" if animated else "png"
    url = f"https://cdn.discordapp.com/emojis/{emoji_id}.{extension}?size=48&quality=lossless"
    escaped_url = html.escape(url, quote=True)
    escaped_name = html.escape(name)
    return (
        f'<img class="chat-custom-emoji" '
        f'src="{escaped_url}" alt=":{escaped_name}:" title=":{escaped_name}:" '
        'loading="lazy" decoding="async">'
    )


def _render_discord_content(content, message):
    rendered = render_markdown(content)
    user_mentions = _discord_user_mentions(message)
    role_mentions = _discord_role_mentions() if "&lt;@&" in rendered or "&lt;@&amp;" in rendered else {}

    def replace_user(match):
        label = _discord_user_mention_label(match.group(1), user_mentions)
        return _mention_span(f"@{label}")

    def replace_role(match):
        label = role_mentions.get(match.group(1), "Unknown Role")
        return _mention_span(f"@{label}", "chat-mention chat-mention-role")

    rendered = DISCORD_ROLE_MENTION_RE.sub(replace_role, rendered)
    rendered = DISCORD_USER_MENTION_RE.sub(replace_user, rendered)
    return DISCORD_CUSTOM_EMOJI_RE.sub(lambda match: _emoji_img(match.group(1), match.group(2), match.group(3)), rendered)


def _load_users_by_id(user_ids):
    users_by_id = {}
    for user_id in sorted({str(value) for value in (user_ids or []) if value}):
        try:
            row = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
        except AppwriteException:
            row = None
        if row:
            users_by_id[user_id] = row
    return users_by_id


def _serialize_message(row, users_by_id=None):
    created = _message_timestamp(row)
    user_id = row.get("user_id")
    author_profile = None
    if user_id:
        user_row = (users_by_id or {}).get(str(user_id))
        if user_row is None and users_by_id is None:
            try:
                user_row = get_row_safe(COLLECTIONS["users"], str(user_id), allow_missing=True)
            except AppwriteException:
                user_row = None
        if user_row:
            author_profile = _public_user(user_row)
    can_delete = (
        user_id
        and str(user_id) == _current_user_id()
        and not row.get("deleted_at")
        and (_now() - created).total_seconds() <= DELETE_WINDOW_SECONDS
    )
    previews = []
    images = []
    if row.get("link_preview_json"):
        try:
            media = json.loads(row.get("link_preview_json")) or []
        except (TypeError, json.JSONDecodeError):
            media = []
        previews = [item for item in media if not isinstance(item, dict) or item.get("kind") != "discord_image"]
        images = [item for item in media if isinstance(item, dict) and item.get("kind") == "discord_image"]
    return {
        "id": _row_id(row),
        "channel_id": row.get("channel_id"),
        "thread_id": row.get("thread_id"),
        "source": row.get("source") or "appwrite",
        "user_id": user_id,
        "author_name": row.get("author_name") or "Nest User",
        "author_username": row.get("author_username") or "",
        "author_avatar_url": row.get("author_avatar_url") or DEFAULT_AVATAR,
        "content": row.get("content") or "",
        "rendered_html": row.get("rendered_html") or render_markdown(row.get("content") or ""),
        "previews": previews,
        "images": images,
        "created_at": format_datetime(created),
        "can_delete": bool(can_delete),
        "delete_expires_at": (
            format_datetime(created + timedelta(seconds=DELETE_WINDOW_SECONDS))
            if user_id and str(user_id) == _current_user_id()
            else None
        ),
        "author_profile": author_profile,
    }


def _serialize_messages(rows):
    users_by_id = _load_users_by_id([row.get("user_id") for row in rows if row.get("user_id")])
    return [_serialize_message(row, users_by_id) for row in rows]


def _room_message_metadata(scope_type, scope_id):
    user_id = _current_user_id()
    read_state_row = _read_state_for_scope(user_id, scope_type, scope_id)
    last_read_at = (read_state_row or {}).get("last_read_at")
    unread, _ = _unread_count(scope_type, scope_id, user_id, last_read_at)
    return {
        "read_state": {
            "last_read_at": last_read_at,
            "last_read_message_id": (read_state_row or {}).get("last_read_message_id"),
        },
        "unread_count": unread,
    }


def _message_queries(scope_type, scope_id, before=None, after=None):
    field = "channel_id" if scope_type == "channel" else "thread_id"
    queries = [Query.equal(field, [scope_id])]
    if before:
        queries.append(Query.less_than("created_at", before))
        queries.append(Query.order_desc("created_at"))
    elif after:
        queries.append(Query.greater_than("created_at", after))
        queries.append(Query.order_asc("created_at"))
    else:
        queries.append(Query.order_desc("created_at"))
    return queries


def _message_is_after_cursor(row, cursor_row, cursor_id):
    if not row:
        return False
    if not cursor_row and not cursor_id:
        return True
    row_id = str(_row_id(row) or "")
    cursor_id = str(cursor_id or (_row_id(cursor_row) if cursor_row else "") or "")
    if row_id and cursor_id and row_id == cursor_id:
        return False
    if not cursor_row:
        return True
    row_ts = _message_timestamp(row)
    cursor_ts = _message_timestamp(cursor_row)
    if row_ts > cursor_ts:
        return True
    if row_ts < cursor_ts:
        return False
    return row_id > cursor_id


def _list_messages(scope_type, scope_id, before=None, after=None, after_message_id=None):
    if before:
        query_list = _message_queries(scope_type, scope_id, before=before)
        query_list.append(Query.limit(MESSAGE_PAGE_SIZE))
        rows = list_rows_safe(COLLECTIONS["chat_messages"], query_list).get("rows", [])
        visible = [row for row in rows if not row.get("deleted_at")]
        if scope_type == "thread":
            blocked = _blocked_user_ids(_current_user_id())
            visible = [row for row in visible if row.get("user_id") not in blocked]
        visible.sort(key=_message_timestamp)
        return visible

    if after_message_id or after:
        cursor_row = None
        if after_message_id:
            cursor_row = get_row_safe(COLLECTIONS["chat_messages"], after_message_id, allow_missing=True)
        cursor_id = _row_id(cursor_row) if cursor_row else after_message_id
        field = "channel_id" if scope_type == "channel" else "thread_id"
        queries = [Query.equal(field, [scope_id])]
        if after_message_id and cursor_row:
            queries.append(Query.greater_than_equal("created_at", cursor_row.get("created_at")))
        elif after:
            queries.append(Query.greater_than("created_at", after))
        queries.append(Query.order_asc("created_at"))
        queries.append(Query.limit(MESSAGE_PAGE_SIZE + 5))
        rows = list_rows_safe(COLLECTIONS["chat_messages"], queries).get("rows", [])
        visible = [row for row in rows if not row.get("deleted_at")]
        if scope_type == "thread":
            blocked = _blocked_user_ids(_current_user_id())
            visible = [row for row in visible if row.get("user_id") not in blocked]
        if after_message_id and cursor_row:
            visible = [
                row for row in visible
                if _message_is_after_cursor(row, cursor_row, cursor_id)
            ]
        visible.sort(key=_message_timestamp)
        return visible[:MESSAGE_PAGE_SIZE]

    query_list = _message_queries(scope_type, scope_id)
    query_list.append(Query.limit(MESSAGE_PAGE_SIZE))
    rows = list_rows_safe(COLLECTIONS["chat_messages"], query_list).get("rows", [])
    visible = [row for row in rows if not row.get("deleted_at")]
    if scope_type == "thread":
        blocked = _blocked_user_ids(_current_user_id())
        visible = [row for row in visible if row.get("user_id") not in blocked]
    visible.sort(key=_message_timestamp)
    return visible


def _upsert_discord_message(channel, message, emit_event=False, *, partial=False):
    payload = _discord_message_payload(channel, message, partial=partial)
    if not payload:
        return None, False
    channel_id = payload.get("channel_id")
    external_id = payload.get("external_id")
    discord_id = payload.get("discord_message_id")
    row_id = _discord_message_row_id(channel, discord_id)
    changes = payload
    try:
        existing = None
        if row_id:
            existing = get_row_safe(COLLECTIONS["chat_messages"], row_id, allow_missing=True)
        if not existing and external_id:
            existing = first_row(COLLECTIONS["chat_messages"], [Query.equal("external_id", [external_id])])
        if existing:
            row_id = _row_id(existing)
            changes = _discord_message_changes(existing, payload)
            if partial and not changes and message.get("edited_timestamp"):
                changes = {"updated_at": payload.get("updated_at")}
            if not changes:
                return existing, False
            row = update_row_safe(COLLECTIONS["chat_messages"], row_id, changes)
            if emit_event:
                emit_chat_event(
                    "channel",
                    channel_id,
                    "message_updated",
                    message_id=row_id,
                    channel_id=channel_id,
                    channel=channel,
                )
            return row, False
        if partial and any(key not in payload for key in DISCORD_PARTIAL_CREATE_REQUIRED_FIELDS):
            logger.info("Skipping partial Discord message update for unknown message %s", discord_id)
            return None, False
        row = create_row_safe(COLLECTIONS["chat_messages"], row_id=row_id or ID.unique(), data=payload)
        if emit_event:
            emit_chat_event(
                "channel",
                channel_id,
                "message_created",
                message_id=_row_id(row),
                channel_id=channel_id,
                channel=channel,
            )
        return row, True
    except AppwriteException:
        existing = None
        if row_id:
            try:
                existing = get_row_safe(COLLECTIONS["chat_messages"], row_id, allow_missing=True)
            except AppwriteException:
                existing = None
        if not existing and external_id:
            try:
                existing = first_row(COLLECTIONS["chat_messages"], [Query.equal("external_id", [external_id])])
            except AppwriteException:
                existing = None
        if existing:
            row_id = _row_id(existing)
            changes = _discord_message_changes(existing, payload)
            if partial and not changes and message.get("edited_timestamp"):
                changes = {"updated_at": payload.get("updated_at")}
            if not changes:
                return existing, False
            try:
                row = update_row_safe(COLLECTIONS["chat_messages"], row_id, changes)
                if emit_event:
                    emit_chat_event(
                        "channel",
                        channel_id,
                        "message_updated",
                        message_id=row_id,
                        channel_id=channel_id,
                        channel=channel,
                    )
                return row, False
            except AppwriteException:
                return existing, False
        _log_discord_upsert_failure(row_id, external_id, discord_id, changes)
        return None, False


def _soft_delete_discord_message(channel, discord_message_id, *, emit_event=False):
    if not channel or not discord_message_id:
        return None
    channel_id = _row_id(channel)
    external_id = _discord_message_external_id(channel, discord_message_id)
    row_id = _discord_message_row_id(channel, discord_message_id)
    try:
        row = None
        if row_id:
            row = get_row_safe(COLLECTIONS["chat_messages"], row_id, allow_missing=True)
        if not row and external_id:
            row = first_row(COLLECTIONS["chat_messages"], [Query.equal("external_id", [external_id])])
        if not row:
            row = first_row(
                COLLECTIONS["chat_messages"],
                [
                    Query.equal("channel_id", [channel_id]),
                    Query.equal("discord_message_id", [str(discord_message_id)]),
                ],
            )
        if not row or row.get("deleted_at"):
            return row
        deleted_at = format_datetime(_now())
        update_row_safe(
            COLLECTIONS["chat_messages"],
            _row_id(row),
            {
                "deleted_at": deleted_at,
                "deleted_by": "discord",
                "updated_at": deleted_at,
            },
        )
        if emit_event:
            emit_chat_event(
                "channel",
                channel_id,
                "message_deleted",
                message_id=_row_id(row),
                channel_id=channel_id,
                actor_id="discord",
                channel=channel,
            )
        return row
    except AppwriteException:
        logger.exception("Failed to soft-delete Discord message %s", discord_message_id)
        return None


def _discord_avatar(author):
    avatar_hash = author.get("avatar")
    user_id = author.get("id")
    if avatar_hash and user_id:
        extension = "gif" if str(avatar_hash).startswith("a_") else "png"
        return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{extension}?size=128"
    return DEFAULT_AVATAR


def _emit_chat_delete_audit(row, deleted_at):
    try:
        emit_audit_event(
            DiscordAuditEvent(
                channel="chat_deletes",
                title="Chat Message Deleted",
                actor=format_actor(current_user),
                target=str(_row_id(row) or ""),
                metadata={
                    "message_id": _row_id(row),
                    "source": row.get("source") or "appwrite",
                    "channel_id": row.get("channel_id"),
                    "thread_id": row.get("thread_id"),
                    "author_user_id": row.get("user_id"),
                    "author_name": row.get("author_name"),
                    "author_username": row.get("author_username"),
                    "created_at": row.get("created_at"),
                    "deleted_at": deleted_at,
                    "discord_message_id": row.get("discord_message_id"),
                    "discord_webhook_id": row.get("discord_webhook_id"),
                    "content": row.get("content") or "",
                },
                color="red",
            )
        )
    except Exception:
        logger.exception("Failed to emit chat delete audit event")


def _sync_discord_channel(channel, emit_events=False):
    discord_channel_id = channel.get("discord_channel_id")
    if not discord_channel_id:
        return 0
    messages = fetch_channel_messages(discord_channel_id, DISCORD_MESSAGE_LIMIT)
    created_count = 0
    for message in messages:
        _, created = _upsert_discord_message(channel, message, emit_event=emit_events)
        if created:
            created_count += 1
    _prune_discord_messages(_row_id(channel))
    return created_count


def sync_discord_channels(emit_events=True):
    _default_channels()
    try:
        channels = list_rows_all(
            COLLECTIONS["chat_channels"],
            [Query.equal("kind", ["discord"])],
        )
    except AppwriteException:
        logger.exception("Failed to list Discord chat channels for sync")
        return 0
    created_count = 0
    for channel in channels:
        if not _can_sync_discord_channel(channel):
            continue
        created_count += _sync_discord_channel(channel, emit_events=emit_events)
    return created_count


def ingest_discord_gateway_message(message, *, event_type="create"):
    channel = _discord_channel_for_discord_id((message or {}).get("channel_id"))
    if not _can_sync_discord_channel(channel):
        return None, False
    partial = event_type == "update"
    row, created = _upsert_discord_message(channel, message, emit_event=True, partial=partial)
    if row:
        _prune_discord_messages(_row_id(channel))
    return row, created


def delete_discord_gateway_message(discord_channel_id, discord_message_id):
    channel = _discord_channel_for_discord_id(discord_channel_id)
    if not _can_sync_discord_channel(channel):
        return None
    return _soft_delete_discord_message(channel, discord_message_id, emit_event=True)


def delete_discord_gateway_messages(discord_channel_id, discord_message_ids):
    deleted = 0
    for message_id in discord_message_ids or []:
        row = delete_discord_gateway_message(discord_channel_id, message_id)
        if row:
            deleted += 1
    return deleted


def _can_sync_discord_channel(channel):
    return bool(channel and channel.get("kind") == "discord" and channel.get("discord_channel_id"))


def _discord_channel_for_discord_id(discord_channel_id):
    if not discord_channel_id:
        return None
    try:
        channel = first_row(
            COLLECTIONS["chat_channels"],
            [Query.equal("discord_channel_id", [str(discord_channel_id)])],
        )
        if channel:
            return channel
        _default_channels()
        return first_row(
            COLLECTIONS["chat_channels"],
            [Query.equal("discord_channel_id", [str(discord_channel_id)])],
        )
    except AppwriteException:
        logger.exception("Failed to resolve Discord chat channel %s", discord_channel_id)
        return None


def _discord_ingest_secret():
    for key in DISCORD_INGEST_SECRET_ENV_KEYS:
        value = os.environ.get(key)
        if value:
            return value.strip()
    return ""


def _discord_ingest_token():
    auth_header = request.headers.get("Authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return (request.headers.get("X-Discord-Bridge-Secret") or "").strip()


def _valid_discord_ingest_request():
    expected = _discord_ingest_secret()
    provided = _discord_ingest_token()
    return bool(expected and provided and secrets.compare_digest(provided, expected))


def _prune_discord_messages(channel_id):
    try:
        rows = list_rows_all(
            COLLECTIONS["chat_messages"],
            [
                Query.equal("channel_id", [channel_id]),
                Query.order_desc("created_at"),
            ],
        )
    except AppwriteException:
        return
    for row in rows[DISCORD_MESSAGE_LIMIT:]:
        try:
            delete_row_safe(COLLECTIONS["chat_messages"], _row_id(row))
        except AppwriteException:
            logger.exception("Failed to prune old Discord message")


def _blocked_user_ids(user_id):
    try:
        rows = list_rows_all(COLLECTIONS["chat_blocks"], [Query.equal("blocker_id", [user_id])])
    except AppwriteException:
        return set()
    return {row.get("blocked_id") for row in rows if row.get("blocked_id")}


def _is_blocked_between(user_a, user_b):
    keys = [f"{user_a}:{user_b}", f"{user_b}:{user_a}"]
    try:
        return bool(first_row(COLLECTIONS["chat_blocks"], [Query.equal("block_key", keys)]))
    except AppwriteException:
        logger.exception("Failed to check chat block")
        return True


def _thread_key(user_a, user_b):
    return ":".join(sorted([str(user_a), str(user_b)]))


def _get_or_create_thread_between(user_a, user_b):
    key = _thread_key(user_a, user_b)
    existing = first_row(COLLECTIONS["chat_dm_threads"], [Query.equal("participant_key", [key])])
    if existing:
        return existing
    now = format_datetime(_now())
    participant_a, participant_b = key.split(":", 1)
    return create_row_safe(
        COLLECTIONS["chat_dm_threads"],
        row_id=ID.unique(),
        data={
            "participant_a": participant_a,
            "participant_b": participant_b,
            "participant_key": key,
            "created_at": now,
            "updated_at": now,
        },
    )


def initialize_new_user_discord_read_states(user_id):
    user_id = str(user_id or "").strip()
    if not user_id:
        return
    _default_channels()
    try:
        channels = list_rows_all(COLLECTIONS["chat_channels"], [Query.equal("kind", ["discord"])])
    except AppwriteException:
        logger.exception("Failed to list Discord channels for onboarding read init")
        return
    for channel in channels:
        channel_id = _row_id(channel)
        if not channel_id:
            continue
        latest = _latest_visible_message("channel", channel_id)
        if latest:
            _persist_read_state(user_id, "channel", channel_id, latest)


def create_welcome_dm_for_user(user_id):
    user_id = str(user_id or "").strip()
    if not user_id or user_id == WELCOME_DM_SENDER_ID:
        return None
    external_id = f"welcome:{WELCOME_DM_SENDER_ID}:{user_id}"
    try:
        existing = first_row(COLLECTIONS["chat_messages"], [Query.equal("external_id", [external_id])])
    except AppwriteException:
        logger.exception("Failed to check welcome DM for user %s", user_id)
        return None
    if existing:
        return existing

    sender = get_row_safe(COLLECTIONS["users"], WELCOME_DM_SENDER_ID, allow_missing=True)
    try:
        thread = _get_or_create_thread_between(WELCOME_DM_SENDER_ID, user_id)
    except AppwriteException:
        logger.exception("Failed to create welcome DM thread for user %s", user_id)
        return None

    thread_id = _row_id(thread)
    now = format_datetime(_now())
    content = WELCOME_DM_TEXT
    try:
        row = create_row_safe(
            COLLECTIONS["chat_messages"],
            row_id=ID.unique(),
            data={
                "thread_id": thread_id,
                "source": "system",
                "external_id": external_id,
                "user_id": WELCOME_DM_SENDER_ID,
                "author_name": (sender or {}).get("name") or (sender or {}).get("username") or "Nest User",
                "author_username": (sender or {}).get("username") or "",
                "author_avatar_url": (sender or {}).get("picture_url") or "",
                "content": content,
                "rendered_html": render_markdown(content),
                "link_preview_json": "[]",
                "created_at": now,
                "updated_at": now,
            },
        )
        update_row_safe(
            COLLECTIONS["chat_dm_threads"],
            thread_id,
            {"last_message_at": now, "updated_at": now},
        )
        emit_chat_event(
            "thread",
            thread_id,
            "message_created",
            message_id=_row_id(row),
            thread_id=thread_id,
            actor_id=WELCOME_DM_SENDER_ID,
            readable_user_ids=_thread_participant_ids(thread),
        )
        return row
    except AppwriteException:
        logger.exception("Failed to create welcome DM for user %s", user_id)
        return None


def _get_or_create_thread(other_user_id):
    user_id = _current_user_id()
    if other_user_id == user_id:
        raise ValueError("You cannot start a DM with yourself.")
    other = get_row_safe(COLLECTIONS["users"], other_user_id, allow_missing=True)
    if not other:
        raise ValueError("User not found.")
    return _get_or_create_thread_between(user_id, other_user_id)


def _thread_for_user(thread_id):
    thread = get_row_safe(COLLECTIONS["chat_dm_threads"], thread_id, allow_missing=True)
    if not thread:
        return None
    user_id = _current_user_id()
    if user_id not in {thread.get("participant_a"), thread.get("participant_b")}:
        return None
    return thread


def _other_participant(thread):
    user_id = _current_user_id()
    other_id = thread.get("participant_b") if thread.get("participant_a") == user_id else thread.get("participant_a")
    return get_row_safe(COLLECTIONS["users"], other_id, allow_missing=True)


def _thread_participant_ids(thread):
    return [
        str(value)
        for value in (thread.get("participant_a"), thread.get("participant_b"))
        if value
    ]


def _read_key(user_id, scope_type, scope_id):
    return f"{user_id}:{scope_type}:{scope_id}"


def _read_state_for_scope(user_id, scope_type, scope_id):
    try:
        return first_row(
            COLLECTIONS["chat_read_states"],
            [Query.equal("read_key", [_read_key(user_id, scope_type, scope_id)])],
        )
    except AppwriteException:
        logger.exception("Failed to load chat read state")
        return None


def _latest_visible_message(scope_type, scope_id):
    field = "channel_id" if scope_type == "channel" else "thread_id"
    try:
        rows = list_rows_safe(
            COLLECTIONS["chat_messages"],
            [
                Query.equal(field, [scope_id]),
                Query.order_desc("created_at"),
                Query.limit(10),
            ],
        ).get("rows", [])
    except AppwriteException:
        logger.exception("Failed to load latest chat message")
        return None
    for row in rows:
        if not row.get("deleted_at"):
            return row
    return None


def _message_scope_field(scope_type):
    return "channel_id" if scope_type == "channel" else "thread_id"


def _message_in_scope(row, scope_type, scope_id):
    return bool(row and row.get(_message_scope_field(scope_type)) == scope_id)


def _message_for_current_user(message_id):
    row = get_row_safe(COLLECTIONS["chat_messages"], message_id, allow_missing=True)
    if not row or row.get("deleted_at"):
        return None
    channel_id = row.get("channel_id")
    thread_id = row.get("thread_id")
    if channel_id:
        channel = get_row_safe(COLLECTIONS["chat_channels"], channel_id, allow_missing=True)
        if not _can_access_channel(channel):
            return None
    elif thread_id:
        if not _thread_for_user(thread_id):
            return None
        if str(row.get("user_id") or "") in _blocked_user_ids(_current_user_id()):
            return None
    else:
        return None
    return row


def _message_visible_for_user(row, scope_type, blocked_user_ids=None):
    if not row or row.get("deleted_at"):
        return False
    if scope_type == "thread" and str(row.get("user_id") or "") in (blocked_user_ids or set()):
        return False
    return True


def _message_can_be_unread_target(row, scope_type, user_id, blocked_user_ids=None):
    if not _message_visible_for_user(row, scope_type, blocked_user_ids):
        return False
    return str(row.get("user_id") or "") != str(user_id)


def _persist_read_state(user_id, scope_type, scope_id, latest, *, fallback_to_now=True):
    read_key = _read_key(user_id, scope_type, scope_id)
    last_read_at = latest.get("created_at") if latest else (format_datetime(_now()) if fallback_to_now else None)
    payload = {
        "user_id": user_id,
        "scope_type": scope_type,
        "scope_id": scope_id,
        "read_key": read_key,
        "last_read_message_id": _row_id(latest) if latest else None,
        "last_read_at": last_read_at,
    }
    try:
        existing = first_row(COLLECTIONS["chat_read_states"], [Query.equal("read_key", [read_key])])
        if existing:
            return update_row_safe(COLLECTIONS["chat_read_states"], _row_id(existing), payload)
        return create_row_safe(COLLECTIONS["chat_read_states"], row_id=ID.unique(), data=payload)
    except AppwriteException:
        logger.exception("Failed to persist chat read state")
        return None


def _mark_read(scope_type, scope_id, message_id=None):
    user_id = _current_user_id()
    latest = None
    if message_id:
        try:
            latest = get_row_safe(COLLECTIONS["chat_messages"], message_id, allow_missing=True)
        except AppwriteException:
            latest = None
        if latest:
            if not _message_in_scope(latest, scope_type, scope_id) or latest.get("deleted_at"):
                latest = None
    if not latest:
        latest = _latest_visible_message(scope_type, scope_id)
    return _persist_read_state(user_id, scope_type, scope_id, latest)


def _latest_unread_target(scope_type, scope_id, user_id, blocked_user_ids):
    field = _message_scope_field(scope_type)
    offset = 0
    while True:
        try:
            rows = list_rows_safe(
                COLLECTIONS["chat_messages"],
                [
                    Query.equal(field, [scope_id]),
                    Query.order_desc("created_at"),
                    Query.limit(CHAT_SUMMARY_SCAN_LIMIT),
                    Query.offset(offset),
                ],
            ).get("rows", [])
        except AppwriteException:
            logger.exception("Failed to load latest unread chat target")
            return None
        for row in rows:
            if _message_can_be_unread_target(row, scope_type, user_id, blocked_user_ids):
                return row
        if len(rows) < CHAT_SUMMARY_SCAN_LIMIT:
            return None
        offset += CHAT_SUMMARY_SCAN_LIMIT


def _previous_visible_message(scope_type, scope_id, target, blocked_user_ids):
    created_at = target.get("created_at") if target else None
    if not created_at:
        return None
    field = _message_scope_field(scope_type)
    offset = 0
    while True:
        try:
            rows = list_rows_safe(
                COLLECTIONS["chat_messages"],
                [
                    Query.equal(field, [scope_id]),
                    Query.less_than("created_at", created_at),
                    Query.order_desc("created_at"),
                    Query.limit(CHAT_SUMMARY_SCAN_LIMIT),
                    Query.offset(offset),
                ],
            ).get("rows", [])
        except AppwriteException:
            logger.exception("Failed to load previous chat read boundary")
            return None
        for row in rows:
            if _message_visible_for_user(row, scope_type, blocked_user_ids):
                return row
        if len(rows) < CHAT_SUMMARY_SCAN_LIMIT:
            return None
        offset += CHAT_SUMMARY_SCAN_LIMIT


def _clear_read_state(user_id, scope_type, scope_id):
    read_key = _read_key(user_id, scope_type, scope_id)
    try:
        existing = first_row(COLLECTIONS["chat_read_states"], [Query.equal("read_key", [read_key])])
        if existing:
            delete_row_safe(COLLECTIONS["chat_read_states"], _row_id(existing))
    except AppwriteException:
        logger.exception("Failed to clear chat read state")
    return None


def _mark_unread(scope_type, scope_id, message_id=None):
    user_id = _current_user_id()
    blocked_user_ids = _blocked_user_ids(user_id) if scope_type == "thread" else set()
    target = None
    if message_id:
        try:
            candidate = get_row_safe(COLLECTIONS["chat_messages"], message_id, allow_missing=True)
        except AppwriteException:
            candidate = None
        if (
            _message_in_scope(candidate, scope_type, scope_id)
            and _message_can_be_unread_target(candidate, scope_type, user_id, blocked_user_ids)
        ):
            target = candidate
    if not target:
        target = _latest_unread_target(scope_type, scope_id, user_id, blocked_user_ids)
    if not target:
        return _read_state_for_scope(user_id, scope_type, scope_id)

    previous = _previous_visible_message(scope_type, scope_id, target, blocked_user_ids)
    if previous:
        return _persist_read_state(user_id, scope_type, scope_id, previous, fallback_to_now=False)
    _clear_read_state(user_id, scope_type, scope_id)
    return {}


def _existing_visible_channels_for_summary():
    _default_channels()
    try:
        rows = list_rows_all(COLLECTIONS["chat_channels"], [Query.equal("kind", ["discord", "university"])])
    except AppwriteException:
        logger.exception("Failed to list chat summary channels")
        return []
    return [row for row in rows if _can_access_channel(row)]


def _unread_count(scope_type, scope_id, user_id, last_read_at):
    field = "channel_id" if scope_type == "channel" else "thread_id"
    offset = 0
    blocked_user_ids = _blocked_user_ids(user_id) if scope_type == "thread" else set()
    count = 0

    while True:
        queries = [
            Query.equal(field, [scope_id]),
            Query.order_desc("created_at"),
            Query.limit(CHAT_SUMMARY_SCAN_LIMIT),
            Query.offset(offset),
        ]
        if last_read_at:
            queries.insert(1, Query.greater_than("created_at", last_read_at))
        try:
            rows = list_rows_safe(COLLECTIONS["chat_messages"], queries).get("rows", [])
        except AppwriteException:
            logger.exception("Failed to count unread chat messages")
            return 0, False

        for row in rows:
            if row.get("deleted_at"):
                continue
            message_user_id = str(row.get("user_id") or "")
            if message_user_id == str(user_id):
                continue
            if message_user_id in blocked_user_ids:
                continue
            count += 1
            if count >= CHAT_UNREAD_CAP:
                return CHAT_UNREAD_CAP, True

        if len(rows) < CHAT_SUMMARY_SCAN_LIMIT:
            return count, False
        offset += CHAT_SUMMARY_SCAN_LIMIT


@chat_api_bp.route("/api/universities")
@login_required
def universities():
    query = request.args.get("q") or ""
    return jsonify({"results": search_universities(query)})


@chat_api_bp.route("/api/chat/discord/messages", methods=["POST"])
def discord_message_ingest():
    if not _valid_discord_ingest_request():
        return jsonify({"error": "Discord chat ingest is unavailable."}), 403
    raw_payload = request.get_json(silent=True) or {}
    payload = raw_payload if isinstance(raw_payload, dict) else {}
    message = payload.get("message") if isinstance(payload.get("message"), dict) else payload
    discord_channel_id = (
        payload.get("discord_channel_id")
        or message.get("channel_id")
        or message.get("channel")
    )
    channel = _discord_channel_for_discord_id(discord_channel_id)
    if not _can_sync_discord_channel(channel):
        return jsonify({"error": "Discord channel is not mapped to /chat."}), 404
    row, created = _upsert_discord_message(channel, message, emit_event=True)
    if not row:
        return jsonify({"error": "Unable to ingest Discord message."}), 502
    return jsonify({
        "ok": True,
        "created": bool(created),
        "message_id": _row_id(row),
        "channel_id": _row_id(channel),
    })


@chat_api_bp.route("/api/chat/realtime-token")
@login_required
def chat_realtime_token():
    user_id = _current_user_id()
    sync_chat_presence_labels_for_user(user_id)
    try:
        result = Users(appwrite_client).create_jwt(user_id=user_id, duration=3600)
    except AppwriteException:
        logger.exception("Failed to create Appwrite JWT for chat presence")
        return jsonify({"error": "Unable to create realtime token."}), 502
    jwt = result.get("jwt") if isinstance(result, dict) else getattr(result, "jwt", None)
    if not jwt:
        return jsonify({"error": "Unable to create realtime token."}), 502
    return jsonify({"jwt": jwt})


@chat_api_bp.route("/api/chat/events/stream")
@login_required
def chat_events_stream():
    since = (request.args.get("since") or "").strip() or None
    after_id = (request.args.get("after_id") or "").strip() or None

    def generate():
        cursor_since = since or format_datetime(_now())
        cursor_after_id = after_id
        listener = threading.Condition()
        with _chat_event_listener_lock:
            _chat_event_listeners.append(listener)
        last_keepalive = time.monotonic()
        try:
            while True:
                events = _list_chat_events_after(cursor_since, cursor_after_id)
                for event in events:
                    payload = json.dumps(_serialize_chat_event(event), separators=(",", ":"))
                    yield f"data: {payload}\n\n"
                    cursor_since = event.get("created_at") or cursor_since
                    cursor_after_id = _row_id(event)
                    last_keepalive = time.monotonic()
                now = time.monotonic()
                if now - last_keepalive >= CHAT_EVENTS_KEEPALIVE_SECONDS:
                    yield ": keepalive\n\n"
                    last_keepalive = now
                    wait_seconds = CHAT_EVENTS_POLL_SECONDS
                else:
                    wait_seconds = min(
                        CHAT_EVENTS_KEEPALIVE_SECONDS - (now - last_keepalive),
                        CHAT_EVENTS_POLL_SECONDS,
                    )
                with listener:
                    listener.wait(timeout=max(wait_seconds, CHAT_EVENTS_POLL_SECONDS))
        finally:
            with _chat_event_listener_lock:
                try:
                    _chat_event_listeners.remove(listener)
                except ValueError:
                    pass

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers=headers)


@chat_api_bp.route("/api/chat/bootstrap")
@login_required
def bootstrap():
    channels = _default_channels()
    university = _ensure_university_request()
    if university.get("channel"):
        channels.append(university["channel"])
    sync_chat_presence_labels_for_user(_current_user_id())
    dm_threads = _list_threads()
    return jsonify({
        "user": _current_user_payload(),
        "settings": _settings_payload(),
        "sections": {
            "nest": [_channel_payload(channel, university.get("status") if channel == university.get("channel") else None) for channel in channels],
            "direct_messages": dm_threads,
        },
        "university": {
            "status": university.get("status"),
            "school": current_user.school,
            "school_key": getattr(current_user, "school_key", None),
        },
        "discord_invite_url": os.environ.get("DISCORD_INVITE_URL", ""),
    })


@chat_api_bp.route("/api/chat/summary")
@login_required
def chat_summary():
    user_id = _current_user_id()
    rooms = []
    total_unread = 0
    has_capped_room = False

    for channel in _existing_visible_channels_for_summary():
        channel_id = _row_id(channel)
        read_state = _read_state_for_scope(user_id, "channel", channel_id)
        unread, capped = _unread_count("channel", channel_id, user_id, (read_state or {}).get("last_read_at"))
        total_unread += unread
        has_capped_room = has_capped_room or capped
        rooms.append({
            "type": "channel",
            "id": channel_id,
            "label": channel.get("label") or channel.get("name") or "Chat",
            "unread_count": min(unread, CHAT_UNREAD_CAP),
            "has_unread": unread > 0,
        })

    for thread in _threads_for_current_user():
        thread_id = _row_id(thread)
        read_state = _read_state_for_scope(user_id, "thread", thread_id)
        unread, capped = _unread_count("thread", thread_id, user_id, (read_state or {}).get("last_read_at"))
        total_unread += unread
        has_capped_room = has_capped_room or capped
        rooms.append({
            "type": "thread",
            "id": thread_id,
            "unread_count": min(unread, CHAT_UNREAD_CAP),
            "has_unread": unread > 0,
        })

    return jsonify({
        "total_unread": min(total_unread, CHAT_UNREAD_CAP),
        "unread_capped": total_unread >= CHAT_UNREAD_CAP or has_capped_room,
        "has_unread": total_unread > 0,
        "rooms": rooms,
    })


@chat_api_bp.route("/api/chat/read", methods=["POST"])
@login_required
def mark_chat_read():
    data = request.get_json(silent=True) or {}
    scope_type = str(data.get("scope_type") or "").strip()
    scope_id = str(data.get("scope_id") or "").strip()
    message_id = str(data.get("message_id") or "").strip() or None
    if scope_type == "channel":
        channel = get_row_safe(COLLECTIONS["chat_channels"], scope_id, allow_missing=True)
        if not _can_access_channel(channel):
            return jsonify({"error": "Channel unavailable."}), 404
    elif scope_type == "thread":
        if not _thread_for_user(scope_id):
            return jsonify({"error": "Thread unavailable."}), 404
    else:
        return jsonify({"error": "Unsupported read scope."}), 400
    row = _mark_read(scope_type, scope_id, message_id=message_id)
    return jsonify({"status": "ok", "read_state": row or {}})


@chat_api_bp.route("/api/chat/unread", methods=["POST"])
@login_required
def mark_chat_unread():
    data = request.get_json(silent=True) or {}
    scope_type = str(data.get("scope_type") or "").strip()
    scope_id = str(data.get("scope_id") or "").strip()
    message_id = str(data.get("message_id") or "").strip() or None
    if scope_type == "channel":
        channel = get_row_safe(COLLECTIONS["chat_channels"], scope_id, allow_missing=True)
        if not _can_access_channel(channel):
            return jsonify({"error": "Channel unavailable."}), 404
    elif scope_type == "thread":
        if not _thread_for_user(scope_id):
            return jsonify({"error": "Thread unavailable."}), 404
    else:
        return jsonify({"error": "Unsupported unread scope."}), 400
    row = _mark_unread(scope_type, scope_id, message_id=message_id)
    return jsonify({"status": "ok", "read_state": row or {}})


def _threads_for_current_user():
    user_id = _current_user_id()
    try:
        rows_a = list_rows_all(COLLECTIONS["chat_dm_threads"], [Query.equal("participant_a", [user_id])])
        rows_b = list_rows_all(COLLECTIONS["chat_dm_threads"], [Query.equal("participant_b", [user_id])])
    except AppwriteException:
        logger.exception("Failed to list DM threads")
        return []
    threads = {(_row_id(row)): row for row in rows_a + rows_b}.values()
    return list(threads)


def _thread_payload(thread):
    other = _public_user(_other_participant(thread))
    if not other:
        return None
    other["online"] = False
    thread_id = _row_id(thread)
    return {
        "id": thread_id,
        "other_user": other,
        "last_message_at": thread.get("last_message_at") or thread.get("updated_at") or thread.get("created_at"),
        "blocked": _is_blocked_between(_current_user_id(), other["id"]),
        "active_count": 0,
        "presence_status": "offline",
        "presence_scope": _presence_scope("thread", thread_id),
        "presence_read_permissions": _presence_read_permissions_for_thread(thread),
        "presence_profile_resolve_allowed": True,
    }


def _list_threads():
    threads = _threads_for_current_user()
    payload = []
    for thread in threads:
        item = _thread_payload(thread)
        if item:
            payload.append(item)
    payload.sort(key=lambda item: item.get("last_message_at") or "", reverse=True)
    return payload


@chat_api_bp.route("/api/chat/channels/<channel_id>/messages")
@login_required
def channel_messages(channel_id):
    channel = get_row_safe(COLLECTIONS["chat_channels"], channel_id, allow_missing=True)
    if not _can_access_channel(channel):
        return jsonify({"error": "Channel unavailable."}), 404
    after = request.args.get("after")
    after_message_id = request.args.get("after_message_id")
    rows = _list_messages(
        "channel",
        channel_id,
        request.args.get("before"),
        after,
        after_message_id=after_message_id,
    )
    return jsonify({
        "messages": _serialize_messages(rows),
        "has_more": not after and not after_message_id and channel.get("kind") != "discord" and len(rows) == MESSAGE_PAGE_SIZE,
        "channel": _channel_payload(channel),
        **_room_message_metadata("channel", channel_id),
    })


@chat_api_bp.route("/api/chat/channels/<channel_id>/messages", methods=["POST"])
@login_required
def send_channel_message(channel_id):
    channel = get_row_safe(COLLECTIONS["chat_channels"], channel_id, allow_missing=True)
    if not _can_access_channel(channel):
        return jsonify({"error": "Channel unavailable."}), 404
    if channel.get("read_only"):
        return jsonify({"error": "This channel is read-only."}), 403
    content = (request.get_json(silent=True) or {}).get("content") or ""
    content = str(content).strip()
    if not content:
        return jsonify({"error": "Message cannot be empty."}), 400
    if len(content) > 2000:
        return jsonify({"error": "Message is too long."}), 400

    now = format_datetime(_now())
    previews = _previews_for_content(content)
    base_payload = {
        "channel_id": channel_id,
        "user_id": _current_user_id(),
        "author_name": current_user.name or current_user.username or "Nest User",
        "author_username": current_user.username or "",
        "author_avatar_url": current_user.picture_url or "",
        "content": content,
        "rendered_html": render_markdown(content),
        "link_preview_json": json.dumps(previews),
        "created_at": now,
        "updated_at": now,
    }

    if channel.get("kind") == "discord":
        try:
            discord_message = execute_chat_webhook(
                content,
                current_user.name or current_user.username or "Nest User",
                current_user.picture_url,
            )
        except (DiscordBridgeError, Exception):
            logger.exception("Failed to send Discord webhook message")
            return jsonify({"error": "Unable to send to Discord right now."}), 502
        base_payload.update({
            "source": "discord",
            "external_id": _discord_message_external_id(channel, discord_message.get("id")),
            "discord_message_id": discord_message.get("id"),
            "discord_webhook_id": discord_message.get("webhook_id"),
            "created_at": discord_message.get("timestamp") or now,
        })
    else:
        base_payload["source"] = "appwrite"

    row_id = None
    if channel.get("kind") == "discord" and base_payload.get("discord_message_id"):
        row_id = _discord_message_row_id(channel, base_payload.get("discord_message_id"))

    try:
        row = create_row_safe(
            COLLECTIONS["chat_messages"],
            row_id=row_id or ID.unique(),
            data=base_payload,
        )
        created = True
    except AppwriteException:
        existing = None
        if row_id:
            existing = get_row_safe(COLLECTIONS["chat_messages"], row_id, allow_missing=True)
        if not existing and base_payload.get("external_id"):
            existing = first_row(
                COLLECTIONS["chat_messages"],
                [Query.equal("external_id", [base_payload.get("external_id")])],
            )
        if existing:
            row = existing
            created = False
        else:
            logger.exception("Failed to persist channel message")
            return jsonify({"error": "Unable to save message."}), 500
    try:
        if channel.get("kind") == "discord":
            _prune_discord_messages(channel_id)
        if created:
            emit_chat_event(
                "channel",
                channel_id,
                "message_created",
                message_id=_row_id(row),
                channel_id=channel_id,
                actor_id=_current_user_id(),
                channel=channel,
            )
    except AppwriteException:
        logger.exception("Failed to finalize channel message")
        return jsonify({"error": "Unable to save message."}), 500
    return jsonify({"message": _serialize_message(row)}), 201


@chat_api_bp.route("/api/chat/messages/<message_id>", methods=["GET", "DELETE"])
@login_required
def delete_message(message_id):
    if request.method == "GET":
        row = _message_for_current_user(message_id)
        if not row:
            return jsonify({"error": "Message not found."}), 404
        return jsonify({"message": _serialize_message(row)})

    row = get_row_safe(COLLECTIONS["chat_messages"], message_id, allow_missing=True)
    if not row or row.get("deleted_at"):
        return jsonify({"error": "Message not found."}), 404
    if str(row.get("user_id") or "") != _current_user_id():
        return jsonify({"error": "You can only delete your own messages."}), 403
    created = _message_timestamp(row)
    if (_now() - created).total_seconds() > DELETE_WINDOW_SECONDS:
        return jsonify({"error": "Messages can only be deleted within 5 minutes of sending."}), 403

    if row.get("source") == "discord" and row.get("discord_message_id"):
        try:
            delete_webhook_message(row.get("discord_webhook_id"), row.get("discord_message_id"))
        except Exception:
            logger.exception("Failed to delete Discord webhook message")
            return jsonify({"error": "Unable to delete the Discord message right now."}), 502
    try:
        deleted_at = format_datetime(_now())
        update_row_safe(
            COLLECTIONS["chat_messages"],
            message_id,
            {
                "deleted_at": deleted_at,
                "deleted_by": _current_user_id(),
                "updated_at": deleted_at,
            },
        )
        if row.get("channel_id"):
            channel = get_row_safe(COLLECTIONS["chat_channels"], row.get("channel_id"), allow_missing=True)
            emit_chat_event(
                "channel",
                row.get("channel_id"),
                "message_deleted",
                message_id=message_id,
                channel_id=row.get("channel_id"),
                actor_id=_current_user_id(),
                channel=channel,
            )
        elif row.get("thread_id"):
            thread = get_row_safe(COLLECTIONS["chat_dm_threads"], row.get("thread_id"), allow_missing=True)
            emit_chat_event(
                "thread",
                row.get("thread_id"),
                "message_deleted",
                message_id=message_id,
                thread_id=row.get("thread_id"),
                actor_id=_current_user_id(),
                readable_user_ids=_thread_participant_ids(thread or {}),
            )
        _emit_chat_delete_audit(row, deleted_at)
    except AppwriteException:
        logger.exception("Failed to delete chat message")
        return jsonify({"error": "Unable to delete message."}), 500
    return jsonify({"status": "ok"})


@chat_api_bp.route("/api/chat/dm/search")
@login_required
def dm_search():
    query = (request.args.get("q") or "").strip().lower()
    if len(query) < 2:
        return jsonify({"results": []})
    try:
        users = list_rows_all(COLLECTIONS["users"], [Query.order_desc("created_at")], limit=100)
    except AppwriteException:
        logger.exception("Failed to search DM users")
        return jsonify({"results": []})
    results = []
    for user in users:
        if _row_id(user) == _current_user_id():
            continue
        haystack = " ".join([
            user.get("name") or "",
            user.get("username") or "",
            user.get("school") or "",
            user.get("major") or "",
            user.get("graduation_year") or "",
            user.get("class_year") or "",
        ]).lower()
        if query in haystack:
            results.append(_public_user(user))
        if len(results) >= 20:
            break
    return jsonify({"results": results})


@chat_api_bp.route("/api/chat/dm/threads", methods=["GET", "POST"])
@login_required
def dm_threads():
    if request.method == "GET":
        return jsonify({"threads": _list_threads()})
    other_user_id = str((request.get_json(silent=True) or {}).get("user_id") or "").strip()
    try:
        thread = _get_or_create_thread(other_user_id)
    except (ValueError, AppwriteException) as exc:
        return jsonify({"error": str(exc) or "Unable to create thread."}), 400
    emit_chat_event(
        "thread",
        _row_id(thread),
        "thread_updated",
        thread_id=_row_id(thread),
        actor_id=_current_user_id(),
        readable_user_ids=_thread_participant_ids(thread),
    )
    return jsonify({"thread": _thread_payload(thread)}), 201


@chat_api_bp.route("/api/chat/dm/threads/<thread_id>")
@login_required
def dm_thread(thread_id):
    thread = _thread_for_user(thread_id)
    if not thread:
        return jsonify({"error": "Thread unavailable."}), 404
    payload = _thread_payload(thread)
    if not payload:
        return jsonify({"error": "Thread unavailable."}), 404
    return jsonify({"thread": payload})


@chat_api_bp.route("/api/chat/dm/threads/<thread_id>/messages", methods=["GET", "POST"])
@login_required
def dm_thread_messages(thread_id):
    thread = _thread_for_user(thread_id)
    if not thread:
        return jsonify({"error": "Thread unavailable."}), 404
    other = _public_user(_other_participant(thread))
    if request.method == "GET":
        after = request.args.get("after")
        after_message_id = request.args.get("after_message_id")
        rows = _list_messages(
            "thread",
            thread_id,
            request.args.get("before"),
            after,
            after_message_id=after_message_id,
        )
        thread_payload = _thread_payload(thread) or {}
        return jsonify({
            "messages": _serialize_messages(rows),
            "has_more": not after and not after_message_id and len(rows) == MESSAGE_PAGE_SIZE,
            "thread": {
                "id": thread_id,
                "other_user": thread_payload.get("other_user", other),
                "blocked": thread_payload.get("blocked", _is_blocked_between(_current_user_id(), other["id"]) if other else False),
                "active_count": 0,
                "presence_status": thread_payload.get("presence_status", "offline"),
                "presence_scope": thread_payload.get("presence_scope") or _presence_scope("thread", thread_id),
                "presence_read_permissions": thread_payload.get("presence_read_permissions") or _presence_read_permissions_for_thread(thread),
                "presence_profile_resolve_allowed": True,
            },
            **_room_message_metadata("thread", thread_id),
        })

    if not other:
        return jsonify({"error": "Recipient unavailable."}), 404
    if _is_blocked_between(_current_user_id(), other["id"]):
        return jsonify({"error": "This conversation is blocked."}), 403
    content = str((request.get_json(silent=True) or {}).get("content") or "").strip()
    if not content:
        return jsonify({"error": "Message cannot be empty."}), 400
    if len(content) > 2000:
        return jsonify({"error": "Message is too long."}), 400
    now = format_datetime(_now())
    previews = _previews_for_content(content)
    try:
        row = create_row_safe(
            COLLECTIONS["chat_messages"],
            row_id=ID.unique(),
            data={
                "thread_id": thread_id,
                "source": "appwrite",
                "user_id": _current_user_id(),
                "author_name": current_user.name or current_user.username or "Nest User",
                "author_username": current_user.username or "",
                "author_avatar_url": current_user.picture_url or "",
                "content": content,
                "rendered_html": render_markdown(content),
                "link_preview_json": json.dumps(previews),
                "created_at": now,
                "updated_at": now,
            },
        )
        update_row_safe(COLLECTIONS["chat_dm_threads"], thread_id, {"last_message_at": now, "updated_at": now})
        emit_chat_event(
            "thread",
            thread_id,
            "message_created",
            message_id=_row_id(row),
            thread_id=thread_id,
            actor_id=_current_user_id(),
            readable_user_ids=_thread_participant_ids(thread),
        )
    except AppwriteException:
        logger.exception("Failed to save DM")
        return jsonify({"error": "Unable to send message."}), 500
    return jsonify({"message": _serialize_message(row)}), 201


@chat_api_bp.route("/api/chat/blocks/<user_id>", methods=["POST", "DELETE"])
@login_required
def blocks(user_id):
    target_id = str(user_id or "").strip()
    if target_id == _current_user_id():
        return jsonify({"error": "You cannot block yourself."}), 400
    key = f"{_current_user_id()}:{target_id}"
    if request.method == "DELETE":
        try:
            row = first_row(COLLECTIONS["chat_blocks"], [Query.equal("block_key", [key])])
            if row:
                delete_row_safe(COLLECTIONS["chat_blocks"], _row_id(row))
            for thread in _threads_for_current_user():
                if target_id in _thread_participant_ids(thread):
                    emit_chat_event(
                        "thread",
                        _row_id(thread),
                        "block_updated",
                        thread_id=_row_id(thread),
                        actor_id=_current_user_id(),
                        readable_user_ids=_thread_participant_ids(thread),
                    )
        except AppwriteException:
            logger.exception("Failed to unblock user")
            return jsonify({"error": "Unable to unblock user."}), 500
        return jsonify({"status": "ok", "blocked": False})

    try:
        existing = first_row(COLLECTIONS["chat_blocks"], [Query.equal("block_key", [key])])
        if not existing:
            create_row_safe(
                COLLECTIONS["chat_blocks"],
                row_id=ID.unique(),
                data={
                    "blocker_id": _current_user_id(),
                    "blocked_id": target_id,
                    "block_key": key,
                    "created_at": format_datetime(_now()),
                },
            )
        for thread in _threads_for_current_user():
            if target_id in _thread_participant_ids(thread):
                emit_chat_event(
                    "thread",
                    _row_id(thread),
                    "block_updated",
                    thread_id=_row_id(thread),
                    actor_id=_current_user_id(),
                    readable_user_ids=_thread_participant_ids(thread),
                )
    except AppwriteException:
        logger.exception("Failed to block user")
        return jsonify({"error": "Unable to block user."}), 500
    return jsonify({"status": "ok", "blocked": True})


@chat_api_bp.route("/api/chat/presence/users", methods=["POST"])
@login_required
def presence_users():
    data = request.get_json(silent=True) or {}
    scope_type = str(data.get("scope_type") or "").strip()
    scope_id = str(data.get("scope_id") or "").strip()
    requested_ids = []
    for value in data.get("user_ids") or []:
        user_id = str(value or "").strip()
        if user_id and user_id not in requested_ids:
            requested_ids.append(user_id)
        if len(requested_ids) >= 80:
            break

    allowed_ids = None
    if scope_type == "channel":
        channel = get_row_safe(COLLECTIONS["chat_channels"], scope_id, allow_missing=True)
        if not _can_access_channel(channel):
            return jsonify({"error": "Presence scope unavailable."}), 404
    elif scope_type == "thread":
        thread = _thread_for_user(scope_id)
        if not thread:
            return jsonify({"error": "Presence scope unavailable."}), 404
        allowed_ids = set(_thread_participant_ids(thread))
    else:
        return jsonify({"error": "Unsupported presence scope."}), 400

    users = []
    for user_id in requested_ids:
        if allowed_ids is not None and user_id not in allowed_ids:
            continue
        try:
            user = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
        except AppwriteException:
            logger.exception("Failed to resolve presence user %s", user_id)
            continue
        public_user = _public_user(user)
        if public_user:
            users.append(public_user)
    return jsonify({"users": users})


@chat_api_bp.route("/api/chat/presence", methods=["POST"])
@login_required
def presence():
    # Compatibility endpoint for older clients. Live chat presence now uses
    # Appwrite Presences directly from the browser.
    return jsonify({
        "status": "ok",
        "users": [],
        "dm_statuses": {},
    })
