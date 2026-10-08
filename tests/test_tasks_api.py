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


    def selected_deletion(self, selection, tasks, completions=None):
        completions = completions or {}
        with self.app.test_request_context("/api/task-lists/list-1/completed-tasks", method="DELETE", json={"selection": selection}):
            with patch.object(ta, "current_user", self.user), \
                    patch.object(ta, "_list_owner_or_404", return_value={"$id": "list-1"}), \
                    patch.object(ta, "list_rows_all", return_value=tasks), \
                    patch.object(ta, "_completion_rows_for_task", side_effect=lambda _user_id, task_id: completions.get(task_id, [])), \
                    patch.object(ta, "delete_row_safe") as delete_row:
                response = ta.delete_completed_tasks_in_list.__wrapped__("list-1")
        return response, delete_row

    def test_selected_completed_delete_preserves_later_tasks_and_occurrences(self):
        old_time = "2026-10-01T12:00:00Z"
        new_time = "2026-10-05T12:00:00Z"
        def task(task_id, **updates):
            return {"$id": task_id, "user_id": "user-1", "list_id": "list-1", "completed": True, "completed_at": old_time, **updates}
        recurring = task("repeat", recurrence_json=json.dumps({"every": 1, "unit": "week", "startDate": "2026-10-01", "endDate": None}))
        def occurrence(row_id, key, timestamp, **updates):
            return {"$id": row_id, "user_id": "user-1", "task_id": "repeat", "occurrence_key": key, "completed_at": timestamp, **updates}
        selection = [
            {"task_id": "selected", "completed_at": "2026-10-01T12:00:00.000Z"},
            {"task_id": "recompleted", "completed_at": old_time},
            {"task_id": "moved", "completed_at": old_time},
            {"task_id": "repeat", "occurrences": [
                {"id": "old-row", "occurrence_key": "old", "completed_at": old_time},
                {"id": "original-row", "occurrence_key": "recompleted", "completed_at": old_time},
            ]},
        ]
        response, deleted = self.selected_deletion(selection, [task("selected"), task("later", completed_at=new_time),
            task("recompleted", completed_at=new_time), task("moved", list_id="list-2"), recurring], {"repeat": [
                occurrence("old-row", "old", old_time), occurrence("new-row", "next", new_time),
                occurrence("replacement-row", "recompleted", new_time),
            ]})
        self.assertEqual(response.get_json(), {"ok": True, "deleted_tasks": 1, "cleared_completions": 1})
        self.assertEqual([call.args[1] for call in deleted.call_args_list], ["selected", "old-row"])

    def test_empty_selection_is_noop_and_never_falls_back_to_sweep(self):
        response, deleted = self.selected_deletion([], [{"$id": "done", "user_id": "user-1", "list_id": "list-1", "completed": True}])
        self.assertEqual(response.get_json()["deleted_tasks"], 0)
        deleted.assert_not_called()

    def test_selected_delete_filters_foreign_and_other_list_records(self):
        selection = [{"task_id": task_id, "completed_at": None} for task_id in ["foreign", "other-list"]]
        response, deleted = self.selected_deletion(selection, [
            {"$id": "foreign", "user_id": "someone-else", "list_id": "list-1", "completed": True},
            {"$id": "other-list", "user_id": "user-1", "list_id": "list-2", "completed": True},
        ])
        self.assertEqual(response.get_json()["deleted_tasks"], 0)
        deleted.assert_not_called()

    def test_selected_delete_requires_current_owned_list(self):
        from werkzeug.exceptions import NotFound
        with self.app.test_request_context("/api/task-lists/foreign/completed-tasks", method="DELETE", json={"selection": []}):
            with patch.object(ta, "current_user", self.user), patch.object(ta, "get_row_safe", return_value={"user_id": "someone-else"}), patch.object(ta, "delete_row_safe") as deleted:
                with self.assertRaises(NotFound):
                    ta.delete_completed_tasks_in_list.__wrapped__("foreign")
                deleted.assert_not_called()

    def test_recurring_selection_rechecks_completion_owner_identity_and_timestamp(self):
        timestamp = "2026-10-01T12:00:00Z"
        task = {"$id": "repeat", "user_id": "user-1", "list_id": "list-1", "recurrence_json": json.dumps({"every": 1, "unit": "week", "startDate": "2026-10-01"})}
        selection = [{"task_id": "repeat", "occurrences": [{"id": "captured", "occurrence_key": "old", "completed_at": timestamp}]}]
        for updates in [{"user_id": "someone-else"}, {"task_id": "different"}, {"$id": "replacement"}, {"completed_at": "2026-10-05T12:00:00Z"}]:
            with self.subTest(updates=updates):
                completion = {"$id": "captured", "user_id": "user-1", "task_id": "repeat", "occurrence_key": "old", "completed_at": timestamp, **updates}
                response, deleted = self.selected_deletion(selection, [task], {"repeat": [completion]})
                self.assertEqual(response.get_json()["cleared_completions"], 0)
                deleted.assert_not_called()

    def test_invalid_selected_delete_payloads_reject_before_any_mutation(self):
        invalid = [None, {}, [None], [{"task_id": "one"}], [{"task_id": "one", "completed_at": "bad"}],
            [{"task_id": "one", "completed_at": None}, {"task_id": "one", "completed_at": None}],
            [{"task_id": "repeat", "occurrences": None}],
            [{"task_id": "repeat", "occurrences": [{"occurrence_key": "old"}]}],
            [{"task_id": "repeat", "occurrences": [{"occurrence_key": "old", "completed_at": "bad"}]}],
        ]
        for selection in invalid:
            with self.subTest(selection=selection):
                response, deleted = self.selected_deletion(selection, [])
                self.assertEqual(response[1], 400)
                deleted.assert_not_called()

    def test_malformed_selection_json_never_uses_legacy_sweep(self):
        with self.app.test_request_context("/api/task-lists/list-1/completed-tasks", method="DELETE", data="broken", content_type="application/json"):
            with patch.object(ta, "current_user", self.user), patch.object(ta, "_list_owner_or_404"), patch.object(ta, "delete_row_safe") as deleted:
                response = ta.delete_completed_tasks_in_list.__wrapped__("list-1")
        self.assertEqual(response[1], 400)
        deleted.assert_not_called()


if __name__ == "__main__":
    unittest.main()
