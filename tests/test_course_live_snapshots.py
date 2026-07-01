import os
import shutil
import sqlite3
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch

from services import course_live_snapshots as snapshots


class CourseLiveSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmpdir)
        self.db_path = os.path.join(self.tmpdir, "nest.sqlite3")
        conn = sqlite3.connect(self.db_path)
        try:
            with open(os.path.join(os.getcwd(), "migrations", "002_course_live_snapshots.sql"), encoding="utf-8") as handle:
                conn.executescript(handle.read())
            conn.commit()
        finally:
            conn.close()
        self.env_patch = patch.dict(os.environ, {"DATABASE_PATH": self.db_path})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def _section(self, seats=2):
        return {
            "id": "Fall_2026|CHEM|150|2760|1",
            "term": "Fall_2026",
            "subject": "CHEM",
            "catalog_number": "150",
            "course_code": "CHEM 150",
            "course_title": "Structure and Properties",
            "crn": "2760",
            "section_number": "1",
            "enrollment_status": "Open",
            "seats_available": seats,
            "enrollment_capacity": 36,
            "is_cancelled": False,
        }

    def test_upsert_and_merge_snapshot(self):
        fetched_at = "2026-06-25T10:00:00Z"
        snapshot = snapshots.upsert_snapshot(self._section(seats=7), fetched_at=fetched_at)

        merged = snapshots.merge_snapshot({"id": self._section()["id"], "seats_available": 0}, snapshot)

        self.assertEqual(snapshot["section_id"], self._section()["id"])
        self.assertEqual(merged["seats_available"], 7)
        self.assertEqual(merged["enrollment_capacity"], 36)
        self.assertEqual(merged["live_updated_at"], fetched_at)
        self.assertTrue(merged["live_snapshot_available"])

    def test_snapshot_freshness_uses_thirty_minutes(self):
        now = snapshots.utcnow()
        fresh = {"fetched_at": snapshots.isoformat(now - timedelta(minutes=29))}
        stale = {"fetched_at": snapshots.isoformat(now - timedelta(minutes=31))}

        self.assertTrue(snapshots.snapshot_is_fresh(fresh, now=now))
        self.assertFalse(snapshots.snapshot_is_fresh(stale, now=now))

    def test_fresh_snapshot_skips_atlas_fetch(self):
        now = snapshots.utcnow()
        snapshots.upsert_snapshot(self._section(seats=5), fetched_at=snapshots.isoformat(now))

        with patch.object(snapshots, "fetch_live_section_status") as fetch_live:
            section, error, fetched_at, stale = snapshots.refresh_section_snapshot(self._section(), now=now)

        fetch_live.assert_not_called()
        self.assertIsNone(error)
        self.assertFalse(stale)
        self.assertEqual(section["seats_available"], 5)
        self.assertEqual(fetched_at, snapshots.isoformat(now))

    def test_force_refresh_calls_atlas_and_persists(self):
        now = snapshots.utcnow()
        live = self._section(seats=11)
        with patch.object(snapshots, "fetch_live_section_status", return_value={"section": live}) as fetch_live:
            section, error, fetched_at, stale = snapshots.refresh_section_snapshot(self._section(), force=True, now=now)

        fetch_live.assert_called_once()
        self.assertIsNone(error)
        self.assertFalse(stale)
        self.assertEqual(section["seats_available"], 11)
        self.assertEqual(snapshots.get_snapshot(self._section()["id"])["seats_available"], 11)
        self.assertEqual(fetched_at, snapshots.isoformat(now))

    def test_atlas_failure_falls_back_to_existing_snapshot(self):
        now = snapshots.utcnow()
        old_time = snapshots.isoformat(now - timedelta(minutes=45))
        snapshots.upsert_snapshot(self._section(seats=3), fetched_at=old_time)

        with patch.object(snapshots, "fetch_live_section_status", return_value={"error": "Atlas unavailable"}):
            section, error, fetched_at, stale = snapshots.refresh_section_snapshot(self._section(), now=now)

        self.assertEqual(error, "Atlas unavailable")
        self.assertTrue(stale)
        self.assertEqual(section["seats_available"], 3)
        self.assertEqual(fetched_at, old_time)


if __name__ == "__main__":
    unittest.main()
