import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.dashboard as dashboard_bp


class TestDashboardSummary(unittest.TestCase):
    def setUp(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(root, "templates"),
            static_folder=os.path.join(root, "static"),
        )
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.app.register_blueprint(dashboard_bp.dashboard_bp)

        @self.app.route("/settings/", endpoint="settings.settings_page")
        def _settings_page():
            return ""

        self.user = SimpleNamespace(
            id="user-1",
            name="Derek",
            username="derek",
            email="derek@example.test",
            picture_url="",
            emory_student=False,
            school="Nest University",
            school_key="nest-university",
            education_level="Undergraduate",
            class_year=None,
            graduation_year="2027",
            onboarding_complete=True,
        )

    def _summary_with_patches(self, *, settings=None, calendar=None, tasks=None, courses=None):
        with self.app.test_request_context("/api/dashboard/summary"):
            with patch.object(dashboard_bp, "current_user", self.user), \
                    patch.object(dashboard_bp, "_load_user_settings", return_value=settings), \
                    patch.object(dashboard_bp, "_load_calendar_summary", return_value=calendar or {"events": [], "setup_complete": False}), \
                    patch.object(dashboard_bp, "_load_tasks_summary", return_value=tasks or {"items": [], "setup_complete": False}), \
                    patch.object(dashboard_bp, "_load_recent_files", return_value={"items": [], "total_count": 0}), \
                    patch.object(dashboard_bp, "_load_recent_notes", return_value={"items": [], "total_count": 0}), \
                    patch.object(dashboard_bp, "_load_message_rooms", return_value={"items": [], "total_count": 0}), \
                    patch.object(dashboard_bp, "_load_courses_summary", return_value=courses or {"items": [], "available": False}):
                return dashboard_bp._dashboard_summary_payload()

    def test_summary_omits_courses_for_non_emory_empty_account(self):
        self.user.emory_student = False
        self.user.name = ""
        self.user.username = ""
        self.user.school = ""
        self.user.graduation_year = ""

        summary = self._summary_with_patches()

        self.assertNotIn("courses", summary["tile_order"])
        self.assertEqual(summary["available_tiles"], ["calendar", "tasks", "files", "notes", "messages"])
        self.assertEqual(summary["tile_layout_version"], 1)
        self.assertEqual(summary["checklist"]["completed"], 0)
        self.assertFalse(summary["checklist"]["hidden"])

    def test_summary_applies_saved_order_and_conditional_courses(self):
        self.user.emory_student = True
        settings = {"dashboard_layout_json": json.dumps(["messages", "calendar"])}
        courses = {"items": [{"id": "course-1"}], "available": True}

        summary = self._summary_with_patches(
            settings=settings,
            calendar={"events": [], "setup_complete": True},
            tasks={"items": [], "setup_complete": True},
            courses=courses,
        )

        self.assertEqual(summary["tile_order"][:2], ["messages", "calendar"])
        self.assertEqual(summary["tile_layout"][:2], [
            {"id": "messages", "size": "standard"},
            {"id": "calendar", "size": "standard", "view": "month"},
        ])
        self.assertIn("courses", summary["tile_order"])
        self.assertTrue(summary["checklist"]["complete"])

    def test_summary_migrates_v2_saved_layout_sizes(self):
        settings = {
            "dashboard_layout_json": json.dumps({
                "version": 2,
                "tiles": [
                    {"id": "tasks", "size": "compact"},
                    {"id": "calendar", "size": "wide"},
                ],
            }),
        }

        summary = self._summary_with_patches(settings=settings)

        self.assertEqual(summary["tile_layout"][:2], [
            {"id": "tasks", "size": "standard"},
            {"id": "calendar", "size": "wide", "view": "month"},
        ])

    def test_summary_v3_omitted_tiles_stay_hidden(self):
        settings = {
            "dashboard_layout_json": json.dumps({
                "version": 3,
                "tiles": [{"id": "calendar", "size": "tall", "view": "week"}],
            }),
        }

        summary = self._summary_with_patches(settings=settings)

        self.assertEqual(summary["tile_order"], ["calendar"])
        self.assertEqual(summary["tile_layout_version"], 3)
        self.assertEqual(summary["tile_layout"], [
            {"id": "calendar", "size": "tall", "view": "week"},
        ])

    def test_hidden_checklist_requires_matching_signature(self):
        with self.app.test_request_context("/dashboard"):
            with patch.object(dashboard_bp, "current_user", self.user):
                signature = dashboard_bp._build_checklist(True, True)["signature"]

        summary = self._summary_with_patches(
            settings={"dashboard_checklist_hidden_signature": signature},
            calendar={"events": [], "setup_complete": True},
            tasks={"items": [], "setup_complete": True},
        )

        self.assertTrue(summary["checklist"]["hidden"])


class TestDashboardPreferenceRoutes(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.user = SimpleNamespace(id="user-1", onboarding_complete=True)

    def test_layout_rejects_unknown_tile_id(self):
        with self.app.test_request_context(
            "/api/dashboard/layout",
            method="PATCH",
            json={"tile_order": ["calendar", "unknown"]},
        ):
            with patch.object(dashboard_bp, "current_user", self.user):
                response, status = dashboard_bp.update_dashboard_layout.__wrapped__()

        self.assertEqual(status, 400)
        self.assertIn("Unknown dashboard tile", response.get_json()["error"])

    def test_layout_rejects_invalid_tile_size(self):
        with self.app.test_request_context(
            "/api/dashboard/layout",
            method="PATCH",
            json={"tile_layout": {"version": 3, "tiles": [{"id": "courses", "size": "tall"}]}},
        ):
            with patch.object(dashboard_bp, "current_user", self.user):
                response, status = dashboard_bp.update_dashboard_layout.__wrapped__()

        self.assertEqual(status, 400)
        self.assertIn("Invalid size", response.get_json()["error"])

    def test_layout_rejects_invalid_calendar_view(self):
        with self.app.test_request_context(
            "/api/dashboard/layout",
            method="PATCH",
            json={"tile_layout": {"version": 3, "tiles": [{"id": "calendar", "size": "standard", "view": "agenda"}]}},
        ):
            with patch.object(dashboard_bp, "current_user", self.user):
                response, status = dashboard_bp.update_dashboard_layout.__wrapped__()

        self.assertEqual(status, 400)
        self.assertIn("Invalid calendar view", response.get_json()["error"])

    def test_layout_rejects_duplicate_tile_id(self):
        with self.app.test_request_context(
            "/api/dashboard/layout",
            method="PATCH",
            json={"tile_layout": {"version": 3, "tiles": [{"id": "tasks"}, {"id": "tasks"}]}},
        ):
            with patch.object(dashboard_bp, "current_user", self.user):
                response, status = dashboard_bp.update_dashboard_layout.__wrapped__()

        self.assertEqual(status, 400)
        self.assertIn("Duplicate dashboard tile", response.get_json()["error"])

    def test_layout_saves_unique_valid_layout(self):
        existing = {"$id": "settings-1", "user_id": "user-1"}
        saved_json = '{"version":3,"tiles":[{"id":"tasks","size":"standard"},{"id":"calendar","size":"wide","view":"upcoming"}]}'
        updated = {**existing, "dashboard_layout_json": saved_json}

        with self.app.test_request_context(
            "/api/dashboard/layout",
            method="PATCH",
            json={
                "tile_layout": {
                    "version": 2,
                    "tiles": [
                        {"id": "tasks", "size": "compact"},
                        {"id": "calendar", "size": "wide", "view": "upcoming"},
                    ],
                },
            },
        ):
            with patch.object(dashboard_bp, "current_user", self.user), \
                    patch.object(dashboard_bp, "_ensure_user_settings", return_value=existing), \
                    patch.object(dashboard_bp, "update_row_safe", return_value=updated) as update_row:
                response = dashboard_bp.update_dashboard_layout.__wrapped__()

        self.assertEqual(response.get_json()["tile_order"], ["tasks", "calendar"])
        self.assertEqual(response.get_json()["tile_layout"], [
            {"id": "tasks", "size": "standard"},
            {"id": "calendar", "size": "wide", "view": "upcoming"},
        ])
        self.assertEqual(update_row.call_args.args[2]["dashboard_layout_json"], saved_json)

    def test_checklist_hide_saves_current_signature(self):
        existing = {"$id": "settings-1", "user_id": "user-1"}
        summary = {"checklist": {"signature": "abc123"}}

        with self.app.test_request_context(
            "/api/dashboard/checklist/hidden",
            method="POST",
            json={"hidden": True},
        ):
            with patch.object(dashboard_bp, "current_user", self.user), \
                    patch.object(dashboard_bp, "_dashboard_summary_payload", return_value=summary), \
                    patch.object(dashboard_bp, "_ensure_user_settings", return_value=existing), \
                    patch.object(dashboard_bp, "update_row_safe") as update_row:
                response = dashboard_bp.update_dashboard_checklist_hidden.__wrapped__()

        self.assertTrue(response.get_json()["hidden"])
        self.assertEqual(update_row.call_args.args[2]["dashboard_checklist_hidden_signature"], "abc123")

    def test_quote_today_normalizes_zenquotes_payload(self):
        payload = [{
            "q": "Adapt and enjoy something better.",
            "a": "Spencer Johnson",
            "i": "https://zenquotes.io/img/spencer-johnson.jpg",
            "h": "<blockquote>ignored</blockquote>",
            "date": "2026-05-31",
        }]

        class FakeResponse:
            def raise_for_status(self):
                return None

            def json(self):
                return payload

        with self.app.test_request_context("/api/dashboard/quote/today"):
            with patch.object(dashboard_bp, "current_user", self.user), \
                    patch.object(dashboard_bp.http_requests, "get", return_value=FakeResponse()) as get_quote:
                response = dashboard_bp.dashboard_quote_today.__wrapped__()

        self.assertEqual(response.get_json(), {
            "quote": {
                "text": "Adapt and enjoy something better.",
                "author": "Spencer Johnson",
                "date": "2026-05-31",
            },
        })
        get_quote.assert_called_once_with(dashboard_bp.DASHBOARD_QUOTE_URL, timeout=dashboard_bp.DASHBOARD_QUOTE_TIMEOUT)

    def test_quote_today_returns_fallback_on_fetch_failure(self):
        with self.app.test_request_context("/api/dashboard/quote/today"):
            with patch.object(dashboard_bp, "current_user", self.user), \
                    patch.object(
                        dashboard_bp.http_requests,
                        "get",
                        side_effect=dashboard_bp.http_requests.RequestException("offline"),
                    ):
                response = dashboard_bp.dashboard_quote_today.__wrapped__()

        self.assertEqual(response.get_json(), {"quote": dashboard_bp.DASHBOARD_FALLBACK_QUOTE})


class TestDashboardTasksSummary(unittest.TestCase):
    def test_tasks_summary_falls_back_to_thirty_day_and_no_deadline_tasks(self):
        now = datetime.now(timezone.utc)
        rows = [
            {
                "$id": "far",
                "title": "Far task",
                "priority": "high",
                "deadline_at": (now + timedelta(days=45)).isoformat(),
                "completed": False,
            },
            {
                "$id": "no-deadline-low",
                "title": "No deadline low",
                "priority": "low",
                "deadline_at": None,
                "completed": False,
            },
            {
                "$id": "thirty-medium",
                "title": "Thirty medium",
                "priority": "medium",
                "deadline_at": (now + timedelta(days=20)).isoformat(),
                "completed": False,
            },
            {
                "$id": "no-deadline-high",
                "title": "No deadline high",
                "priority": "high",
                "deadline_at": None,
                "completed": False,
            },
        ]

        with patch.object(dashboard_bp, "list_rows_all", return_value=rows):
            summary = dashboard_bp._load_tasks_summary("user-1")

        self.assertEqual(
            [item["id"] for item in summary["items"]],
            ["thirty-medium", "no-deadline-high", "no-deadline-low"],
        )
        self.assertEqual(summary["total_count"], 3)

    def test_tasks_summary_prioritizes_seven_day_tasks_before_later_tasks(self):
        now = datetime.now(timezone.utc)
        rows = [
            {
                "$id": "thirty-high",
                "title": "Thirty high",
                "priority": "high",
                "deadline_at": (now + timedelta(days=20)).isoformat(),
                "completed": False,
            },
            {
                "$id": "seven-low",
                "title": "Seven low",
                "priority": "low",
                "deadline_at": (now + timedelta(days=2)).isoformat(),
                "completed": False,
            },
            {
                "$id": "seven-high",
                "title": "Seven high",
                "priority": "high",
                "deadline_at": (now + timedelta(days=6)).isoformat(),
                "completed": False,
            },
            {
                "$id": "no-deadline-high",
                "title": "No deadline high",
                "priority": "high",
                "deadline_at": None,
                "completed": False,
            },
        ]

        with patch.object(dashboard_bp, "list_rows_all", return_value=rows):
            summary = dashboard_bp._load_tasks_summary("user-1")

        self.assertEqual(
            [item["id"] for item in summary["items"]],
            ["seven-high", "seven-low", "thirty-high", "no-deadline-high"],
        )


class TestDashboardFilesSummary(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.app.add_url_rule("/files", endpoint="file_share.file_share_page", view_func=lambda: "")

    def test_recent_files_excludes_expired_files(self):
        now = datetime.now(timezone.utc)
        rows = [
            {
                "$id": "active",
                "original_filename": "active.pdf",
                "file_size_bytes": 1200,
                "expires_at": (now + timedelta(days=1)).isoformat(),
                "updated_at": (now - timedelta(minutes=5)).isoformat(),
            },
            {
                "$id": "expired",
                "original_filename": "expired.pdf",
                "file_size_bytes": 2400,
                "expires_at": (now - timedelta(minutes=1)).isoformat(),
                "updated_at": now.isoformat(),
            },
            {
                "$id": "no-expiry",
                "original_filename": "no-expiry.pdf",
                "file_size_bytes": 3600,
                "expires_at": None,
                "updated_at": (now - timedelta(minutes=10)).isoformat(),
            },
        ]

        with self.app.test_request_context("/api/dashboard/summary"):
            with patch.object(dashboard_bp, "list_rows_all", return_value=rows):
                summary = dashboard_bp._load_recent_files("user-1")

        self.assertEqual([item["id"] for item in summary["items"]], ["active", "no-expiry"])
        self.assertEqual(summary["total_count"], 2)


if __name__ == "__main__":
    unittest.main()
