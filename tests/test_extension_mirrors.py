import importlib.util
import sqlite3
from tests.test_calendar_phase2_store import CalendarPhase2StoreTests, ACCOUNT_1
from services.calendar_store import calendar_connection
from services.extension_contract import ExtensionContractError

from services import extension_mirrors as mirrors

class ExtensionMirrorTests(CalendarPhase2StoreTests):
    def view(self):
        return mirrors.inspect_item('user-1', 'user:one')

    def act(self, action, view=None, **overrides):
        view = view or self.view()
        return mirrors.change_item('user-1', {'event_ref': 'user:one', 'source_ref': view['sources'][0]['source_ref'],
            'action': action, 'expected_revision': view['expected_revision'], **overrides})

    def link(self):
        with calendar_connection() as connection:
            connection.execute("INSERT INTO calendar_event_links (id,user_id,source_id,account_key,event_kind,nest_event_id,event_ref,canvas_item_type,canvas_item_id,canvas_context_id,canvas_calendar_id,source_revision,mirror_state,created_at,updated_at) VALUES ('link1','user-1','source-1',?,'native','one','user:one','calendar_event','55','user_1','user_1','r1','applied','now','now')", [ACCOUNT_1])

    def test_mirror_duplicate_and_unlink_keep_local(self):
        self.personal_source()
        view = self.view()
        result = self.act('mirror', view)
        self.assertEqual(result['state'], 'queued')
        with self.assertRaises(ExtensionContractError):
            self.act('mirror', view)
        with self.assertRaises(ExtensionContractError):
            self.act('mirror')
        self.assertEqual(self.act('unlink')['state'], 'unlinked')
        with calendar_connection() as connection:
            rows = connection.execute('SELECT * FROM calendar_writebacks').fetchall()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['state'], 'cancelled')
            self.assertIsNotNone(connection.execute("SELECT * FROM user_events WHERE id='one'").fetchone())

    def test_reject_stale_item_foreign_owner_and_untrusted_fields(self):
        self.personal_source()
        view = self.view()
        with calendar_connection() as connection:
            connection.execute("UPDATE user_events SET title='Changed' WHERE id='one'")
        with self.assertRaises(ExtensionContractError):
            self.act('mirror', view)
        with self.assertRaises(ExtensionContractError):
            mirrors.inspect_item('user-2', 'user:one')
        for extra in ({'payload': {'title': 'Injected'}}, {'source_ref': 'src1:another'}, {'event_ref': 'assignment:one'}):
            with self.assertRaises(ExtensionContractError):
                self.act('mirror', **extra)
        with calendar_connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_writebacks').fetchone()[0], 0)

    def test_local_delete_cancels_link_and_retains_canvas(self):
        self.personal_source()
        self.link()
        self.assertEqual(self.act('delete_local')['state'], 'deleted_local')
        with calendar_connection() as connection:
            self.assertIsNone(connection.execute("SELECT * FROM user_events WHERE id='one'").fetchone())
            self.assertIsNotNone(connection.execute("SELECT archived_at FROM calendar_event_links").fetchone()[0])
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_writebacks').fetchone()[0], 0)

    def test_delete_both_defers_local_deletion_and_rechecks_item(self):
        self.personal_source()
        self.link()
        result = self.act('delete_both')
        with calendar_connection() as connection:
            row = connection.execute('SELECT * FROM calendar_writebacks WHERE id=?', [result['operation_id']]).fetchone()
            self.assertEqual(row['operation'], 'delete')
            self.assertIsNotNone(connection.execute("SELECT * FROM user_events WHERE id='one'").fetchone())
            connection.execute("UPDATE user_events SET title='New edit' WHERE id='one'")
            self.assertFalse(mirrors.finish_delete(connection, 'user-1', row))
            self.assertIsNotNone(connection.execute("SELECT * FROM user_events WHERE id='one'").fetchone())

    def test_delete_both_deletes_only_unchanged_owned_item_after_ack(self):
        self.personal_source()
        self.link()
        result = self.act('delete_both')
        with calendar_connection() as connection:
            connection.execute("INSERT INTO user_events (id,user_id,title,start,end,created_at) VALUES ('other','user-2','Other','2026-09-09','2026-09-09','now')")
            row = connection.execute('SELECT * FROM calendar_writebacks WHERE id=?', [result['operation_id']]).fetchone()
            self.assertTrue(mirrors.finish_delete(connection, 'user-1', row))
            self.assertIsNone(connection.execute("SELECT * FROM user_events WHERE id='one'").fetchone())
            self.assertIsNotNone(connection.execute("SELECT * FROM user_events WHERE id='other'").fetchone())

    def test_result_delivery_deletes_and_duplicate_ack_remains_idempotent(self):
        from services import calendar_events as events
        self.personal_source()
        self.link()
        result = self.act('delete_both')
        payload = {'state': 'applied', 'expected_revision': 'r1', 'result_revision': 'deleted'}
        first = events.record_canvas_writeback_result('user-1', 'source-1', result['operation_id'], payload)
        self.assertEqual(first['state'], 'applied')
        second = events.record_canvas_writeback_result('user-1', 'source-1', result['operation_id'], payload)
        self.assertTrue(second['idempotent'])

    def test_result_delivery_preserves_new_nest_edits_as_conflict(self):
        from services import calendar_events as events
        self.personal_source()
        self.link()
        result = self.act('delete_both')
        with calendar_connection() as connection:
            connection.execute("UPDATE user_events SET title='New edit' WHERE id='one'")
        result = events.record_canvas_writeback_result('user-1', 'source-1', result['operation_id'],
            {'state': 'applied', 'expected_revision': 'r1', 'result_revision': 'deleted'})
        self.assertEqual(result['state'], 'conflict')
        with calendar_connection() as connection:
            self.assertEqual(connection.execute("SELECT title FROM user_events WHERE id='one'").fetchone()[0], 'New edit')
