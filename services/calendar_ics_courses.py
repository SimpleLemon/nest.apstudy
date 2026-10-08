"""Project persisted Simulated Courses selections into calendar occurrences."""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from appwrite.query import Query

from appwrite_client import COLLECTIONS
from appwrite_helpers import list_rows_all
from services.atlas_catalog_store import CatalogStore
from services.calendar_ics_contract import (
    require_utc_range,
    CalendarIcsDiagnosticCode,
    CalendarIcsProjectionOutcome,
    CAMPUS_TIMEZONE,
    NormalizedCalendarEvent,
    SIMULATED_COURSES_CALENDAR_ID,
    subscription_window,
)


logger = logging.getLogger(__name__)

_COURSE_ZONE = ZoneInfo(CAMPUS_TIMEZONE)

COURSE_DATA_ROOT = Path(__file__).resolve().parent.parent
SIMULATED_COURSE_SOURCE_TYPE = "simulated_course"
SIMULATED_COURSE_EVENT_TYPE = "class-meeting"

SOURCE_UNRESOLVED = CalendarIcsDiagnosticCode.SOURCE_UNAVAILABLE
SOURCE_MALFORMED = CalendarIcsDiagnosticCode.SOURCE_INVALID
SOURCE_READ_FAILURE = CalendarIcsDiagnosticCode.RESOURCE_UNAVAILABLE
RESOURCE_UNAVAILABLE = CalendarIcsDiagnosticCode.RESOURCE_UNAVAILABLE

_DAY_NUMBERS = {
    "sun": 6,
    "sunday": 6,
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tues": 1,
    "tuesday": 1,
    "wed": 2,
    "wednesday": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
}


class _SourceProblem(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def _failure(code: str, message: str, *, resource: bool = False) -> CalendarIcsProjectionOutcome:
    if resource:
        return CalendarIcsProjectionOutcome.resource_failure(code, message)
    return CalendarIcsProjectionOutcome.source_failure(code, message)


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course contains malformed text.")
    value = value.strip()
    return value or None


def _course_row_id(row: dict[str, Any], fallback: str) -> str:
    value = row.get("$id") or row.get("id")
    if value is None or str(value).strip() == "":
        return fallback
    return str(value)


def _parse_source_date(value: Any) -> date:
    if not isinstance(value, str) or not value.strip():
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid date range.")
    try:
        return date.fromisoformat(value.strip())
    except ValueError as exc:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid date range.") from exc


def _parse_time(value: Any) -> time:
    if isinstance(value, bool) or value is None:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid meeting time.")
    digits = "".join(character for character in str(value).strip() if character.isdigit())
    if len(digits) == 3:
        digits = "0" + digits
    if len(digits) != 4:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid meeting time.")
    hour, minute = int(digits[:2]), int(digits[2:])
    if hour > 23 or minute > 59:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid meeting time.")
    return time(hour, minute)


def _parse_last_modified(row: dict[str, Any]) -> datetime | None:
    raw = row.get("updated_at") or row.get("added_at")
    if raw is None:
        return None
    if isinstance(raw, datetime):
        parsed = raw
    elif isinstance(raw, str):
        text = raw.strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _parse_overrides(row: dict[str, Any]) -> dict[str, Any]:
    raw = row.get("course_overrides_json")
    if raw in (None, "", {}):
        return {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise _SourceProblem(SOURCE_MALFORMED, "A saved course has malformed overrides.") from exc
    if not isinstance(raw, dict):
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has malformed overrides.")
    allowed = {
        "course_code", "course_title", "course_name", "section_number", "instructor",
        "instructor_name", "schedule_type", "location", "course_description",
        "course_notes", "meetings",
    }
    return {key: value for key, value in raw.items() if key in allowed}


def _safe_source_path(data_root: Path, row: dict[str, Any]) -> Path:
    values = []
    for key in ("term", "subject", "catalog"):
        value = _text(row.get(key))
        if not value or value in {".", ".."} or any(separator in value for separator in ("/", "\\")):
            raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid source reference.")
        values.append(value)
    return data_root / values[0] / values[1].upper() / f"{values[2]}.json"


def _read_course(path: Path) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except FileNotFoundError as exc:
        raise _SourceProblem(SOURCE_UNRESOLVED, "A saved course source could not be resolved.") from exc
    except (OSError, UnicodeError) as exc:
        raise _SourceProblem(SOURCE_READ_FAILURE, "A saved course source could not be read.") from exc
    except json.JSONDecodeError as exc:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course source is malformed.") from exc
    if not isinstance(value, dict):
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course source is malformed.")
    return value


def _selected_sections(row: dict[str, Any], course: dict[str, Any]) -> list[dict[str, Any]]:
    sections = course.get("sections")
    if not isinstance(sections, list):
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course source has malformed sections.")
    if not sections:
        raise _SourceProblem(SOURCE_UNRESOLVED, "A saved course section could not be resolved.")
    crn = str(row.get("crn") or "").strip()
    section_number = str(row.get("section_number") or "").strip()
    if crn:
        selected = [section for section in sections if isinstance(section, dict) and str(section.get("crn") or "").strip() == crn]
    elif section_number:
        selected = [section for section in sections if isinstance(section, dict) and str(section.get("section_number") or "").strip() == section_number]
    else:
        selected = [section for section in sections if isinstance(section, dict)]
    if not selected:
        raise _SourceProblem(SOURCE_UNRESOLVED, "A saved course section could not be resolved.")
    if crn and len(selected) != 1:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an ambiguous section.")
    return selected



def _resolve_saved_course(view, root, row):
    # Validate persisted references before allowing the store to resolve paths.
    _safe_source_path(root, row)
    paths = view.course_paths(row["term"].strip(), row["subject"].strip().upper(), row["catalog"].strip(), include_history=True)
    for path in paths:
        course = _read_course(path)
        try:
            return course, _selected_sections(row, course)
        except _SourceProblem as exc:
            if exc.code != SOURCE_UNRESOLVED:
                raise
    raise _SourceProblem(SOURCE_UNRESOLVED, "A saved course section could not be resolved.")

def _meetings(section: dict[str, Any], overrides: dict[str, Any]) -> list[tuple[int, time, time]]:
    raw_meetings = overrides.get("meetings")
    if raw_meetings is None:
        schedule = section.get("schedule")
        if isinstance(schedule, dict):
            raw_meetings = schedule.get("meetings")
        else:
            raw_meetings = section.get("meetings")
    if raw_meetings in (None, []):
        return []
    if not isinstance(raw_meetings, list):
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has malformed meetings.")
    result = []
    for meeting in raw_meetings:
        if not isinstance(meeting, dict):
            raise _SourceProblem(SOURCE_MALFORMED, "A saved course has malformed meetings.")
        day_name = str(meeting.get("day") or "").strip().lower()
        if day_name not in _DAY_NUMBERS:
            raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid meeting day.")
        start = _parse_time(meeting.get("start"))
        end = _parse_time(meeting.get("end"))
        if end <= start:
            raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid meeting range.")
        result.append((_DAY_NUMBERS[day_name], start, end))
    return result


def _date_range(course: dict[str, Any], section: dict[str, Any]) -> tuple[date, date]:
    raw = section.get("date_range", course.get("date_range"))
    if not isinstance(raw, dict):
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has no valid date range.")
    start = _parse_source_date(raw.get("start"))
    end = _parse_source_date(raw.get("end"))
    if end < start:
        raise _SourceProblem(SOURCE_MALFORMED, "A saved course has an invalid date range.")
    return start, end


def _event_for_occurrence(
    row: dict[str, Any],
    course: dict[str, Any],
    section: dict[str, Any],
    overrides: dict[str, Any],
    occurrence: date,
    start: datetime,
    end: datetime,
    start_time: time,
    end_time: time,
    meeting_key: str,
    last_modified: datetime | None,
) -> NormalizedCalendarEvent:
    subject = _text(row.get("subject")) or ""
    catalog = _text(row.get("catalog")) or ""
    course_code = _text(overrides.get("course_code")) or _text(course.get("course_code")) or f"{subject.upper()} {catalog}".strip()
    title = (
        _text(overrides.get("course_title"))
        or _text(overrides.get("course_name"))
        or _text(row.get("course_name"))
        or _text(section.get("course_title"))
        or _text(course.get("course_title"))
        or course_code
    )
    schedule_type = _text(overrides.get("schedule_type")) or _text(section.get("schedule_type"))
    section_number = _text(overrides.get("section_number")) or _text(row.get("section_number")) or _text(section.get("section_number"))
    instructor = _text(overrides.get("instructor")) or _text(overrides.get("instructor_name")) or _text(row.get("instructor_name")) or _text(section.get("instructor"))
    location = _text(overrides.get("location")) or _text(section.get("location"))
    description = _text(overrides.get("course_description")) or _text(section.get("course_description")) or _text(course.get("course_description"))
    notes = _text(overrides.get("course_notes")) or _text(section.get("course_notes")) or _text(course.get("course_notes"))
    summary = " ".join(value for value in (course_code, schedule_type) if value) or title
    if section_number:
        summary += f" (Sec {section_number})"
    row_id = _course_row_id(row, f"{row.get('term')}|{subject.upper()}|{catalog}|{row.get('crn') or section_number}")
    raw_identity = "|".join((
        "simulated-course", row_id, str(occurrence), meeting_key,
        start_time.strftime("%H:%M"), end_time.strftime("%H:%M"),
    ))
    return NormalizedCalendarEvent.from_internal(
        raw_identity=raw_identity,
        calendar_id=SIMULATED_COURSES_CALENDAR_ID,
        source_type=SIMULATED_COURSE_SOURCE_TYPE,
        title=summary,
        start=start,
        end=end,
        is_all_day=False,
        description=description,
        location=location,
        event_type=SIMULATED_COURSE_EVENT_TYPE,
        course_name=title,
        course_type=schedule_type,
        course_code=course_code,
        course_title=title,
        section=section_number,
        instructor=instructor,
        course_location=location,
        notes=notes,
        crn=_text(section.get("crn")) or _text(row.get("crn")),
        last_modified=last_modified,
    )


def project_simulated_courses(
    user_id: str,
    range_start: datetime,
    range_end: datetime,
    *,
    data_root: str | Path | None = None,
    list_rows_fn=None,
) -> CalendarIcsProjectionOutcome:
    """Project persisted course selections in a required half-open UTC range.

    Invalid caller bounds raise ValueError before any source reads. Source
    failures return an outcome and never produce a partial calendar.
    """
    require_utc_range(range_start, range_end)

    try:
        load_rows = list_rows_fn or list_rows_all
        rows = load_rows(
            COLLECTIONS["user_courses"],
            [Query.equal("user_id", [str(user_id)])],
        )
    except Exception:
        logger.exception("Failed to load persisted courses for calendar projection")
        return _failure(RESOURCE_UNAVAILABLE, "Saved courses are temporarily unavailable.", resource=True)
    if not isinstance(rows, list):
        return _failure(RESOURCE_UNAVAILABLE, "Saved courses are temporarily unavailable.", resource=True)
    if not rows:
        return CalendarIcsProjectionOutcome.valid_empty()

    root = Path(data_root) if data_root is not None else COURSE_DATA_ROOT
    catalog_view = CatalogStore(root).view()
    events: list[NormalizedCalendarEvent] = []
    for row in rows:
        if not isinstance(row, dict) or (row.get("user_id") is not None and str(row.get("user_id")) != str(user_id)):
            return _failure(SOURCE_MALFORMED, "A saved course record is malformed.")
        try:
            overrides = _parse_overrides(row)
            course, sections = _resolve_saved_course(catalog_view, root, row)
            last_modified = _parse_last_modified(row)
            for section in sections:
                if not isinstance(section, dict):
                    raise _SourceProblem(SOURCE_MALFORMED, "A saved course has malformed sections.")
                course_start, course_end = _date_range(course, section)
                meeting_values = _meetings(section, overrides)
                for day_number, start_time, end_time in meeting_values:
                    first_date = course_start + timedelta(days=(day_number - course_start.weekday()) % 7)
                    occurrence = first_date
                    while occurrence <= course_end:
                        # Localize each campus occurrence before converting to UTC
                        # so weekly meetings retain their wall-clock time across DST.
                        start_dt = datetime.combine(occurrence, start_time, tzinfo=_COURSE_ZONE).astimezone(timezone.utc)
                        end_dt = datetime.combine(occurrence, end_time, tzinfo=_COURSE_ZONE).astimezone(timezone.utc)
                        if start_dt < range_end and end_dt > range_start:
                            events.append(_event_for_occurrence(
                                row, course, section, overrides, occurrence,
                                start_dt, end_dt, start_time, end_time,
                                f"{day_number}:{start_time.strftime('%H:%M')}-{end_time.strftime('%H:%M')}",
                                last_modified,
                            ))
                        occurrence += timedelta(days=7)
        except _SourceProblem as exc:
            return _failure(exc.code, exc.message)
        except Exception:
            logger.exception("Unexpected failure projecting a saved course")
            return _failure(SOURCE_MALFORMED, "A saved course could not be projected.")

    events.sort(key=lambda event: (event.start, event.end, event.uid))
    return CalendarIcsProjectionOutcome.valid_empty() if not events else CalendarIcsProjectionOutcome.success(tuple(events))


project_simulated_courses_for_user = project_simulated_courses
