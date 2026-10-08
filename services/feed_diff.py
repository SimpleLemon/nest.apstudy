"""
services/feed_diff.py

Event upsert/diff helpers for calendar feed caching.
"""
from dataclasses import dataclass
import hashlib
from datetime import datetime
from typing import Any, Iterable, Mapping

from appwrite_helpers import format_datetime
from services.database import RowMapping
from services.feed_types import FeedCachePayload


FINGERPRINT_FIELDS = (
    "event_title",
    "event_start",
    "event_end",
    "event_type",
    "course_name",
    "raw_description",
    "is_all_day",
)


def _build_fallback_uid(event: Mapping[str, Any]) -> str:
    title = event.get("title") or event.get("event_title") or ""
    start = event.get("start") or event.get("event_start")
    end = event.get("end") or event.get("event_end")
    return f"fallback:{title}|{start}|{end}"


def resolve_event_uid(event: Mapping[str, Any]) -> str:
    uid = event.get("uid") or event.get("event_uid")
    if uid:
        return str(uid)
    return _build_fallback_uid(event)


def build_cache_payload(
    event: Mapping[str, Any], user_id: str, feed_url: str, fetched_at: datetime,
) -> FeedCachePayload:
    feed_hash = hashlib.sha256(feed_url.encode("utf-8")).hexdigest()
    return {
        "user_id": str(user_id),
        "feed_url": feed_url,
        "feed_url_hash": feed_hash,
        "event_uid": resolve_event_uid(event),
        "event_title": event.get("title") or event.get("event_title"),
        "event_start": format_datetime(event.get("start") or event.get("event_start")),
        "event_end": format_datetime(event.get("end") or event.get("event_end")),
        "event_type": event.get("event_type"),
        "course_name": event.get("course_name"),
        "raw_description": event.get("description") or event.get("raw_description"),
        "fetched_at": format_datetime(fetched_at),
        "is_all_day": bool(event.get("is_all_day", False)),
    }


def fingerprint_payload(payload: Mapping[str, Any]) -> tuple[Any, ...]:
    return tuple(payload.get(field) for field in FINGERPRINT_FIELDS)


@dataclass
class FeedDiff:
    to_create: list[FeedCachePayload]
    to_update: list[tuple[str | None, FeedCachePayload]]
    to_delete: list[RowMapping]
    unchanged: list[RowMapping]


def diff_events(
    existing_rows: Iterable[RowMapping], incoming_events: Iterable[Mapping[str, Any]],
    user_id: str, feed_url: str, fetched_at: datetime,
) -> FeedDiff:
    """
    Compute diff actions for a single feed using a composite key
    (feed_url + event_uid) to match stable events.
    """
    existing_by_uid = {
        row.get("event_uid"): row for row in existing_rows if row.get("event_uid")
    }
    incoming_by_uid = {}
    for event in incoming_events:
        incoming_by_uid[resolve_event_uid(event)] = event

    to_create: list[FeedCachePayload] = []
    to_update: list[tuple[str | None, FeedCachePayload]] = []
    to_delete: list[RowMapping] = []
    unchanged: list[RowMapping] = []

    for uid, event in incoming_by_uid.items():
        payload = build_cache_payload(event, user_id, feed_url, fetched_at)
        existing = existing_by_uid.get(uid)
        if not existing:
            to_create.append(payload)
            continue
        if fingerprint_payload(existing) != fingerprint_payload(payload):
            to_update.append((existing.get("$id"), payload))
        else:
            unchanged.append(existing)

    for uid, row in existing_by_uid.items():
        if uid not in incoming_by_uid:
            to_delete.append(row)

    return FeedDiff(
        to_create=to_create,
        to_update=to_update,
        to_delete=to_delete,
        unchanged=unchanged,
    )
