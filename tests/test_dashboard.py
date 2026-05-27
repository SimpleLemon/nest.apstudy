import json
import os
import unittest
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
            {"id": "calendar", "size": "large", "view": "month"},
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
        saved_json = '{"version":3,"tiles":[{"id":"tasks","size":"standard"},{"id":"calendar","size":"large","view":"upcoming"}]}'
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
            {"id": "calendar", "size": "large", "view": "upcoming"},
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


if __name__ == "__main__":
    unittest.main()
