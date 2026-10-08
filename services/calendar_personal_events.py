"""Calendar operations with explicit identity and payload inputs; no HTTP handlers."""

import logging
from typing import Any, Callable, Mapping
from datetime import datetime, timezone
from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import format_datetime
from appwrite.id import ID
from services.calendar_identity import _normalize_calendar_id, _normalize_color, _normalize_reminder_minutes
from services.calendar_serialization import _serialize_user_event
from services.calendar_sources import _ensure_local_calendar_source, _upsert_event_override
from services.calendar_store import get_calendar_row, create_calendar_row, update_calendar_row, delete_calendar_row
from services.discord_audit import emit_creation_event, format_actor

logger = logging.getLogger(__name__)


def _parse_iso_like(s: object) -> datetime | None:
    """Parse dates as naive midnight and preserve supplied timestamp offsets.

    Storage serialization treats naive timestamps as UTC. Invalid dates return
    None so callers can reject the payload before changing persisted state.
    """
    if not s:
        return None

    s = str(s)
    # date-only -> treat as local midnight (all-day semantics)
    import re
    from datetime import datetime, timezone

    if re.match(r"^\d{4}-\d{2}-\d{2}$", s):
        try:
            return datetime.fromisoformat(s)
        except ValueError:
            return None

    # replace trailing Z with +00:00 for fromisoformat
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"

    try:
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None



def create_event(
    user_id: str,
    data: Mapping[str, Any],
    actor: Any,
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Create an owner event after validating its dates and metadata."""
    dependencies = dependencies or {}
    create_calendar_row_fn = dependencies.get('create_calendar_row', create_calendar_row)
    _ensure_local_calendar_source_fn = dependencies.get('_ensure_local_calendar_source', _ensure_local_calendar_source)
    _serialize_user_event_fn = dependencies.get('_serialize_user_event', _serialize_user_event)
    emit_creation_event_fn = dependencies.get('emit_creation_event', emit_creation_event)
    format_actor_fn = dependencies.get('format_actor', format_actor)
    _parse_iso_like_fn = dependencies.get('_parse_iso_like', _parse_iso_like)
    title = (data.get('title') or '').strip()
    description = data.get('description')
    start_raw = data.get('start_date') or data.get('start')
    end_raw = data.get('end_date') or data.get('end')
    all_day = bool(data.get('all_day', False))
    from services.external_calendar_domain import native_metadata
    try:
        metadata = native_metadata(data)
    except ValueError as exc:
        return ({'error': str(exc)}, 400)
    calendar_id = _normalize_calendar_id(data.get('calendar_id'))
    try:
        color = _normalize_color(data.get('color'))
        reminder_minutes = _normalize_reminder_minutes(data.get('reminder_minutes'), all_day)
    except ValueError as exc:
        return ({'error': str(exc)}, 400)
    if not title:
        return ({'error': 'title is required'}, 400)
    start_dt = _parse_iso_like_fn(start_raw)
    end_dt = _parse_iso_like_fn(end_raw)
    if not start_dt or not end_dt:
        return ({'error': 'start_date and end_date must be valid ISO datetimes'}, 400)
    if end_dt <= start_dt:
        return ({'error': 'end_date must be after start_date'}, 400)
    try:
        _ensure_local_calendar_source_fn(user_id=user_id, source_id=calendar_id)
        ev = create_calendar_row_fn(
            COLLECTIONS['user_events'],
            row_id=ID.unique(),
            data={
                **metadata,
                'user_id': str(user_id),
                'title': title,
                'description': description,
                'start': format_datetime(start_dt),
                'end': format_datetime(end_dt),
                'is_all_day': all_day,
                'color': color,
                'calendar_id': calendar_id,
                'reminder_minutes': reminder_minutes,
                'created_at': format_datetime(datetime.utcnow()),
            },
        )
    except AppwriteException:
        logger.exception('Failed to create user event')
        return ({'error': 'Unable to create event.'}, 500)
    emit_creation_event_fn(
        'Calendar Event Created',
        actor=format_actor_fn(actor),
        target=title,
        metadata={
            'page_context': 'calendar/events',
            'resource_type': 'user_event',
            'resource_id': ev.get('$id') or ev.get('id'),
            'calendar_id': calendar_id,
            'is_all_day': all_day,
            'start': format_datetime(start_dt),
            'end': format_datetime(end_dt),
        },
        color='green',
    )
    return ({'success': True, 'event': _serialize_user_event_fn(ev)}, 200)


def get_single_event(
    user_id: str,
    event_id: str,
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    dependencies = dependencies or {}
    get_calendar_row_fn = dependencies.get('get_calendar_row', get_calendar_row)
    _serialize_user_event_fn = dependencies.get('_serialize_user_event', _serialize_user_event)
    try:
        ev = get_calendar_row_fn(COLLECTIONS['user_events'], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return ({'error': 'not found'}, 404)
        logger.exception('Failed to load user event')
        return ({'error': 'Unable to load event.'}, 500)
    if ev.get('user_id') != str(user_id):
        return ({'error': 'not found'}, 404)
    return ({'event': _serialize_user_event_fn(ev)}, 200)


def update_event(
    user_id: str,
    event_id: str,
    data: Mapping[str, Any],
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    dependencies = dependencies or {}
    get_calendar_row_fn = dependencies.get('get_calendar_row', get_calendar_row)
    update_calendar_row_fn = dependencies.get('update_calendar_row', update_calendar_row)
    _ensure_local_calendar_source_fn = dependencies.get('_ensure_local_calendar_source', _ensure_local_calendar_source)
    _serialize_user_event_fn = dependencies.get('_serialize_user_event', _serialize_user_event)
    _parse_iso_like_fn = dependencies.get('_parse_iso_like', _parse_iso_like)
    try:
        ev = get_calendar_row_fn(COLLECTIONS['user_events'], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return ({'error': 'not found'}, 404)
        logger.exception('Failed to load user event')
        return ({'error': 'Unable to load event.'}, 500)
    if ev.get('user_id') != str(user_id):
        return ({'error': 'not found'}, 404)
    title = data.get('title')
    description = data.get('description')
    supplied_dates = {}
    for field in ("start", "end"):
        aliases = (field + "_date", field)
        for alias in aliases:
            if alias in data:
                parsed = _parse_iso_like_fn(data[alias])
                if parsed is None:
                    return {"error": "start_date and end_date must be valid ISO datetimes"}, 400
                supplied_dates.setdefault(field, parsed)
    effective_dates = {
        field: supplied_dates.get(field) or _parse_iso_like_fn(ev.get(field))
        for field in ("start", "end")
    }
    if any(value is None for value in effective_dates.values()):
        return {"error": "start_date and end_date must be valid ISO datetimes"}, 400
    effective_start = effective_dates['start'].replace(tzinfo=timezone.utc) if effective_dates['start'].tzinfo is None else effective_dates['start']
    effective_end = effective_dates['end'].replace(tzinfo=timezone.utc) if effective_dates['end'].tzinfo is None else effective_dates['end']
    if effective_end <= effective_start:
        return {"error": "end_date must be after start_date"}, 400
    all_day = data.get('all_day')
    calendar_id = data.get('calendar_id')
    from services.external_calendar_domain import native_metadata
    try:
        updates = {'updated_at': format_datetime(datetime.utcnow()), **native_metadata(data)}
    except ValueError as exc:
        return ({'error': str(exc)}, 400)
    if title is not None:
        updates['title'] = title
    if description is not None:
        updates['description'] = description
    updates.update({field: format_datetime(value) for field, value in supplied_dates.items()})
    if all_day is not None:
        updates['is_all_day'] = bool(all_day)
    if 'reminder_minutes' in data or all_day is not None:
        reminder_all_day = bool(all_day) if all_day is not None else bool(ev.get('is_all_day'))
        try:
            updates['reminder_minutes'] = _normalize_reminder_minutes(data.get('reminder_minutes'), reminder_all_day)
        except ValueError as exc:
            return ({'error': str(exc)}, 400)
    if 'color' in data:
        try:
            updates['color'] = _normalize_color(data.get('color'))
        except ValueError as exc:
            return ({'error': str(exc)}, 400)
    if calendar_id is not None:
        normalized_calendar_id = _normalize_calendar_id(calendar_id)
        _ensure_local_calendar_source_fn(user_id=user_id, source_id=normalized_calendar_id)
        updates['calendar_id'] = normalized_calendar_id
    try:
        ev = update_calendar_row_fn(COLLECTIONS['user_events'], event_id, updates)
    except AppwriteException:
        logger.exception('Failed to update user event')
        return ({'error': 'Unable to update event.'}, 500)
    return ({'success': True, 'event': _serialize_user_event_fn(ev)}, 200)


def delete_event(
    user_id: str,
    event_id: str,
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    dependencies = dependencies or {}
    get_calendar_row_fn = dependencies.get('get_calendar_row', get_calendar_row)
    delete_calendar_row_fn = dependencies.get('delete_calendar_row', delete_calendar_row)
    try:
        ev = get_calendar_row_fn(COLLECTIONS['user_events'], event_id)
    except AppwriteException as exc:
        if exc.code == 404:
            return ({'error': 'not found'}, 404)
        logger.exception('Failed to load user event')
        return ({'error': 'Unable to delete event.'}, 500)
    if ev.get('user_id') != str(user_id):
        return ({'error': 'not found'}, 404)
    from services.extension_mirrors import has_mirror_work
    if has_mirror_work(str(user_id), 'user:' + event_id):
        return (
            {
                'error': 'Choose whether to delete only Nest or both copies in Canvas copies.',
                'code': 'mirror_delete_choice_required',
            },
            409,
        )
    try:
        delete_calendar_row_fn(COLLECTIONS['user_events'], event_id)
    except AppwriteException:
        logger.exception('Failed to delete user event')
        return ({'error': 'Unable to delete event.'}, 500)
    return ({'success': True}, 200)


def upsert_event_override(
    user_id: str,
    data: Mapping[str, Any],
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Create or update the authenticated user's override for an imported event."""
    dependencies = dependencies or {}
    _ensure_local_calendar_source_fn = dependencies.get('_ensure_local_calendar_source', _ensure_local_calendar_source)
    _upsert_event_override_fn = dependencies.get('_upsert_event_override', _upsert_event_override)
    _parse_iso_like_fn = dependencies.get('_parse_iso_like', _parse_iso_like)
    event_ref = (data.get('event_ref') or '').strip()
    if not event_ref.startswith('feed:'):
        return ({'error': 'event_ref is required for an imported event.'}, 400)
    title = (data.get('title') or '').strip()
    start_raw = data.get('start_date') or data.get('start')
    end_raw = data.get('end_date') or data.get('end')
    all_day = bool(data.get('all_day', data.get('is_all_day', False)))
    calendar_id = _normalize_calendar_id(data.get('calendar_id'))
    if not title:
        return ({'error': 'title is required'}, 400)
    start_dt = _parse_iso_like_fn(start_raw)
    end_dt = _parse_iso_like_fn(end_raw)
    if not start_dt or not end_dt:
        return ({'error': 'start_date and end_date must be valid ISO datetimes'}, 400)
    if end_dt < start_dt:
        return ({'error': 'end_date must be on or after start_date'}, 400)
    try:
        color = _normalize_color(data.get('color'))
        reminder_minutes = _normalize_reminder_minutes(data.get('reminder_minutes'), all_day)
    except ValueError as exc:
        return ({'error': str(exc)}, 400)
    try:
        _ensure_local_calendar_source_fn(user_id, calendar_id)
        override = _upsert_event_override_fn(
            user_id,
            event_ref,
            {
                'title': title,
                'description': data.get('description') or '',
                'start': format_datetime(start_dt),
                'end': format_datetime(end_dt),
                'is_all_day': all_day,
                'calendar_id': calendar_id,
                'color': color,
                'reminder_minutes': reminder_minutes,
                'hidden': False,
            },
        )
    except AppwriteException:
        logger.exception('Failed to save event override')
        return ({'error': 'Unable to save event override.'}, 500)
    return ({'success': True, 'override': override}, 200)


def hide_event_override(
    user_id: str,
    data: Mapping[str, Any],
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Hide an imported event for the authenticated user without deleting the source feed event."""
    dependencies = dependencies or {}
    _upsert_event_override_fn = dependencies.get('_upsert_event_override', _upsert_event_override)
    event_ref = (data.get('event_ref') or '').strip()
    if not event_ref.startswith('feed:'):
        return ({'error': 'event_ref is required for an imported event.'}, 400)
    try:
        override = _upsert_event_override_fn(user_id, event_ref, {'hidden': True})
    except AppwriteException:
        logger.exception('Failed to hide imported event')
        return ({'error': 'Unable to delete event.'}, 500)
    return ({'success': True, 'override': override}, 200)
