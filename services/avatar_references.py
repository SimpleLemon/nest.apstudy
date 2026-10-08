"""Avatar identities and retirement fences without image or database services."""

from urllib.parse import parse_qs, quote, unquote, urlsplit

from flask import current_app, has_app_context

from appwrite_client import ENDPOINT, PROFILE_AVATAR_BUCKET_ID, PROJECT_ID
from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services.storage_errors import StorageUnavailable, StorageValidationError


def environment_config_snapshot():
    if has_app_context():
        configured = current_app.extensions.get(ENVIRONMENT_CONFIG_EXTENSION_KEY)
        if configured is not None:
            return configured
    return load_environment_config()


def legacy_identity():
    configured = environment_config_snapshot()
    return (
        (ENDPOINT or configured.appwrite_endpoint or "").rstrip("/"),
        PROJECT_ID or configured.appwrite_project_id or "",
        PROFILE_AVATAR_BUCKET_ID,
    )


def legacy_avatar_id(url, *, identity=None):
    """Recognize only this configured endpoint, bucket and project identity."""
    endpoint, project_id, bucket_id = identity if identity is not None else legacy_identity()
    if not endpoint or not project_id:
        return None
    try:
        parsed, configured = urlsplit(str(url or "")), urlsplit(endpoint)
        if parsed.username or parsed.password or parsed.fragment:
            return None
        if (parsed.scheme.lower(), parsed.netloc.lower()) != (configured.scheme.lower(), configured.netloc.lower()):
            return None
        prefix = f"{configured.path.rstrip('/')}/storage/buckets/{quote(bucket_id, safe='')}/files/"
        if not parsed.path.startswith(prefix):
            return None
        parts = parsed.path[len(prefix):].split("/")
        if len(parts) != 2 or parts[1] not in {"view", "download", "preview"}:
            return None
        if parse_qs(parsed.query).get("project") != [project_id]:
            return None
        file_id = unquote(parts[0])
        return file_id if file_id and "/" not in file_id and "\\" not in file_id else None
    except (TypeError, ValueError):
        return None


def local_avatar_id(url, *, app_base_url=None):
    try:
        parsed = urlsplit(str(url or ""))
        if parsed.username or parsed.password or parsed.fragment:
            return None
        if parsed.netloc:
            configured = urlsplit(app_base_url if app_base_url is not None else environment_config_snapshot().app_base_url)
            if (parsed.scheme.lower(), parsed.netloc.lower()) != (configured.scheme.lower(), configured.netloc.lower()):
                return None
        elif parsed.scheme or not str(url or "").startswith("/api/avatars/"):
            return None
        prefix = "/api/avatars/"
        if not parsed.path.startswith(prefix):
            return None
        file_id = unquote(parsed.path[len(prefix):])
        return file_id if file_id and "/" not in file_id and "\\" not in file_id else None
    except (TypeError, ValueError):
        return None


def avatar_identities(fields):
    """Return the stored identities present in a profile or message snapshot."""
    identities = set()
    if fields.get("avatar_file_id"):
        identities.add(str(fields["avatar_file_id"]))
    for column in ("picture_url", "author_avatar_url", "author_picture_url"):
        value = fields.get(column)
        file_id = local_avatar_id(value) or legacy_avatar_id(value)
        if file_id:
            identities.add(file_id)
    return identities


def reject_retiring_avatar_references(conn, fields):
    """A pending remote delete prevents new references during network I/O.

    Profile and chat writers call this while holding the same SQLite writer
    used to enqueue retirement. Existing references are checked before delete.
    """
    if not conn.in_transaction:
        raise StorageValidationError("Avatar references require an active SQLite transaction.")
    for file_id in avatar_identities(fields):
        if conn.execute(
            "SELECT 1 FROM storage_legacy_deletions WHERE namespace = 'avatars' AND object_id = ? LIMIT 1",
            [file_id],
        ).fetchone():
            raise StorageUnavailable("This avatar is being retired. Please choose another image.")

