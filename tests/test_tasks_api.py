import json
import os
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

from blueprints.tasks_api import (
    TASK_CALENDAR_ID,
    _list_to_payload,
    _normalize_recurrence,
    _normalize_task_reminder,
    _normalize_sort_mode,
    _task_preferences_for_user,
    _task_to_payload,
    _task_updates_from_payload,
    build_task_calendar_events,
)
import blueprints.tasks_api as ta


class TestTasksApiHelpers(unittest.TestCase):
    def test_recurring_task_expands_into_calendar_occurrences(self):
        task = {
            "$id": "task-1",
            "title": "Review lab notes",
            "priority": "high",
            "deadline_at": "2026-05-18T13:00:00Z",
            "deadline_time": "09:00",
            "timezone": "America/New_York",
            "recurrence_json": json.dumps({
                "every": 1,
                "unit": "week",
                "startDate": "2026-05-18",
                "endDate": None,
            }),
            "completed": False,
        }
        completions = [{
            "$id": "completion-1",
            "task_id": "task-1",
            "occurrence_key": "2026-05-25",
            "completed_at": "2026-05-25T13:10:00Z",
        }]

        events = build_task_calendar_events(
            [task],
            completions,
            datetime(2026, 5, 18, tzinfo=timezone.utc),
            datetime(2026, 6, 2, tzinfo=timezone.utc),
        )

        self.assertEqual([event["occurrence_key"] for event in events], ["2026-05-18", "2026-05-25", "2026-06-01"])
        self.assertEqual(events[0]["calendar_id"], TASK_CALENDAR_ID)
        self.assertEqual(events[0]["type"], "task")
        self.assertEqual(events[0]["priority"], "high")
        self.assertFalse(events[0]["completed"])
        self.assertTrue(events[1]["completed"])

    def test_single_deadline_task_uses_task_completed_state(self):
        task = {
            "$id": "task-2",
            "title": "Submit draft",
            "priority": "medium",
            "deadline_at": "2026-05-19T20:00:00Z",
            "deadline_time": "16:00",
            "timezone": "America/New_York",
            "recurrence_json": None,
            "completed": True,
        }

        events = build_task_calendar_events(
            [task],
            [],
            datetime(2026, 5, 19, tzinfo=timezone.utc),
            datetime(2026, 5, 20, tzinfo=timezone.utc),
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["occurrence_key"], "single")
        self.assertTrue(events[0]["completed"])

    def test_recurrence_validation_rejects_invalid_end_date(self):
        with self.assertRaises(ValueError):
            _normalize_recurrence({
                "every": 1,
                "unit": "week",
                "startDate": "2026-05-18",
                "endDate": "2026-05-17",
            })

    def test_task_payload_validation_requires_title(self):
        with self.assertRaises(ValueError):
            _task_updates_from_payload({"title": "   "}, creating=True)

    def test_task_payload_normalizes_deadline_and_repeat_rule(self):
        updates = _task_updates_from_payload(
            {
                "title": "Read chapter",
                "priority": "HIGH",
                "deadline_at": "2026-05-18T13:00:00Z",
                "timezone": "America/New_York",
                "recurrence": {
                    "every": 2,
                    "unit": "weeks",
                    "startDate": "2026-05-18",
                    "endDate": None,
                },
            },
            creating=True,
        )

        self.assertEqual(updates["priority"], "high")
        self.assertEqual(updates["deadline_time"], "09:00")
        self.assertEqual(json.loads(updates["recurrence_json"])["unit"], "week")
        self.assertEqual(updates["reminder_minutes"], 10)

    def test_date_only_deadline_preserves_null_time_and_alert(self):
        updates = _task_updates_from_payload(
            {
                "title": "Submit reflection",
                "deadline_at": "2026-05-18T04:00:00Z",
                "deadline_time": None,
                "timezone": "America/New_York",
                "reminder_minutes": -540,
            },
            creating=True,
        )

        self.assertIsNone(updates["deadline_time"])
        self.assertEqual(updates["reminder_minutes"], -540)

    def test_task_alert_validation_uses_deadline_kind(self):
        self.assertEqual(_normalize_task_reminder(10, False), 10)
        self.assertEqual(_normalize_task_reminder(-540, True), -540)
        with self.assertRaises(ValueError):
            _normalize_task_reminder(10, True)

    def test_clearing_deadline_also_disables_alert(self):
        updates = _task_updates_from_payload(
            {"deadline_at": None},
            existing={"deadline_at": "2026-05-18T13:00:00Z", "deadline_time": "09:00", "reminder_minutes": 10},
        )
        self.assertIsNone(updates["deadline_at"])
        self.assertIsNone(updates["deadline_time"])
        self.assertEqual(updates["reminder_minutes"], -1)

    def test_date_only_task_calendar_event_is_all_day(self):
        events = build_task_calendar_events([{
            "$id": "task-date",
            "title": "Reading day",
            "deadline_at": "2026-05-18T04:00:00Z",
            "deadline_time": None,
            "timezone": "America/New_York",
            "reminder_minutes": -1,
            "completed": False,
        }], [], datetime(2026, 5, 18, tzinfo=timezone.utc), datetime(2026, 5, 20, tzinfo=timezone.utc))

        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["is_all_day"])
        self.assertEqual(events[0]["reminder_minutes"], -1)

    def test_task_and_list_payloads_include_ui_preferences(self):
        task = _task_to_payload({
            "$id": "task-3",
            "title": "Pin this",
            "priority": "none",
            "starred": True,
        })
        task_updates = _task_updates_from_payload({"title": "Pin this", "starred": True}, creating=True)
        task_list = _list_to_payload({
            "$id": "list-1",
            "name": "Research",
            "description": "Longer context",
            "hidden": True,
            "sort_mode": "deadline",
        })

        self.assertTrue(task["starred"])
        self.assertTrue(task_updates["starred"])
        self.assertEqual(task_list["description"], "Longer context")
        self.assertTrue(task_list["hidden"])
        self.assertEqual(task_list["sort_mode"], "deadline")

    def test_list_sort_validation_rejects_unknown_mode(self):
        self.assertEqual(_normalize_sort_mode("title"), "title")
        with self.assertRaises(ValueError):
            _normalize_sort_mode("priority")

    def test_task_preferences_include_sound_toggle(self):
        with patch.object(ta, "first_row", return_value={"task_sound_enabled": False}):
            self.assertEqual(_task_preferences_for_user("user-1"), {"task_sound_enabled": False})
        with patch.object(ta, "first_row", return_value=None):
            self.assertEqual(_task_preferences_for_user("user-1"), {"task_sound_enabled": True})


class TestTasksApiRoutes(unittest.TestCase):
    def setUp(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(root, "templates"),
            static_folder=os.path.join(root, "static"),
        )
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.app.register_blueprint(ta.tasks_api_bp)
        self.user = SimpleNamespace(id="user-1")

    def test_update_task_list_persists_visibility_description_and_sort(self):
        existing = {"$id": "list-1", "user_id": "user-1", "name": "Research"}
        updated = {
            **existing,
            "description": "Paper queue",
            "hidden": True,
            "sort_mode": "date",
        }
        with self.app.test_request_context(
            "/api/task-lists/list-1",
            method="PATCH",
            json={"description": "Paper queue", "hidden": True, "sort_mode": "date"},
        ):
            with patch.object(ta, "current_user", self.user), \
                    patch.object(ta, "get_row_safe", return_value=existing), \
                    patch.object(ta, "update_row_safe", return_value=updated) as update_row:
                response = ta.update_task_list.__wrapped__("list-1")

        payload = response.get_json()["list"]
        self.assertTrue(payload["hidden"])
        self.assertEqual(payload["description"], "Paper queue")
        self.assertEqual(payload["sort_mode"], "date")
        self.assertEqual(update_row.call_args.args[2]["sort_mode"], "date")

    def test_task_patch_persists_starred(self):
        existing = {"$id": "task-1", "user_id": "user-1", "title": "Read"}
        updated = {**existing, "starred": True}
        with self.app.test_request_context("/api/tasks/task-1", method="PATCH", json={"starred": True}):
            with patch.object(ta, "current_user", self.user), \
                    patch.object(ta, "get_row_safe", return_value=existing), \
                    patch.object(ta, "update_row_safe", return_value=updated), \
                    patch.object(ta, "_completion_rows_for_task", return_value=[]):
                response = ta.update_task.__wrapped__("task-1")

        self.assertTrue(response.get_json()["task"]["starred"])

    def test_delete_completed_tasks_removes_one_off_and_clears_recurrence_completions(self):
        completed = {
            "$id": "task-completed",
            "user_id": "user-1",
            "list_id": "list-1",
            "title": "Done",
            "completed": True,
            "recurrence_json": None,
        }
        incomplete = {
            "$id": "task-open",
            "user_id": "user-1",
            "list_id": "list-1",
            "title": "Open",
            "completed": False,
            "recurrence_json": None,
        }
        recurring = {
            "$id": "task-recurring",
            "user_id": "user-1",
            "list_id": "list-1",
            "title": "Repeat",
            "completed": False,
            "recurrence_json": json.dumps({"every": 1, "unit": "week", "startDate": "2026-05-18", "endDate": None}),
        }
        completions = {
            "task-completed": [{"$id": "completion-1"}],
            "task-open": [],
            "task-recurring": [{"$id": "completion-2"}],
        }

        with self.app.test_request_context("/api/task-lists/list-1/completed-tasks", method="DELETE"):
            with patch.object(ta, "current_user", self.user), \
                    patch.object(ta, "_list_owner_or_404", return_value={"$id": "list-1"}), \
                    patch.object(ta, "list_rows_all", return_value=[completed, incomplete, recurring]), \
                    patch.object(ta, "_completion_rows_for_task", side_effect=lambda _user_id, task_id: completions[task_id]), \
                    patch.object(ta, "delete_row_safe") as delete_row:
                response = ta.delete_completed_tasks_in_list.__wrapped__("list-1")

        payload = response.get_json()
        self.assertEqual(payload["deleted_tasks"], 1)
        self.assertEqual(payload["cleared_completions"], 2)
        deleted_ids = [call.args[1] for call in delete_row.call_args_list]
        self.assertIn("task-completed", deleted_ids)
        self.assertIn("completion-1", deleted_ids)
        self.assertIn("completion-2", deleted_ids)
        self.assertNotIn("task-recurring", deleted_ids)


if __name__ == "__main__":
    unittest.main()
