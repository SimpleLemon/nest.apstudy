import copy
import os
import shutil
import sqlite3
import tempfile
import unittest
from datetime import timedelta
from unittest.mock import patch

from services import course_live_snapshots as snapshots
from services import professor_ratings
from services.professor_rating_identity import section_instructors


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

    def _roster_section(self, instructors, **extra):
        return {**self._section(), "campus": "Atlanta", "instructors": instructors,
                "instructor": instructors[0]["name"] if instructors else "TBA", **extra}

    def _merge_roster(self, original, live):
        return snapshots.merge_snapshot(self._roster_section(original), {"payload_json": {"instructors": live}})

    def test_unique_normalized_name_recovers_id_without_changing_live_details(self):
        original = [{"name": "Jane Q. Example", "atlas_id": "500", "email": "old@example.test"}]
        live = [{"name": " jane q example ", "email": "new@example.test", "role": "Instructor"}]
        before = copy.deepcopy((original, live))
        merged = self._merge_roster(original, live)
        self.assertEqual(merged["instructors"], [{**live[0], "atlas_id": "500"}])
        self.assertEqual(next(section_instructors(merged))["instructor_key"], "340:atlas:500")
        self.assertEqual((original, live), before)

    def test_cached_idless_snapshot_preserves_saved_rating_without_network(self):
        now = snapshots.utcnow()
        original = self._roster_section([{"name": "Jane Example", "atlas_id": "500"}])
        live = self._roster_section([{"name": "Jane Example", "email": "jane@example.test"}], seats_available=11)
        snapshots.upsert_snapshot(live, fetched_at=snapshots.isoformat(now))
        stored = {"instructor_key": "340:atlas:500", "name": "Jane Example", "school_id": "340",
                  "professor_id": "100", "overall_rating": 4.2, "difficulty": 3.1, "rating_count": 12,
                  "status": "matched", "verified": True, "fetched_at": snapshots.isoformat(now)}
        with patch.object(snapshots, "fetch_live_section_status") as fetch_live, \
                patch.object(professor_ratings, "_ratings_index", return_value={stored["instructor_key"]: stored}):
            merged, error, _fetched_at, stale = snapshots.refresh_section_snapshot(original, now=now)
            rating = professor_ratings.enrich_sections_with_professor_ratings([merged])[0]["professor_ratings"][0]
        fetch_live.assert_not_called()
        self.assertIsNone(error)
        self.assertFalse(stale)
        self.assertEqual(merged["seats_available"], 11)
        self.assertEqual(merged["instructors"][0]["atlas_id"], "500")
        self.assertEqual(rating["overall_rating"], 4.2)
        self.assertEqual(rating["profile_url"], "https://www.ratemyprofessors.com/professor/100")

    def test_unverified_or_wrong_term_snapshot_cannot_replace_the_catalog_professor(self):
        original = self._roster_section([{"name": "Jane Example", "atlas_id": "500"}], atlas_srcdb="5269")
        for srcdb in (None, "5271"):
            with self.subTest(srcdb=srcdb):
                payload = self._roster_section([{"name": "Unrelated Professor", "atlas_id": "600"}],
                                               atlas_srcdb=srcdb, seats_available=20)
                merged = snapshots.merge_snapshot(original, {"payload_json": payload, "fetched_at": snapshots.isoformat()})
                self.assertEqual(merged["instructors"], original["instructors"])
                self.assertEqual(merged["seats_available"], original["seats_available"])
                self.assertFalse(merged["live_snapshot_available"])
                self.assertTrue(merged["live_stale"])

    def test_old_unverified_snapshot_forces_a_verified_refresh(self):
        now = snapshots.utcnow()
        original = self._roster_section([{"name": "Jane Example", "atlas_id": "500"}], atlas_srcdb="5269")
        old = self._roster_section([{"name": "Unrelated Professor", "atlas_id": "600"}])
        snapshots.upsert_snapshot(old, fetched_at=snapshots.isoformat(now))
        live = {**original, "seats_available": 11}
        with patch.object(snapshots, "fetch_live_section_status", return_value={"section": live}) as fetch_live:
            merged, error, _fetched_at, stale = snapshots.refresh_section_snapshot(original, now=now)
        fetch_live.assert_called_once()
        self.assertIsNone(error)
        self.assertFalse(stale)
        self.assertEqual(merged["instructors"], original["instructors"])
        self.assertEqual(merged["seats_available"], 11)
        self.assertEqual(snapshots.snapshot_payload(snapshots.get_snapshot(original["id"]))["atlas_srcdb"], "5269")

    def test_failed_refresh_does_not_restore_an_unverified_professor(self):
        original = self._roster_section([{"name": "Jane Example", "atlas_id": "500"}], atlas_srcdb="5269")
        old = self._roster_section([{"name": "Unrelated Professor", "atlas_id": "600"}])
        snapshots.upsert_snapshot(old)
        with patch.object(snapshots, "fetch_live_section_status", return_value={"error": "Atlas unavailable"}):
            merged, error, fetched_at, stale = snapshots.refresh_section_snapshot(original)
        self.assertEqual(error, "Atlas unavailable")
        self.assertEqual(merged["instructors"], original["instructors"])
        self.assertIsNone(fetched_at)
        self.assertTrue(stale)

    def test_changed_name_does_not_inherit_original_id(self):
        merged = self._merge_roster([{"name": "Jane Example", "atlas_id": "500"}], [{"name": "Janet Example"}])
        self.assertNotIn("atlas_id", merged["instructors"][0])
        self.assertEqual(next(section_instructors(merged))["instructor_key"], "340:name:janet example")

    def test_duplicate_normalized_names_do_not_transfer_ids(self):
        cases = (
            ([{"name": "Jane Example", "atlas_id": "500"}, {"name": "Jane-Example", "atlas_id": "501"}],
             [{"name": "Jane Example"}]),
            ([{"name": "Jane Example", "atlas_id": "500"}],
             [{"name": "Jane Example"}, {"name": "Jane-Example"}]),
        )
        for original, live in cases:
            with self.subTest(original=original, live=live):
                merged = self._merge_roster(original, live)
                for instructor in merged["instructors"]:
                    self.assertNotIn("atlas_id", instructor)
                    self.assertTrue(instructor["atlas_id_conflict"])

    def test_any_explicit_live_id_alias_prevents_original_id_transfer(self):
        for field in ("atlas_id", "instructor_id", "id"):
            with self.subTest(field=field):
                live = {"name": "Jane Example", field: "new"}
                merged = self._merge_roster([{"name": "Jane Example", "atlas_id": "old"}], [live])
                self.assertEqual(merged["instructors"], [live])
                self.assertEqual(next(section_instructors(merged))["instructor_key"], "340:atlas:new")

    def test_conflict_marker_and_alias_conflicts_survive_cached_replay(self):
        cases = (
            [{"name": "Jane Example", "atlas_id_conflict": True}],
            [{"name": "Jane Example", "atlas_id": "500", "instructor_id": "501"}],
        )
        for live in cases:
            with self.subTest(live=live):
                merged = self._merge_roster([{"name": "Jane Example", "atlas_id": "500"}], live)
                identity = next(section_instructors(merged))
                self.assertTrue(identity["atlas_id_conflict"])
                self.assertEqual(identity["instructor_key"], "340:conflict:name:jane example")

    def test_unique_name_retains_conflicting_original_metadata_without_using_it(self):
        original = [{"name": "Jane Example", "atlas_id": "500", "instructor_id": "501", "id": "502"}]
        live = [{"name": "Jane-Example", "email": "new@example.test"}]
        merged = self._merge_roster(original, live)
        self.assertEqual(merged["instructors"], [{**original[0], **live[0], "atlas_id_conflict": True}])
        identity = next(section_instructors(merged))
        stored = {**identity, "status": "matched", "verified": True, "professor_id": "100",
                  "overall_rating": 4.2, "difficulty": 3.1, "rating_count": 12}
        rating = professor_ratings.public_entry(identity, stored)
        self.assertEqual(identity["instructor_key"], "340:conflict:name:jane example")
        self.assertEqual(rating["status"], "ambiguous")
        self.assertIsNone(rating["overall_rating"])
        self.assertIsNone(rating["profile_url"])

    def test_explicit_empty_roster_clears_previous_ratings(self):
        original = self._roster_section([{"name": "Jane Example", "atlas_id": "500"}])
        merged = snapshots.merge_snapshot(original, {"payload_json": {"instructor": "TBA", "instructors": []}})
        self.assertEqual(merged["instructor"], "TBA")
        self.assertEqual(merged["instructors"], [])
        self.assertEqual(professor_ratings.enrich_sections_with_professor_ratings([merged])[0]["professor_ratings"], [])
        for payload in ({}, {"instructors": None}):
            with self.subTest(payload=payload):
                unchanged = snapshots.merge_snapshot(original, {"payload_json": payload})
                self.assertEqual(unchanged["instructors"], original["instructors"])


if __name__ == "__main__":
    unittest.main()
