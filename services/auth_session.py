"""Appwrite-backed profile persistence and authenticated session completion."""

import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, Iterable, Protocol

from flask import current_app, request, session
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime
from models import User, user_from_doc
from services import discord_bridge, invites, notes_collaboration
from services.avatar_storage import avatar_profile_fields
from services.discord_audit import format_actor, format_user_target

Row = dict[str, Any]
logger = logging.getLogger(__name__)


class GetUserRow(Protocol):
    def __call__(self, collection: str, row_id: str, *, allow_missing: bool = False) -> Row | None: ...


class PersistProfile(Protocol):
    def __call__(self, user_id: str, data: Row, *, prepared: Row | None = None, create: bool = False, provider_source_url: str | None = None, initial_settings: Row | None = None) -> Row: ...


class ProviderToken(Protocol):
    def __call__(self, appwrite_user_id: str, provider: str | None = None) -> Row: ...


class ProviderAvatar(Protocol):
    def __call__(self, provider_profile: Row, remote_user: Row, provider: str | None = None) -> str | None: ...


class LogAvatar(Protocol):
    def __call__(self, *, user_id: str, provider: str, page_context: str, created_user: bool, has_provider_token: bool, provider_profile_avatar: str | None, remote_avatar_candidate: str | None, resolved_avatar_url: str | None, storage_result: str) -> None: ...


class DiscordIdentity(Protocol):
    def __call__(self, *, provider_uid: str | None = None, provider_access_token: str | None = None, appwrite_user_ids: Iterable[str] = ()) -> Row: ...


class EstablishLogin(Protocol):
    def __call__(self, user: User, remember: bool = False, duration: timedelta | None = None) -> bool: ...


class SetOAuthSession(Protocol):
    def __call__(self, provider: str, user_id: str, email: str, name: str | None = None, picture_url: str | None = None) -> None: ...


class EmitLoginEvent(Protocol):
    def __call__(self, title: str, *, actor: str, target: str, metadata: Row | None = None, color: str = "green") -> object: ...


@dataclass(frozen=True)
class LoginProfiles:
    get_row: GetUserRow
    find_by_email: Callable[[str], Row | None]
    prepare_avatar: Callable[[str, str], Row | None]
    persist: PersistProfile
    can_refresh_avatar: Callable[[Row], bool]

    def find(self, remote_id: str, email: str | None) -> Row | None:
        row = self.get_row(COLLECTIONS["users"], remote_id, allow_missing=True)
        return row or (self.find_by_email(email) if email else None)


@dataclass(frozen=True)
class LoginProviders:
    identity_token: ProviderToken
    fetch_profile: Callable[[str, str | None], Row]
    avatar_url: ProviderAvatar
    log_avatar: LogAvatar
    discord_identity: DiscordIdentity


@dataclass(frozen=True)
class LoginCompletion:
    login: EstablishLogin
    set_oauth: SetOAuthSession
    sync_presence: Callable[[str, Row], list[str] | None]
    emit_event: EmitLoginEvent
    redirect: Callable[[Row], str]
    session_duration: timedelta
    invite_cookie: str

    def establish(self, user_doc: Row, *, email: str, provider: str, remote_id: str, name: str | None, picture_url: str | None) -> None:
        session.permanent = True
        self.login(user_from_doc(user_doc), remember=True, duration=current_app.config.get("AUTH_SESSION_DURATION", self.session_duration))
        session["user_id"] = user_doc.get("$id") or user_doc.get("id")
        session["email"] = email
        self.set_oauth(provider, remote_id, email, name=name, picture_url=picture_url)

    def audit(self, user_doc: Row, provider: str, page_context: str, *, created_user: bool, email: str) -> None:
        user_id = user_doc.get("$id") or user_doc.get("id")
        actor = format_actor(user_id=user_id, username=user_doc.get("username") or user_doc.get("name"))
        metadata = {"page_context": page_context, "resource_type": "user", "resource_id": user_id, "provider": provider}
        if created_user:
            self.emit_event("New User Created", actor=actor, target=format_user_target(user_doc), metadata={**metadata, "email": email, "default_settings_created": True}, color="green")
        self.emit_event("User Login", actor=actor, target=format_user_target(user_doc), metadata={**metadata, "created_user": created_user}, color="green")


def _complete_appwrite_login(
    remote_user,
    provider="appwrite",
    email=None,
    provider_access_token=None,
    provider_uid=None,
    page_context="auth/session",
    *,
    profiles: LoginProfiles,
    providers: LoginProviders,
    completion: LoginCompletion,
    now_fn: Callable[[], datetime] = datetime.utcnow,
):
    """Persist provider identity, then establish the local authenticated session."""
    remote_user = remote_user or {}
    remote_user_id = remote_user.get("$id") or remote_user.get("id")
    remote_email = remote_user.get("email") or ""
    if not remote_user_id:
        raise ValueError("Invalid Appwrite user.")
    if not email:
        email = remote_email

    appwrite_user_id = str(remote_user_id)
    user_doc = profiles.find(appwrite_user_id, email)
    created_user = False

    if not provider_access_token:
        identity_token = providers.identity_token(
            appwrite_user_id,
            provider=provider,
        )
        provider_access_token = (
            identity_token.get("provider_access_token") or provider_access_token
        )
        if not provider_uid:
            provider_uid = identity_token.get("provider_uid")
        if identity_token.get("provider"):
            provider = identity_token["provider"]

    provider_profile = providers.fetch_profile(provider, provider_access_token)
    provider_name = provider_profile.get("name")
    resolved_provider_avatar_url = providers.avatar_url(
        provider_profile,
        remote_user,
        provider=provider,
    )
    remote_avatar_candidate = providers.avatar_url({}, remote_user, provider=provider)
    providers.log_avatar(
        user_id=appwrite_user_id,
        provider=provider,
        page_context=page_context,
        created_user=not bool(user_doc),
        has_provider_token=bool(provider_access_token),
        provider_profile_avatar=provider_profile.get("avatar_url"),
        remote_avatar_candidate=remote_avatar_candidate,
        resolved_avatar_url=resolved_provider_avatar_url,
        storage_result="pending",
    )

    discord_id_value = None
    discord_username_value = None
    if provider == "discord":
        discord_identity = providers.discord_identity(
            provider_uid=provider_uid,
            provider_access_token=provider_access_token,
            appwrite_user_ids=[appwrite_user_id],
        )
        discord_id_value = discord_identity.get("id")
        discord_username_value = discord_identity.get("username")

    # Provider names initialize profiles; a name chosen in Nest survives login.
    preserve_name = bool(user_doc and str(user_doc.get("name") or "").strip())
    name = None if preserve_name else (provider_name or remote_user.get("name") or remote_user.get("displayName"))
    picture_url = resolved_provider_avatar_url

    if not user_doc:
        created_at = format_datetime(now_fn())
        avatar_file_id = None
        avatar_file_size_bytes = 0
        storage_result = "none"
        prepared_avatar = None
        if picture_url:
            prepared_avatar = profiles.prepare_avatar(appwrite_user_id, picture_url)
            if prepared_avatar:
                picture_url = prepared_avatar["view_url"]
                avatar_file_id = prepared_avatar["file_id"]
                avatar_file_size_bytes = prepared_avatar["size_bytes"]
                storage_result = "stored"
        row_data = {
            "google_id": appwrite_user_id,
            "email": email,
            "name": name or remote_user.get("name"),
            "picture_url": picture_url,
            "avatar_file_id": avatar_file_id,
            "avatar_file_size_bytes": avatar_file_size_bytes,
            "avatar_storage_backend": prepared_avatar["backend"] if prepared_avatar else "appwrite",
            "tier": "free",
            "banner_color": "#fecae1",
            "avatar_source": "provider" if picture_url else None,
            "school": None,
            "major": None,
            "graduation_year": None,
            "onboarding_complete": False,
            "onboarding_step": 1,
            "created_at": created_at,
            "last_login": created_at,
        }
        if provider and provider != "appwrite":
            row_data["provider"] = provider
        if discord_id_value:
            row_data["discord_id"] = discord_id_value
            row_data["discord_username"] = discord_username_value
            row_data["discord_linked_at"] = created_at
        initial_settings = {
            "user_id": appwrite_user_id,
            "ics_secret_token": secrets.token_urlsafe(32),
            "feed_refresh_minutes": 15,
            "preferred_calendar_view": "week",
            "interface_theme": "obsidian-dark",
            "theme": "dark",
            "sidebar_default": "expanded",
            "email_notifications": True,
            "product_updates": True,
            "task_sound_enabled": True,
            "chat_sound_enabled": True,
            "language": "en",
            "timezone": "",
            "created_at": created_at,
        }
        user_doc = profiles.persist(
            appwrite_user_id, row_data, prepared=prepared_avatar, create=True,
            provider_source_url=resolved_provider_avatar_url, initial_settings=initial_settings,
        )
        created_user = True
        try:
            invites.attribute_signup(
                request.cookies.get(completion.invite_cookie),
                appwrite_user_id,
            )
        except Exception:
            logger.exception("Failed to attribute new user signup to invite")
    else:
        updates = {"last_login": format_datetime(now_fn())}
        prepared_avatar = None
        if name:
            updates["name"] = name
        if picture_url and profiles.can_refresh_avatar(user_doc):
            prepared_avatar = profiles.prepare_avatar(appwrite_user_id, picture_url)
            stored_picture_url = prepared_avatar["view_url"] if prepared_avatar else picture_url
            stored_file_id = prepared_avatar["file_id"] if prepared_avatar else None
            stored_file_size_bytes = prepared_avatar["size_bytes"] if prepared_avatar else 0
            storage_result = "stored" if prepared_avatar else "provider_url_fallback"
            # A failed provider refresh must not replace a working Nest avatar.
            # Retire the old file only after the profile transaction commits.
            if stored_picture_url and (storage_result == "stored" or not user_doc.get("picture_url")):
                updates["picture_url"] = stored_picture_url
                updates["avatar_source"] = "provider"
                updates["avatar_file_size_bytes"] = stored_file_size_bytes
                updates["avatar_file_id"] = stored_file_id
                updates["avatar_storage_backend"] = prepared_avatar["backend"] if prepared_avatar else "appwrite"
                if prepared_avatar:
                    updates.update(avatar_profile_fields(prepared_avatar))
        if email:
            updates["email"] = email
        if provider and provider != "appwrite":
            updates["provider"] = provider
        if discord_id_value:
            updates["discord_id"] = discord_id_value
            updates["discord_username"] = discord_username_value
            if not user_doc.get("discord_id"):
                updates["discord_linked_at"] = format_datetime(now_fn())

        row_id = user_doc.get("$id") or user_doc.get("id")
        if not row_id:
            raise ValueError("User lookup failed.")
        user_doc = profiles.persist(row_id, updates, prepared=prepared_avatar, provider_source_url=picture_url)

    completion.sync_presence(
        user_doc.get("$id") or user_doc.get("id"),
        user_doc,
    )
    completion.establish(user_doc, email=email or remote_email, provider=provider,
                         remote_id=appwrite_user_id, name=name, picture_url=picture_url)
    if email or remote_email:
        try:
            notes_collaboration.claim_pending_invitations(
                session["user_id"],
                email or remote_email,
            )
        except Exception:
            logger.exception(
                "Failed to claim pending note invitations for %s",
                session["user_id"],
            )

    if discord_id_value:
        try:
            discord_bridge.add_guild_member_role(discord_id_value)
        except Exception:
            logger.exception(
                "Failed to grant Discord role on login for %s",
                discord_id_value,
            )

    completion.audit(user_doc, provider, page_context, created_user=created_user, email=email or remote_email)

    return {
        "created_user": created_user,
        "email": email or remote_email,
        "redirect": completion.redirect(user_doc),
        "user_doc": user_doc,
        "user_id": session["user_id"],
    }
