"""Bounded REST clients. URLs, credentials and provider errors stay server-side."""
import time
from datetime import datetime, timezone
from urllib.parse import quote, urlsplit
from zoneinfo import ZoneInfo
import requests
from babel.core import get_global
from services.external_calendar_domain import CalendarError, normalize

GOOGLE = 'https://www.googleapis.com/calendar/v3'
GRAPH = 'https://graph.microsoft.com/v1.0'
OWNERSHIP_PROPERTY = 'String {89a0efe7-4f61-4bb8-8bb5-244733283103} Name APStudyConnection'


class ProviderError(CalendarError):
    def __init__(self, status, retry_after=0):
        code = {401: 'reconnect_required', 403: 'calendar_permission_denied', 404: 'remote_not_found',
                410: 'cursor_expired', 409: 'remote_conflict', 412: 'remote_conflict', 429: 'provider_throttled'}.get(status, 'provider_unavailable')
        super().__init__(code, status)
        self.retry_after = retry_after


def zone(value):
    value = get_global('windows_zone_mapping').get(value, value) or 'UTC'
    try:
        ZoneInfo(value)
        return value
    except (KeyError, ValueError):
        return 'UTC'


def instant(part):
    raw = part.get('dateTime', '')
    dt = datetime.fromisoformat(raw.replace('Z', '+00:00'))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(zone(part.get('timeZone'))))
    return dt.astimezone(timezone.utc).isoformat()


def safe_event_url(provider, value):
    if not isinstance(value, str):
        return None
    parsed = urlsplit(value)
    hosts = {'google': {'calendar.google.com', 'www.google.com'},
             'microsoft': {'outlook.office.com', 'outlook.office365.com', 'outlook.live.com'}}
    return value if parsed.scheme == 'https' and parsed.hostname in hosts[provider] and not parsed.username and not parsed.password and parsed.port in (None, 443) else None


class Provider:
    def __init__(self, provider, token, *, http=requests, heartbeat=lambda: None):
        self.provider, self.token, self.http, self.heartbeat = provider, token, http, heartbeat
        self.base = GOOGLE if provider == 'google' else GRAPH
        self.deadline = time.monotonic() + 100

    def request(self, method, path, *, params=None, body=None, revision=None):
        if time.monotonic() >= self.deadline:
            raise CalendarError('sync_time_budget', 503)
        self.heartbeat()
        url = path if path.startswith('https://') else self.base + path
        parsed, base = urlsplit(url), urlsplit(self.base)
        if parsed.scheme != 'https' or parsed.hostname != base.hostname or not parsed.path.startswith(base.path + '/') or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise CalendarError('invalid_provider_cursor', 502)
        headers = {'Authorization': 'Bearer ' + self.token, 'Accept': 'application/json'}
        if self.provider == 'microsoft':
            headers['Prefer'] = 'IdType="ImmutableId", outlook.timezone="UTC"'
        if revision:
            headers['If-Match'] = revision
        try:
            response = self.http.request(method, url, params=params, json=body, headers=headers, timeout=(5, 15), allow_redirects=False)
        except requests.RequestException:
            raise CalendarError('provider_unavailable', 503) from None
        if response.status_code >= 300:
            delay = response.headers.get('Retry-After', '0')
            raise ProviderError(response.status_code, min(86400, int(delay)) if delay.isdigit() else 180)
        if response.status_code == 204:
            return {}
        try:
            return response.json()
        except ValueError:
            raise CalendarError('invalid_provider_response', 502) from None

    def pages(self, path, params=None, collection='value'):
        result, last = [], {}
        for _ in range(100):
            last = self.request('GET', path, params=params)
            result.extend(last.get(collection, []))
            if len(result) > 20000:
                raise CalendarError('calendar_too_large', 422)
            if self.provider == 'google' and last.get('nextPageToken'):
                params = {**(params or {}), 'pageToken': last['nextPageToken']}
            elif last.get('@odata.nextLink'):
                path, params = last['@odata.nextLink'], None
            else:
                return result, last
        raise CalendarError('calendar_too_large', 422)

    def calendars(self):
        if self.provider == 'google':
            items, _ = self.pages('/users/me/calendarList', {'maxResults': 250}, 'items')
            return [{'remote_id': x['id'], 'name': x.get('summary', 'Calendar'), 'writable': x.get('accessRole') in ('writer', 'owner'),
                     'is_primary': x.get('primary', False), 'ownership_marker': x.get('description')} for x in items if not x.get('deleted') and x.get('accessRole') != 'freeBusyReader']
        items, _ = self.pages('/me/calendars', {'$top': 100, '$expand': "singleValueExtendedProperties($filter=id eq '" + OWNERSHIP_PROPERTY + "')"})
        return [{'remote_id': x['id'], 'name': x.get('name', 'Calendar'), 'writable': x.get('canEdit', False),
                 'is_primary': x.get('isDefaultCalendar', False), 'ownership_marker': next((v.get('value') for v in x.get('singleValueExtendedProperties', []) if v.get('id') == OWNERSHIP_PROPERTY), None)} for x in items]

    def create_calendar(self, marker):
        if self.provider == 'google':
            return self.request('POST', '/calendars', body={'summary': 'APStudy', 'description': marker})['id']
        return self.request('POST', '/me/calendars', body={'name': 'APStudy', 'singleValueExtendedProperties': [{'id': OWNERSHIP_PROPERTY, 'value': marker}]})['id']

    def events(self, calendar, bounds):
        remote = quote(calendar['remote_id'], safe='')
        cursor = calendar.get('cursor')
        try:
            if self.provider == 'google':
                params = {'maxResults': 2500, 'singleEvents': True, 'showDeleted': True}
                if cursor:
                    params['syncToken'] = cursor
                else:
                    params.update(timeMin=bounds[0] + 'T00:00:00Z', timeMax=bounds[1] + 'T00:00:00Z')
                items, last = self.pages('/calendars/' + remote + '/events', params, 'items')
                return items, last.get('nextSyncToken'), not cursor
            params = {'startDateTime': bounds[0] + 'T00:00:00Z', 'endDateTime': bounds[1] + 'T00:00:00Z', '$top': 100}
            if calendar['is_primary']:
                items, last = self.pages(cursor or '/me/calendarView/delta', None if cursor else {k: v for k, v in params.items() if k != '$top'})
                return items, last.get('@odata.deltaLink'), not cursor
            items, _ = self.pages('/me/calendars/' + remote + '/calendarView', params)
            return items, None, True
        except ProviderError as exc:
            if exc.status == 410 and cursor:
                return self.events({**calendar, 'cursor': None}, bounds)
            raise

    def decode(self, item, writable=True):
        if item.get('status') == 'cancelled' or item.get('isCancelled') or '@removed' in item:
            return None
        google = self.provider == 'google'
        start, end = item.get('start', {}), item.get('end', {})
        all_day = 'date' in start if google else item.get('isAllDay', False)
        tz = zone(start.get('timeZone') if google else item.get('originalStartTimeZone'))
        if all_day:
            if google:
                begin, finish = start['date'], end['date']
            else:
                begin, finish = (datetime.fromisoformat(instant(part)).astimezone(ZoneInfo(tz)).date().isoformat() for part in (start, end))
        else:
            begin, finish = instant(start), instant(end)
        if google:
            reminders = item.get('reminders', {}).get('overrides', [])
            reminder = next((x['minutes'] for x in reminders if x.get('method') == 'popup'), -1)
        else:
            reminder = item.get('reminderMinutesBeforeStart', -1) if item.get('isReminderOn') else -1
        description = item.get('description', '') if google else item.get('body', {}).get('content', '')
        # Graph descriptions may be HTML; plaintext previews avoid executable markup.
        if not google and item.get('body', {}).get('contentType', '').lower() == 'html':
            from html.parser import HTMLParser
            class PlainText(HTMLParser):
                def __init__(self):
                    super().__init__(); self.parts = []
                def handle_data(self, data):
                    self.parts.append(data)
            parser = PlainText(); parser.feed(description); description = ''.join(parser.parts)
        body = normalize({'title': ((item.get('summary') if google else item.get('subject')) or '(Untitled)')[:512],
                          'description': description[:4096], 'location': (item.get('location', '') if google else item.get('location', {}).get('displayName', ''))[:512],
                          'start': begin, 'end': finish, 'all_day': bool(all_day), 'timezone': tz, 'reminder_minutes': reminder})
        special = item.get('eventType', 'default') != 'default' if google else item.get('type') == 'seriesMaster'
        editable = bool(writable and not item.get('attendees') and not special and not item.get('recurrence')
                        and not item.get('locked') and not item.get('isOnlineMeeting') and not item.get('conferenceData'))
        series = item.get('recurringEventId') or item.get('seriesMasterId')
        occurrence = item.get('originalStartTime') if google else item.get('originalStart')
        if isinstance(occurrence, dict):
            occurrence = occurrence.get('dateTime') or occurrence.get('date')
        return {'body': body, 'revision': item.get('etag') or item.get('@odata.etag') or item.get('changeKey'),
                'editable': editable, 'source_url': safe_event_url(self.provider, item.get('htmlLink') if google else item.get('webLink')),
                'occurrence_id': (series + ':' + str(occurrence or item['id'])) if series else None}

    def encode(self, body):
        if self.provider == 'google':
            key = 'date' if body['all_day'] else 'dateTime'
            return {'summary': body['title'], 'description': body['description'], 'location': body['location'],
                    'start': {key: body['start'], 'timeZone': body['timezone']}, 'end': {key: body['end'], 'timeZone': body['timezone']},
                    'reminders': {'useDefault': False, 'overrides': [] if body['reminder_minutes'] < 0 else [{'method': 'popup', 'minutes': body['reminder_minutes']}]}}
        def graph_time(value):
            return {'dateTime': value + 'T00:00:00' if body['all_day'] else datetime.fromisoformat(value).astimezone(ZoneInfo(body['timezone'])).strftime('%Y-%m-%dT%H:%M:%S'),
                    'timeZone': body['timezone']}
        return {'subject': body['title'], 'body': {'contentType': 'text', 'content': body['description']},
                'location': {'displayName': body['location']}, 'start': graph_time(body['start']), 'end': graph_time(body['end']),
                'isAllDay': body['all_day'], 'isReminderOn': body['reminder_minutes'] >= 0,
                'reminderMinutesBeforeStart': max(0, body['reminder_minutes'])}

    def event_path(self, calendar_id, event_id=None):
        prefix = '/calendars/' if self.provider == 'google' else '/me/calendars/'
        return prefix + quote(calendar_id, safe='') + '/events' + ('/' + quote(event_id, safe='') if event_id else '')

    def get(self, calendar_id, event_id):
        try:
            return self.request('GET', self.event_path(calendar_id, event_id))
        except ProviderError as exc:
            if exc.status in (404, 410):
                return None
            raise

    def write(self, calendar_id, event_id, body, operation_id, revision=None):
        path = self.event_path(calendar_id, event_id)
        original = None
        if event_id:
            original = self.get(calendar_id, event_id)
            decoded = self.decode(original) if original else None
            if decoded and not decoded['editable']:
                raise CalendarError('event_no_longer_editable', 409)
            if decoded and revision and decoded['revision'] != revision:
                raise ProviderError(412)
            revision = decoded['revision'] if decoded else revision
        if body is None:
            if not event_id or original is None:
                return None
            try:
                self.request('DELETE', path, revision=revision)
            except ProviderError as exc:
                if exc.status not in (404, 410):
                    raise
            return None
        payload = self.encode(body)
        if event_id:
            if original is None:
                raise ProviderError(412)
            # Patch only changed field groups. In particular, an unrelated title
            # edit must preserve HTML descriptions, reminders and conference data.
            previous = self.encode(decoded['body'])
            payload = {key: value for key, value in payload.items() if value != previous.get(key)}
            if not payload:
                return original
            return self.request('PATCH', path, body=payload, revision=revision)
        if self.provider == 'google':
            payload['id'] = operation_id
            payload['extendedProperties'] = {'private': {'apstudyOperation': operation_id}}
        else:
            payload['transactionId'] = operation_id
        try:
            return self.request('POST', path, body=payload)
        except ProviderError as exc:
            if self.provider == 'google' and exc.status == 409:
                return self.get(calendar_id, operation_id)
            raise
