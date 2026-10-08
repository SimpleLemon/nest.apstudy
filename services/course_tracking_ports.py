"""Explicit integration ports for grouped course tracking polls."""
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from services.course_tracking_state import Row


class FetchTrackedSection(Protocol):
    def __call__(self, term: str | None, subject: str | None, catalog: str | None,
                 *, crn: str | None) -> dict[str, Any]: ...


class NotifyCourseOpening(Protocol):
    def __call__(self, user_id: str | None, category: str, title: str, body: str,
                 target_url: str, *, source_ref: str, dedupe_key: str,
                 tag: str) -> tuple[str | None, Mapping[str, int]]: ...


class EmitTrackingEvent(Protocol):
    def __call__(self, title: str, *, actor: str, target: str,
                 metadata: Mapping[str, Any], color: str) -> bool: ...


class CourseEmailMessaging(Protocol):
    def create_email(self, *, message_id: str, subject: str, content: str,
                     users: list[str | None], html: bool) -> object: ...

    def get_message(self, message_id: str) -> object: ...


@dataclass(frozen=True)
class PollingPorts:
    term_is_polling: Callable[[str | None], bool]
    fetch_section: FetchTrackedSection
    send_open_email: Callable[[Row, Row], None]
    preferences: Callable[[str | None], Mapping[str, bool]]
    notify: NotifyCourseOpening
    update_row: Callable[[str, str, dict[str, Any]], Row]
    emit_event: EmitTrackingEvent
