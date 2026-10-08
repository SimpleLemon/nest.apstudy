"""Transport, UTC input and raw-row regressions for calendar repairs."""
import os
import tempfile
import unittest
from contextlib import ExitStack
from datetime import date, datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask
import icalendar
from blueprints import extension_calendar_api as extension, external_calendar_api as provider
from services import calendar_ics_tasks as tasks, calendar_ics_canvas as canvas, calendar_ics_courses as courses
from services import calendar_store, database, ics_builder
from services.external_calendar_domain import CalendarError
from services.extension_consent import put_consent
from services.extension_contract import canonical_canvas_source_key

UTC = timezone.utc
ACCOUNT = "a" * 64


class CalendarProjectorRangeTests(unittest.TestCase):
    def test_all_projectors_reject_invalid_utc_bounds_before_io(self):
        good = datetime(2026, 8, 1, tzinfo=UTC)
        invalid = [(date(2026, 8, 1), date(2026, 9, 1)), ("2026-08-01", "2026-09-01"),
                   (None, good), (datetime(2026, 8, 1), good),
                   (good.astimezone(timezone(timedelta(hours=-4))), good + timedelta(days=1)),
                   (good, good), (good, good - timedelta(seconds=1))]
        for name, projector, extra, io_target in (
            ("tasks", tasks.project_tasks_for_user, "list_rows_fn", None),
            ("canvas", canvas.project_canvas_calendar, None, "_strict_sources"),
            ("courses", courses.project_simulated_courses, "list_rows_fn", None),
        ):
            for start, end in invalid:
                with self.subTest(projector=name, start=start, end=end), ExitStack() as stack:
                    io = Mock()
                    kwargs = {extra: io} if extra else {}
                    if io_target:
                        stack.enter_context(patch.object(canvas, io_target, io))
                    with self.assertRaises(ValueError):
                        projector(user_id="owner", range_start=start, range_end=end, **kwargs)
                    io.assert_not_called()


class CalendarProviderEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.register_blueprint(provider.external_calendar_bp, url_prefix="/owner")
        self.app.register_blueprint(provider.external_calendar_extension_bp, url_prefix="/extension")
        for name, value in (("_auth_or_response", Mock(return_value=None)),
                            ("current_user", SimpleNamespace(id="owner", is_authenticated=True))):
            patcher = patch.object(provider, name, value)
            patcher.start(); self.addCleanup(patcher.stop)
        self.client = self.app.test_client()

    def test_both_provider_routes_use_shared_error_envelope(self):
        for prefix in ("owner", "extension"):
            for status in (400, 403, 409, 503):
                with self.subTest(prefix=prefix, status=status), patch.object(provider.service, "status", side_effect=CalendarError("calendar_unavailable", status)):
                    response = self.client.get(f"/{prefix}/connections", headers={"X-Request-ID": "calendar-regression"})
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json, {"ok": False, "contractVersion": 1,
                                                "error": {"code": "calendar_unavailable", "message": "calendar unavailable"}})
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(response.headers["X-Request-ID"], "calendar-regression")

    def test_invalid_json_rejects_before_provider_service_and_success_shape_remains(self):
        with patch.object(provider.service, "sync_now") as sync:
            response = self.client.post("/owner/connections/c/sync", json=[])
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json["error"]["code"], "json_object_required")
        sync.assert_not_called()
        with patch.object(provider.service, "status", return_value={"connections": []}):
            response = self.client.get("/owner/connections")
        self.assertEqual(response.json, {"ok": True, "contractVersion": 1, "connections": []})


class CalendarContentConsentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.db_path = os.path.join(self.tmp.name, "calendar.sqlite3")
        env = patch.dict(os.environ, {"DATABASE_PATH": self.db_path}); env.start(); self.addCleanup(env.stop)
        database.init_db(path=self.db_path)
        self.app = Flask(__name__)
        self.app.register_blueprint(extension.extension_calendar_bp, url_prefix="/calendar")
        self.app.config["TESTING"] = True
        for name, value in (("_auth_or_response", Mock(return_value=None)),
                            ("_require_capabilities", Mock()),
                            ("current_user", SimpleNamespace(id="owner", is_authenticated=True))):
            patcher = patch.object(extension, name, value); patcher.start(); self.addCleanup(patcher.stop)
        capabilities = patch("services.extension_consent.extension_capability_enabled", return_value=True)
        capabilities.start(); self.addCleanup(capabilities.stop)
        self.client = self.app.test_client()

    def grant(self):
        put_consent("owner", canonical_canvas_source_key(ACCOUNT), ACCOUNT, action="grant", version=1,
                    scopes=["full_history_upload", "ongoing_read", "shares_ics_inclusion"], path=self.db_path)

    def assert_read(self, route, target, expected, headers=None):
        owner, name = target
        with patch.object(owner, name, return_value=({"events": []}, 200)) as operation:
            response = self.client.get(route, headers=headers or {})
        self.assertEqual(response.status_code, expected, response.json)
        if expected == 200:
            operation.assert_called_once()
        else:
            operation.assert_not_called()
            self.assertIn("code", response.json["error"])

    def test_read_grant_required_for_all_content_routes(self):
        routes = [("/calendar/preferences", (extension.calendar_preferences, "get_calendar_preferences")),
                  ("/calendar/events", (extension, "load_events_payload_with_initial_refresh")),
                  ("/calendar/events/user:event-1", (extension.calendar, "get_single_event"))]
        for route, target in routes:
            for headers in ({}, {"X-Canvas-Account-Key": "bad"}, {"X-Canvas-Account-Key": ACCOUNT}):
                with self.subTest(route=route, headers=headers):
                    self.assert_read(route, target, 400, headers)
        self.grant()
        for route, target in routes:
            self.assert_read(route, target, 200, {"X-Canvas-Account-Key": ACCOUNT})
            self.assert_read(route, target, 400, {"X-Canvas-Account-Key": "b" * 64})
        put_consent("owner", canonical_canvas_source_key(ACCOUNT), ACCOUNT, action="revoke", version=1,
                    scopes=["ongoing_read"], path=self.db_path)
        for route, target in routes:
            self.assert_read(route, target, 400, {"X-Canvas-Account-Key": ACCOUNT})


class CalendarIcsRawRowTests(unittest.TestCase):
    def test_repeated_reference_retains_each_raw_account_source_timezone(self):
        raw_rows = [{"$id": name, "canvas_event_ref": "same", "canvas_source_id": source, "canvas_account_key": account}
                    for name, source, account in (("first", "source-1", "account-1"), ("second", "source-2", "account-2"))]
        emitted = [{"event_ref": "same", "source_type": "canvas", "uid": name,
                    "title": name, "start": "2026-08-20T14:00:00Z", "end": "2026-08-20T15:00:00Z"}
                   for name in ("first", "second")]
        sources = {("source-1", "account-1"): {"timezone": "America/Los_Angeles"},
                   ("source-2", "account-2"): {"timezone": "America/New_York"}}
        with patch.object(ics_builder, "_user_settings", return_value={}), \
                patch.object(ics_builder, "list_calendar_rows_all", return_value=raw_rows), \
                patch.object(ics_builder, "_load_event_overrides", return_value=[]), \
                patch.object(ics_builder, "_load_projected_events", return_value=(emitted, sources)), \
                patch.object(ics_builder, "_inject_atlas_schedule"):
            content = ics_builder.build_ics_for_user("owner")
        events = [event for event in icalendar.Calendar.from_ical(content).walk() if event.name == "VEVENT"]
        self.assertEqual([event["DTSTART"].params["TZID"] for event in events], ["America/Los_Angeles", "America/New_York"])
        self.assertEqual([event["DTSTART"].dt.hour for event in events], [7, 10])
