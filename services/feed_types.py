"""Structured values exchanged by calendar feed parsing and cache diffing."""

from datetime import datetime
from typing import Literal, TypedDict


class FeedEvent(TypedDict, total=False):
    """Incoming event fields; feeds and legacy callers may omit optional values."""

    uid: str | None
    title: str
    start: datetime | None
    end: datetime | None
    event_type: str
    course_name: str
    description: str
    fetched_at: datetime
    is_all_day: bool


class FeedCachePayload(TypedDict):
    user_id: str
    feed_url: str
    feed_url_hash: str
    event_uid: str
    event_title: str | None
    event_start: str | None
    event_end: str | None
    event_type: str | None
    course_name: str | None
    raw_description: str | None
    fetched_at: str | None
    is_all_day: bool


class FeedProbeResult(TypedDict):
    feed_url: str
    calendar_name: str | None


class FeedFetchResult(FeedProbeResult):
    status_code: Literal[200, 304]
    events: list[FeedEvent]
    etag: str | None
    last_modified: str | None
