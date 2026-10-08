"""Provider-independent calendar values and three-way conflict detection."""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import hashlib
import json

FIELDS = ('title', 'description', 'start', 'end', 'timezone', 'all_day', 'location', 'reminder_minutes')
TIME_FIELDS = ('start', 'end', 'timezone', 'all_day')
EXPORT_SOURCES = ('personal', 'canvas', 'tasks', 'courses')


class CalendarError(ValueError):
    def __init__(self, code, status=400):
        self.code, self.status = code, status
        super().__init__(code)


def dumps(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(dumps(value).encode()).hexdigest()


def window(now=None):
    today = (now or datetime.now(timezone.utc)).date()
    return ((today - timedelta(days=30)).isoformat(), (today + timedelta(days=366)).isoformat())


def normalize(body, base=None):
    if not isinstance(body, dict):
        raise CalendarError('invalid_event')
    result = dict(base or {})
    for key in FIELDS:
        if key in body:
            result[key] = body[key]
    for key, limit in [('title', 512), ('description', 4096), ('location', 512)]:
        value = result.get(key, '')
        if not isinstance(value, str) or len(value) > limit:
            raise CalendarError('invalid_' + key)
        result[key] = value.strip() if key != 'description' else value
    if not result['title']:
        raise CalendarError('title_required')
    result.setdefault('timezone', 'UTC')
    try:
        ZoneInfo(result['timezone'])
    except (TypeError, ValueError, ZoneInfoNotFoundError):
        raise CalendarError('invalid_timezone') from None
    result.setdefault('all_day', False)
    if not isinstance(result['all_day'], bool):
        raise CalendarError('invalid_all_day')
    try:
        if result['all_day']:
            start, end = (date.fromisoformat(result[k]) for k in ('start', 'end'))
            result['start'], result['end'] = start.isoformat(), end.isoformat()
        else:
            start, end = (datetime.fromisoformat(result[k].replace('Z', '+00:00')) for k in ('start', 'end'))
            if start.tzinfo is None or end.tzinfo is None:
                raise ValueError()
            result['start'], result['end'] = (v.astimezone(timezone.utc).isoformat() for v in (start, end))
        if end <= start:
            raise ValueError()
    except (KeyError, TypeError, ValueError):
        raise CalendarError('invalid_event_range') from None
    reminder = result.get('reminder_minutes', -1)
    if isinstance(reminder, bool) or not isinstance(reminder, int) or not -1 <= reminder <= 40320:
        raise CalendarError('invalid_reminder')
    result['reminder_minutes'] = reminder
    return {key: result[key] for key in FIELDS}


def merge(base, local, remote):
    """None represents deletion; time is an indivisible conflict group."""
    if local == remote:
        return local, []
    if local == base:
        return remote, []
    if remote == base:
        return local, []
    if local is None or remote is None or base is None:
        return None, ['deleted']
    merged, conflicts = dict(remote), []
    for group in [TIME_FIELDS] + [(key,) for key in FIELDS if key not in TIME_FIELDS]:
        a, b, original = ([obj.get(key) for key in group] for obj in (local, remote, base))
        if a != original and b != original and a != b:
            conflicts.append('time' if group == TIME_FIELDS else group[0])
        elif a != original:
            merged.update({key: local.get(key) for key in group})
    return merged, conflicts


def in_window(body, bounds):
    return bool(body and body['end'][:10] >= bounds[0] and body['start'][:10] < bounds[1])


def native_metadata(body):
    """Validate only additive native metadata; retain the existing event API."""
    result = {}
    if 'timezone' in body:
        try:
            ZoneInfo(body['timezone'])
        except (TypeError, ValueError, ZoneInfoNotFoundError):
            raise CalendarError('invalid_timezone') from None
        result['timezone'] = body['timezone']
    if 'location' in body:
        if not isinstance(body['location'], str) or len(body['location']) > 512:
            raise CalendarError('invalid_location')
        result['location'] = body['location']
    return result
