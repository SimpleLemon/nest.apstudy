import json
import logging
import os
from datetime import datetime, timedelta, timezone

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.permission import Permission
from appwrite.query import Query
from appwrite.role import Role

from appwrite_client import COLLECTIONS
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
from services.chat_formatting import extract_links, fetch_link_preview, render_markdown, url_hash
from services.discord_bridge import (
    DiscordBridgeError,
    delete_webhook_message,
    execute_chat_webhook,
    fetch_channel_messages,
)
from services.universities import normalize_school_key, school_payload, search_universities


chat_api_bp = Blueprint("chat_api", __name__)
logger = logging.getLogger(__name__)

DISCORD_MESSAGE_LIMIT = 50
MESSAGE_PAGE_SIZE = 50
DELETE_WINDOW_SECONDS = 5 * 60
PRESENCE_TTL_SECONDS = 90
DEFAULT_AVATAR = "https://resources.apstudy.org/images/AP-Resources-Logo.png"


def _now():
    return datetime.now(timezone.utc)


def _row_id(row):
    return row.get("$id") or row.get("id")


def _current_user_id():
    return str(current_user.id)


def _readable_by_users(user_ids=None):
    ids = [str(user_id) for user_id in (user_ids or []) if user_id]
    if ids:
        return [Permission.read(Role.user(user_id)) for user_id in sorted(set(ids))]
    return [Permission.read(Role.users())]


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
):
    if not scope_type or not scope_id or not event_type:
        return None
    now = format_datetime(_now())
    try:
        return create_row_safe(
            COLLECTIONS["chat_events"],
            row_id=ID.unique(),
            data={
                "scope_type": str(scope_type),
                "scope_id": str(scope_id),
                "event_type": str(event_type),
                "message_id": str(message_id) if message_id else None,
                "thread_id": str(thread_id) if thread_id else None,
                "channel_id": str(channel_id) if channel_id else None,
                "actor_id": str(actor_id) if actor_id else None,
                "created_at": now,
            },
            permissions=_readable_by_users(readable_user_ids),
        )
    except AppwriteException:
        logger.exception("Failed to emit chat event")
        return None


def _message_timestamp(row):
    value = parse_datetime(row.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def _public_user(row):
    if not row:
        return None
    user_id = _row_id(row)
    return {
        "id": user_id,
        "name": row.get("name") or row.get("username") or "Nest User",
        "username": row.get("username") or "",
        "picture_url": row.get("picture_url") or DEFAULT_AVATAR,
        "school": row.get("school") or "",
        "major": row.get("major") or "",
        "graduation_year": row.get("graduation_year") or row.get("class_year") or "",
        "education_level": row.get("education_level") or "",
        "profile_url": f"/u/{row.get('username')}" if row.get("username") else f"/user/{user_id}",
    }


def _current_user_payload():
    return _public_user({
        "$id": _current_user_id(),
        "name": current_user.name,
        "username": current_user.username,
        "picture_url": current_user.picture_url,
        "school": current_user.school,
        "major": current_user.major,
        "graduation_year": current_user.graduation_year,
        "class_year": current_user.class_year,
        "education_level": current_user.education_level,
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
    payload = {
        "kind": "discord",
        "name": name,
        "label": label,
        "section": "nest",
        "discord_channel_id": channel_id,
        "read_only": read_only,
        "approved": True,
        "updated_at": now,
    }
    if existing:
        return update_row_safe(COLLECTIONS["chat_channels"], row_id, payload)
    return create_row_safe(
        COLLECTIONS["chat_channels"],
        row_id=row_id,
        data={**payload, "created_at": now},
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
    active = _active_users("channel", channel_id)
    return {
        "id": channel_id,
        "kind": channel.get("kind"),
        "name": channel.get("name"),
        "label": channel.get("label") or channel.get("name"),
        "school_key": channel.get("school_key"),
        "school_name": channel.get("school_name"),
        "read_only": bool(channel.get("read_only")),
        "approved": bool(channel.get("approved")),
        "active_count": len(active),
        "active_users": active,
        "history_limited": channel.get("kind") == "discord",
        "university_status": university_status or channel.get("university_status"),
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


def _serialize_message(row):
    created = _message_timestamp(row)
    user_id = row.get("user_id")
    can_delete = (
        user_id
        and str(user_id) == _current_user_id()
        and not row.get("deleted_at")
        and (_now() - created).total_seconds() <= DELETE_WINDOW_SECONDS
    )
    previews = []
    if row.get("link_preview_json"):
        try:
            previews = json.loads(row.get("link_preview_json")) or []
        except (TypeError, json.JSONDecodeError):
            previews = []
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
        "created_at": format_datetime(created),
        "can_delete": bool(can_delete),
        "delete_expires_at": format_datetime(created + timedelta(seconds=DELETE_WINDOW_SECONDS)) if user_id == _current_user_id() else None,
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


def _list_messages(scope_type, scope_id, before=None, after=None):
    query_list = _message_queries(scope_type, scope_id, before, after)
    query_list.append(Query.limit(MESSAGE_PAGE_SIZE))
    rows = list_rows_safe(COLLECTIONS["chat_messages"], query_list).get("rows", [])
    visible = [row for row in rows if not row.get("deleted_at")]
    if scope_type == "thread":
        blocked = _blocked_user_ids(_current_user_id())
        visible = [row for row in visible if row.get("user_id") not in blocked]
    visible.sort(key=_message_timestamp)
    return visible


def _upsert_discord_message(channel, message):
    channel_id = _row_id(channel)
    discord_id = str(message.get("id") or "")
    if not discord_id:
        return None
    external_id = f"discord:{channel.get('discord_channel_id')}:{discord_id}"
    author = message.get("author") or {}
    content = message.get("content") or ""
    created_at = message.get("timestamp") or format_datetime(_now())
    previews = _discord_previews(message)
    payload = {
        "channel_id": channel_id,
        "source": "discord",
        "external_id": external_id,
        "author_name": author.get("global_name") or author.get("username") or "Discord User",
        "author_username": author.get("username") or "",
        "author_avatar_url": _discord_avatar(author),
        "content": content,
        "rendered_html": render_markdown(content),
        "link_preview_json": json.dumps(previews),
        "discord_message_id": discord_id,
        "discord_webhook_id": message.get("webhook_id"),
        "created_at": created_at,
        "updated_at": format_datetime(_now()),
    }
    try:
        existing = first_row(COLLECTIONS["chat_messages"], [Query.equal("external_id", [external_id])])
        if existing:
            return update_row_safe(COLLECTIONS["chat_messages"], _row_id(existing), payload)
        return create_row_safe(COLLECTIONS["chat_messages"], row_id=ID.unique(), data=payload)
    except AppwriteException:
        logger.exception("Failed to upsert Discord message")
        return None


def _discord_avatar(author):
    avatar_hash = author.get("avatar")
    user_id = author.get("id")
    if avatar_hash and user_id:
        extension = "gif" if str(avatar_hash).startswith("a_") else "png"
        return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{extension}?size=128"
    return DEFAULT_AVATAR


def _sync_discord_channel(channel):
    discord_channel_id = channel.get("discord_channel_id")
    if not discord_channel_id:
        return
    messages = fetch_channel_messages(discord_channel_id, DISCORD_MESSAGE_LIMIT)
    for message in messages:
        _upsert_discord_message(channel, message)
    _prune_discord_messages(_row_id(channel))


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


def _get_or_create_thread(other_user_id):
    user_id = _current_user_id()
    if other_user_id == user_id:
        raise ValueError("You cannot start a DM with yourself.")
    other = get_row_safe(COLLECTIONS["users"], other_user_id, allow_missing=True)
    if not other:
        raise ValueError("User not found.")
    key = _thread_key(user_id, other_user_id)
    existing = first_row(COLLECTIONS["chat_dm_threads"], [Query.equal("participant_key", [key])])
    if existing:
        return existing
    now = format_datetime(_now())
    a, b = key.split(":", 1)
    return create_row_safe(
        COLLECTIONS["chat_dm_threads"],
        row_id=ID.unique(),
        data={
            "participant_a": a,
            "participant_b": b,
            "participant_key": key,
            "created_at": now,
            "updated_at": now,
        },
    )


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


def _is_user_online(user_id):
    if not user_id:
        return False
    cutoff = _now() - timedelta(seconds=PRESENCE_TTL_SECONDS)
    try:
        rows = list_rows_all(
            COLLECTIONS["chat_presence"],
            [Query.equal("user_id", [str(user_id)]), Query.order_desc("last_seen_at")],
        )
    except AppwriteException:
        logger.exception("Failed to load user presence")
        return False
    for row in rows:
        last_seen = parse_datetime(row.get("last_seen_at"))
        if last_seen and last_seen >= cutoff:
            return True
    return False


def _dm_presence_statuses():
    statuses = {}
    for thread in _threads_for_current_user():
        other = _public_user(_other_participant(thread))
        if other:
            statuses[other["id"]] = "online" if _is_user_online(other["id"]) else "offline"
    return statuses


def _active_users(scope_type, scope_id):
    cutoff = _now() - timedelta(seconds=PRESENCE_TTL_SECONDS)
    try:
        rows = list_rows_all(
            COLLECTIONS["chat_presence"],
            [
                Query.equal("scope_type", [scope_type]),
                Query.equal("scope_id", [scope_id]),
            ],
        )
    except AppwriteException:
        return []
    user_ids = []
    for row in rows:
        last_seen = parse_datetime(row.get("last_seen_at"))
        if last_seen and last_seen >= cutoff and row.get("user_id") not in user_ids:
            user_ids.append(row.get("user_id"))
    users = []
    for user_id in user_ids[:60]:
        try:
            user = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
        except AppwriteException:
            user = None
        if user:
            users.append(_public_user(user))
    return users


def _heartbeat(scope_type, scope_id):
    if scope_type not in {"channel", "thread"} or not scope_id:
        return
    key = f"{_current_user_id()}:{scope_type}:{scope_id}"
    now = format_datetime(_now())
    try:
        existing = first_row(COLLECTIONS["chat_presence"], [Query.equal("presence_key", [key])])
        payload = {
            "user_id": _current_user_id(),
            "scope_type": scope_type,
            "scope_id": scope_id,
            "presence_key": key,
            "last_seen_at": now,
        }
        if existing:
            update_row_safe(COLLECTIONS["chat_presence"], _row_id(existing), payload)
        else:
            create_row_safe(COLLECTIONS["chat_presence"], row_id=ID.unique(), data=payload)
    except AppwriteException:
        logger.exception("Failed to update chat presence")


@chat_api_bp.route("/api/universities")
@login_required
def universities():
    query = request.args.get("q") or ""
    return jsonify({"results": search_universities(query)})


@chat_api_bp.route("/api/chat/bootstrap")
@login_required
def bootstrap():
    channels = _default_channels()
    university = _ensure_university_request()
    if university.get("channel"):
        channels.append(university["channel"])
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
    online = _is_user_online(other["id"])
    other["online"] = online
    return {
        "id": _row_id(thread),
        "other_user": other,
        "last_message_at": thread.get("last_message_at") or thread.get("updated_at") or thread.get("created_at"),
        "blocked": _is_blocked_between(_current_user_id(), other["id"]),
        "active_count": len(_active_users("thread", _row_id(thread))),
        "presence_status": "online" if online else "offline",
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
    if channel.get("kind") == "discord" and not request.args.get("before"):
        _sync_discord_channel(channel)
    _heartbeat("channel", channel_id)
    after = request.args.get("after")
    rows = _list_messages("channel", channel_id, request.args.get("before"), after)
    return jsonify({
        "messages": [_serialize_message(row) for row in rows],
        "has_more": not after and channel.get("kind") != "discord" and len(rows) == MESSAGE_PAGE_SIZE,
        "channel": _channel_payload(channel),
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
        "author_avatar_url": current_user.picture_url or DEFAULT_AVATAR,
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
            "external_id": f"discord:{channel.get('discord_channel_id')}:{discord_message.get('id')}",
            "discord_message_id": discord_message.get("id"),
            "discord_webhook_id": discord_message.get("webhook_id"),
            "created_at": discord_message.get("timestamp") or now,
        })
    else:
        base_payload["source"] = "appwrite"

    try:
        row = create_row_safe(COLLECTIONS["chat_messages"], row_id=ID.unique(), data=base_payload)
        if channel.get("kind") == "discord":
            _prune_discord_messages(channel_id)
        emit_chat_event(
            "channel",
            channel_id,
            "message_created",
            message_id=_row_id(row),
            channel_id=channel_id,
            actor_id=_current_user_id(),
        )
    except AppwriteException:
        logger.exception("Failed to persist channel message")
        return jsonify({"error": "Unable to save message."}), 500
    return jsonify({"message": _serialize_message(row)}), 201


@chat_api_bp.route("/api/chat/messages/<message_id>", methods=["DELETE"])
@login_required
def delete_message(message_id):
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
            emit_chat_event(
                "channel",
                row.get("channel_id"),
                "message_deleted",
                message_id=message_id,
                channel_id=row.get("channel_id"),
                actor_id=_current_user_id(),
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


@chat_api_bp.route("/api/chat/dm/threads/<thread_id>/messages", methods=["GET", "POST"])
@login_required
def dm_thread_messages(thread_id):
    thread = _thread_for_user(thread_id)
    if not thread:
        return jsonify({"error": "Thread unavailable."}), 404
    other = _public_user(_other_participant(thread))
    if request.method == "GET":
        _heartbeat("thread", thread_id)
        after = request.args.get("after")
        rows = _list_messages("thread", thread_id, request.args.get("before"), after)
        thread_payload = _thread_payload(thread) or {}
        return jsonify({
            "messages": [_serialize_message(row) for row in rows],
            "has_more": not after and len(rows) == MESSAGE_PAGE_SIZE,
            "thread": {
                "id": thread_id,
                "other_user": thread_payload.get("other_user", other),
                "blocked": thread_payload.get("blocked", _is_blocked_between(_current_user_id(), other["id"]) if other else False),
                "active_count": len(_active_users("thread", thread_id)),
                "presence_status": thread_payload.get("presence_status", "offline"),
            },
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
                "author_avatar_url": current_user.picture_url or DEFAULT_AVATAR,
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


@chat_api_bp.route("/api/chat/presence", methods=["POST"])
@login_required
def presence():
    data = request.get_json(silent=True) or {}
    scope_type = data.get("scope_type")
    scope_id = data.get("scope_id")
    _heartbeat(scope_type, scope_id)
    return jsonify({
        "status": "ok",
        "users": _active_users(scope_type, scope_id),
        "dm_statuses": _dm_presence_statuses(),
    })
