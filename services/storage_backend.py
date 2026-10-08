"""Resolve upload rollout settings from the application's immutable snapshot."""

import logging

from flask import current_app, has_app_context

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services.storage_errors import StorageMutationPaused, StorageUnavailable


_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off", ""}
_LOG = logging.getLogger(__name__)


def storage_setting(name, default=None):
    """Never reread process environment inside an application context."""
    if has_app_context():
        if name in current_app.config:
            return current_app.config[name]
        environment = current_app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
    else:
        environment = load_environment_config()
    settings = getattr(environment, "upload_storage_settings", {}) or {}
    return settings.get(name, default)


def _boolean(value, *, default, name):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (str, int)):
        normalized = str(value).strip().lower()
        if normalized in _TRUE:
            return True
        if normalized in _FALSE:
            return False
    raise StorageUnavailable(f"Invalid {name} configuration.")


def write_backend():
    backend = str(storage_setting("NEST_STORAGE_BACKEND", "appwrite") or "appwrite").strip().lower()
    if backend not in {"appwrite", "sqlite"}:
        raise StorageUnavailable("Upload storage backend is not configured correctly.")
    return backend


def legacy_reads_enabled():
    return _boolean(storage_setting("NEST_STORAGE_READ_LEGACY"), default=True, name="legacy storage read")


def require_legacy_reads():
    if not legacy_reads_enabled():
        _LOG.warning("Legacy upload storage read rejected: compatibility reads disabled")
        raise StorageUnavailable("Legacy upload storage reads are disabled.")
    _LOG.info("Legacy upload storage read requested")


def require_mutations_enabled():
    if _boolean(storage_setting("NEST_STORAGE_MUTATIONS_PAUSED"), default=False, name="storage mutation pause"):
        raise StorageMutationPaused("Upload storage changes are temporarily paused.")


def chat_attachments_enabled():
    value = storage_setting("NEST_CHAT_ATTACHMENTS_ENABLED")
    if value is None:
        if has_app_context():
            environment = current_app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
        else:
            environment = load_environment_config()
        value = getattr(environment, "chat_attachments_enabled", True)
    return _boolean(value, default=True, name="chat attachment capability")
