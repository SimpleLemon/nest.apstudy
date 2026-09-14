"""Authenticated calendar operations and public projection, without provider secrets."""
import json
import time
from services.external_calendar_domain import CalendarError, EXPORT_SOURCES, digest, dumps, in_window, normalize, window
from services.external_calendar_store import available, connection, row, rows, transaction, uid
from services.external_calendar_oauth import access_token
from services.external_calendar_provider import Provider


def capabilities(user_id=None):
    configured = {provider: available(provider, user_id) for provider in ('google', 'microsoft')}
    return {'providers': configured, 'provider_calendar_read': any(configured.values()),
            'provider_calendar_write': any(configured.values()), 'provider_calendar_manage': any(configured.values())}


def status(user_id):
    with transaction() as db:
        records = rows(db, 'SELECT * FROM external_calendar_connections WHERE user_id=? ORDER BY created_at', (str(user_id),))
        result = []
        for item in records:
            item_calendars = rows(db, 'SELECT id,name,writable,selected,is_primary,available FROM external_calendars WHERE connection_id=? ORDER BY name', (item['id'],))
            result.append({key: item[key] for key in ('id', 'provider', 'label', 'status', 'last_sync_at', 'last_error')} | {
                'export_error': item['export_error'],
                'failed': rows(db, "SELECT id,event_id,last_error FROM external_calendar_jobs WHERE connection_id=? AND state='failed'", (item['id'],)),
                'calendars': item_calendars, 'export_sources': json.loads(item['export_sources']),
                'pending': db.execute("SELECT COUNT(*) FROM external_calendar_jobs WHERE connection_id=? AND state='queued'", (item['id'],)).fetchone()[0],
                'conflicts': db.execute('SELECT COUNT(*) FROM external_calendar_conflicts WHERE connection_id=?', (item['id'],)).fetchone()[0],
                'suppressed': rows(db, 'SELECT id,source_ref FROM external_calendar_exports WHERE connection_id=? AND suppressed=1', (item['id'],))})
    return {'connections': result, 'capabilities': capabilities(user_id), 'window': {'start': window()[0], 'end': window()[1]}, 'consent_version': 1}


def refresh_calendars(user_id, connection_id, client=None):
    from services.external_calendar_store import claim, assert_lease
    token = claim(connection_id)
    if not token:
        raise CalendarError('sync_in_progress', 409)
    try:
        with transaction() as db:
            item = connection(db, user_id, connection_id)
        if not available(item['provider'], item['user_id']):
            raise CalendarError('provider_not_configured', 503)
        client = client or Provider(item['provider'], access_token(item))
        calendars = client.calendars()
        with transaction() as db:
            assert_lease(db, connection_id, token)
            db.execute('UPDATE external_calendars SET writable=0,available=0 WHERE connection_id=?', (connection_id,))
            for calendar in calendars:
                db.execute('INSERT INTO external_calendars(id,connection_id,user_id,remote_id,name,writable,is_primary,selected) VALUES(?,?,?,?,?,?,?,?) '
                           'ON CONFLICT(connection_id,remote_id) DO UPDATE SET name=excluded.name,writable=excluded.writable,is_primary=excluded.is_primary',
                           (uid(), connection_id, str(user_id), calendar['remote_id'], calendar['name'][:160], calendar['writable'], calendar['is_primary'], calendar['is_primary']))
                db.execute('UPDATE external_calendars SET ownership_marker=?,available=1 WHERE connection_id=? AND remote_id=?', (calendar.get('ownership_marker'), connection_id, calendar['remote_id']))
    finally:
        with transaction() as db:
            db.execute('UPDATE external_calendar_connections SET lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?', (connection_id, token))
    return status(user_id)


def configure(user_id, connection_id, body):
    selected, sources = body.get('calendar_ids'), body.get('export_sources')
    if body.get('consent_version') != 1 or not isinstance(selected, list) or len(selected) > 50 or not isinstance(sources, list) or any(not isinstance(x, str) or x not in EXPORT_SOURCES for x in sources):
        raise CalendarError('calendar_selection_required')
    with transaction() as db:
        item = connection(db, user_id, connection_id)
        if not available(item['provider'], item['user_id']) or not item['credentials']:
            raise CalendarError('reconnect_required', 409)
        if item['lease_until'] > time.time():
            raise CalendarError('sync_in_progress', 409)
        known = {x['id'] for x in rows(db, 'SELECT id FROM external_calendars WHERE connection_id=?', (connection_id,))}
        if any(not isinstance(x, str) or x not in known for x in selected):
            raise CalendarError('invalid_calendar_selection')
        for calendar_id in known:
            db.execute('UPDATE external_calendars SET selected=? WHERE id=?', (calendar_id in selected, calendar_id))
        db.execute("UPDATE external_calendar_jobs SET state='cancelled' WHERE connection_id=? AND state IN ('queued','failed') AND event_id IN (SELECT e.id FROM external_calendar_events e JOIN external_calendars k ON k.id=e.calendar_id WHERE k.selected=0)", (connection_id,))
        db.execute("UPDATE external_calendar_events SET body=COALESCE(baseline,body),deleted=CASE WHEN remote_id IS NULL THEN 1 ELSE 0 END,status='synchronized' WHERE connection_id=? AND status IN ('queued','failed') AND calendar_id IN (SELECT id FROM external_calendars WHERE selected=0)", (connection_id,))
        db.execute("UPDATE external_calendar_connections SET consent_version=1,export_sources=?,status='active',next_sync_at=0,last_error=NULL WHERE id=?", (dumps(sorted(set(sources))), connection_id))
    return status(user_id)


def sync_now(user_id, connection_id):
    with transaction() as db:
        item = connection(db, user_id, connection_id)
        if item['status'] not in ('active', 'cleanup'):
            raise CalendarError('connection_not_active', 409)
        if item['last_sync_requested_at'] and time.time() - item['last_sync_requested_at'] < 30:
            raise CalendarError('sync_rate_limited', 429)
        if not available(item['provider'], item['user_id']):
            raise CalendarError('provider_not_configured', 503)
        db.execute("UPDATE external_calendar_jobs SET state='queued',next_attempt_at=0 WHERE connection_id=? AND state='failed'", (connection_id,))
        db.execute("UPDATE external_calendar_events SET status='queued' WHERE connection_id=? AND status='failed'", (connection_id,))
        db.execute('UPDATE external_calendar_connections SET next_sync_at=0,last_sync_requested_at=? WHERE id=?', (time.time(), connection_id))
    return {'state': 'queued'}


def purge(db, item):
    connection_id = item['id']
    for table in ('external_calendar_events', 'external_calendar_jobs', 'external_calendar_conflicts', 'external_calendar_resolutions'):
        db.execute('DELETE FROM ' + table + ' WHERE connection_id=?', (connection_id,))
    db.execute('UPDATE external_calendars SET cursor=NULL,selected=0 WHERE connection_id=?', (connection_id,))
    db.execute('UPDATE external_calendar_exports SET baseline=NULL,revision=NULL,pending_body=NULL,pending_revision=NULL,pending_remote_id=NULL WHERE connection_id=?', (connection_id,))
    db.execute('DELETE FROM external_calendar_oauth WHERE connection_id=?', (connection_id,))
    db.execute("UPDATE external_calendar_connections SET credentials=NULL,status='disconnected',consent_version=0,last_error=NULL,lease_token=NULL,lease_until=0 WHERE id=?", (connection_id,))


def disconnect(user_id, connection_id, cleanup=False):
    with transaction() as db:
        item = connection(db, user_id, connection_id)
        if cleanup and item['credentials']:
            db.execute("UPDATE external_calendar_connections SET status='cleanup',next_sync_at=0,last_error=NULL WHERE id=?", (connection_id,))
            db.execute("UPDATE external_calendar_jobs SET state='cancelled' WHERE connection_id=? AND state='queued'", (connection_id,))
        elif item['lease_until'] > time.time():
            # Fence subsequent requests immediately. The leased worker finishes
            # its current HTTP call, then purges; crash recovery does the same.
            db.execute("UPDATE external_calendar_connections SET status='disconnecting',next_sync_at=0 WHERE id=?", (connection_id,))
        else:
            purge(db, item)
    return status(user_id)


def project(user_id, start=None, end=None):
    if not capabilities(user_id)['provider_calendar_read']:
        return [], []
    active_window = window()
    bounds = (max(str(start or active_window[0])[:10], active_window[0]), min(str(end or active_window[1])[:10], active_window[1]))
    with transaction() as db:
        events = rows(db, "SELECT e.*,c.provider,k.name,k.writable FROM external_calendar_events e JOIN external_calendar_connections c ON c.id=e.connection_id JOIN external_calendars k ON k.id=e.calendar_id WHERE e.user_id=? AND c.status='active' AND k.selected=1 AND k.available=1 AND e.deleted=0 AND NOT EXISTS (SELECT 1 FROM external_calendar_exports m WHERE m.connection_id=e.connection_id AND m.remote_id=e.remote_id)", (str(user_id),))
        sources = rows(db, "SELECT k.id,k.name,k.writable,c.provider,c.id AS connection_id FROM external_calendars k JOIN external_calendar_connections c ON c.id=k.connection_id WHERE k.user_id=? AND c.status='active' AND k.selected=1 AND k.available=1", (str(user_id),))
    public = []
    for event in events:
        body = json.loads(event['body'])
        if bounds[0] >= bounds[1] or not in_window(body, bounds) or not available(event['provider'], user_id):
            continue
        editable = bool(event['editable'] and event['writable'] and event['status'] == 'synchronized')
        public.append(body | {'id': 'external:' + event['id'], 'event_ref': 'external:' + event['id'], 'calendar_id': 'external:' + event['calendar_id'],
                             'source_type': 'external', 'provider': event['provider'], 'connection_id': event['connection_id'],
                             'source_label': event['name'], 'editable': editable, 'revision': event['revision'], 'sync_state': event['status'],
                             'source_url': event['source_url'], 'occurrence_id': event['occurrence_id'], 'is_all_day': body['all_day']})
    return public, [{'id': 'external:' + x['id'], 'name': x['name'], 'provider': x['provider'], 'connection_id': x['connection_id'],
                     'kind': 'external', 'source_type': 'external', 'editable': bool(x['writable']), 'visible': True} for x in sources if available(x['provider'], user_id)]


def mutate(user_id, event_id, operation, payload):
    key = payload.get('idempotency_key')
    if not isinstance(key, str) or not 8 <= len(key) <= 128:
        raise CalendarError('idempotency_key_required')
    payload_hash = digest({'event_id': event_id, 'operation': operation, 'payload': payload})
    with transaction() as db:
        previous = row(db, 'SELECT * FROM external_calendar_jobs WHERE user_id=? AND idempotency_key=?', (str(user_id), key))
        if previous:
            if previous['payload_hash'] != payload_hash:
                raise CalendarError('idempotency_conflict', 409)
            return {'state': previous['state'], 'operation_id': previous['id']}
        event = row(db, 'SELECT * FROM external_calendar_events WHERE id=? AND user_id=?', (event_id, str(user_id))) if event_id else None
        if event_id and not event:
            raise CalendarError('event_not_found', 404)
        calendar_id = event['calendar_id'] if event else str(payload.get('calendar_id', '')).removeprefix('external:')
        calendar = row(db, 'SELECT * FROM external_calendars WHERE id=? AND user_id=?', (calendar_id, str(user_id)))
        if not calendar:
            raise CalendarError('calendar_not_found', 404)
        item = connection(db, user_id, calendar['connection_id'])
        if not available(item['provider'], item['user_id']) or item['status'] != 'active' or item['consent_version'] != 1 or not calendar['selected'] or not calendar['writable'] or not calendar['available']:
            raise CalendarError('calendar_write_forbidden', 403)
        if event and (not event['editable'] or event['deleted'] or event['status'] != 'synchronized'):
            raise CalendarError('event_not_editable', 409)
        if event and (not payload.get('revision') or payload['revision'] != event['revision']):
            raise CalendarError('event_revision_conflict', 409)
        body = None if operation == 'delete' else normalize(payload, json.loads(event['body']) if event else None)
        operation_id = uid()
        if not event:
            event_id = uid()
            db.execute("INSERT INTO external_calendar_events(id,connection_id,calendar_id,user_id,body,editable,status) VALUES(?,?,?,?,?,1,'queued')", (event_id, item['id'], calendar_id, str(user_id), dumps(body)))
        else:
            db.execute("UPDATE external_calendar_events SET status='queued',body=?,deleted=? WHERE id=?", (dumps(body or json.loads(event['body'])), operation == 'delete', event_id))
        db.execute('INSERT INTO external_calendar_jobs(id,user_id,connection_id,event_id,operation,payload,expected_revision,idempotency_key,payload_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                   (operation_id, str(user_id), item['id'], event_id, operation, dumps(body), event['revision'] if event else None, key, payload_hash, time.time()))
        db.execute('UPDATE external_calendar_connections SET next_sync_at=0 WHERE id=?', (item['id'],))
    return {'state': 'queued', 'operation_id': operation_id, 'event_ref': 'external:' + event_id}


def conflicts(user_id):
    with transaction() as db:
        result = rows(db, 'SELECT id,event_id,export_id,local_body,remote_body,remote_revision,reason,source_url,created_at FROM external_calendar_conflicts WHERE user_id=?', (str(user_id),))
        from services.external_calendar_sources import source_body
        for value in result:
            if value['export_id'] and value['event_id'].startswith('user:'):
                current = row(db, 'SELECT * FROM user_events WHERE id=? AND user_id=?', (value['event_id'][5:], str(user_id)))
                value['local_body'] = dumps(source_body(current) if current else None)
                db.execute('UPDATE external_calendar_conflicts SET local_body=? WHERE id=?', (value['local_body'], value['id']))
    return {'conflicts': [{**x, 'revision': digest(x), 'local_body': json.loads(x['local_body']), 'remote_body': json.loads(x['remote_body'])} for x in result]}


def resolve(user_id, conflict_id, choice, revision=None, idempotency_key=None):
    if choice not in ('local', 'remote', 'retry'):
        raise CalendarError('conflict_choice_required')
    payload_hash = digest({'id': conflict_id, 'choice': choice, 'revision': revision})
    with transaction() as db:
        if idempotency_key:
            prior = row(db, 'SELECT * FROM external_calendar_resolutions WHERE user_id=? AND idempotency_key=?', (str(user_id), idempotency_key))
            if prior:
                if prior['payload_hash'] != payload_hash:
                    raise CalendarError('idempotency_conflict', 409)
                return json.loads(prior['result'])
        conflict = row(db, 'SELECT * FROM external_calendar_conflicts WHERE id=? AND user_id=?', (conflict_id, str(user_id)))
        if not conflict:
            raise CalendarError('conflict_not_found', 404)
        snapshot = {key: conflict[key] for key in ('id','event_id','export_id','local_body','remote_body','remote_revision','reason','source_url','created_at')}
        if revision is not None and revision != digest(snapshot):
            raise CalendarError('event_revision_conflict', 409)
        item = connection(db, user_id, conflict['connection_id'])
        if item['status'] != 'active' or not available(item['provider'], item['user_id']):
            raise CalendarError('connection_not_active', 409)
        if item['lease_until'] > time.time():
            raise CalendarError('sync_in_progress', 409)
        if conflict['reason'] == 'provider_review_required' and choice != 'retry':
            raise CalendarError('provider_review_required', 409)
        if choice == 'retry' and (conflict['reason'] != 'provider_review_required' or not conflict['export_id']):
            raise CalendarError('conflict_choice_required')
        chosen = json.loads(conflict[('local' if choice == 'retry' else choice) + '_body'])
        if conflict['export_id']:
            from services.external_calendar_sources import save_personal
            mapping = row(db, 'SELECT * FROM external_calendar_exports WHERE id=?', (conflict['export_id'],))
            if mapping['source_kind'] == 'personal':
                from services.external_calendar_sources import source_body
                current = row(db, 'SELECT * FROM user_events WHERE id=? AND user_id=?', (mapping['source_ref'][5:], str(user_id)))
                if dumps(source_body(current) if current else None) != conflict['local_body']:
                    raise CalendarError('event_revision_conflict', 409)
            if choice == 'remote':
                save_personal(db, str(user_id), mapping['source_ref'], chosen)
            if choice != 'retry':
                db.execute('UPDATE external_calendar_exports SET baseline=?,revision=?,pending_body=NULL,pending_revision=NULL,pending_remote_id=NULL WHERE id=?', (conflict['remote_body'], conflict['remote_revision'], mapping['id']))
        else:
            db.execute('UPDATE external_calendar_events SET baseline=?,revision=?,body=?,deleted=?,status=? WHERE id=?',
                       (conflict['remote_body'], conflict['remote_revision'], dumps(chosen), chosen is None, 'queued' if choice == 'local' else 'synchronized', conflict['event_id']))
            db.execute("UPDATE external_calendar_jobs SET state=?,payload=?,expected_revision=? WHERE event_id=? AND state='conflict'", ('queued' if choice == 'local' else 'cancelled', dumps(chosen), conflict['remote_revision'], conflict['event_id']))
        db.execute('DELETE FROM external_calendar_conflicts WHERE id=?', (conflict_id,))
        db.execute('UPDATE external_calendar_connections SET next_sync_at=0 WHERE id=?', (item['id'],))
        result = {'state': 'queued' if choice in ('local', 'retry') else 'synchronized'}
        if idempotency_key:
            db.execute('INSERT INTO external_calendar_resolutions VALUES(?,?,?,?,?)', (str(user_id), idempotency_key, payload_hash, item['id'], dumps(result)))
    return result
