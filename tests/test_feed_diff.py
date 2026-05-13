import unittest
from datetime import datetime, timezone

from appwrite_helpers import format_datetime
from services.feed_diff import diff_events


class TestFeedDiff(unittest.TestCase):
    def test_diff_new_changed_deleted(self):
        start = datetime(2026, 5, 12, 10, 0, 0, tzinfo=timezone.utc)
        end = datetime(2026, 5, 12, 11, 0, 0, tzinfo=timezone.utc)
        fetched_at = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)

        existing_rows = [
            {
                "$id": "row-1",
                "event_uid": "uid-1",
                "event_title": "Homework 1",
                "event_start": format_datetime(start),
                "event_end": format_datetime(end),
                "event_type": "assignment",
                "course_name": "CS 101",
                "raw_description": "Old",
                "is_all_day": False,
            },
            {
                "$id": "row-2",
                "event_uid": "uid-2",
                "event_title": "Quiz 1",
                "event_start": format_datetime(start),
                "event_end": format_datetime(end),
                "event_type": "quiz",
                "course_name": "CS 101",
                "raw_description": "Old",
                "is_all_day": False,
            },
            {
                "$id": "row-3",
                "event_uid": "uid-3",
                "event_title": "Old Event",
                "event_start": format_datetime(start),
                "event_end": format_datetime(end),
                "event_type": "event",
                "course_name": "CS 101",
                "raw_description": "Old",
                "is_all_day": False,
            },
        ]

        incoming_events = [
            {
                "uid": "uid-1",
                "title": "Homework 1",
                "start": start,
                "end": end,
                "event_type": "assignment",
                "course_name": "CS 101",
                "description": "Old",
                "is_all_day": False,
            },
            {
                "uid": "uid-2",
                "title": "Quiz 1 (Updated)",
                "start": start,
                "end": end,
                "event_type": "quiz",
                "course_name": "CS 101",
                "description": "New",
                "is_all_day": False,
            },
            {
                "uid": "uid-4",
                "title": "New Event",
                "start": start,
                "end": end,
                "event_type": "event",
                "course_name": "CS 101",
                "description": "New",
                "is_all_day": False,
            },
        ]

        diff = diff_events(
            existing_rows,
            incoming_events,
            user_id="user-1",
            feed_url="https://example.com/feed",
            fetched_at=fetched_at,
        )

        self.assertEqual(len(diff.to_create), 1)
        self.assertEqual(len(diff.to_update), 1)
        self.assertEqual(len(diff.to_delete), 1)
        self.assertEqual(len(diff.unchanged), 1)


if __name__ == "__main__":
    unittest.main()
