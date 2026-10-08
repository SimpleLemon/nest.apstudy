"""Calendar operations with explicit identity and payload inputs; no HTTP handlers."""

import logging
from typing import Any, Callable, Mapping
from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from services.calendar_constants import PREFERENCES_BATCH_LIMIT
from services.calendar_identity import _calendar_preference_updates, _calendar_preference_unchanged
from services.calendar_store import list_calendar_rows_all, first_calendar_row
from services.calendar_sources import _upsert_calendar_preference

logger = logging.getLogger(__name__)



def get_calendar_preferences(
    user_id: str,
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """List the owner's persisted calendar preferences."""
    dependencies = dependencies or {}
    list_calendar_rows_all_fn = dependencies.get('list_calendar_rows_all', list_calendar_rows_all)
    try:
        prefs = list_calendar_rows_all_fn(COLLECTIONS['user_calendar_preferences'], [Query.equal('user_id', [user_id])])
    except AppwriteException:
        logger.exception('Failed to load calendar preferences')
        return ({'error': 'Unable to load calendar preferences.'}, 500)
    return (
        {
            'preferences': [
                {
                    'calendar_name': p.get('calendar_name'),
                    'color_hex': p.get('color_hex'),
                    'visible': p.get('visible'),
                    'display_name': p.get('display_name') or '',
                }
                for p in prefs
            ],
        },
        200,
    )


def update_calendar_preferences(
    user_id: str,
    data: Mapping[str, Any],
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Validate and save one owner calendar preference."""
    dependencies = dependencies or {}
    first_calendar_row_fn = dependencies.get('first_calendar_row', first_calendar_row)
    _upsert_calendar_preference_fn = dependencies.get('_upsert_calendar_preference', _upsert_calendar_preference)
    calendar_name = data.get('calendar_name')
    if not calendar_name:
        return ({'error': 'calendar_name is required'}, 400)
    try:
        updates = _calendar_preference_updates(data)
    except ValueError as exc:
        return ({'error': str(exc)}, 400)
    try:
        pref = first_calendar_row_fn(
            COLLECTIONS['user_calendar_preferences'],
            [Query.equal('user_id', [user_id]), Query.equal('calendar_name', [calendar_name])],
        )
        if pref and updates and _calendar_preference_unchanged(pref, updates):
            return (
                {
                    'status': 'ok',
                    'calendar_name': calendar_name,
                    'color_hex': pref.get('color_hex'),
                    'visible': pref.get('visible'),
                    'display_name': pref.get('display_name') or '',
                },
                200,
            )
        if updates or not pref:
            pref = _upsert_calendar_preference_fn(user_id, calendar_name, updates)
    except AppwriteException:
        logger.exception('Failed to update calendar preference')
        return ({'error': 'Unable to update preferences.'}, 500)
    return (
        {
            'status': 'ok',
            'calendar_name': calendar_name,
            'color_hex': pref.get('color_hex'),
            'visible': pref.get('visible'),
            'display_name': pref.get('display_name') or '',
        },
        200,
    )


def update_calendar_preferences_batch(
    user_id: str,
    data: Mapping[str, Any],
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Save bounded preference entries and report each entry's outcome."""
    dependencies = dependencies or {}
    first_calendar_row_fn = dependencies.get('first_calendar_row', first_calendar_row)
    _upsert_calendar_preference_fn = dependencies.get('_upsert_calendar_preference', _upsert_calendar_preference)
    entries = data.get('preferences')
    if not isinstance(entries, list):
        return ({'error': 'preferences must be a list'}, 400)
    if len(entries) > PREFERENCES_BATCH_LIMIT:
        return ({'error': f'preferences batch must be <= {PREFERENCES_BATCH_LIMIT}'}, 400)
    updated = []
    skipped = []
    errors = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            logger.warning('Invalid calendar preference entry', extra={'index': index})
            errors.append({'index': index, 'error': 'Invalid preference entry.'})
            continue
        calendar_name = entry.get('calendar_name')
        if not calendar_name:
            logger.warning('Missing calendar_name in preference batch', extra={'index': index})
            errors.append({'index': index, 'error': 'calendar_name is required.'})
            continue
        try:
            updates = _calendar_preference_updates(entry)
        except ValueError as exc:
            logger.warning('Invalid calendar preference update', extra={'calendar_name': calendar_name, 'error': str(exc)})
            errors.append({'calendar_name': calendar_name, 'error': str(exc)})
            continue
        try:
            pref = first_calendar_row_fn(
                COLLECTIONS['user_calendar_preferences'],
                [Query.equal('user_id', [user_id]), Query.equal('calendar_name', [calendar_name])],
            )
            if pref and updates and _calendar_preference_unchanged(pref, updates):
                skipped.append(calendar_name)
                continue
            if updates or not pref:
                _upsert_calendar_preference_fn(user_id, calendar_name, updates)
                updated.append(calendar_name)
            else:
                skipped.append(calendar_name)
        except AppwriteException:
            logger.exception('Failed to update calendar preference', extra={'calendar_name': calendar_name})
            errors.append({'calendar_name': calendar_name, 'error': 'Unable to update preferences.'})
    return ({'status': 'ok', 'updated': updated, 'skipped': skipped, 'errors': errors}, 200)



def save_calendar_preferences(
    user_id: str,
    data: Mapping[str, Any],
    *,
    dependencies: Mapping[str, Callable[..., Any]] | None = None,
) -> tuple[dict[str, Any], int]:
    """Apply either the public single-entry or batch preference contract."""
    handler = update_calendar_preferences_batch if "preferences" in data else update_calendar_preferences
    return handler(user_id, data, dependencies=dependencies)
