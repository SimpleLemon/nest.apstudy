import json
import os
import tempfile
import time
import unittest
from unittest.mock import patch
from flask import Flask
from cryptography.fernet import Fernet
from services import database
from services.external_calendar_domain import CalendarError, normalize, merge, window
from services.external_calendar_store import seal, unseal, transaction, row, rows, uid
from services.external_calendar_service import configure, disconnect, mutate, project, resolve, status
from services.external_calendar_sync import run_connection
from services.external_calendar_provider import Provider, ProviderError


def event(title='Study', start=None, **changes):
    day = window()[0]
    return normalize({'title': title, 'start': start or day + 'T15:00:00+00:00', 'end': day + 'T16:00:00+00:00', **changes})


class FakeProvider:
    provider = 'google'
    def __init__(self):
        self.data, self.writes = {}, []
        self.fail = False
        self.managed_created = False
    def calendars(self):
        return [{'remote_id': 'primary', 'name': 'Personal', 'writable': True, 'is_primary': True}] + ([{'remote_id':'managed','name':'APStudy','writable':True,'is_primary':False}] if self.managed_created else [])
    def create_calendar(self, marker):
        self.managed_created = True
        return 'managed'
    def events(self, calendar, bounds):
        if self.fail:
            raise ProviderError(503)
        return [v for (c, _), v in self.data.items() if c == calendar['remote_id']], 'cursor', True
    def get(self, calendar, event_id):
        return self.data.get((calendar, event_id))
    def decode(self, raw, writable=True):
        return None if raw is None else {'body': raw['body'], 'revision': raw['revision'], 'editable': writable,
                                         'source_url': 'https://calendar.google.com/calendar/event', 'occurrence_id': None}
    def write(self, calendar, event_id, body, operation_id, revision=None):
        self.writes.append((calendar, event_id, body))
        if body is None:
            self.data.pop((calendar, event_id), None)
            return None
        event_id = event_id or operation_id
        raw = {'id': event_id, 'body': body, 'revision': uid()}
        self.data[(calendar, event_id)] = raw
        return raw


class CalendarSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        path = os.path.join(self.tmp.name, 'calendar.sqlite3')
        self.env = patch.dict(os.environ, {'DATABASE_PATH': path}); self.env.start(); self.addCleanup(self.env.stop)
        self.app = Flask(__name__)
        self.app.config.update(DATABASE_PATH=path, CALENDAR_SYNC_ENABLED='1', CALENDAR_GOOGLE_CLIENT_ID='test',
                               CALENDAR_GOOGLE_CLIENT_SECRET='secret', CALENDAR_TOKEN_KEYS=json.dumps({'v1': Fernet.generate_key().decode()}))
        self.context = self.app.app_context(); self.context.push(); self.addCleanup(self.context.pop)
        database.init_db(path=path)
        self.client = FakeProvider()
        with transaction() as db:
            db.execute("INSERT INTO external_calendar_connections(id,user_id,provider,subject,credentials,status,consent_version,created_at) VALUES('c1','u1','google','subject',?,'active',1,?)", (seal({'access_token': 'secret', 'refresh_token': 'refresh', 'expires_at': time.time()+3600}), time.time()))
            db.execute("INSERT INTO external_calendars(id,connection_id,user_id,remote_id,name,writable,selected,is_primary) VALUES('k1','c1','u1','primary','Personal',1,1,1)")
    def sync(self, sources=None):
        run_connection('c1', self.client, lambda *_: sources or {})
    def cached(self):
        with transaction() as db:
            return rows(db, 'SELECT * FROM external_calendar_events')
    def test_encryption_and_wrong_key(self):
        encrypted = seal({'access_token': 'never-plaintext'})
        self.assertNotIn('never-plaintext', encrypted)
        self.assertEqual(unseal(encrypted)['access_token'], 'never-plaintext')
        self.app.config['CALENDAR_TOKEN_KEYS'] = json.dumps({'v2': Fernet.generate_key().decode()})
        with self.assertRaises(CalendarError): unseal(encrypted)
    def test_projection_is_user_scoped(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync()
        self.assertEqual(len(project('u1')[0]), 1)
        self.assertEqual(project('u2')[0], [])
        self.assertNotIn('credentials', json.dumps(status('u1')))
    def test_disabled_provider_is_not_exposed(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync()
        self.app.config['CALENDAR_SYNC_ENABLED'] = '0'
        self.assertEqual(project('u1')[0], [])
    def test_incomplete_read_preserves_cached_events(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync()
        self.client.fail = True; self.client.data.clear(); self.sync()
        self.assertEqual(self.cached()[0]['deleted'], 0)
    def test_complete_read_marks_missing_event_deleted(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync()
        self.client.data.clear(); self.sync()
        self.assertEqual(self.cached()[0]['deleted'], 1)
    def test_update_idempotency_and_cross_user_rejection(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync()
        cached = self.cached()[0]
        payload = {'title': 'Changed', 'revision': cached['revision'], 'idempotency_key': 'unique-change'}
        response = mutate('u1', cached['id'], 'update', payload)
        self.assertEqual(mutate('u1', cached['id'], 'update', payload), {'state': 'queued', 'operation_id': response['operation_id']})
        with self.assertRaises(CalendarError): mutate('u2', cached['id'], 'update', payload)
        with self.assertRaises(CalendarError): mutate('u1', cached['id'], 'update', {**payload, 'title': 'Other'})
        self.sync(); self.assertEqual(self.client.data[('primary', 'e1')]['body']['title'], 'Changed')
    def test_create_then_retry_does_not_duplicate(self):
        payload = event() | {'calendar_id': 'external:k1', 'idempotency_key': 'create-key'}
        mutate('u1', None, 'create', payload); mutate('u1', None, 'create', payload)
        self.sync(); self.sync()
        self.assertEqual(len(self.client.data), 1)
    def test_conflict_resolution(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync()
        cached = self.cached()[0]
        mutate('u1', cached['id'], 'update', {'title': 'Local', 'revision': cached['revision'], 'idempotency_key': 'conflict-key'})
        self.client.write('primary', 'e1', event('Remote'), 'op'); self.sync()
        self.assertEqual(self.cached()[0]['status'], 'conflict')
        with transaction() as db: conflict_id = row(db, 'SELECT id FROM external_calendar_conflicts')['id']
        resolve('u1', conflict_id, 'local'); self.sync()
        self.assertEqual(self.client.data[('primary', 'e1')]['body']['title'], 'Local')
    def test_nonoverlapping_edits_merge(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync(); cached = self.cached()[0]
        mutate('u1', cached['id'], 'update', {'title': 'Local', 'revision': cached['revision'], 'idempotency_key': 'disjoint-key'})
        self.client.write('primary', 'e1', event(description='Remote notes'), 'op'); self.sync()
        body = self.client.data[('primary', 'e1')]['body']
        self.assertEqual((body['title'], body['description']), ('Local', 'Remote notes'))
    def test_time_fields_conflict_together(self):
        base = event(); local = base | {'start': window()[0] + 'T14:00:00+00:00'}; remote = base | {'end': window()[0] + 'T17:00:00+00:00'}
        self.assertEqual(merge(base, local, remote)[1], ['time'])
    def test_delete_versus_edit_is_conflict(self):
        self.assertEqual(merge(event(), None, event('Changed'))[1], ['deleted'])
    def test_all_day_dates_and_exclusive_end(self):
        value = normalize({'title':'Holiday','start':'2026-11-01','end':'2026-11-02','all_day':True,'timezone':'America/New_York'})
        self.assertEqual(value['end'], '2026-11-02')
        with self.assertRaises(CalendarError): normalize(value | {'end': value['start']})
    def test_disconnect_purges_content_and_keeps_exports(self):
        self.client.write('primary', 'e1', event(), 'op'); self.sync(); disconnect('u1', 'c1')
        self.assertEqual(self.cached(), [])
        self.assertEqual(len(self.client.data), 1)
        with transaction() as db: self.assertIsNone(row(db, 'SELECT credentials FROM external_calendar_connections')['credentials'])
    def test_foreign_calendar_selection_rejected(self):
        with self.assertRaises(CalendarError): configure('u1', 'c1', {'consent_version':1,'calendar_ids':['foreign'],'export_sources':[]})
    def test_export_is_stable_and_source_deletion_suppressed(self):
        configure('u1', 'c1', {'consent_version':1,'calendar_ids':['k1'],'export_sources':['canvas']})
        sources = {'canvas:assignment': ('canvas', event())}
        self.sync(sources); self.sync(sources)
        self.assertEqual(len(self.client.data), 1)
        self.client.data.clear(); self.sync(sources)
        with transaction() as db: self.assertEqual(row(db, 'SELECT suppressed FROM external_calendar_exports')['suppressed'], 1)
    def test_canvas_exports_restore_remote_edits(self):
        configure('u1', 'c1', {'consent_version':1,'calendar_ids':['k1'],'export_sources':['canvas']})
        sources = {'canvas:assignment': ('canvas', event())}; self.sync(sources)
        key = next(iter(self.client.data)); self.client.write(*key, event('Changed remotely'), 'op'); self.sync(sources)
        self.assertEqual(self.client.data[key]['body']['title'], 'Study')
    def test_cleanup_deletes_only_managed_exports(self):
        configure('u1', 'c1', {'consent_version':1,'calendar_ids':['k1'],'export_sources':['canvas']})
        self.client.write('primary', 'personal', event('Private'), 'op')
        self.sync({'canvas:assignment': ('canvas', event())}); disconnect('u1','c1',True); self.sync()
        self.assertEqual(list(self.client.data), [('primary','personal')])


class ProviderBoundaryTests(unittest.TestCase):
    def test_cursor_origin_is_restricted(self):
        provider = Provider('microsoft','secret')
        with self.assertRaises(CalendarError): provider.request('GET','https://attacker.test/steal')
    def test_google_recurring_occurrence_and_guest_permissions(self):
        provider = Provider('google','secret')
        raw = {'id':'e','summary':'Work','start':{'dateTime':'2026-11-01T09:00:00-05:00','timeZone':'America/New_York'},'end':{'dateTime':'2026-11-01T10:00:00-05:00'},'recurringEventId':'series','etag':'1'}
        self.assertTrue(provider.decode(raw)['editable'])
        self.assertFalse(provider.decode(raw | {'attendees':[{'email':'guest@example.test'}]})['editable'])
        self.assertEqual(provider.decode(raw)['body']['start'], '2026-11-01T14:00:00+00:00')
    def test_microsoft_windows_time_zone(self):
        provider=Provider('microsoft','secret')
        raw={'id':'e','subject':'Study','start':{'dateTime':'2026-11-01T09:00:00','timeZone':'Eastern Standard Time'},'end':{'dateTime':'2026-11-01T10:00:00','timeZone':'Eastern Standard Time'},'originalStartTimeZone':'Eastern Standard Time','@odata.etag':'1'}
        self.assertEqual(provider.decode(raw)['body']['start'],'2026-11-01T14:00:00+00:00')

class ProviderPagingTests(unittest.TestCase):
    def test_google_commits_only_final_cursor_and_restarts_expired_cursor(self):
        provider = Provider('google', 'secret')
        calendar = {'remote_id': 'primary', 'is_primary': True, 'cursor': 'expired'}
        with patch.object(provider, 'request', side_effect=[ProviderError(410), {'items':[{'id':'a'}], 'nextPageToken':'p2'}, {'items':[{'id':'b'}], 'nextSyncToken':'complete'}]) as request:
            values, cursor, full = provider.events(calendar, window())
        self.assertEqual(([v['id'] for v in values],cursor,full), (['a','b'],'complete',True))
        self.assertEqual(request.call_args_list[-1].kwargs['params']['pageToken'],'p2')
        self.assertNotIn('syncToken',request.call_args_list[-1].kwargs['params'])
    def test_failed_page_does_not_return_a_checkpoint(self):
        provider = Provider('google','secret')
        with patch.object(provider,'request',side_effect=[{'items':[{'id':'a'}],'nextPageToken':'p2'},ProviderError(429,120)]):
            with self.assertRaises(ProviderError): provider.events({'remote_id':'primary','cursor':None},window())
    def test_graph_secondary_never_uses_delta(self):
        provider=Provider('microsoft','secret')
        with patch.object(provider,'request',return_value={'value':[]}) as request:
            _,cursor,full=provider.events({'remote_id':'secondary','is_primary':False,'cursor':None},window())
        self.assertEqual(request.call_args.args[1],'/me/calendars/secondary/calendarView')
        self.assertIsNone(cursor); self.assertTrue(full)
    def test_graph_patch_preserves_unchanged_html_and_reminders(self):
        provider=Provider('microsoft','secret')
        raw={'id':'e','subject':'Study','body':{'contentType':'html','content':'<b>Notes</b>'},'start':{'dateTime':'2026-09-14T12:00:00','timeZone':'UTC'},'end':{'dateTime':'2026-09-14T13:00:00','timeZone':'UTC'},'@odata.etag':'r1'}
        body=provider.decode(raw)['body'] | {'title':'Changed'}
        with patch.object(provider,'request',side_effect=[raw,raw | {'subject':'Changed'}]) as request:
            provider.write('primary','e',body,'operation','r1')
        self.assertEqual(request.call_args.kwargs['body'],{'subject':'Changed'})
        self.assertEqual(request.call_args.kwargs['revision'],'r1')
    def test_changed_meeting_cannot_be_patched(self):
        provider=Provider('google','secret')
        raw={'id':'e','summary':'Meeting','attendees':[{'email':'guest@example.test'}],'start':{'dateTime':'2026-09-14T12:00:00Z'},'end':{'dateTime':'2026-09-14T13:00:00Z'},'etag':'r1'}
        with patch.object(provider,'request',return_value=raw) as request:
            with self.assertRaises(CalendarError): provider.write('primary','e',event(),'op','r1')
        self.assertEqual(request.call_count,1)

class CalendarRecoveryTests(unittest.TestCase):
    setUp = CalendarSyncTests.setUp
    sync = CalendarSyncTests.sync
    def test_adoption_does_not_create_a_second_export(self):
        configure('u1','c1',{'consent_version':1,'calendar_ids':['k1'],'export_sources':['personal']})
        self.client.write('managed','external-new',event(),'op'); self.client.writes.clear()
        self.sync()
        self.assertEqual(self.client.writes,[])
        with transaction() as db:
            self.assertEqual(len(rows(db,'SELECT * FROM user_events')),1)
            self.assertEqual(len(rows(db,'SELECT * FROM external_calendar_exports')),1)
    def test_disconnect_fences_running_worker_and_recovers_after_crash(self):
        with transaction() as db: db.execute("UPDATE external_calendar_connections SET lease_until=?,lease_token='worker' WHERE id='c1'",(time.time()+60,))
        disconnect('u1','c1')
        with transaction() as db:
            self.assertEqual(row(db,"SELECT status FROM external_calendar_connections WHERE id='c1'")['status'],'disconnecting')
            db.execute("UPDATE external_calendar_connections SET lease_until=0 WHERE id='c1'")
        self.sync()
        with transaction() as db: self.assertIsNone(row(db,"SELECT credentials FROM external_calendar_connections WHERE id='c1'")['credentials'])

class MicrosoftExportIdentityTests(CalendarRecoveryTests):
    def test_new_export_never_looks_up_an_operation_id_as_a_graph_id(self):
        configure('u1','c1',{'consent_version':1,'calendar_ids':['k1'],'export_sources':['canvas']})
        original_get=self.client.get
        def get(calendar,event_id):
            if (calendar,event_id) not in self.client.data:
                raise ProviderError(400)
            return original_get(calendar,event_id)
        self.client.get=get
        self.sync({'canvas:test':('canvas',event())})
        self.assertEqual(len(self.client.data),1)
