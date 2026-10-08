import json
from datetime import date
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from flask import Flask, g
from flask_login import LoginManager, UserMixin
from services import extension_streaks as streaks
from blueprints.extension_api import extension_api_bp
import blueprints.admin as admin
from extensions import csrf

ACCOUNT = 'a' * 64
ZONE = 'America/New_York'


class ExtensionStreakTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db_path = str(Path(self.directory.name) / 'streak.sqlite3')
        with sqlite3.connect(self.db_path) as conn:
            conn.executescript((Path(__file__).parents[1] / 'migrations/023_extension_streaks.sql').read_text())
        self.app = Flask(__name__)
        self.app.config.update(DATABASE_PATH=self.db_path, SECRET_KEY='test-secret', TESTING=True)
        self.app.register_blueprint(extension_api_bp)
        self.app.register_blueprint(admin.admin_bp)
        self.app.add_url_rule("/dashboard", endpoint="dashboard.dashboard", view_func=lambda: "Dashboard")
        manager = LoginManager(self.app)
        class User(UserMixin):
            def __init__(self, user_id): self.id = user_id
        manager.user_loader(lambda user_id: User(user_id))
        csrf.init_app(self.app)
        ctx = self.app.app_context(); ctx.push(); self.addCleanup(ctx.pop)
        mocked = patch.object(streaks, 'today_for', return_value='2026-09-12')
        mocked.start(); self.addCleanup(mocked.stop)

    def payload(self, revision=0):
        return dict(accountKey=ACCOUNT, timeZone=ZONE, expectedRevision=revision, history=dict(
            since='2026-09-08', lastSettledDate='2026-09-11', todayComplete=True,
            days=[dict(date=f'2026-09-{d:02}', state='missed' if d in [8, 10] else 'none') for d in range(8, 12)]))

    def test_domain_helpers_validate_and_serialize_streak_contract(self):
        self.assertEqual(streaks.validate_streak_account_scope(ACCOUNT, ZONE), (ACCOUNT, ZONE))
        for account, zone in [('short', ZONE), (ACCOUNT, 'Invalid/Zone')]:
            with self.subTest(account=account, zone=zone), self.assertRaises(streaks.StreakError):
                streaks.validate_streak_account_scope(account, zone)
        self.assertEqual(streaks.parse_streak_date('2024-02-29'), date(2024, 2, 29))
        for value in ['2026-02-29', '20260912', None]:
            with self.subTest(value=value), self.assertRaises(streaks.StreakError):
                streaks.parse_streak_date(value)
        history = streaks.empty_streak_history(ACCOUNT, ZONE)
        history['days'] = {'2026-09-11': 'missed', '2026-09-10': 'clear'}
        record = dict(history=history, revision=3, marks={'mark': dict(completed=False, revision=2)})
        payload = streaks.serialize_streak_record(record)
        self.assertEqual(payload['history']['accountKey'], ACCOUNT)
        self.assertEqual(payload['history']['revision'], 3)
        self.assertEqual(payload['history']['days'], [dict(date='2026-09-10', state='clear'), dict(date='2026-09-11', state='missed')])
        self.assertFalse(payload['marks'][0]['completed'])
        self.assertEqual(history['days'], {'2026-09-11': 'missed', '2026-09-10': 'clear'})

    def test_misses_are_sticky_and_corrections_recalculate_and_revoke(self):
        first = streaks.sync('one', self.payload(), 'first')
        self.assertEqual(first['history']['current'], 2)
        p = self.payload(1); p['history']['days'][2]['state'] = 'clear'
        self.assertEqual(streaks.sync('one', p, 'late')['history']['current'], 2)
        preview = streaks.correct('one', 'staff', ACCOUNT, ZONE, ['2026-09-10'], 'Canvas correction', expected_revision=2, preview=True)
        self.assertEqual(preview['history']['current'], 4)
        self.assertEqual(streaks.read('one', ACCOUNT, ZONE)['revision'], 2)
        corrected = streaks.correct('one', 'staff', ACCOUNT, ZONE, ['2026-09-10'], 'Canvas correction', expected_revision=2)
        self.assertEqual(corrected['history']['current'], 4)
        revoked = streaks.correct('one', 'staff', ACCOUNT, ZONE, ['2026-09-10'], 'Wrong date', revoke=True, expected_revision=3)
        self.assertEqual(revoked['history']['current'], 2)
        with sqlite3.connect(self.db_path) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM extension_streak_audit').fetchone()[0], 2)

    def test_revision_idempotency_and_ownership(self):
        p = self.payload()
        streaks.sync('one', p, 'same')
        self.assertEqual(streaks.sync('one', p, 'same')['revision'], 1)
        with self.assertRaises(streaks.StreakError): streaks.sync('one', p, 'stale')
        self.assertEqual(streaks.read('two', ACCOUNT, ZONE)['history']['current'], 0)
        p['history']['todayComplete'] = False
        with self.assertRaises(streaks.StreakError): streaks.sync('one', p, 'same')

    def test_student_cannot_forgive_or_change_baseline(self):
        streaks.sync('one', self.payload(), 'first')
        p = self.payload(1); p['history']['forgiven'] = ['2026-09-10']
        with self.assertRaises(streaks.StreakError): streaks.sync('one', p, 'forge')
        p = self.payload(1); p['history']['since'] = '2026-09-09'
        with self.assertRaises(streaks.StreakError): streaks.sync('one', p, 'baseline')
        with self.assertRaises(streaks.StreakError): streaks.correct('one', 'staff', ACCOUNT, ZONE, ['2026-09-09'], 'not missed', expected_revision=1)

    def test_manual_marks_compare_revisions_and_preserve_false(self):
        p = dict(accountKey=ACCOUNT, timeZone=ZONE, expectedRevision=0, marks=[dict(id=f'canvas:{ACCOUNT}:' + 'b' * 64, completed=True, revision=0)])
        streaks.sync('one', p, 'mark')
        p['expectedRevision'] = 1
        with self.assertRaises(streaks.StreakError): streaks.sync('one', p, 'old-mark')
        p['marks'][0].update(completed=False, revision=1)
        self.assertFalse(streaks.sync('one', p, 'unmark')['marks'][0]['completed'])

    def test_partial_future_and_malformed_observations_rejected(self):
        for mutate in [lambda p: p['history']['days'].pop(), lambda p: p['history'].update(lastSettledDate='2026-09-12'), lambda p: p.update(timeZone='Invalid/Zone')]:
            p = self.payload(); mutate(p)
            with self.assertRaises(streaks.StreakError): streaks.sync('one', p, 'invalid')

    def test_http_auth_csrf_and_read_write(self):
        client = self.app.test_client()
        url = f'/api/extension/streak?accountKey={ACCOUNT}&timeZone={ZONE}'
        self.assertEqual(client.get(url).status_code, 401)
        with client.session_transaction() as session: session['_user_id'] = 'one'
        g.pop('_login_user', None)
        self.assertEqual(client.get(url).status_code, 200)
        self.assertEqual(client.post('/api/extension/streak', json=self.payload()).status_code, 400)
        token = client.get('/api/extension/csrf').headers['X-CSRFToken']
        response = client.post('/api/extension/streak', json=self.payload(), headers={'X-CSRFToken': token, 'Idempotency-Key': 'http'})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        self.assertEqual(response.get_json()['history']['current'], 2)
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        malformed = client.post('/api/extension/streak', json=[], headers={'X-CSRFToken': token, 'Idempotency-Key': 'invalid-http'})
        self.assertEqual(malformed.status_code, 400)
        self.assertIsNotNone(malformed.get_json())

    def test_support_route_requires_staff_and_previews_before_commit(self):
        streaks.sync('one', self.payload(), 'first')
        client = self.app.test_client()
        with client.session_transaction() as session: session['_user_id'] = 'student'
        g.pop('_login_user', None)
        token = client.get('/api/extension/csrf').headers['X-CSRFToken']
        data = dict(csrf_token=token, accountKey=ACCOUNT, timeZone=ZONE, dates=['2026-09-10'], reason='Correct Canvas evidence', revision='1', action='forgive', preview='1')
        with patch.object(admin, '_admin_ids', return_value={'staff'}):
            denied = client.post('/admin/one/streak/corrections', data=data)
            self.assertEqual(denied.status_code, 302)
            self.assertEqual(streaks.read('one', ACCOUNT, ZONE)['revision'], 1)
            with client.session_transaction() as session: session['_user_id'] = 'staff'
            g.pop('_login_user', None)
            with patch.object(admin, 'render_template', return_value='Review'):
                preview = client.post('/admin/one/streak/corrections', data=data)
                self.assertEqual(preview.status_code, 200)
            self.assertEqual(streaks.read('one', ACCOUNT, ZONE)['revision'], 1)
            data.pop('preview')
            with patch.object(admin, '_log_admin_action'):
                result = client.post('/admin/one/streak/corrections', data=data)
                self.assertEqual(result.status_code, 302)
            self.assertEqual(streaks.read('one', ACCOUNT, ZONE)['history']['current'], 4)
            data.pop('csrf_token')
            self.assertEqual(client.post('/admin/one/streak/corrections', data=data).status_code, 400)
