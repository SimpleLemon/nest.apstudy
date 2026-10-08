"""Feed URL identity, configuration validation, cache refresh, and source metadata."""

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import parse_datetime
from collections import Counter
from services.calendar_store import delete_calendar_row, first_calendar_row, list_calendar_rows_all
from services.calendar_urls import (
    MAX_OTHER_CALENDAR_URLS,
    iter_valid_other_calendar_urls,
    load_other_calendar_urls,
    normalize_calendar_url as _normalize_calendar_url,
)
from services.feed_fetcher import derive_feed_status
from urllib.parse import urlparse, urlunparse
import json
from services.calendar_constants import (
    CANVAS_CALENDAR_HOST_PREFIX,
    CANVAS_CALENDAR_HOST_SUFFIX,
    CANVAS_CALENDAR_PATH_PREFIXES,
    CANVAS_SOURCE_ID,
    FEED_SOURCE_PREFIX,
)
from services.calendar_identity import (
    _feed_source_id,
    _feed_url_hash,
    _legacy_feed_source_id,
    _normalize_source_label,
    _raw_feed_url_hash,
    _url_fallback_label,
)

import logging

logger = logging.getLogger(__name__)


def _normalize_canvas_calendar_url(url):
    """Return a normalized Canvas calendar URL, or None if invalid."""
    if not isinstance(url, str):
        return None

    raw = url.strip()
    if not raw:
        return None

    if "://" not in raw:
        raw = f"https://{raw}"

    parsed = urlparse(raw)
    if parsed.scheme.lower() != "https":
        return None

    host = parsed.netloc.lower()
    if not (host.startswith(CANVAS_CALENDAR_HOST_PREFIX) and host.endswith(CANVAS_CALENDAR_HOST_SUFFIX)):
        return None

    path = parsed.path or ""
    if not path.startswith(CANVAS_CALENDAR_PATH_PREFIXES):
        return None

    normalized_path = path.rstrip("/")
    return urlunparse((
        "https",
        host,
        normalized_path,
        "",
        parsed.query,
        "",
    ))


def _validate_other_calendar_urls(other_urls, canvas_url):
    """Validate optional external calendar links and prevent duplicates."""
    if other_urls is None:
        return []
    if not isinstance(other_urls, list):
        raise ValueError("other_ical_urls must be a list.")

    cleaned = []
    seen = set()
    normalized_canvas = _normalize_calendar_url(canvas_url)

    for raw in other_urls:
        if not isinstance(raw, str):
            raise ValueError("Each calendar URL must be a string.")

        value = raw.strip()
        if not value:
            continue

        normalized = _normalize_calendar_url(value)
        if not normalized:
            raise ValueError(
                "Each optional calendar link must be a valid http(s) or webcal URL."
            )

        if normalized_canvas and normalized == normalized_canvas:
            raise ValueError("Optional calendar links cannot duplicate the Nest Canvas calendar.")

        if normalized in seen:
            raise ValueError("Duplicate optional calendar links are not allowed.")

        seen.add(normalized)
        cleaned.append(normalized)

    if len(cleaned) > MAX_OTHER_CALENDAR_URLS:
        raise ValueError(f"You can add up to {MAX_OTHER_CALENDAR_URLS} optional calendar links.")

    return cleaned


def _resolve_last_fetched(user_id):
    last_fetched = None
    feed_table = COLLECTIONS.get("calendar_feeds")
    latest_feed = None
    if feed_table:
        try:
            latest_feed = first_calendar_row(
                feed_table,
                [
                    Query.equal("user_id", [user_id]),
                    Query.order_desc("last_fetched"),
                ],
            )
        except AppwriteException:
            latest_feed = None

    if latest_feed and latest_feed.get("last_fetched"):
        parsed = parse_datetime(latest_feed.get("last_fetched"))
        if parsed:
            return parsed.isoformat()

    try:
        latest_event = first_calendar_row(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [user_id]),
                Query.order_desc("fetched_at"),
            ],
        )
    except AppwriteException:
        latest_event = None

    if latest_event and latest_event.get("fetched_at"):
        parsed = parse_datetime(latest_event.get("fetched_at"))
        if parsed:
            last_fetched = parsed.isoformat()
    return last_fetched


def _configured_feed_urls(settings):
    """Return all configured calendar feed URLs for a user."""
    if not settings:
        return []
    urls = []
    canvas_url = settings.get("canvas_ical_url")
    if canvas_url:
        urls.append(canvas_url.strip())
    urls.extend(load_other_calendar_urls(settings))
    return urls


def _load_calendar_feed_metadata(user_id, list_rows_fn=None):
    list_rows_fn = list_rows_fn or list_calendar_rows_all
    feed_table = COLLECTIONS.get("calendar_feeds")
    if not feed_table:
        return {}
    rows = list_rows_fn(
        feed_table,
        [Query.equal("user_id", [str(user_id)])],
    )
    return {row.get("feed_url_hash"): row for row in rows if row.get("feed_url_hash")}


def _configured_feed_sources(settings, cache_events=None, preferences=None, feed_metadata=None):
    """Return editable feed source metadata for configured URLs."""
    if not settings:
        return []

    cache_events = cache_events or []
    preferences = preferences or []
    feed_metadata = feed_metadata or {}
    prefs_by_name = {
        pref.get("calendar_name"): pref
        for pref in preferences
        if pref.get("calendar_name")
    }
    labels_by_hash = {}
    for row in cache_events:
        feed_hash = row.get("feed_url_hash")
        label = row.get("course_name")
        if feed_hash and label:
            labels_by_hash.setdefault(feed_hash, Counter())[label] += 1

    sources = []
    canvas_url = (settings.get("canvas_ical_url") or "").strip()
    if canvas_url:
        canvas_hash = _feed_url_hash(canvas_url)
        canvas_meta = feed_metadata.get(canvas_hash) or {}
        sources.append({
            "id": CANVAS_SOURCE_ID,
            "kind": "canvas",
            "default_name": "Canvas",
            "url": canvas_url,
            "editable": True,
            "legacy_names": ["Canvas"],
            "status": derive_feed_status(canvas_meta),
            "last_error_message": canvas_meta.get("last_error_message") or "",
        })

    for raw_url, url in iter_valid_other_calendar_urls(settings):
        feed_hash = _feed_url_hash(url)
        raw_feed_hash = _raw_feed_url_hash(url)
        label_counts = labels_by_hash.get(feed_hash)
        if not label_counts and raw_feed_hash != feed_hash:
            label_counts = labels_by_hash.get(raw_feed_hash)
        metadata = feed_metadata.get(feed_hash) or feed_metadata.get(raw_feed_hash) or {}
        metadata_name = _normalize_source_label(metadata.get("calendar_name"))
        default_name = metadata_name
        if label_counts:
            default_name = default_name or label_counts.most_common(1)[0][0]
        default_name = _normalize_source_label(default_name) or _url_fallback_label(url)
        legacy_source_id = _legacy_feed_source_id(raw_url)
        legacy_names = [default_name]
        if legacy_source_id != _feed_source_id(url):
            legacy_names.append(legacy_source_id)
        sources.append({
            "id": _feed_source_id(url),
            "kind": "external",
            "default_name": default_name,
            "url": url,
            "editable": True,
            "legacy_names": legacy_names,
            "status": derive_feed_status(metadata),
            "last_error_message": metadata.get("last_error_message") or "",
        })

    for source in sources:
        source_pref = prefs_by_name.get(source["id"])
        legacy_pref = next(
            (prefs_by_name.get(name) for name in source.get("legacy_names", []) if prefs_by_name.get(name)),
            None,
        )
        display_name = (
            (source_pref or {}).get("display_name")
            or (legacy_pref or {}).get("display_name")
            or ""
        )
        source["display_name"] = display_name
        source["color_hex"] = (source_pref or {}).get("color_hex") or (legacy_pref or {}).get("color_hex") or None

    return sources


def _filter_configured_cache_events(cache_events, feed_urls):
    configured_hashes = set()
    for url in feed_urls:
        if not url:
            continue
        configured_hashes.add(_feed_url_hash(url))
        configured_hashes.add(_raw_feed_url_hash(url))
    return [
        event
        for event in cache_events
        if event.get("feed_url_hash") in configured_hashes
    ]


def _feed_needs_initial_fetch(feed_url, cache_events, feed_metadata):
    canonical_hash = _feed_url_hash(feed_url)
    raw_hash = _raw_feed_url_hash(feed_url)
    hashes = {canonical_hash, raw_hash}
    has_cache = any(event.get("feed_url_hash") in hashes for event in cache_events)
    metadata = feed_metadata.get(canonical_hash) or feed_metadata.get(raw_hash) or {}
    has_named_metadata = bool(_normalize_source_label(metadata.get("calendar_name")))
    return not has_named_metadata and not has_cache


def _initial_fetch_feed_urls(feed_urls, cache_events, feed_metadata):
    return [
        url
        for url in feed_urls
        if url and _feed_needs_initial_fetch(url, cache_events, feed_metadata)
    ]


def _refresh_initial_feed_cache(user_id, feed_urls, cache_events, feed_metadata):
    missing_urls = _initial_fetch_feed_urls(feed_urls, cache_events, feed_metadata)
    if not missing_urls:
        return False, None

    try:
        from services.feed_fetcher import fetch_and_cache_feeds

        fetch_and_cache_feeds(user_id, missing_urls)
        return True, None
    except Exception as exc:
        logger.exception(
            "Initial calendar feed fetch failed",
            extra={"user_id": user_id, "feed_count": len(missing_urls)},
        )
        return False, str(exc)


def _delete_cache_rows_for_feed(user_id, feed_url):
    feed_hashes = {_feed_url_hash(feed_url), _raw_feed_url_hash(feed_url)}
    seen_row_ids = set()
    for feed_hash in feed_hashes:
        rows = list_calendar_rows_all(
            COLLECTIONS["calendar_cache"],
            [
                Query.equal("user_id", [str(user_id)]),
                Query.equal("feed_url_hash", [feed_hash]),
            ],
        )
        for row in rows:
            row_id = row.get("$id") or row.get("id")
            if row_id and row_id not in seen_row_ids:
                seen_row_ids.add(row_id)
                delete_calendar_row(COLLECTIONS["calendar_cache"], row_id)

    feed_table = COLLECTIONS.get("calendar_feeds")
    if feed_table:
        seen_feed_row_ids = set()
        for feed_hash in feed_hashes:
            feed_rows = list_calendar_rows_all(
                feed_table,
                [
                    Query.equal("user_id", [str(user_id)]),
                    Query.equal("feed_url_hash", [feed_hash]),
                ],
            )
            for row in feed_rows:
                row_id = row.get("$id") or row.get("id")
                if row_id and row_id not in seen_feed_row_ids:
                    seen_feed_row_ids.add(row_id)
                    delete_calendar_row(feed_table, row_id)


def _settings_payload_for_source_update(settings, source_id, next_url):
    if not settings:
        raise ValueError("No calendar settings found.")

    current_canvas_url = (settings.get("canvas_ical_url") or "").strip()
    other_urls = load_other_calendar_urls(settings)

    if source_id == CANVAS_SOURCE_ID:
        normalized_canvas = _normalize_canvas_calendar_url(next_url)
        if not normalized_canvas:
            raise ValueError("Canvas calendar must use https://canvas.<school>.edu/feeds/calendar...")
        validated_other_urls = _validate_other_calendar_urls(other_urls, normalized_canvas)
        return {
            "old_url": current_canvas_url,
            "new_url": normalized_canvas,
            "new_source_id": CANVAS_SOURCE_ID,
            "settings_updates": {
                "canvas_ical_url": normalized_canvas,
                "other_ical_urls_json": json.dumps(validated_other_urls),
            },
        }

    if not source_id.startswith(FEED_SOURCE_PREFIX):
        raise ValueError("Only feed calendars can be edited.")

    match_index = None
    for index, url in enumerate(other_urls):
        if _feed_source_id(url) == source_id or _legacy_feed_source_id(url) == source_id:
            match_index = index
            break
    if match_index is None:
        raise ValueError("Calendar source was not found.")
    if not (next_url or "").strip():
        raise ValueError("Calendar URL is required.")

    candidate_urls = list(other_urls)
    candidate_urls[match_index] = (next_url or "").strip()
    validated_other_urls = _validate_other_calendar_urls(candidate_urls, current_canvas_url)
    new_url = validated_other_urls[match_index]
    return {
        "old_url": other_urls[match_index],
        "new_url": new_url,
        "new_source_id": _feed_source_id(new_url),
        "settings_updates": {
            "other_ical_urls_json": json.dumps(validated_other_urls),
        },
    }
