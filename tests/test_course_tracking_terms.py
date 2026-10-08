import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from services import course_tracking_terms as terms
from services.database import db_connection


class TermPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Flask(__name__)
        self.app.config['DATABASE_PATH'] = str(Path(self.tmp.name) / 'test.sqlite3')
        self.context = self.app.app_context()
        self.context.push()
        self.addCleanup(self.context.pop)
        with db_connection() as conn:
            conn.execute('CREATE TABLE chat_bridge_config (id TEXT PRIMARY KEY, config_key TEXT UNIQUE, config_value TEXT, created_at TEXT, updated_at TEXT)')
            conn.execute('CREATE TABLE course_seat_tracks (id TEXT PRIMARY KEY, term TEXT, enabled INTEGER)')
            conn.executescript(Path('migrations/027_course_tracking_terms.sql').read_text())
        self.catalog = patch.object(terms, '_catalog_terms', return_value={'Fall_2026', 'Spring_2026', 'Spring_2027', 'Fall_2027'})
        self.catalog.start()
        self.addCleanup(self.catalog.stop)

    def save(self, term='Spring_2027', state='upcoming', **extra):
        return terms.save_term_policy(term, {'state': state, 'expected_revision': terms.term_policy(term)['revision'], **extra}, 'admin-1')[0]

    def test_fall_closed_and_new_terms_queue_without_polling(self):
        self.assertFalse(terms.term_policy('Fall_2026')['can_enable'])
        spring = terms.term_policy('Spring_2027')
        self.assertTrue(spring['can_enable'])
        self.assertFalse(spring['polling_enabled'])
        self.assertEqual(terms.track_policy_fields({'term': 'Spring_2027', 'enabled': True})['tracking_state'], 'queued')

    def test_disabled_track_is_off_for_every_term_state(self):
        for state in ('upcoming', 'open', 'closed', 'unavailable'):
            with self.subTest(state=state):
                fields = terms.track_policy_fields(
                    {'term': 'Spring_2027', 'enabled': False},
                    {'effective_state': state, 'polling_enabled': state == 'open'},
                )
                self.assertEqual(fields['tracking_state'], 'off')
                self.assertFalse(fields['effective_enabled'])

    def test_boundaries_are_utc_and_closing_takes_precedence(self):
        policy = self.save(opens_at='2027-01-01T09:00:00-05:00', closes_at='2027-01-10T09:00:00-05:00')
        for value, state in [('2027-01-01T13:59:59+00:00', 'upcoming'), ('2027-01-01T14:00:00+00:00', 'open'), ('2027-01-10T14:00:00+00:00', 'closed')]:
            actual = terms.evaluate_policy('Spring_2027', policy, datetime.fromisoformat(value))
            self.assertEqual(actual['effective_state'], state)
        self.assertEqual(terms.term_policy('Spring_2027', now=datetime(2028, 1, 1, tzinfo=timezone.utc))['effective_state'], 'closed')

    def test_independent_years_and_paused_preferences_survive_reopen(self):
        with db_connection() as conn:
            conn.execute("INSERT INTO course_seat_tracks VALUES ('enabled', 'Spring_2027', 1)")
            conn.execute("INSERT INTO course_seat_tracks VALUES ('paused', 'Spring_2027', 0)")
        self.save(state='closed')
        self.assertFalse(terms.term_is_polling('Spring_2027'))
        self.save(state='open')
        self.assertTrue(terms.term_is_polling('Spring_2027'))
        self.assertFalse(terms.term_is_polling('Fall_2026'))
        self.assertFalse(terms.term_is_polling('Spring_2026'))
        with db_connection() as conn:
            self.assertEqual(dict(conn.execute('SELECT id, enabled FROM course_seat_tracks').fetchall()), {'enabled': 1, 'paused': 0})

    def test_stale_revision_cannot_overwrite_another_admin(self):
        self.save(state='open')
        with self.assertRaises(terms.TermPolicyConflict):
            terms.save_term_policy('Spring_2027', {'state': 'closed', 'expected_revision': 0}, 'admin-2')
        self.assertTrue(terms.term_is_polling('Spring_2027'))

    def test_invalid_schedule_and_states_rejected(self):
        invalid = [
            {'state': True}, {'state': []}, {'expected_revision': True},
            {'opens_at': '2027-01-01T09:00'},
            {'opens_at': '2027-01-02T00:00Z', 'closes_at': '2027-01-01T00:00Z'},
            {'state': 'closed', 'opens_at': '2027-01-01T00:00Z'},
            {'closes_at': '2027-01-01T00:00Z'},
        ]
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(terms.TermPolicyError):
                terms.save_term_policy('Spring_2027', {'state': 'upcoming', 'expected_revision': 0, **payload}, 'admin')
        with self.assertRaises(terms.TermPolicyError):
            self.save(term='Summer_2027')

    def test_database_guard_blocks_closed_inserts_and_resumes_but_allows_pausing(self):
        with db_connection() as conn:
            conn.execute("INSERT INTO course_seat_tracks VALUES ('fall', 'Fall_2026', 0)")
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("UPDATE course_seat_tracks SET enabled=1 WHERE id='fall'")
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO course_seat_tracks VALUES ('new-fall', 'Fall_2026', 1)")
            conn.execute("UPDATE course_seat_tracks SET enabled=0 WHERE id='fall'")
        self.save(opens_at='2020-01-01T00:00Z', closes_at='2020-02-01T00:00Z')
        with db_connection() as conn, self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO course_seat_tracks VALUES ('ended-spring', 'Spring_2027', 1)")

    def test_unavailable_and_corrupt_policy_fail_closed(self):
        self.save()
        with db_connection() as conn:
            conn.execute('UPDATE chat_bridge_config SET config_value=? WHERE config_key=?', ('{bad', terms.PREFIX + 'Spring_2027'))
        with self.assertLogs(terms.logger, level='ERROR'):
            policy = terms.term_policy('Spring_2027')
        self.assertFalse(policy['can_enable'])
        self.assertFalse(policy['polling_enabled'])

    def test_inventory_counts_queued_and_paused_separately(self):
        with db_connection() as conn:
            conn.execute("INSERT INTO course_seat_tracks VALUES ('queue', 'Spring_2027', 1)")
            conn.execute("INSERT INTO course_seat_tracks VALUES ('pause', 'Spring_2027', 0)")
        spring = next(row for row in terms.term_inventory() if row['term'] == 'Spring_2027')
        self.assertEqual((spring['active_count'], spring['waiting_count'], spring['paused_count']), (0, 1, 1))

    def test_replaying_migration_does_not_replace_admin_settings(self):
        self.save('Spring_2026', 'closed')
        with db_connection() as conn:
            conn.executescript(Path('migrations/027_course_tracking_terms.sql').read_text())
        self.assertEqual(terms.term_policy('Spring_2026')['state'], 'closed')

    def test_future_year_can_be_scheduled_before_data_without_polling(self):
        self.save('Spring_2028', opens_at='2028-01-01T12:00Z', closes_at='2028-02-01T12:00Z')
        at_open = datetime(2028, 1, 2, tzinfo=timezone.utc)
        policy = terms.term_policy('Spring_2028', now=at_open)
        self.assertEqual(policy['effective_state'], 'open')
        self.assertFalse(policy['polling_enabled'])
        with patch.object(terms, '_catalog_terms', return_value={'Spring_2028'}):
            self.assertTrue(terms.term_policy('Spring_2028', now=at_open)['polling_enabled'])


if __name__ == '__main__':
    unittest.main()
