"""Shared calendar feed URL normalization and validation."""

import json
import re
from urllib.parse import urlparse, urlunparse

MAX_OTHER_CALENDAR_URLS = 10
_INVALID_FEED_URL_PART = re.compile(r"[\s;<>]|\.\.")


def _feed_url_parts_are_safe(path, query):
    for part in (path, query):
        if part and _INVALID_FEED_URL_PART.search(part):
            return False
    return True


def normalize_calendar_url(url):
    """Return a normalized calendar feed URL, or None if invalid."""
    if not isinstance(url, str):
        return None

    raw = url.strip()
    if not raw:
        return None

    parsed = urlparse(raw)
    scheme = parsed.scheme.lower()
    if scheme == "webcal":
        scheme = "https"

    if scheme not in {"http", "https"}:
        return None

    if not parsed.netloc:
        return None

    normalized_path = (parsed.path or "").rstrip("/")
    if not _feed_url_parts_are_safe(normalized_path, parsed.query):
        return None

    return urlunparse((
        scheme,
        parsed.netloc.lower(),
        normalized_path,
        "",
        parsed.query,
        "",
    ))


def iter_valid_other_calendar_urls(settings, *, max_urls=MAX_OTHER_CALENDAR_URLS):
    """Yield (raw, normalized) pairs for each valid optional calendar URL."""
    if not settings or not settings.get("other_ical_urls_json"):
        return

    try:
        parsed = json.loads(settings.get("other_ical_urls_json"))
    except json.JSONDecodeError:
        return

    if not isinstance(parsed, list):
        return

    count = 0
    for item in parsed:
        if count >= max_urls:
            break
        if not isinstance(item, str):
            continue
        raw = item.strip()
        if not raw:
            continue
        normalized = normalize_calendar_url(raw)
        if not normalized:
            continue
        count += 1
        yield raw, normalized


def load_other_calendar_urls(settings, *, max_urls=MAX_OTHER_CALENDAR_URLS):
    """Load and sanitize persisted optional calendar URLs from JSON text."""
    return [normalized for _, normalized in iter_valid_other_calendar_urls(settings, max_urls=max_urls)]
