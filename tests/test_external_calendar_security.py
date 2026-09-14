"""Calendar-specific OAuth and private projection boundaries."""
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from tests.test_external_calendar_sync import CalendarSyncTests, event
from services.external_calendar_domain import CalendarError
from services.external_calendar_store import available, row, rows, transaction, seal, unseal
from services.external_calendar_service import disconnect, project
from services import external_calendar_oauth as oauth


class CalendarSecurityTests(unittest.TestCase):
    setUp = CalendarSyncTests.setUp
    sync = CalendarSyncTests.sync

    def consent(self, subject, tenant='', provider='google', reconnect=None, scope=None):
        self.app.config.update(CALENDAR_MICROSOFT_ENABLED='1', CALENDAR_MICROSOFT_CLIENT_ID='client', CALENDAR_MICROSOFT_CLIENT_SECRET='secret')
        state = parse_qs(urlsplit(oauth.begin('u1', provider, reconnect)).query)['state'][0]
        token = {'access_token':'access-secret','refresh_token':'refresh-secret','expires_at':time.time()+3600,'scope':scope if scope is not None else oauth.SCOPES[provider]}
        with patch.object(oauth, 'identity', return_value=(subject,tenant,'same@example.test')), patch.object(oauth,'token_request',return_value=token):
            return oauth.complete('u1',provider,state,'authorization-code')

    def test_same_email_does_not_collapse_subject_or_tenant(self):
        ids = {self.consent('a'),self.consent('b'),self.consent('a','tenant-a','microsoft'),self.consent('a','tenant-b','microsoft')}
        self.assertEqual(len(ids),4)
        with transaction() as db:
            self.assertEqual(len(rows(db,"SELECT * FROM external_calendar_connections WHERE label='same@example.test'")),4)

    def test_reconnect_account_switch_preserves_original(self):
        original = self.consent('a')
        with self.assertRaisesRegex(CalendarError,'reconnect_account_mismatch'):
            self.consent('different',reconnect=original)
        with transaction() as db:
            self.assertEqual(row(db,'SELECT subject FROM external_calendar_connections WHERE id=?',(original,))['subject'],'a')
            self.assertIsNone(row(db,"SELECT id FROM external_calendar_connections WHERE subject='different'"))

    def test_partial_consent_does_not_store_connection(self):
        with self.assertRaisesRegex(CalendarError,'calendar_consent_incomplete'):
            self.consent('partial',scope='openid email')
        with transaction() as db: self.assertIsNone(row(db,"SELECT id FROM external_calendar_connections WHERE subject='partial'"))

    def test_refresh_rotation_and_disconnect_race(self):
        with transaction() as db:
            db.execute("UPDATE external_calendar_connections SET credentials=? WHERE id='c1'",(seal({'access_token':'old','refresh_token':'old-refresh','expires_at':0}),))
            record = row(db,"SELECT * FROM external_calendar_connections WHERE id='c1'")
        with patch.object(oauth,'token_request',return_value={'access_token':'new','refresh_token':'new-refresh','expires_at':time.time()+3600}):
            self.assertEqual(oauth.access_token(record),'new')
        with transaction() as db:
            record = row(db,"SELECT * FROM external_calendar_connections WHERE id='c1'")
            self.assertEqual(unseal(record['credentials'])['refresh_token'],'new-refresh')
        record['credentials']=seal({'access_token':'old','refresh_token':'old','expires_at':0})
        disconnect('u1','c1')
        with patch.object(oauth,'token_request',return_value={'access_token':'late','expires_at':time.time()+3600}):
            with self.assertRaisesRegex(CalendarError,'connection_changed'): oauth.access_token(record)
        with transaction() as db: self.assertIsNone(row(db,"SELECT credentials FROM external_calendar_connections WHERE id='c1'")['credentials'])

    def test_revoked_refresh_is_reconnect_not_retryable_unavailable(self):
        response = SimpleNamespace(status_code=400)
        with patch.object(oauth.requests,'post',return_value=response):
            with self.assertRaisesRegex(CalendarError,'reconnect_required'): oauth.token_request('google',{})

    def test_rollout_allowlist_applies_to_worker_and_projection(self):
        self.client.write('primary','one',event(),'operation'); self.sync()
        self.app.config['CALENDAR_SYNC_USER_ALLOWLIST']='test-owner'
        self.assertFalse(available('google','u1')); self.assertTrue(available('google','test-owner'))
        self.assertEqual(project('u1')[0],[])
        self.client.write('primary','two',event(),'operation'); self.sync()
        with transaction() as db: self.assertEqual(len(rows(db,'SELECT id FROM external_calendar_events')),1)
        self.app.config['CALENDAR_SYNC_USER_ALLOWLIST']='*'
        self.assertTrue(available('google','u1'))

    def test_signed_oidc_claims_reject_wrong_audience_nonce_expiry_and_signature(self):
        key = rsa.generate_private_key(public_exponent=65537,key_size=2048)
        other = rsa.generate_private_key(public_exponent=65537,key_size=2048)
        claims = {'sub':'subject','aud':'test','iss':'https://accounts.google.com','exp':time.time()+60,'iat':time.time(),'nonce':'expected'}
        with patch.object(oauth.jwt,'PyJWKClient') as jwks:
            jwks.return_value.get_signing_key_from_jwt.return_value.key=key.public_key()
            token={'id_token':jwt.encode(claims,key,algorithm='RS256')}
            self.assertEqual(oauth.identity('google',token,'expected')[0],'subject')
            for altered, signing_key in [(claims|{'aud':'different'},key),(claims|{'exp':0},key),(claims|{'nonce':'wrong'},key),(claims,other)]:
                with self.assertRaisesRegex(CalendarError,'invalid_provider_identity'):
                    oauth.identity('google',{'id_token':jwt.encode(altered,signing_key,algorithm='RS256')},'expected')

    def test_account_removal_purges_provider_records(self):
        from services.calendar_store import delete_calendar_rows_by_user
        self.client.write('primary','private',event('Private external event'),'op'); self.sync()
        oauth.begin('u1','google')
        delete_calendar_rows_by_user('u1')
        with transaction() as db:
            for table in ('external_calendar_connections','external_calendars','external_calendar_events','external_calendar_oauth'):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],0)

    def test_public_shares_do_not_invoke_external_projector(self):
        from blueprints import calendar_api as api
        from datetime import datetime, timezone
        self.client.write('primary','private',event('PRIVATE_PROVIDER_CONTENT'),'op'); self.sync()
        share={'id':'share','user_id':'u1','include_all_calendars':True,'calendar_ids_json':'[]','date_scope':'all'}
        with self.app.test_request_context('/api/calendar/share/public/events'), patch.object(api,'first_row',return_value={}), patch.object(api,'list_calendar_rows_all',return_value=[]), patch('services.external_calendar_service.project',side_effect=AssertionError('provider cache in public share')):
            payload=api._public_calendar_events_payload(share,datetime(2026,1,1,tzinfo=timezone.utc),datetime(2027,1,1,tzinfo=timezone.utc))
        self.assertNotIn('PRIVATE_PROVIDER_CONTENT',json.dumps(payload))
        self.assertEqual(payload['events'],[])
