"""OAuth provider identity helpers."""

import logging
from collections.abc import Callable, Iterable, Mapping
from typing import Any, Protocol

from services.user_profile import clean_avatar_url

import requests as http_requests


# Preserve the existing auth-path logging namespace after extraction.
logger = logging.getLogger("blueprints.auth")


class LinkedDiscordIdentity(Protocol):
    def __call__(self, *appwrite_user_ids: str) -> dict[str, Any]: ...


def _discord_avatar_url(profile):
    user_id = profile.get("id") or profile.get("$id")
    avatar_hash = profile.get("avatar")
    if not user_id or not avatar_hash:
        return None
    extension = "gif" if avatar_hash.startswith("a_") else "png"
    return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{extension}?size=256"


def _fetch_provider_identity(provider, access_token):
    if not provider or not access_token:
        return {}

    provider_key = provider.lower()
    try:
        if provider_key == "google":
            response = http_requests.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=8,
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("verified_email") is False:
                    logger.warning("Google token email is not verified")
                    return {}
                return {
                    "id": data.get("id"),
                    "email": data.get("email"),
                    "name": data.get("name"),
                    "avatar_url": data.get("picture"),
                }
            logger.warning("Google identity fetch failed: %s", response.status_code)
            return {}

        if provider_key == "github":
            response = http_requests.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/vnd.github+json",
                },
                timeout=8,
            )
            if response.status_code != 200:
                logger.warning("GitHub identity fetch failed: %s", response.status_code)
                return {}

            data = response.json()
            email = data.get("email")
            if not email:
                emails_response = http_requests.get(
                    "https://api.github.com/user/emails",
                    headers={
                        "Authorization": f"Bearer {access_token}",
                        "Accept": "application/vnd.github+json",
                    },
                    timeout=8,
                )
                if emails_response.status_code == 200:
                    emails = emails_response.json()
                    primary_email = next(
                        (
                            item.get("email")
                            for item in emails
                            if item.get("primary") and item.get("verified")
                        ),
                        None,
                    )
                    email = primary_email

            return {
                "id": data.get("id"),
                "email": email,
                "name": data.get("name") or data.get("login"),
                "avatar_url": data.get("avatar_url"),
            }

        if provider_key == "discord":
            response = http_requests.get(
                "https://discord.com/api/users/@me",
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=8,
            )
            if response.status_code == 200:
                data = response.json()
                if data.get("verified") is False:
                    logger.warning("Discord token email is not verified")
                    return {}
                return {
                    "id": data.get("id"),
                    "email": data.get("email"),
                    "name": data.get("global_name") or data.get("username"),
                    "username": data.get("username") or data.get("global_name"),
                    "avatar_url": _discord_avatar_url(data),
                }
            logger.warning("Discord identity fetch failed: %s", response.status_code)
            return {}
    except Exception:
        logger.exception("Failed to fetch provider identity: %s", provider)

    return {}


def fetch_provider_profile(
    provider: str,
    access_token: str | None,
    *,
    fetch_identity: Callable[[str, str | None], dict[str, Any]],
) -> dict[str, Any]:
    identity = fetch_identity(provider, access_token)
    return {
        "id": identity.get("id"),
        "name": identity.get("name"),
        "username": identity.get("username"),
        "avatar_url": identity.get("avatar_url"),
    } if identity else {}


def provider_avatar_url(
    provider_profile: Mapping[str, Any],
    remote_user: Mapping[str, Any] | None,
    provider: str | None = None,
    *,
    discord_avatar_url: Callable[[Mapping[str, Any]], str | None] = _discord_avatar_url,
    clean_url: Callable[[object], str | None] = clean_avatar_url,
) -> str | None:
    remote_user = remote_user or {}
    provider_key = str(provider or "").strip().lower()
    prefs = remote_user.get("prefs") if isinstance(remote_user.get("prefs"), dict) else {}
    if provider_key == "discord":
        url = clean_url(discord_avatar_url(remote_user))
        if url:
            return url

    candidates = (
        (provider_profile or {}).get("avatar_url"),
        remote_user.get("avatar_url"),
        remote_user.get("photoUrl"),
        remote_user.get("photo_url"),
        remote_user.get("picture"),
        remote_user.get("picture_url"),
        None if provider_key == "discord" else remote_user.get("avatar"),
        prefs.get("avatar_url"),
        prefs.get("photoUrl"),
        prefs.get("photo_url"),
        prefs.get("picture"),
        prefs.get("picture_url"),
        None if provider_key == "discord" else prefs.get("avatar"),
    )
    for candidate in candidates:
        url = clean_url(candidate)
        if url:
            return url
    return None


def resolve_discord_link_identity(
    *,
    provider_uid: str | None = None,
    provider_access_token: str | None = None,
    appwrite_user_ids: Iterable[str] = (),
    fetch_profile: Callable[[str, str | None], dict[str, Any]],
    appwrite_identity: LinkedDiscordIdentity,
) -> dict[str, Any]:
    """Best-effort Discord identity resolution for link/login flows."""
    provider_uid = str(provider_uid or "").strip()
    profile = (
        fetch_profile("discord", provider_access_token)
        if provider_access_token
        else {}
    )
    linked_identity = appwrite_identity(*appwrite_user_ids)

    access_token = provider_access_token or linked_identity.get("access_token")
    if access_token and not profile.get("id"):
        profile = fetch_profile("discord", access_token) or profile

    discord_id = (
        provider_uid
        or str(profile.get("id") or "").strip()
        or str(linked_identity.get("id") or "").strip()
    )
    username = (
        profile.get("username")
        or profile.get("name")
        or linked_identity.get("username")
    )
    return {
        "id": discord_id or None,
        "username": username,
        "has_provider_uid": bool(provider_uid),
        "has_access_token": bool(provider_access_token),
        "has_appwrite_identity": bool(linked_identity.get("id")),
    }
