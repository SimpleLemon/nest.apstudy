import unittest
import json
from pathlib import Path
from services.extension_contract import ExtensionContractError
from services.extension_write_validation import validate_fields, validate_personal_identity
from tests.test_calendar_phase2_store import CalendarPhase2StoreTests, ACCOUNT_1
from services import calendar_events as events
from services.extension_bridge import personal_target
from services.calendar_store import calendar_connection


class WriteFieldTests(unittest.TestCase):
    def test_shared_contract_cases(self):
        fixture = Path(__file__).parent / "fixtures" / "bridge-personal-write-fields.json"
        for case in json.loads(fixture.read_text()):
            with self.subTest(case=case["name"]):
                if case["valid"]:
                    self.assertEqual(validate_fields(case["ref"], case["operation"], case["fields"]), case["fields"])
                else:
                    with self.assertRaises(ExtensionContractError):
                        validate_fields(case["ref"], case["operation"], case["fields"])

    def test_accepts_supported_event_and_planner_fields(self):
        for ref, fields in [('user:one', {'title': 'Event', 'start_at': '2026-09-09T12:00:00Z', 'all_day': False}),
                            ('task:one', {'title': 'Task', 'todo_date': '2026-09-09', 'details': 'Notes'})]:
            self.assertEqual(validate_fields(ref, 'create', fields), fields)
        self.assertEqual(validate_fields('user:one', 'delete', {}), {})

    def test_rejects_unknown_nested_types_dates_and_missing_create_fields(self):
        cases = [('user:one', 'update', {'context_code': 'course_123'}),
                 ('user:one', 'update', {'title': {'title': 'nested'}}),
                 ('user:one', 'update', {'all_day': 1}),
                 ('user:one', 'update', {'description': 'x' * 8193}),
                 ('user:one', 'update', {'start_at': '2026-02-30'}),
                 ('user:one', 'create', {'title': 'Missing date'}),
                 ('task:one', 'create', {'title': 'Task', 'todo_date': '2026-02-30'}),
                 ('task:one', 'update', {'todo_date': '2026-9-9'}),
                 ('task:one', 'update', {'start_at': '2026-09-09'}),
                 ('user:one', 'delete', {'title': 'Unexpected'}),
                 ('user:one:alias', 'update', {'title': 'Alias'}),
                 ('assignment:one', 'update', {'title': 'Coursework'})]
        for ref, operation, fields in cases:
            with self.subTest(ref=ref, operation=operation, fields=fields):
                with self.assertRaises(ExtensionContractError):
                    validate_fields(ref, operation, fields)


class WriteBoundaryTests(CalendarPhase2StoreTests):
    def test_invalid_queue_requests_leave_no_durable_rows(self):
        self.personal_source()
        payload = {'account_key': ACCOUNT_1, 'operation': 'create', 'event_ref': 'user:one',
                   'idempotency_key': 'validation', 'target_account': ACCOUNT_1,
                   'payload': {'title': 'Event', 'start_at': '2026-09-09T12:00:00Z'}}
        for extra in [{'payload': {'title': 'Event', 'context_code': 'course_1'}},
                      {'mirror_delete_nest_hash': 'injected'}, {'target_calendar': 'course_1'},
                      {'event_ref': 'user:one:alias'}, {'payload': []}]:
            with self.subTest(extra=extra), self.assertRaises(ExtensionContractError):
                events.create_canvas_writeback('user-1', 'source-1', {**payload, **extra})
        with calendar_connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_writebacks').fetchone()[0], 0)
            with self.assertRaises(ExtensionContractError):
                personal_target(connection, 'user-1', 'user:one:alias')
        self.assertEqual(events.create_canvas_writeback('user-1', 'source-1', payload)['operation'], 'create')

    def test_link_identity_rejects_coursework_mismatches_and_occurrences(self):
        self.personal_source()
        payload = {'account_key': ACCOUNT_1, 'event_ref': 'user:one', 'canvas_item_type': 'calendar_event',
                   'canvas_item_id': '1', 'canvas_context_id': 'user_1', 'canvas_calendar_id': 'user_1'}
        for extra in [{'canvas_context_id': 'course_1', 'canvas_calendar_id': 'course_1'},
                      {'canvas_calendar_id': 'user_2'}, {'canvas_item_type': 'planner_note'},
                      {'canvas_item_id': 'abc'}, {'canvas_occurrence_id': '2'}]:
            with self.subTest(extra=extra), self.assertRaises(ExtensionContractError):
                events.create_canvas_event_link('user-1', 'source-1', {**payload, **extra})
        with calendar_connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_event_links').fetchone()[0], 0)
        self.assertEqual(events.create_canvas_event_link('user-1', 'source-1', payload)['canvas_item_id'], '1')


    def test_personal_destination_is_bound_to_registered_provider(self):
        self.personal_source()
        link = {'account_key': ACCOUNT_1, 'event_ref': 'user:one', 'canvas_item_type': 'calendar_event',
                'canvas_item_id': '1', 'canvas_context_id': 'user_2', 'canvas_calendar_id': 'user_2'}
        with self.assertRaises(ExtensionContractError):
            events.create_canvas_event_link('user-1', 'source-1', link)
        request = {'account_key': ACCOUNT_1, 'operation': 'create', 'event_ref': 'user:one',
                   'idempotency_key': 'foreign-calendar', 'target_account': ACCOUNT_1,
                   'target_calendar': 'user_2', 'payload': {'title': 'Event', 'start_at': '2026-09-09'}}
        with self.assertRaises(ExtensionContractError):
            events.create_canvas_writeback('user-1', 'source-1', request)
        with calendar_connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_event_links').fetchone()[0], 0)
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_writebacks').fetchone()[0], 0)
        request['target_calendar'] = 'user_1'
        self.assertEqual(events.create_canvas_writeback('user-1', 'source-1', request)['target_calendar'], 'user_1')

    def test_reregistration_cannot_rebind_existing_provider_or_origin(self):
        self.personal_source()
        payload = {'account_key': ACCOUNT_1, 'source_id': 'source-1', 'origin': 'https://canvas.example.edu',
                   'provider_user_id': '1', 'label': 'Updated label'}
        for override in [{'provider_user_id': '2'}, {'origin': 'https://other.example.edu'}]:
            with self.subTest(override=override), self.assertRaises(ExtensionContractError):
                events.register_canvas_import_source('user-1', {**payload, **override})
        events.register_canvas_import_source('user-1', payload)
        with calendar_connection() as connection:
            source = connection.execute("SELECT * FROM calendar_import_sources WHERE source_id='source-1'").fetchone()
            self.assertEqual(source['provider_user_id'], '1')
            self.assertEqual(source['origin'], payload['origin'])
            self.assertEqual(source['label'], 'Updated label')

    def test_invalid_legacy_provider_disables_mirroring_without_queueing(self):
        from services.extension_mirrors import inspect_item, change_item
        self.personal_source()
        with calendar_connection() as connection:
            connection.execute("UPDATE calendar_import_sources SET provider_user_id='legacy-name'")
        view = inspect_item('user-1', 'user:one')
        self.assertFalse(view['sources'][0]['allowed'])
        with self.assertRaises(ExtensionContractError):
            change_item('user-1', {'event_ref': 'user:one', 'source_ref': view['sources'][0]['source_ref'],
                                  'action': 'mirror', 'expected_revision': view['expected_revision']})
        with calendar_connection() as connection:
            self.assertEqual(connection.execute('SELECT COUNT(*) FROM calendar_writebacks').fetchone()[0], 0)
