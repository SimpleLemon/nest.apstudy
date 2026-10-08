"""Local calendar inventory, preferences, event overrides, and source updates."""

from appwrite.exception import AppwriteException
from appwrite.id import ID
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import create_row_safe, first_row, format_datetime, update_row_safe
from datetime import datetime
from services.calendar_store import (
    create_calendar_row,
    first_calendar_row,
    list_calendar_rows_all,
    update_calendar_row,
)
from services.calendar_urls import normalize_calendar_url as _normalize_calendar_url
from services.settings_defaults import settings_defaults as _settings_defaults
from services.task_calendar import (
    task_calendar_events_for_user,
    task_calendar_source,
    user_has_tasks,
)
from services.calendar_constants import (
    DEFAULT_CALENDAR_COLOR,
    DEFAULT_LOCAL_SOURCE_ID,
    DEFAULT_LOCAL_SOURCE_NAME,
    LOCAL_SOURCE_PREFIX,
)
from services.calendar_feed_sources import (
    _configured_feed_sources,
    _configured_feed_urls,
    _delete_cache_rows_for_feed,
    _filter_configured_cache_events,
    _load_calendar_feed_metadata,
    _settings_payload_for_source_update,
)
from services.calendar_identity import (
    _canvas_truthy,
    _normalize_calendar_id,
    _normalize_source_label,
)
from services.canvas_domain import (
    _canvas_user_id,
)

import logging

logger = logging.getLogger(__name__)


def _load_local_calendar_sources(user_id, list_rows_fn=None):
    list_rows_fn = list_rows_fn or list_calendar_rows_all
    table_id = COLLECTIONS.get("user_calendar_sources")
    if not table_id:
        return []
    return list_rows_fn(
        table_id,
        [Query.equal("user_id", [str(user_id)])],
    )


def _configured_local_sources(local_sources=None, preferences=None, created_events=None):
    local_sources = local_sources or []
    preferences = preferences or []
    created_events = created_events or []
    prefs_by_name = {
        pref.get("calendar_name"): pref
        for pref in preferences
        if pref.get("calendar_name")
    }
    rows_by_source = {
        row.get("source_id"): row
        for row in local_sources
        if row.get("source_id")
    }
    if any(not event.get("calendar_id") for event in created_events):
        rows_by_source.setdefault(
            DEFAULT_LOCAL_SOURCE_ID,
            {
                "source_id": DEFAULT_LOCAL_SOURCE_ID,
                "default_name": DEFAULT_LOCAL_SOURCE_NAME,
                "kind": "local",
            },
        )

    sources = []
    for source_id, row in rows_by_source.items():
        default_name = _normalize_source_label(row.get("default_name")) or DEFAULT_LOCAL_SOURCE_NAME
        pref = prefs_by_name.get(source_id) or {}
        sources.append({
            "id": source_id,
            "kind": row.get("kind") or "local",
            "default_name": default_name,
            "display_name": pref.get("display_name") or "",
            "color_hex": pref.get("color_hex") or row.get("color_hex") or DEFAULT_CALENDAR_COLOR,
            "url": "",
            "editable": True,
            "source_id": source_id,
            "legacy_names": [],
        })
    return sorted(sources, key=lambda item: (item.get("display_name") or item.get("default_name") or "").lower())


def _configured_calendar_sources(settings, cache_events=None, preferences=None, feed_metadata=None, local_sources=None, created_events=None):
    return _configured_feed_sources(settings, cache_events, preferences, feed_metadata) + _configured_local_sources(
        local_sources,
        preferences,
        created_events,
    )


def extension_calendar_destinations(user_id):
    """Return the authenticated extension's safe, visible routing destinations.

    The source/preference inputs intentionally come from the same loader family
    used by the dashboard, calendar share, and ICS projections. Provider URLs,
    event rows, and account identifiers stay inside this service and are never
    copied into the extension response.
    """
    user_id = _canvas_user_id(user_id)
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [user_id])],
    ) or _settings_defaults(user_id)
    preferences = _load_calendar_preferences(user_id)
    cache_events = list_calendar_rows_all(
        COLLECTIONS["calendar_cache"],
        [Query.equal("user_id", [user_id])],
    )
    feed_urls = _configured_feed_urls(settings)
    cache_events = _filter_configured_cache_events(cache_events, feed_urls)
    feed_metadata = _load_calendar_feed_metadata(user_id)
    local_sources = _load_local_calendar_sources(user_id)
    created_events = list_calendar_rows_all(
        COLLECTIONS["user_events"],
        [Query.equal("user_id", [user_id])],
    )
    sources = _configured_calendar_sources(
        settings,
        cache_events,
        preferences,
        feed_metadata,
        local_sources,
        created_events,
    )
    try:
        _, task_source = _task_calendar_payload(user_id, preferences)
    except (AppwriteException, AttributeError):
        task_source = None
    sources = _append_task_calendar_source(sources, task_source)

    preferences_by_name = {
        preference.get("calendar_name"): preference
        for preference in preferences
        if preference.get("calendar_name")
    }
    destinations = []
    for source in sources:
        calendar_id = source.get("id")
        if not isinstance(calendar_id, str) or not calendar_id.strip():
            continue
        source_status = str(source.get("status") or "active").strip().lower()
        if source_status in {"archived", "deleted", "hidden"}:
            continue
        preference = preferences_by_name.get(calendar_id)
        if preference is None:
            preference = next(
                (
                    preferences_by_name.get(legacy_name)
                    for legacy_name in source.get("legacy_names", [])
                    if preferences_by_name.get(legacy_name) is not None
                ),
                None,
            )
        if preference is not None:
            preference_visible = preference.get("visible", True)
            if preference_visible is not None and not _canvas_truthy(preference_visible):
                continue

        kind = str(source.get("kind") or "local").strip().lower() or "local"
        imported = bool(source.get("imported")) or kind in {"canvas", "external", "imported"}
        label = _normalize_source_label(
            (preference or {}).get("display_name")
            or source.get("display_name")
            or source.get("default_name")
            or calendar_id
        ) or calendar_id
        destinations.append({
            "id": calendar_id,
            "label": label,
            "visible": True,
            "read_only": bool(source.get("read_only")) or imported,
            "imported": imported,
            "kind": kind,
            "routing_eligible": True,
            "routing_degraded": False,
        })

    return sorted(destinations, key=lambda item: (item["label"].lower(), item["id"]))


def _task_calendar_payload(user_id, preferences, range_start=None, range_end=None):
    try:
        task_events = task_calendar_events_for_user(user_id, range_start, range_end)
        source = task_calendar_source(preferences) if task_events or user_has_tasks(user_id) else None
        return task_events, source
    except AppwriteException as exc:
        status_code = getattr(exc, "code", None) or getattr(exc, "response_code", None)
        if int(status_code or 0) == 404:
            logger.warning("Task calendar tables are not available yet; omitting task events.")
            return [], None
        raise
    except AttributeError as exc:
        if "list_rows" in str(exc):
            logger.warning("Task calendar storage is not configured; omitting task events.")
            return [], None
        raise


def _append_task_calendar_source(sources, source):
    if not source:
        return sources
    if any(item.get("id") == source.get("id") for item in sources):
        return sources
    return sources + [source]


def _ensure_user_settings(user_id):
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [str(user_id)])],
    )
    if settings:
        return settings
    return create_row_safe(
        COLLECTIONS["user_settings"],
        row_id=str(user_id),
        data=_settings_defaults(str(user_id)),
    )


def _ensure_local_calendar_source(user_id, source_id=DEFAULT_LOCAL_SOURCE_ID, display_name=DEFAULT_LOCAL_SOURCE_NAME):
    source_id = _normalize_calendar_id(source_id)
    if not source_id.startswith(LOCAL_SOURCE_PREFIX):
        return None
    table_id = COLLECTIONS.get("user_calendar_sources")
    if not table_id:
        return None
    existing = first_calendar_row(
        table_id,
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("source_id", [source_id]),
        ],
    )
    if existing:
        return existing
    now = format_datetime(datetime.utcnow())
    return create_calendar_row(
        table_id,
        row_id=ID.unique(),
        data={
            "user_id": str(user_id),
            "source_id": source_id,
            "kind": "local",
            "default_name": _normalize_source_label(display_name) or DEFAULT_LOCAL_SOURCE_NAME,
            "created_at": now,
            "updated_at": now,
        },
    )


def _load_event_overrides(user_id, list_rows_fn=None):
    list_rows_fn = list_rows_fn or list_calendar_rows_all
    table_id = COLLECTIONS.get("user_event_overrides")
    if not table_id:
        return []
    return list_rows_fn(
        table_id,
        [Query.equal("user_id", [str(user_id)])],
    )


def _update_local_calendar_source_payload(user_id, source_id, display_name):
    source = _ensure_local_calendar_source(user_id, source_id, display_name or DEFAULT_LOCAL_SOURCE_NAME)
    if source and display_name:
        source = update_calendar_row(
            COLLECTIONS["user_calendar_sources"],
            source.get("$id"),
            {
                "default_name": display_name,
                "updated_at": format_datetime(datetime.utcnow()),
            },
        )
    _upsert_calendar_preference(user_id, source_id, {"display_name": display_name})
    preferences = _load_calendar_preferences(user_id)
    local_sources = _load_local_calendar_sources(user_id)
    sources = _configured_local_sources(local_sources, preferences)
    return {
        "status": "ok",
        "source": next((item for item in sources if item.get("id") == source_id), None),
        "refresh_required": False,
    }


def _update_url_calendar_source_payload(user_id, source_id, display_name, next_url):
    settings = first_row(
        COLLECTIONS["user_settings"],
        [Query.equal("user_id", [user_id])],
    )
    update_info = _settings_payload_for_source_update(settings, source_id, next_url)
    old_source_pref = first_calendar_row(
        COLLECTIONS["user_calendar_preferences"],
        [
            Query.equal("user_id", [user_id]),
            Query.equal("calendar_name", [source_id]),
        ],
    )

    old_url = update_info["old_url"]
    new_url = update_info["new_url"]
    new_source_id = update_info["new_source_id"]
    refresh_required = _normalize_calendar_url(old_url) != _normalize_calendar_url(new_url)
    settings_updates = {
        **update_info["settings_updates"],
        "updated_at": format_datetime(datetime.utcnow()),
    }

    settings = update_row_safe(
        COLLECTIONS["user_settings"],
        settings.get("$id"),
        settings_updates,
    )
    pref_updates = {"display_name": display_name}
    if old_source_pref:
        if old_source_pref.get("color_hex"):
            pref_updates["color_hex"] = old_source_pref.get("color_hex")
        if old_source_pref.get("visible") is not None:
            pref_updates["visible"] = bool(old_source_pref.get("visible"))
    _upsert_calendar_preference(user_id, new_source_id, pref_updates)
    if refresh_required and old_url:
        _delete_cache_rows_for_feed(user_id, old_url)

    cache_events = list_calendar_rows_all(
        COLLECTIONS["calendar_cache"],
        [
            Query.equal("user_id", [user_id]),
            Query.order_asc("event_start"),
        ],
    )
    preferences = _load_calendar_preferences(user_id)
    feed_metadata = _load_calendar_feed_metadata(user_id)
    feed_urls = _configured_feed_urls(settings)
    cache_events = _filter_configured_cache_events(cache_events, feed_urls)
    sources = _configured_feed_sources(settings, cache_events, preferences, feed_metadata)
    return {
        "status": "ok",
        "source": next((item for item in sources if item.get("id") == new_source_id), None),
        "refresh_required": refresh_required,
    }


def _load_calendar_preferences(user_id, list_rows_fn=None):
    list_rows_fn = list_rows_fn or list_calendar_rows_all
    return list_rows_fn(
        COLLECTIONS["user_calendar_preferences"],
        [Query.equal("user_id", [str(user_id)])],
    )


def _upsert_calendar_preference(user_id, calendar_name, updates):
    pref = first_calendar_row(
        COLLECTIONS["user_calendar_preferences"],
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("calendar_name", [calendar_name]),
        ],
    )
    now = format_datetime(datetime.utcnow())
    payload = {"updated_at": now, **updates}
    if not pref:
        pref = create_calendar_row(
            COLLECTIONS["user_calendar_preferences"],
            row_id=ID.unique(),
            data={
                "user_id": str(user_id),
                "calendar_name": calendar_name,
                "color_hex": updates.get("color_hex") or "#6366f1",
                "visible": bool(True if updates.get("visible") is None else updates.get("visible")),
                "created_at": now,
                **payload,
            },
        )
    else:
        pref = update_calendar_row(
            COLLECTIONS["user_calendar_preferences"],
            pref.get("$id"),
            payload,
        )
    return pref


def _upsert_event_override(user_id, event_ref, updates):
    table_id = COLLECTIONS["user_event_overrides"]
    existing = first_calendar_row(
        table_id,
        [
            Query.equal("user_id", [str(user_id)]),
            Query.equal("event_ref", [event_ref]),
        ],
    )
    now = format_datetime(datetime.utcnow())
    payload = {"updated_at": now, **updates}
    if not existing:
        return create_calendar_row(
            table_id,
            row_id=ID.unique(),
            data={
                "user_id": str(user_id),
                "event_ref": event_ref,
                "hidden": False,
                "created_at": now,
                **payload,
            },
        )
    return update_calendar_row(
        table_id,
        existing.get("$id"),
        payload,
    )
