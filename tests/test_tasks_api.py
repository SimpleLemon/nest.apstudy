import json
import unittest
from datetime import datetime, timezone

from blueprints.tasks_api import (
    TASK_CALENDAR_ID,
    _normalize_recurrence,
    _task_updates_from_payload,
    build_task_calendar_events,
)


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


if __name__ == "__main__":
    unittest.main()
