"""Owner API projection, ordering and initial refresh regressions."""
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import Mock, patch
from datetime import datetime, timezone

from flask import Flask, make_response
from appwrite.exception import AppwriteException
import blueprints.calendar_api as calendar_api
from services import calendar_projection as projection
from services.calendar_identity import _event_ref_for_cache_event, _feed_url_hash

START = datetime(2026, 8, 20, tzinfo=timezone.utc)
END = datetime(2026, 8, 21, tzinfo=timezone.utc)
FEED = "https://example.test/calendar.ics"


def feed_row(identity, **fields):
    return {"$id": identity, "event_uid": identity, "feed_url": FEED,
            "feed_url_hash": _feed_url_hash(fields.get("feed_url", FEED)),
            "event_title": identity, "event_start": "2026-08-20T14:00:00Z",
            "event_end": "2026-08-20T15:00:00Z", **fields}


class CalendarEventsRouteTestCase(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)

    def test_get_events_delegates_owner_and_preserves_response_status(self):
        with self.app.test_request_context("/api/calendar/events?start=2026-05-01T00:00:00Z"), \
                patch.object(calendar_api, "current_user", SimpleNamespace(id="user-1")), \
                patch.object(calendar_api, "load_events_payload_with_initial_refresh", return_value=({"error": "paired range"}, 400)) as load:
            response = make_response(calendar_api.get_events.__wrapped__())
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json(), {"error": "paired range"})
        self.assertEqual(load.call_args.args[:2], ("user-1", "user-1"))
        self.assertEqual(load.call_args.args[2]["start"], "2026-05-01T00:00:00Z")

    def load_payload(self, *, rows=None, settings=None, refresh=(False, None), args=None, native=None):
        rows = [feed_row("feed-1")] if rows is None else rows
        settings = {"canvas_ical_url": FEED, "feed_refresh_minutes": 30} if settings is None else settings
        task = {"id": "task-1", "source_type": "task"}
        provider = {"id": "provider-1", "source_type": "external"}
        with ExitStack() as stack:
            mocks = {}
            for name, value in {
                "first_row": settings, "_load_calendar_preferences": [],
                "_load_calendar_feed_metadata": {}, "_load_local_calendar_sources": [],
                "_load_event_overrides": [], "_refresh_initial_feed_cache": refresh,
                "_task_calendar_payload": ([task], {"id": "tasks", "kind": "tasks"}),
                "_resolve_last_fetched": "2026-05-01T12:00:00Z",
            }.items():
                mocks[name] = stack.enter_context(patch.object(projection, name, return_value=value))
            def list_rows(collection, _queries):
                return rows if collection == "calendar_cache" else (native or [])
            stack.enter_context(patch.object(projection, "list_calendar_rows_all", side_effect=list_rows))
            stack.enter_context(patch("services.external_calendar_service.project", return_value=([provider], [{"id": "provider"}])))
            stack.enter_context(patch("services.external_calendar_service.capabilities", return_value={"provider_calendar_read": True}))
            payload, status = projection.load_events_payload_with_initial_refresh("owner-1", "response-user-1", args or {})
        return payload, status, mocks

    def test_serializes_real_feed_native_rows_and_adds_tasks_and_provider(self):
        native = [{"$id": "native-1", "title": "Personal", "start": "2026-08-20T16:00:00Z", "end": "2026-08-20T17:00:00Z"}]
        body, status, mocks = self.load_payload(native=native)
        self.assertEqual(status, 200)
        self.assertEqual(body["user_id"], "response-user-1")
        self.assertEqual([event["source_type"] for event in body["events"]], ["feed", "user", "task", "external"])
        self.assertEqual(body["count"], 4)
        self.assertEqual(body["events"][0]["title"], "feed-1")
        self.assertEqual(body["events"][1]["id"], "native-1")
        self.assertEqual(body["refresh_interval_minutes"], 30)
        self.assertEqual(body["last_fetched"], "2026-05-01T12:00:00Z")
        mocks["_refresh_initial_feed_cache"].assert_called_once()

    def test_refresh_failure_returns_cached_content_and_error(self):
        body, status, _ = self.load_payload(refresh=(False, "feed unavailable"))
        self.assertEqual(status, 200)
        self.assertEqual(body["events"][0]["title"], "feed-1")
        self.assertEqual(body["refresh_error"], "feed unavailable")

    def test_refresh_success_reloads_rows_and_metadata(self):
        with ExitStack() as stack:
            for name, value in {"first_row": {"canvas_ical_url": FEED}, "_load_calendar_preferences": [],
                                "_load_local_calendar_sources": [], "_load_event_overrides": [],
                                "_refresh_initial_feed_cache": (True, None), "_task_calendar_payload": ([], None),
                                "_resolve_last_fetched": None}.items():
                stack.enter_context(patch.object(projection, name, return_value=value))
            load = stack.enter_context(patch.object(projection, "list_calendar_rows_all", side_effect=[[], [], [feed_row("refreshed")]]))
            metadata = stack.enter_context(patch.object(projection, "_load_calendar_feed_metadata", side_effect=[{}, {}]))
            stack.enter_context(patch("services.external_calendar_service.project", return_value=([], [])))
            stack.enter_context(patch("services.external_calendar_service.capabilities", return_value={}))
            body, status = projection.load_events_payload_with_initial_refresh("owner")
        self.assertEqual(status, 200)
        self.assertEqual([event["title"] for event in body["events"]], ["refreshed"])
        self.assertEqual(load.call_count, 3)
        self.assertEqual(metadata.call_count, 2)

    def test_no_feeds_skip_refresh_and_invalid_range_rejects_before_reads(self):
        _, status, mocks = self.load_payload(rows=[], settings={})
        self.assertEqual(status, 200)
        mocks["_refresh_initial_feed_cache"].assert_not_called()
        for args in ({"start": "2026-08-20"}, {"start": "bad", "end": "bad"}):
            with self.subTest(args=args), patch.object(projection, "first_row") as read:
                _, status = projection.load_events_payload_with_initial_refresh("owner", args=args)
                self.assertEqual(status, 400)
                read.assert_not_called()

    def test_storage_error_has_calendar_error_response(self):
        with patch.object(projection, "first_row", side_effect=AppwriteException("unavailable")), self.assertLogs(projection.logger, level="ERROR"):
            body, status = projection.load_events_payload_with_initial_refresh("owner")
        self.assertEqual(status, 500)
        self.assertEqual(body, {"error": "Unable to load calendar events."})


class CalendarCompositionTests(unittest.TestCase):
    def test_mixed_cache_order_filters_overrides_and_half_open_range(self):
        canvas1 = {"$id": "canvas-1", "canvas_event_ref": "same", "canvas_source_id": "s"}
        canvas2 = {"$id": "canvas-2", "canvas_event_ref": "same", "canvas_source_id": "s"}
        hidden = feed_row("hidden")
        rows = [canvas1, feed_row("feed-1"), canvas2, hidden,
                feed_row("foreign", feed_url="https://other.test/feed.ics"),
                feed_row("before", event_start="2026-08-19T23:00:00Z", event_end="2026-08-20T00:00:00Z"),
                feed_row("after", event_start="2026-08-21T00:00:00Z", event_end="2026-08-21T01:00:00Z")]
        projected = [{"event_ref": "same", "title": title, "start": "2026-08-20T12:00:00Z", "end": "2026-08-20T13:00:00Z"} for title in ("canvas-1", "canvas-2")]
        overrides = [{"event_ref": _event_ref_for_cache_event(hidden), "hidden": True}]
        with patch.object(projection, "_project_canvas_calendar_events", return_value=projected) as canvas:
            args = ("owner", {"canvas_ical_url": FEED}, rows, [], [], overrides, START, END)
            api = projection.compose_calendar_events(*args)
            shared = projection.compose_calendar_events(*args, cache_order="feed_first", require_shares_ics=True)
        self.assertEqual([event["title"] for event in api.events], ["canvas-1", "feed-1", "canvas-2"])
        self.assertEqual([event["title"] for event in shared.events], ["feed-1", "canvas-1", "canvas-2"])
        self.assertTrue(canvas.call_args.kwargs["require_shares_ics"])
        self.assertEqual(len(api.feed_rows), 4)

    def test_share_loader_has_no_refresh_tasks_or_providers(self):
        with patch.object(projection, "list_calendar_rows_all", side_effect=[[feed_row("feed")], []]), \
                patch.object(projection, "_load_calendar_preferences", return_value=[]), \
                patch.object(projection, "_load_event_overrides", return_value=[]), \
                patch.object(projection, "_refresh_initial_feed_cache") as refresh, \
                patch.object(projection, "_task_calendar_payload") as tasks, \
                patch("services.external_calendar_service.project") as providers:
            events, _, _ = projection.load_calendar_events_for_share("owner", {"canvas_ical_url": FEED}, START, END)
        self.assertEqual([event["title"] for event in events], ["feed"])
        refresh.assert_not_called(); tasks.assert_not_called(); providers.assert_not_called()
