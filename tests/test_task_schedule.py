"""Pure shared occurrence contracts, including bounded expansion and DST."""

import json
import unittest
import tempfile
from pathlib import Path
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from services import task_schedule

UTC = timezone.utc


def utc(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def task(start="2026-01-31", unit="month", **overrides):
    row = {
        "id": "task-1", "title": "Review", "priority": "none",
        "deadline_at": start + "T14:00:00Z", "deadline_time": "14:00",
        "timezone": "UTC", "completed": False, "reminder_minutes": 10,
        "recurrence_json": json.dumps({"unit": unit, "every": 1, "startDate": start}),
    }
    row.update(overrides)
    return row


class TaskScheduleTests(unittest.TestCase):
    def keys(self, row, start, end, completions=None):
        return [item["occurrence_key"] for item in task_schedule.build_task_occurrences(
            [row], completions, utc(start), utc(end),
        )]

    def test_monthly_clamping_advances_from_previous_occurrence(self):
        # Established rules clamp each step, so March retains February's day.
        self.assertEqual(self.keys(task(), "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z"),
                         ["2026-01-31", "2026-02-28", "2026-03-28", "2026-04-28"])
        leap = task(start="2024-01-31")
        self.assertEqual(self.keys(leap, "2024-01-01T00:00:00Z", "2024-04-01T00:00:00Z"),
                         ["2024-01-31", "2024-02-29", "2024-03-29"])

    def test_yearly_leap_clamping_does_not_reanchor_in_later_leap_year(self):
        self.assertEqual(self.keys(task(start="2024-02-29", unit="year"),
                                   "2024-01-01T00:00:00Z", "2029-01-01T00:00:00Z"),
                         ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28", "2028-02-28"])

    def test_multi_month_intervals_and_inclusive_recurrence_end(self):
        row = task(recurrence_json={"unit": "month", "every": 2, "start_date": "2026-01-31", "end_date": "2026-05-31"})
        self.assertEqual(self.keys(row, "2026-01-01T00:00:00Z", "2026-12-01T00:00:00Z"),
                         ["2026-01-31", "2026-03-31", "2026-05-31"])

    def test_local_clock_and_keys_survive_spring_and_fall_dst(self):
        for start, bounds, offsets in [
            ("2026-03-07", ("2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z"), [14, 13, 13]),
            ("2026-10-31", ("2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z"), [13, 14, 14]),
        ]:
            with self.subTest(start=start):
                row = task(start=start, unit="day", timezone="America/New_York", deadline_time="09:00")
                items = task_schedule.build_task_occurrences([row], [], *(utc(value) for value in bounds))
                self.assertEqual([item["start"].hour for item in items], offsets)
                self.assertEqual([item["occurrence_key"] for item in items],
                                 [(utc(start + "T00:00:00Z") + timedelta(days=n)).date().isoformat() for n in range(3)])
                self.assertTrue(all(item["end"] - item["start"] == timedelta(minutes=30) for item in items))

    def test_all_day_dst_bounds_are_local_midnights(self):
        for start, hours in [("2026-03-08", 23), ("2026-11-01", 25)]:
            with self.subTest(start=start):
                row = task(start=start, unit="day", timezone="America/New_York", deadline_time=None,
                           recurrence_json={"unit": "day", "startDate": start, "endDate": start})
                item = task_schedule.build_task_occurrences([row])[0]
                self.assertTrue(item["is_all_day"])
                self.assertEqual(item["end"] - item["start"], timedelta(hours=hours))

    def test_utc_ranges_are_exclusive_at_both_touching_edges(self):
        row = task(start="2026-01-31", recurrence_json=None)
        self.assertEqual(self.keys(row, "2026-01-31T14:30:00Z", "2026-02-01T00:00:00Z"), [])
        self.assertEqual(self.keys(row, "2026-01-01T00:00:00Z", "2026-01-31T14:00:00Z"), [])
        self.assertEqual(self.keys(row, "2026-01-31T14:29:59Z", "2026-01-31T14:30:00Z"), ["single"])
        repeating = task(start="2026-01-31", unit="day")
        self.assertEqual(self.keys(repeating, "2026-02-01T14:30:00Z", "2026-02-02T14:00:00Z"), [])

    def test_completion_identity_is_per_task_and_per_occurrence(self):
        repeating = task(start="2026-02-01", unit="day", completed=True)
        completions = [{"task_id": "other-task", "occurrence_key": "2026-02-01"},
                       {"task_id": "task-1", "occurrence_key": "single"},
                       {"task_id": "task-1", "occurrence_key": "2026-02-02"}]
        items = task_schedule.build_task_occurrences([repeating], completions,
                 utc("2026-02-01T00:00:00Z"), utc("2026-02-04T00:00:00Z"))
        self.assertEqual([item["completed"] for item in items], [False, True, False])
        one_off = task(recurrence_json=None, completed=True)
        self.assertTrue(task_schedule.build_task_occurrences([one_off])[0]["completed"])

    def test_long_horizon_is_bounded_including_skipped_occurrences(self):
        row = task(start="2000-01-01", unit="day")
        start = utc("2000-01-01T00:00:00Z")
        items = task_schedule.build_task_occurrences([row], [], start, utc("2010-01-01T00:00:00Z"))
        self.assertEqual(len(items), task_schedule.MAX_EXPANDED_OCCURRENCES)
        self.assertEqual(items[-1]["occurrence_key"],
                         (start + timedelta(days=task_schedule.MAX_EXPANDED_OCCURRENCES - 1)).date().isoformat())
        self.assertEqual(self.keys(row, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"), [])
        near_guard = start + timedelta(days=task_schedule.MAX_EXPANDED_OCCURRENCES - 1)
        remaining = task_schedule.build_task_occurrences([row], [], near_guard, near_guard + timedelta(days=7))
        self.assertEqual(len(remaining), 1)

    def test_next_key_never_returns_past_date_after_guard_exhaustion(self):
        row = task(start="2000-01-01", unit="day")
        self.assertIsNone(task_schedule.next_task_occurrence_key(row, utc("2026-01-01T00:00:00Z")))
        final = utc("2000-01-01T00:00:00Z") + timedelta(days=task_schedule.MAX_EXPANDED_OCCURRENCES)
        self.assertEqual(task_schedule.next_task_occurrence_key(row, final), final.date().isoformat())

    def test_next_key_uses_local_date_and_recurrence_end(self):
        row = task(start="2026-03-01", unit="week", timezone="America/New_York",
                   recurrence_json={"unit": "week", "startDate": "2026-03-01", "endDate": "2026-03-08"})
        self.assertEqual(task_schedule.next_task_occurrence_key(row, utc("2026-03-09T01:00:00Z")), "2026-03-08")
        self.assertIsNone(task_schedule.next_task_occurrence_key(row, utc("2026-03-09T05:00:00Z")))
        self.assertEqual(task_schedule.next_task_occurrence_key(task(recurrence_json=None)), "single")

    def test_calendar_ics_and_completion_consumers_share_occurrence_identity(self):
        from services import calendar_ics_contract, calendar_ics_tasks, task_calendar
        from blueprints import tasks_api
        row = task(start="2026-03-07", unit="day", timezone="America/New_York", deadline_time="09:00")
        begin, end = utc("2026-03-08T00:00:00Z"), utc("2026-03-09T00:00:00Z")
        completions = [{"task_id": "task-1", "occurrence_key": "2026-03-08"}]
        occurrence = task_schedule.build_task_occurrences([row], completions, begin, end)[0]
        event = task_calendar.build_task_calendar_events([row], completions, begin, end)[0]
        self.assertEqual(event["event_ref"], "task:task-1:" + occurrence["occurrence_key"])
        self.assertTrue(event["completed"])
        self.assertEqual(tasks_api._next_occurrence_key(row, occurrence["start"]), occurrence["occurrence_key"])
        with patch.object(calendar_ics_contract, "CALENDAR_ICS_UID_SECRET", "s" * 32):
            projected = calendar_ics_tasks.project_tasks([row], completions, begin, end)
            expected_uid = calendar_ics_contract.build_calendar_ics_uid("tasks", event["event_ref"])
        self.assertEqual(projected.events[0].uid, expected_uid)
        self.assertTrue(projected.events, projected)
        self.assertEqual(projected.events[0].start, occurrence["start"])
        self.assertTrue(projected.events[0].completed)

    def test_reminder_claims_use_calendar_identity_across_dst(self):
        from flask import Flask
        from services import notifications, task_calendar
        from services.database import init_db, db_connection
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "reminders.sqlite3")
            app = Flask(__name__)
            app.config["DATABASE_PATH"] = path
            init_db(app, path)
            row = task(start="2026-03-07", unit="day", timezone="America/New_York", deadline_time="09:00")
            with app.app_context():
                with db_connection() as conn:
                    conn.execute("INSERT INTO user_settings (id,user_id,created_at,timezone) VALUES ('settings','user','2026-01-01T00:00:00Z','America/New_York')")
                    conn.execute("INSERT INTO tasks (id,user_id,list_id,title,deadline_at,deadline_time,timezone,recurrence_json,reminder_minutes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                                 [row["id"], "user", "list", row["title"], row["deadline_at"], row["deadline_time"], row["timezone"], row["recurrence_json"], row["reminder_minutes"], "2026-01-01T00:00:00Z"])
                begin, end = utc("2026-03-08T00:00:00Z"), utc("2026-03-09T00:00:00Z")
                event = task_calendar.build_task_calendar_events([row], [], begin, end)[0]
                with patch.object(notifications, "notify", return_value=("notification", {"accepted": 1})) as notify:
                    self.assertEqual(notifications.check_calendar_reminders(utc("2026-03-08T12:50:00Z")), 1)
                self.assertEqual(notify.call_args.kwargs["source_ref"], event["event_ref"])
                with db_connection() as conn:
                    claim = dict(conn.execute("SELECT * FROM calendar_reminder_claims").fetchone())
                self.assertEqual(claim["event_ref"], event["event_ref"])
                self.assertEqual(utc(claim["occurrence_start"]), utc(event["start"]))
