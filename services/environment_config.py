"""Access the immutable environment snapshot for the current app."""

from dataclasses import dataclass, field
import ipaddress
import re

from flask import current_app, has_app_context

from config import (
    ENVIRONMENT_CONFIG_EXTENSION_KEY,
    EnvironmentConfig,
    load_environment_config,
)


def runtime_environment_config(app=None) -> EnvironmentConfig:
    """Use an app's snapshot, with a fresh fallback for standalone callers."""
    if app is not None:
        configured = app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
        if configured is not None:
            return configured
    if has_app_context():
        configured = current_app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
        if configured is not None:
            return configured
    return load_environment_config()


def notes_collaboration_callback_base_url(configured=None):
    """Reach the sidecar's configured listener, using loopback for wildcard binds."""
    if configured is None:
        configured = runtime_environment_config()
    host = configured.notes_collaboration_host
    try:
        port = int(configured.notes_collaboration_port_raw)
    except (TypeError, ValueError):
        return None
    if not 1 <= port <= 65535:
        return None
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", host):
            return None
    else:
        if address.is_unspecified:
            address = ipaddress.ip_address("::1" if address.version == 6 else "127.0.0.1")
        host = str(address)
        if address.version == 6:
            host = f"[{host.replace('%', '%25')}]"
    return f"http://{host}:{port}"


@dataclass(frozen=True, slots=True)
class ChatRuntimeSettings:
    poll_seconds: float
    keepalive_seconds: float
    stream_limit: int
    chat_fresh_seconds: int
    site_fresh_seconds: int
    typing_fresh_seconds: int
    lookup_limit: int
    online_limit: int


def chat_runtime_settings(configured=None):
    """Normalize chat settings from this app's snapshot at operation time."""
    if configured is None:
        configured = runtime_environment_config()
    return ChatRuntimeSettings(
        poll_seconds=float(configured.chat_events_poll_seconds_raw),
        keepalive_seconds=float(configured.chat_events_keepalive_seconds_raw),
        stream_limit=int(configured.chat_events_stream_limit_raw),
        chat_fresh_seconds=int(configured.presence_chat_fresh_seconds_raw),
        site_fresh_seconds=int(configured.presence_site_fresh_seconds_raw),
        typing_fresh_seconds=int(configured.presence_typing_fresh_seconds_raw),
        lookup_limit=int(configured.presence_lookup_limit_raw),
        online_limit=int(configured.presence_online_limit_raw),
    )


@dataclass(frozen=True, slots=True)
class APSwiftlySettings:
    control_url: str
    control_token: str = field(repr=False)
    service_name: str
    timeout_seconds: int


def apswiftly_settings(configured=None):
    """Normalize control settings without capturing import-time environment."""
    if configured is None:
        configured = runtime_environment_config()
    return APSwiftlySettings(
        control_url=(configured.apswiftly_control_url_raw or "http://127.0.0.1:3921").rstrip("/"),
        control_token=(configured.apswiftly_control_token_raw or "").strip(),
        service_name=(configured.apswiftly_service_name_raw or "apswiftly").strip() or "apswiftly",
        timeout_seconds=max(1, int(configured.apswiftly_control_timeout_seconds_raw or "15")),
    )


def validate_feature_environment(configured):
    """Fail at explicit factory creation, before feature imports or startup IO."""
    chat_runtime_settings(configured)
    apswiftly_settings(configured)
