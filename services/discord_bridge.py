import json
import logging
import os
import time
from datetime import datetime, timezone

import requests
from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query

from appwrite_client import COLLECTIONS
from appwrite_helpers import create_row_safe, first_row, format_datetime, update_row_safe


logger = logging.getLogger(__name__)
DISCORD_API_BASE = "https://discord.com/api/v10"
WEBHOOK_CONFIG_KEY = "nest_chat_webhook"
DEFAULT_GUILD_ID = "867928393558151228"
GUILD_ROLES_CACHE_SECONDS = 10 * 60
_guild_roles_cache = {}
_user_cache = {}


class DiscordBridgeError(RuntimeError):
    pass


def _bot_token():
    return (os.environ.get("DISCORD_BOT_TOKEN") or "").strip()


def _headers():
    token = _bot_token()
    if not token:
        raise DiscordBridgeError("Discord bot token is not configured.")
    return {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": "Nest.APStudy Discord bridge",
    }


def _request(method, path, **kwargs):
    response = requests.request(
        method,
        f"{DISCORD_API_BASE}{path}",
        headers=kwargs.pop("headers", _headers()),
        timeout=8,
        **kwargs,
    )
    if response.status_code >= 400:
        raise DiscordBridgeError(f"Discord API returned {response.status_code}: {response.text[:200]}")
    if response.status_code == 204 or not response.content:
        return None
    return response.json()


def fetch_channel_messages(channel_id, limit=50):
    if not _bot_token():
        return []
    safe_limit = max(1, min(int(limit or 50), 100))
    try:
        return _request("GET", f"/channels/{channel_id}/messages", params={"limit": safe_limit}) or []
    except (DiscordBridgeError, requests.RequestException):
        logger.exception("Failed to fetch Discord channel messages")
        return []


def fetch_guild_roles(guild_id=None):
    guild_id = str(guild_id or os.environ.get("DISCORD_GUILD_ID") or DEFAULT_GUILD_ID).strip()
    if not guild_id or not _bot_token():
        return []
    now = time.monotonic()
    cached = _guild_roles_cache.get(guild_id)
    if cached and now - cached["loaded_at"] < GUILD_ROLES_CACHE_SECONDS:
        return cached["roles"]
    try:
        roles = _request("GET", f"/guilds/{guild_id}/roles") or []
    except (DiscordBridgeError, requests.RequestException):
        logger.exception("Failed to fetch Discord guild roles")
        return cached["roles"] if cached else []
    _guild_roles_cache[guild_id] = {"loaded_at": now, "roles": roles}
    return roles


def fetch_discord_user(user_id):
    user_id = str(user_id or "").strip()
    if not user_id or not _bot_token():
        return None
    now = time.monotonic()
    cached = _user_cache.get(user_id)
    if cached and now - cached["loaded_at"] < GUILD_ROLES_CACHE_SECONDS:
        return cached["user"]
    try:
        user = _request("GET", f"/users/{user_id}") or None
    except (DiscordBridgeError, requests.RequestException):
        logger.exception("Failed to fetch Discord user %s", user_id)
        return cached["user"] if cached else None
    _user_cache[user_id] = {"loaded_at": now, "user": user}
    return user


def _get_bridge_config():
    try:
        return first_row(
            COLLECTIONS["chat_bridge_config"],
            [Query.equal("config_key", [WEBHOOK_CONFIG_KEY])],
        )
    except AppwriteException:
        logger.exception("Failed to read Discord bridge config")
        return None


def _save_bridge_config(value):
    now = format_datetime(datetime.now(timezone.utc))
    row = _get_bridge_config()
    payload = {
        "config_key": WEBHOOK_CONFIG_KEY,
        "config_value": json.dumps(value),
        "updated_at": now,
    }
    try:
        if row:
            return update_row_safe(COLLECTIONS["chat_bridge_config"], row.get("$id"), payload)
        return create_row_safe(
            COLLECTIONS["chat_bridge_config"],
            row_id=ID.unique(),
            data={**payload, "created_at": now},
        )
    except AppwriteException as exc:
        raise DiscordBridgeError("Unable to save Discord webhook config.") from exc


def _load_webhook():
    row = _get_bridge_config()
    if not row or not row.get("config_value"):
        return None
    try:
        value = json.loads(row.get("config_value"))
    except (TypeError, json.JSONDecodeError):
        return None
    if value.get("id") and value.get("token"):
        return value
    return None


def ensure_chat_webhook():
    webhook = _load_webhook()
    if webhook:
        return webhook

    channel_id = (os.environ.get("DISCORD_CHAT_CHANNEL_ID") or "").strip()
    if not channel_id:
        raise DiscordBridgeError("Discord chat channel is not configured.")

    data = _request(
        "POST",
        f"/channels/{channel_id}/webhooks",
        json={"name": "Nest.APStudy Chat"},
    )
    webhook = {
        "id": data.get("id"),
        "token": data.get("token"),
        "channel_id": data.get("channel_id") or channel_id,
    }
    if not webhook["id"] or not webhook["token"]:
        raise DiscordBridgeError("Discord did not return a usable webhook token.")
    _save_bridge_config(webhook)
    return webhook


def execute_chat_webhook(content, username, avatar_url=None):
    webhook = ensure_chat_webhook()
    payload = {
        "content": str(content or "")[:2000],
        "username": str(username or "Nest User")[:80],
        "allowed_mentions": {"parse": []},
    }
    if avatar_url:
        payload["avatar_url"] = avatar_url

    response = requests.post(
        f"{DISCORD_API_BASE}/webhooks/{webhook['id']}/{webhook['token']}",
        params={"wait": "true"},
        json=payload,
        timeout=8,
    )
    if response.status_code >= 400:
        raise DiscordBridgeError(f"Discord webhook returned {response.status_code}: {response.text[:200]}")
    return response.json()


def delete_webhook_message(webhook_id, message_id):
    webhook = _load_webhook()
    if not webhook or not message_id:
        return False
    if webhook_id and str(webhook_id) != str(webhook.get("id")):
        return False
    response = requests.delete(
        f"{DISCORD_API_BASE}/webhooks/{webhook['id']}/{webhook['token']}/messages/{message_id}",
        timeout=8,
    )
    if response.status_code in {204, 404}:
        return True
    if response.status_code >= 400:
        raise DiscordBridgeError(f"Discord webhook delete returned {response.status_code}: {response.text[:200]}")
    return True
