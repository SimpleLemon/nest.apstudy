import os
import tempfile
import unittest

from appwrite.exception import AppwriteException
from appwrite.query import Query

from services import calendar_store as store
from tests.support.harness import bootstrap_calendar_db


class CalendarStoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.tmpdir.name, "nest.sqlite3")
        self.previous_database_path = os.environ.get("DATABASE_PATH")
        self.previous_calendar_path = os.environ.get("CALENDAR_SQLITE_PATH")
        os.environ["DATABASE_PATH"] = self.db_path
        os.environ.pop("CALENDAR_SQLITE_PATH", None)
        bootstrap_calendar_db(self.db_path)

    def tearDown(self):
        if self.previous_database_path is None:
            os.environ.pop("DATABASE_PATH", None)
        else:
            os.environ["DATABASE_PATH"] = self.previous_database_path
        if self.previous_calendar_path is None:
            os.environ.pop("CALENDAR_SQLITE_PATH", None)
        else:
            os.environ["CALENDAR_SQLITE_PATH"] = self.previous_calendar_path
        self.tmpdir.cleanup()

    def test_crud_count_and_appwrite_id_shape(self):
        created = store.create_calendar_row(
            "user_events",
            row_id="event-1",
            data={
                "user_id": "user-1",
                "title": "Study",
                "description": "",
                "start": "2026-05-20T14:00:00Z",
                "end": "2026-05-20T15:00:00Z",
                "is_all_day": False,
                "calendar_id": "local:default",
                "created_at": "2026-05-18T00:00:00Z",
            },
        )

        self.assertEqual(created["id"], "event-1")
        self.assertEqual(created["$id"], "event-1")
        self.assertFalse(created["is_all_day"])
        self.assertEqual(store.count_calendar_rows("user_events", [Query.equal("user_id", ["user-1"])]), 1)

        updated = store.update_calendar_row("user_events", "event-1", {"is_all_day": True})
        self.assertTrue(updated["is_all_day"])

        rows = store.list_calendar_rows_all(
            "user_events",
            [Query.equal("user_id", ["user-1"]), Query.order_desc("start")],
        )
        self.assertEqual([row["$id"] for row in rows], ["event-1"])

        store.delete_calendar_row("user_events", "event-1")
        self.assertEqual(store.count_calendar_rows("user_events"), 0)

    def test_appwrite_system_metadata_is_ignored(self):
        created = store.create_calendar_row(
            "calendar_cache",
            row_id="cache-1",
            data={
                "$id": "cache-1",
                "$sequence": 42,
                "$createdAt": "2026-05-18T00:00:00Z",
                "$updatedAt": "2026-05-18T00:00:00Z",
                "$permissions": [],
                "user_id": "user-1",
                "feed_url": "https://example.test/feed.ics",
                "feed_url_hash": "hash",
                "event_uid": "uid-1",
                "event_title": "Assignment",
            },
        )

        self.assertEqual(created["$id"], "cache-1")
        self.assertNotIn("$sequence", created)
        self.assertEqual(created["event_title"], "Assignment")

    def test_unique_constraints_match_calendar_contracts(self):
        payload = {
            "user_id": "user-1",
            "calendar_name": "canvas",
            "display_name": "Canvas",
            "color_hex": "#6366f1",
            "visible": True,
            "created_at": "2026-05-18T00:00:00Z",
        }
        store.create_calendar_row("user_calendar_preferences", "pref-1", payload)

        with self.assertRaises(AppwriteException):
            store.create_calendar_row("user_calendar_preferences", "pref-2", payload)

    def test_range_queries_and_nullable_boolean_round_trip(self):
        store.create_calendar_row(
            "user_event_overrides",
            "override-1",
            {
                "user_id": "user-1",
                "event_ref": "feed:abc",
                "hidden": False,
                "is_all_day": None,
                "start": "2026-05-20T14:00:00Z",
                "end": "2026-05-20T15:00:00Z",
                "created_at": "2026-05-18T00:00:00Z",
            },
        )

        rows = store.list_calendar_rows_all(
            "user_event_overrides",
            [
                Query.equal("user_id", ["user-1"]),
                Query.less_than("start", "2026-05-21T00:00:00Z"),
                Query.greater_than("end", "2026-05-19T00:00:00Z"),
            ],
        )

        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["hidden"])
        self.assertIsNone(rows[0]["is_all_day"])


if __name__ == "__main__":
    unittest.main()
