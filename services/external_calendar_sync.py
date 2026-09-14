"""Leased reconciliation. An incomplete provider read never removes cached events."""
import json
import logging
import time
from services.external_calendar_domain import CalendarError, dumps, in_window, merge, window
from services.external_calendar_store import available, assert_lease, claim, connection, row, rows, transaction, uid
from services.external_calendar_oauth import access_token
from services.external_calendar_provider import Provider, ProviderError
from services.external_calendar_sources import load_sources, save_personal

logger = logging.getLogger(__name__)


def conflict(db, item, event_id, local, remote, revision, export_id=None, reason='overlapping_edits', source_url=None):
    db.execute('INSERT INTO external_calendar_conflicts(id,user_id,connection_id,event_id,export_id,local_body,remote_body,remote_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?) '
               'ON CONFLICT(connection_id,event_id) DO UPDATE SET remote_body=excluded.remote_body,remote_revision=excluded.remote_revision',
               (uid(), item['user_id'], item['id'], event_id, export_id, dumps(local), dumps(remote), revision, time.time()))
    db.execute('UPDATE external_calendar_conflicts SET reason=?,source_url=? WHERE connection_id=? AND event_id=?', (reason, source_url, item['id'], event_id))
    if not export_id:
        db.execute("UPDATE external_calendar_events SET status='conflict' WHERE id=?", (event_id,))
        db.execute("UPDATE external_calendar_jobs SET state='conflict' WHERE event_id=? AND state='queued'", (event_id,))


def cache_event(db, item, calendar, raw, decoded):
    previous = row(db, 'SELECT * FROM external_calendar_events WHERE calendar_id=? AND remote_id=?', (calendar['id'], raw['id']))
    body = decoded['body'] if decoded else None
    if previous and previous['status'] in ('queued', 'conflict', 'failed'):
        return
    if not body:
        if previous:
            db.execute('UPDATE external_calendar_events SET deleted=1 WHERE id=?', (previous['id'],))
        return
    db.execute('INSERT INTO external_calendar_events(id,connection_id,calendar_id,user_id,remote_id,revision,body,baseline,editable,source_url,occurrence_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) '
               "ON CONFLICT(calendar_id,remote_id) DO UPDATE SET revision=excluded.revision,body=excluded.body,baseline=excluded.baseline,editable=excluded.editable,source_url=excluded.source_url,occurrence_id=excluded.occurrence_id,deleted=0,status='synchronized'",
               (uid(), item['id'], calendar['id'], item['user_id'], raw['id'], decoded['revision'], dumps(body), dumps(body), decoded['editable'], decoded['source_url'], decoded['occurrence_id']))


def run_jobs(item, client, lease):
    with transaction() as db:
        jobs = rows(db, "SELECT j.*,e.remote_id,e.baseline,e.calendar_id,k.remote_id AS remote_calendar_id,k.writable,k.available,k.selected FROM external_calendar_jobs j JOIN external_calendar_events e ON e.id=j.event_id JOIN external_calendars k ON k.id=e.calendar_id WHERE j.connection_id=? AND j.state='queued' AND j.next_attempt_at<=? ORDER BY j.created_at LIMIT 100", (item['id'], time.time()))
    for job in jobs:
        try:
            run_job(item, client, lease, job)
        except CalendarError as exc:
            from services.external_calendar_failures import defer_job
            with transaction() as db:
                defer_job(db, item, lease, job, exc)


def run_job(item, client, lease, job):
    if not job['writable'] or not job['available'] or not job['selected']:
        raise CalendarError('calendar_permission_denied', 403)
    local = json.loads(job['payload'])
    remote_raw = client.get(job['remote_calendar_id'], job['remote_id']) if job['remote_id'] else None
    decoded = client.decode(remote_raw, True) if remote_raw else None
    remote = decoded['body'] if decoded else None
    if decoded and not decoded['editable']:
        raise CalendarError('event_no_longer_editable', 409)
    base = json.loads(job['baseline']) if job['baseline'] else None
    merged, overlaps = merge(base, local, remote) if job['remote_id'] else (local, [])
    revision = decoded['revision'] if decoded else None
    if overlaps:
        with transaction() as db:
            assert_lease(db, item['id'], lease)
            conflict(db, item, job['event_id'], local, remote, revision)
        return
    raw = remote_raw
    if merged != remote or not job['remote_id']:
        raw = client.write(job['remote_calendar_id'], job['remote_id'] if remote_raw else None, merged, job['id'], revision)
    next_value = client.decode(raw, True) if raw else None
    with transaction() as db:
        assert_lease(db, item['id'], lease)
        db.execute("UPDATE external_calendar_jobs SET state='synchronized',attempts=attempts+1 WHERE id=?", (job['id'],))
        db.execute("UPDATE external_calendar_events SET remote_id=?,revision=?,body=?,baseline=?,deleted=?,status='synchronized',source_url=?,editable=? WHERE id=?",
                   (raw['id'] if raw else job['remote_id'], next_value['revision'] if next_value else None, dumps(merged), dumps(merged), merged is None,
                    next_value['source_url'] if next_value else None, next_value['editable'] if next_value else False, job['event_id']))


def ensure_managed(item, client, lease):
    remote_id = item['managed_calendar_id']
    if remote_id and remote_id.startswith('pending:'):
        raise CalendarError('export_calendar_setup_interrupted', 409)
    if not remote_id:
        with transaction() as db:
            assert_lease(db, item['id'], lease)
            db.execute('UPDATE external_calendar_connections SET managed_calendar_id=? WHERE id=?', ('pending:' + uid(), item['id']))
        # Calendar creation has no cross-provider idempotency key. An interrupted
        # creation is explicitly recoverable by selection, never retried blindly.
        remote_id = client.create_calendar('APStudy connection ' + item['id'])
        with transaction() as db:
            assert_lease(db, item['id'], lease)
            db.execute('UPDATE external_calendar_connections SET managed_calendar_id=? WHERE id=?', (remote_id, item['id']))
        item['managed_calendar_id'] = remote_id
    with transaction() as db:
        db.execute('INSERT INTO external_calendars(id,connection_id,user_id,remote_id,name,writable) VALUES(?,?,?,?,?,1) ON CONFLICT(connection_id,remote_id) DO NOTHING',
                   (uid(), item['id'], item['user_id'], remote_id, 'APStudy'))
        return row(db, 'SELECT * FROM external_calendars WHERE connection_id=? AND remote_id=?', (item['id'], remote_id))


def reconcile_exports(item, client, lease, sources, managed, bounds):
    # Fetching the managed calendar also finds personal events created there.
    raw_events, cursor, full = client.events(managed, bounds)
    by_id = {x['id']: x for x in raw_events}
    with transaction() as db:
        mappings = rows(db, 'SELECT * FROM external_calendar_exports WHERE connection_id=?', (item['id'],))
        conflicted = {x['export_id'] for x in rows(db, 'SELECT export_id FROM external_calendar_conflicts WHERE connection_id=?', (item['id'],))}
    # A Microsoft create can succeed before its returned ID is committed.
    # transactionId lets the complete managed-calendar read recover that mapping.
    for raw in raw_events:
        operation = raw.get('transactionId') or raw.get('extendedProperties', {}).get('private', {}).get('apstudyOperation')
        pending = next((x for x in mappings if (x.get('operation_id') or x['remote_id']) == operation and x['baseline'] is None), None)
        if pending and raw['id'] != pending['remote_id']:
            with transaction() as db:
                assert_lease(db, item['id'], lease)
                db.execute('UPDATE external_calendar_exports SET remote_id=? WHERE id=?', (raw['id'], pending['id']))
            pending['remote_id'] = raw['id']
    mapping_by_source = {x['source_ref']: x for x in mappings}
    known_ids = {x['remote_id'] for x in mappings}
    # Adopt only editable personal events. Guest meetings are never converted.
    for raw in raw_events:
        if raw['id'] in known_ids:
            continue
        decoded = client.decode(raw, True)
        if not decoded or not decoded['editable']:
            continue
        source_ref = 'user:' + uid()
        with transaction() as db:
            assert_lease(db, item['id'], lease)
            save_personal(db, item['user_id'], source_ref, decoded['body'])
            db.execute('INSERT INTO external_calendar_exports(id,connection_id,user_id,source_ref,remote_id,baseline,revision,source_kind) VALUES(?,?,?,?,?,?,?,?)',
                       (uid(), item['id'], item['user_id'], source_ref, raw['id'], dumps(decoded['body']), decoded['revision'], 'personal'))
            mapping_by_source[source_ref] = row(db, 'SELECT * FROM external_calendar_exports WHERE connection_id=? AND source_ref=?', (item['id'], source_ref))
            db.execute('UPDATE external_calendar_exports SET initialized=1 WHERE id=?', (mapping_by_source[source_ref]['id'],))
        known_ids.add(raw['id'])
        sources[source_ref] = ('personal', decoded['body'])
    for source_ref in set(sources) | set(mapping_by_source):
        mapping = mapping_by_source.get(source_ref)
        source = sources.get(source_ref)
        if mapping and (mapping['suppressed'] or mapping['id'] in conflicted):
            continue
        if mapping and mapping['source_kind'] not in json.loads(item['export_sources']):
            continue
        local = source[1] if source else None
        base = json.loads(mapping['baseline']) if mapping and mapping['baseline'] else None
        if not in_window(local or base, bounds):
            continue
        kind = source[0] if source else mapping['source_kind']
        if not mapping:
            mapping = {'id': uid(), 'remote_id': uid(), 'source_kind': kind, 'baseline': None}
            with transaction() as db:
                assert_lease(db, item['id'], lease)
                db.execute('INSERT INTO external_calendar_exports(id,connection_id,user_id,source_ref,remote_id,source_kind) VALUES(?,?,?,?,?,?)',
                           (mapping['id'], item['id'], item['user_id'], source_ref, mapping['remote_id'], kind))
            mapping_by_source[source_ref] = mapping
        from services.external_calendar_exports import send_export
        if mapping.get('pending_body') is not None:
            try:
                send_export(item, client, lease, mapping, managed['remote_id'], None, None, None)
            except CalendarError as exc:
                if exc.code == 'remote_conflict':
                    with transaction() as db:
                        assert_lease(db, item['id'], lease)
                        db.execute('UPDATE external_calendar_exports SET pending_body=NULL,pending_revision=NULL,pending_remote_id=NULL WHERE id=?', (mapping['id'],))
                raise
            continue
        # A full lookup disambiguates a moved/out-of-window event from deletion.
        raw = by_id.get(mapping['remote_id'])
        if raw is None and (mapping.get('initialized') or mapping.get('baseline')):
            raw = client.get(managed['remote_id'], mapping['remote_id'])
        decoded = client.decode(raw, True) if raw else None
        remote = decoded['body'] if decoded else None
        revision = decoded['revision'] if decoded else None
        if kind == 'personal' and base is None and mapping.get('initialized') and local != remote:
            with transaction() as db:
                assert_lease(db, item['id'], lease)
                conflict(db, item, source_ref, local, remote, revision, mapping['id'])
            continue
        if decoded and not decoded['editable']:
            # Someone added guests or a provider-specific event type. Do not send invitations.
            with transaction() as db:
                conflict(db, item, source_ref, local, remote, revision, mapping['id'], 'provider_review_required', decoded['source_url'])
            continue
        if kind != 'personal' and base is not None and remote is None and local is not None:
            with transaction() as db:
                db.execute('UPDATE external_calendar_exports SET suppressed=1 WHERE id=?', (mapping['id'],))
            continue
        desired, overlaps = merge(base, local, remote) if kind == 'personal' and base is not None else (local, [])
        if overlaps:
            with transaction() as db:
                assert_lease(db, item['id'], lease)
                conflict(db, item, source_ref, local, remote, revision, mapping['id'])
            continue
        if kind == 'personal' and desired != local:
            with transaction() as db:
                assert_lease(db, item['id'], lease)
                from services.external_calendar_sources import source_body
                current = row(db, 'SELECT * FROM user_events WHERE id=? AND user_id=?', (source_ref[5:], item['user_id']))
                if (source_body(current) if current else None) != local:
                    conflict(db, item, source_ref, source_body(current) if current else None, remote, revision, mapping['id'])
                    continue
                save_personal(db, item['user_id'], source_ref, desired)
            sources[source_ref] = (kind, desired)
        if desired != remote:
            send_export(item, client, lease, mapping, managed['remote_id'], raw['id'] if decoded else None, desired, revision)
        else:
            with transaction() as db:
                assert_lease(db, item['id'], lease)
                if desired is None:
                    db.execute('DELETE FROM external_calendar_exports WHERE id=?', (mapping['id'],))
                else:
                    db.execute('UPDATE external_calendar_exports SET remote_id=?,baseline=?,revision=?,initialized=1 WHERE id=?',
                               (raw['id'], dumps(desired), revision, mapping['id']))
    with transaction() as db:
        assert_lease(db, item['id'], lease)
        db.execute('UPDATE external_calendars SET cursor=?,window_key=? WHERE id=?', (cursor, ':'.join(bounds), managed['id']))


def run_connection(connection_id, client=None, source_loader=load_sources):
    lease = claim(connection_id)
    if not lease:
        return
    item = None
    try:
        with transaction() as db:
            item = row(db, 'SELECT * FROM external_calendar_connections WHERE id=?', (connection_id,))
        if item and item['status'] == 'disconnecting':
            from services.external_calendar_service import purge
            with transaction() as db:
                assert_lease(db, connection_id, lease)
                purge(db, item)
            return
        if not item or item['status'] not in ('active', 'cleanup') or not available(item['provider'], item['user_id']):
            return
        def heartbeat():
            with transaction() as db:
                status = assert_lease(db, connection_id, lease)
                if status != item['status']:
                    raise CalendarError('connection_not_active', 409)
        client = client or Provider(item['provider'], access_token(item), heartbeat=heartbeat)
        if item['status'] == 'cleanup':
            from services.external_calendar_service import purge
            with transaction() as db:
                exports = rows(db, 'SELECT * FROM external_calendar_exports WHERE connection_id=?', (connection_id,))
            for mapping in exports:
                raw = client.get(item['managed_calendar_id'], mapping['remote_id'])
                decoded = client.decode(raw) if raw else None
                if decoded and not decoded['editable']:
                    raise CalendarError('cleanup_requires_provider_review', 409)
                if raw:
                    client.write(item['managed_calendar_id'], mapping['remote_id'], None, mapping['id'], decoded['revision'] if decoded else None)
                with transaction() as db:
                    assert_lease(db, connection_id, lease)
                    db.execute('DELETE FROM external_calendar_exports WHERE id=?', (mapping['id'],))
            with transaction() as db:
                assert_lease(db, connection_id, lease)
                purge(db, item)
            return
        bounds = window()
        calendar_list = client.calendars()
        remote_calendars = {x['remote_id']: x for x in calendar_list}
        with transaction() as db:
            assert_lease(db, connection_id, lease)
            calendars = rows(db, 'SELECT * FROM external_calendars WHERE connection_id=?', (connection_id,))
            for calendar in calendars:
                remote_calendar = remote_calendars.get(calendar['remote_id'])
                writable = bool(remote_calendar and remote_calendar['writable'])
                db.execute('UPDATE external_calendars SET writable=?,available=? WHERE id=?', (writable, bool(remote_calendar), calendar['id']))
                calendar['writable'] = writable
                if calendar['window_key'] != ':'.join(bounds):
                    calendar['cursor'] = None
        run_jobs(item, client, lease)
        selected_sources = json.loads(item['export_sources'])
        try:
            if selected_sources or item['managed_calendar_id']:
                sources = source_loader(item['user_id'], selected_sources, bounds)
                managed = ensure_managed(item, client, lease)
                if not managed['writable']:
                    raise CalendarError('export_calendar_unavailable', 409)
                if managed['window_key'] != ':'.join(bounds):
                    managed['cursor'] = None
                reconcile_exports(item, client, lease, sources, managed, bounds)
            with transaction() as db:
                assert_lease(db, connection_id, lease)
                db.execute('UPDATE external_calendar_connections SET export_error=NULL WHERE id=?', (connection_id,))
        except CalendarError as exc:
            if exc.code in ('reconnect_required', 'sync_time_budget', 'sync_lease_lost', 'connection_not_active', 'provider_throttled'):
                raise
            with transaction() as db:
                assert_lease(db, connection_id, lease)
                db.execute('UPDATE external_calendar_connections SET export_error=? WHERE id=?', (exc.code, connection_id))
        for calendar in calendars:
            if not calendar['selected'] or calendar['remote_id'] == item['managed_calendar_id']:
                continue
            if calendar['remote_id'] not in remote_calendars:
                continue
            try:
                raw_events, cursor, full = client.events(calendar, bounds)
            except CalendarError as exc:
                if exc.code not in ('calendar_permission_denied', 'remote_not_found'):
                    raise
                with transaction() as db:
                    assert_lease(db, connection_id, lease)
                    db.execute('UPDATE external_calendars SET available=0,writable=0,last_error=? WHERE id=?', (exc.code, calendar['id']))
                continue
            decoded = [(raw, client.decode(raw, calendar['writable'])) for raw in raw_events]
            with transaction() as db:
                assert_lease(db, connection_id, lease)
                for raw, value in decoded:
                    cache_event(db, item, calendar, raw, value)
                if full:
                    seen = {raw['id'] for raw in raw_events}
                    for old in rows(db, 'SELECT * FROM external_calendar_events WHERE calendar_id=?', (calendar['id'],)):
                        if old['remote_id'] not in seen and old['status'] == 'synchronized' and in_window(json.loads(old['body']), bounds):
                            db.execute('UPDATE external_calendar_events SET deleted=1 WHERE id=?', (old['id'],))
                db.execute('UPDATE external_calendars SET cursor=?,window_key=? WHERE id=?', (cursor, ':'.join(bounds), calendar['id']))
        with transaction() as db:
            assert_lease(db, connection_id, lease)
            db.execute('UPDATE external_calendar_connections SET last_sync_at=?,next_sync_at=?,last_error=NULL,failures=0 WHERE id=?', (time.time(), time.time() + 180, connection_id))
    except CalendarError as exc:
        with transaction() as db:
            current = row(db, 'SELECT * FROM external_calendar_connections WHERE id=? AND lease_token=?', (connection_id, lease))
            if current:
                delay = max(getattr(exc, 'retry_after', 0), min(3600, 30 * 2 ** min(current['failures'], 7)))
                status = 'reconnect' if exc.code == 'reconnect_required' else current['status']
                db.execute('UPDATE external_calendar_connections SET last_error=?,failures=failures+1,next_sync_at=?,status=? WHERE id=?', (exc.code, time.time() + delay, status, connection_id))
        logger.warning('Calendar sync %s: %s', connection_id, exc.code)
    except Exception:
        # Never log provider payloads, token-bearing URLs, or event content.
        logger.error('Calendar sync %s failed unexpectedly', connection_id)
        with transaction() as db:
            db.execute("UPDATE external_calendar_connections SET last_error='sync_failed',next_sync_at=? WHERE id=? AND lease_token=?", (time.time() + 180, connection_id, lease))
        return
    finally:
        with transaction() as db:
            current = row(db, 'SELECT * FROM external_calendar_connections WHERE id=? AND lease_token=?', (connection_id, lease))
            if current and current['status'] == 'disconnecting':
                from services.external_calendar_service import purge
                purge(db, current)
            db.execute('UPDATE external_calendar_connections SET lease_until=0,lease_token=NULL WHERE id=? AND lease_token=?', (connection_id, lease))


def tick(app):
    from concurrent.futures import ThreadPoolExecutor
    with app.app_context():
        with transaction() as db:
            due = rows(db, "SELECT id FROM external_calendar_connections WHERE status IN ('active','cleanup','disconnecting') AND next_sync_at<=? AND lease_until<? ORDER BY next_sync_at LIMIT 20", (time.time(), time.time()))
    def sync_one(item):
        with app.app_context():
            try:
                run_connection(item['id'])
            except Exception:
                logger.error('Calendar worker deferred a failed connection')
    with ThreadPoolExecutor(max_workers=4, thread_name_prefix='calendar-sync') as workers:
        list(workers.map(sync_one, due))
