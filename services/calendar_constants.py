"""Static calendar limits, defaults, and Canvas protocol vocabulary."""

import re

CANVAS_SOURCE_ID = "canvas"
FEED_SOURCE_PREFIX = "feed:"
LOCAL_SOURCE_PREFIX = "local:"
DEFAULT_LOCAL_SOURCE_ID = f"{LOCAL_SOURCE_PREFIX}default"
DEFAULT_LOCAL_SOURCE_NAME = "Personal"
DEFAULT_CALENDAR_COLOR = "#6366f1"
SIMULATED_CALENDAR_NAME = "Simulated Courses"
CANVAS_CALENDAR_HOST_PREFIX = "canvas."
CANVAS_CALENDAR_HOST_SUFFIX = ".edu"
CANVAS_CALENDAR_PATH_PREFIXES = ("/feeds/calendar", "/feeds/calendars")
CALENDAR_SHARE_CODE_LENGTH = 16
CALENDAR_SHARE_CODE_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
CALENDAR_SHARE_DATE_SCOPES = {"all", "fixed", "rolling"}
CALENDAR_SHARE_MIN_ROLLING_DAYS = 1
CALENDAR_SHARE_MAX_ROLLING_DAYS = 366
PREFERENCES_BATCH_LIMIT = 50
TIMED_EVENT_REMINDERS = {-1, 0, 5, 10, 15, 30, 60, 120, 1440, 2880}
ALL_DAY_EVENT_REMINDERS = {-1, -540, 900, 2340, 9540}
CANVAS_PROVIDER = "canvas"
CANVAS_READ_SCOPES = frozenset({"full_history_upload", "ongoing_read"})
CANVAS_PROJECTION_SCOPES = frozenset({
    "full_history_upload", "ongoing_read", "shares_ics_inclusion",
})
CANVAS_PERSONAL_EVENTS_WRITE_SCOPE = "personal_events_write"
CANVAS_PLANNER_ITEMS_WRITE_SCOPE = "planner_items_write"
CANVAS_SELECTED_MIRROR_SCOPE = "selected_item_mirroring"
CANVAS_WRITEBACK_SCOPES = frozenset({
    CANVAS_PERSONAL_EVENTS_WRITE_SCOPE,
    CANVAS_PLANNER_ITEMS_WRITE_SCOPE,
})
CANVAS_WRITEBACK_SCOPE = CANVAS_PERSONAL_EVENTS_WRITE_SCOPE
CANVAS_MIRROR_SCOPE = CANVAS_SELECTED_MIRROR_SCOPE
CANVAS_SHARES_SCOPE = "shares_ics_inclusion"
CANVAS_BATCH_ITEM_LIMIT = 100
CANVAS_BATCH_BYTES_LIMIT = 512 * 1024
CANVAS_LEASE_MINUTES = 10
CANVAS_SOURCE_STATUSES = frozenset({"active", "paused", "archived"})
CANVAS_ROUTE_STATES = ("incomplete", "completed")
CANVAS_COMPLETION_STATUSES = ("incomplete", "completed")
CANVAS_COMPLETION_SOURCES = frozenset({"canvas", "extension"})
CANVAS_ALLOWED_ITEM_TYPES = frozenset({
    "assignment", "quiz", "discussion_topic", "planner_note", "calendar_event",
})
CANVAS_REJECTED_ITEM_TYPES = frozenset({
    "announcement", "announcements", "unknown",
})
CANVAS_WRITEBACK_STATES = (
    "waiting_for_canvas_session", "queued", "applied", "unsupported", "forbidden",
    "conflict", "retryable_failed", "cancelled",
)
CANVAS_MIRROR_STATES = frozenset({
    "not_requested", "waiting_for_canvas_session", "queued", "applied", "unsupported",
    "forbidden", "conflict", "retryable_failed", "cancelled",
})
CANVAS_SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/~+-]{0,254}$")
CANVAS_RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CANVAS_IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,254}$")
CANVAS_SOURCE_REF_PATTERN = re.compile(r"^src1:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
CANVAS_CREDENTIAL_KEYS = frozenset({
    "access_token", "api_key", "authorization", "cookie", "cookies", "credential",
    "credentials", "password", "refresh_token", "secret", "session", "session_cookie",
    "token", "tokens",
})
CANVAS_SCOPE_ARRAY_KEYS = frozenset({
    "contexts", "context_ids", "calendars", "calendar_ids", "item_types",
})
CANVAS_SCOPE_DATE_KEYS = frozenset({"start", "end", "start_at", "end_at"})
CANVAS_SYNC_TERMINAL_STATES = frozenset({
    "complete", "partial", "expired", "error", "cancelled", "superseded",
})
CANVAS_WRITEBACK_CREATE_STATES = frozenset({
    "waiting_for_canvas_session", "queued",
})
