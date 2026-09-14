import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
from cryptography.fernet import Fernet
import app as app_module
from extensions import login_manager
from services.external_calendar_domain import CalendarError
from services.external_calendar_oauth import begin, complete
from services.external_calendar_store import transaction, row


class CalendarProviderRoutes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        env = patch.dict(os.environ, {'DATABASE_PATH': os.path.join(self.tmp.name,'test.sqlite3'), 'FLASK_SECRET_KEY':'test-only',
                                      'FLASK_ENV':'testing','APSTUDY_ALLOW_INSECURE_HTTP':'1','SCHEDULER_ENABLED':'0'})
        env.start(); self.addCleanup(env.stop)
        with patch('services.discord_audit.init_discord_audit'), patch('services.scheduler.init_scheduler'):
            self.app = app_module.create_app()
        self.app.config.update(TESTING=True, CALENDAR_SYNC_ENABLED='1', CALENDAR_GOOGLE_CLIENT_ID='client',
                               CALENDAR_GOOGLE_CLIENT_SECRET='secret', CALENDAR_TOKEN_KEYS=json.dumps({'v1':Fernet.generate_key().decode()}))
        old = login_manager._user_callback; self.addCleanup(setattr,login_manager,'_user_callback',old)
        login_manager._user_callback=lambda value: SimpleNamespace(id=value,is_authenticated=True,name='Test')
        self.client=self.app.test_client()
        with self.client.session_transaction() as session: session['_user_id']='u1';session['_fresh']=True
    def csrf(self):
        return {'X-CSRFToken':self.client.get('/api/extension/csrf').headers['X-CSRFToken']}
    def test_routes_require_authentication_and_csrf(self):
        self.assertEqual(self.app.test_client().get('/api/calendar/connections').status_code,401)
        result=self.client.post('/api/calendar/connections/connect/google',json={})
        self.assertEqual(result.status_code,400)
        result=self.client.post('/api/calendar/connections/connect/google',json={},headers=self.csrf())
        self.assertEqual(result.status_code,200)
        self.assertEqual(urlsplit(result.json['authorization_url']).hostname,'accounts.google.com')
        self.assertEqual(result.headers['Cache-Control'],'no-store')
    def test_provider_capabilities_do_not_enable_canvas_writeback(self):
        body=self.client.get('/api/extension/identity').json
        self.assertTrue(body['capabilities']['provider_calendar_write'])
        self.assertFalse(body['capabilities']['calendar_two_way_writeback'])
    def test_calendar_connections_template(self):
        response=self.client.get('/calendar/connections')
        self.assertEqual(response.status_code,200)
        self.assertIn(b'data-calendar-connections-native',response.data)
    def test_extension_metadata_contains_no_oauth_secret(self):
        response=self.client.get('/api/extension/calendar/connections')
        self.assertEqual(response.status_code,200)
        self.assertNotIn('secret',response.get_data(as_text=True))
        self.assertNotIn('client_id',response.get_data(as_text=True))
    def test_cross_user_state_rejected_without_consuming_owner_state(self):
        with self.app.app_context():
            state=parse_qs(urlsplit(begin('u1','google')).query)['state'][0]
            with self.assertRaises(CalendarError): complete('u2','google',state,'code')
            with transaction() as db: self.assertIsNotNone(row(db,'SELECT * FROM external_calendar_oauth'))
    def test_state_consumed_before_exchange_and_cannot_replay(self):
        with self.app.app_context():
            state=parse_qs(urlsplit(begin('u1','google')).query)['state'][0]
            with patch('services.external_calendar_oauth.token_request',side_effect=CalendarError('provider_unavailable')) as exchange:
                with self.assertRaises(CalendarError): complete('u1','google',state,'code')
                with self.assertRaises(CalendarError): complete('u1','google',state,'code')
                self.assertEqual(exchange.call_count,1)
    def test_failed_callback_exposes_only_safe_error(self):
        response=self.client.get('/oauth/calendar/google/callback?state=secret-state&code=secret-code')
        self.assertEqual(response.status_code,303)
        self.assertNotIn('secret',response.location)
        self.assertEqual(response.headers['Referrer-Policy'],'no-referrer')
    def test_unknown_provider_and_bad_range(self):
        response=self.client.post('/api/calendar/connections/connect/unknown',json={},headers=self.csrf())
        self.assertEqual(response.status_code,503)
        self.assertEqual(self.client.get('/api/extension/calendar/planner-events?start=invalid&end=bad').status_code,400)

    def test_microsoft_connection_disabled_even_with_credentials(self):
        self.app.config.update(CALENDAR_MICROSOFT_CLIENT_ID='client', CALENDAR_MICROSOFT_CLIENT_SECRET='secret')
        response = self.client.post('/api/calendar/connections/connect/microsoft', json={}, headers=self.csrf())
        self.assertEqual(response.status_code, 503)
        self.assertFalse(self.client.get('/api/calendar/connections').json['capabilities']['providers']['microsoft'])

    def test_logged_out_callback_never_forwards_code_to_login(self):
        response = self.app.test_client().get('/oauth/calendar/google/callback?code=private-code&state=private-state')
        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.location, '/calendar/connections?error=calendar_login_required')
