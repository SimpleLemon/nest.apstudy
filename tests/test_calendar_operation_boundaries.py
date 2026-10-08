"""Real-store and transport-boundary regressions for personal calendar operations."""

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask, make_response
from appwrite.exception import AppwriteException
import appwrite_helpers
from blueprints import calendar_api
from services import calendar_personal_events as events
from services import calendar_store as store
from tests.support.harness import bootstrap_calendar_db


class CalendarEventUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.env = patch.dict(os.environ, {
            "CALENDAR_SQLITE_PATH": os.path.join(self.tmp.name, "calendar.sqlite3"),
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        bootstrap_calendar_db(os.environ["CALENDAR_SQLITE_PATH"])
        self.original = store.create_calendar_row("user_events", "event-1", {
            "user_id": "owner", "title": "Original", "start": "2026-10-03T14:00:00Z",
            "end": "2026-10-03T15:00:00Z", "is_all_day": False,
            "calendar_id": "local:default", "reminder_minutes": 10, "created_at": "2026-10-03T00:00:00Z",
        })
        self.app = Flask(__name__)

    def update_route(self, body):
        with self.app.test_request_context("/events/event-1", method="PUT", json=body), \
                patch.object(calendar_api, "current_user", SimpleNamespace(id="owner")):
            response = make_response(calendar_api.update_event.__wrapped__("event-1"))
        return response.get_json(), response.status_code

    def assert_rejected_without_writes(self, body):
        with patch.object(calendar_api, "update_calendar_row", wraps=store.update_calendar_row) as write, \
                patch.object(calendar_api, "_ensure_local_calendar_source") as source:
            payload, status = self.update_route({"title": "Changed", "calendar_id": "local:new", **body})
        self.assertEqual(status, 400, payload)
        self.assertIn("error", payload)
        write.assert_not_called()
        source.assert_not_called()
        self.assertEqual(store.get_calendar_row("user_events", "event-1"), self.original)

    def test_every_supplied_date_alias_must_be_valid(self):
        for field in ("start", "end", "start_date", "end_date"):
            for invalid in (None, "", "bad", "2026-02-30", "2026-13-03", {}, []):
                with self.subTest(field=field, invalid=invalid):
                    self.assert_rejected_without_writes({field: invalid})
        self.assert_rejected_without_writes({"start": "bad", "start_date": "2026-10-03T14:00:00Z"})

    def test_one_sided_edits_check_the_effective_interval(self):
        for body in ({"start": "2026-10-03T15:00:00Z"},
                     {"start": "2026-10-03T16:00:00Z"},
                     {"end": "2026-10-03T14:00:00Z"},
                     {"end": "2026-10-03T13:00:00Z"},
                     {"start": "2026-10-03T14:30:00Z", "end": "2026-10-03T14:00:00Z"}):
            with self.subTest(body=body):
                self.assert_rejected_without_writes(body)

    def test_naive_and_offset_dates_compare_as_utc(self):
        payload, status = self.update_route({"start": "2026-10-03T09:30:00-04:00", "end": "2026-10-03T15:30:00"})
        self.assertEqual(status, 200, payload)
        stored = store.get_calendar_row("user_events", "event-1")
        self.assertEqual(stored["start"], "2026-10-03T13:30:00Z")
        self.assertEqual(stored["end"], "2026-10-03T15:30:00Z")

    def test_valid_update_writes_once_and_preserves_omitted_dates(self):
        with patch.object(calendar_api, "update_calendar_row", wraps=store.update_calendar_row) as write:
            payload, status = self.update_route({"title": "Revised", "end_date": "2026-10-03T16:00:00Z"})
        self.assertEqual(status, 200, payload)
        self.assertEqual(write.call_count, 1)
        stored = store.get_calendar_row("user_events", "event-1")
        self.assertEqual(stored["title"], "Revised")
        self.assertEqual(stored["start"], self.original["start"])
        self.assertEqual(stored["end"], "2026-10-03T16:00:00Z")

    def test_update_cannot_reach_another_owners_row(self):
        write = Mock()
        payload, status = events.update_event("other", "event-1", {"title": "Stolen"}, dependencies={"update_calendar_row": write})
        self.assertEqual(status, 404, payload)
        write.assert_not_called()
        self.assertEqual(store.get_calendar_row("user_events", "event-1"), self.original)


class SQLiteBoundaryTests(unittest.TestCase):
    def test_each_database_operation_logs_and_reraises_the_same_error(self):
        calls = (
            ("list_rows", appwrite_helpers.list_rows_safe, ("items",)),
            ("get_row", appwrite_helpers.get_row_safe, ("items", "row")),
            ("create_row", appwrite_helpers.create_row_safe, ("items", "row", {})),
            ("insert_row_ignore", appwrite_helpers.insert_row_ignore_safe, ("items", "row", {})),
            ("update_row", appwrite_helpers.update_row_safe, ("items", "row", {})),
            ("delete_row", appwrite_helpers.delete_row_safe, ("items", "row")),
        )
        for operation, call, args in calls:
            with self.subTest(operation=operation):
                error = AppwriteException("Database unavailable", code=503)
                with patch.object(appwrite_helpers.sqlite_database, operation, side_effect=error), \
                        self.assertLogs(appwrite_helpers.logger, level="ERROR") as captured:
                    with self.assertRaises(AppwriteException) as raised:
                        call(*args)
                self.assertIs(raised.exception, error)
                self.assertEqual(len(captured.records), 1)
                record = captured.records[0]
                self.assertEqual(record.getMessage(), f"SQLite {operation} failed: items")
                self.assertIs(record.exc_info[1], error)
                self.assertIsNotNone(record.exc_info[2])


class ExtensionCalendarEnvelopeTests(unittest.TestCase):
    def setUp(self):
        from blueprints import extension_calendar_api as bridge
        self.bridge = bridge
        self.app = Flask(__name__)
        self.app.register_blueprint(bridge.extension_calendar_bp, url_prefix="/calendar")
        self.app.config["TESTING"] = True
        self.user = SimpleNamespace(id="owner", is_authenticated=True)
        for name, replacement in (("current_user", self.user), ("_auth_or_response", None),
                                  ("_require_capabilities", None), ("canvas_consent_status", {})):
            patcher = patch.object(bridge, name, replacement) if name == "current_user" else patch.object(bridge, name, return_value=replacement)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_put_calls_plain_owner_service_and_preserves_error_envelope(self):
        operation = Mock(return_value=({"error": "end_date must be after start_date"}, 400))
        with patch.object(self.bridge.calendar, "update_event", operation):
            response = self.app.test_client().put("/calendar/events/user:event-1", json={"end": "bad"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "calendar_request_failed")
        operation.assert_called_once_with(user_id="owner", event_id="event-1", data={"end": "bad"})

    def test_read_service_payload_strips_identity_and_adds_source_alias(self):
        operation = Mock(return_value=({"user_id": "owner", "events": [], "calendar_sources": [{"id": "canvas"}]}, 200))
        with patch.object(self.bridge, "load_events_payload_with_initial_refresh", operation):
            response = self.app.test_client().get("/calendar/events?start=2026-10-01&end=2026-11-01")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertNotIn("user_id", body)
        self.assertEqual(body["sources"], body["calendar_sources"])
        inputs = operation.call_args.kwargs
        self.assertEqual(inputs["user_id"], "owner")
        self.assertEqual(inputs["args"]["start"], "2026-10-01")

    def test_anonymous_gate_does_not_read_identity_or_call_owner_service(self):
        from flask import jsonify
        with self.app.app_context():
            refusal = jsonify({"error": "Unauthorized"}), 401
        operation = Mock()
        with patch.object(self.bridge, "_auth_or_response", return_value=refusal), \
                patch.object(self.bridge, "current_user", SimpleNamespace()), \
                patch.object(self.bridge.calendar, "get_single_event", operation):
            response = self.app.test_client().get("/calendar/events/event-1")
        self.assertEqual(response.status_code, 401)
        operation.assert_not_called()

    def test_non_object_write_payload_is_rejected_before_owner_service(self):
        operation = Mock()
        with patch.object(self.bridge.calendar, "update_event", operation):
            response = self.app.test_client().put("/calendar/events/event-1", json=[{"title": "Bad"}])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"]["code"], "invalid_request")
        operation.assert_not_called()
