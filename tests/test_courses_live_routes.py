import unittest
from unittest.mock import patch

from flask import Flask

from blueprints import courses


class CoursesLiveRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)

    def _unwrap(self, view):
        while hasattr(view, "__wrapped__"):
            view = view.__wrapped__
        return view

    def _section(self, seats=0):
        return {
            "id": "Fall_2026|CHEM|150|2760|1",
            "term": "Fall_2026",
            "subject": "CHEM",
            "catalog_number": "150",
            "crn": "2760",
            "section_number": "1",
            "enrollment_status": "Closed",
            "seats_available": seats,
        }

    def test_section_status_uses_server_merge_and_returns_stale_metadata(self):
        section = self._section()
        refreshed = {**section, "seats_available": 4, "live_snapshot_available": True}
        with self.app.test_request_context("/api/courses/section-status", method="POST", json={"section_id": section["id"], "force": True}):
            with patch.object(courses, "_require_emory_student", return_value=None), \
                    patch.object(courses, "_get_section_by_id", return_value=section), \
                    patch.object(courses, "_merge_live_section", return_value=(refreshed, None, "2026-06-25T10:00:00Z", False)) as merge_live:
                response = self._unwrap(courses.section_status)()

        payload = response.get_json()
        merge_live.assert_called_once()
        self.assertTrue(merge_live.call_args.args[1]["force"])
        self.assertEqual(payload["section"]["seats_available"], 4)
        self.assertFalse(payload["live_stale"])

    def test_section_status_batch_hydrates_sections_and_reports_errors(self):
        section = self._section()
        refreshed = {**section, "seats_available": 2, "live_snapshot_available": True}

        def find_section(section_id):
            return section if section_id == section["id"] else None

        with self.app.test_request_context(
            "/api/courses/section-status/batch",
            method="POST",
            json={"section_ids": [section["id"], "missing"], "force": False},
        ):
            with patch.object(courses, "_require_emory_student", return_value=None), \
                    patch.object(courses, "_get_section_by_id", side_effect=find_section), \
                    patch.object(courses, "_merge_live_section", return_value=(refreshed, None, "2026-06-25T10:00:00Z", False)):
                response = self._unwrap(courses.section_status_batch)()

        payload = response.get_json()
        self.assertEqual(payload["sections_by_id"][section["id"]]["seats_available"], 2)
        self.assertEqual(payload["errors_by_id"]["missing"], "Course section not found.")
        self.assertFalse(payload["stale_by_id"][section["id"]])


if __name__ == "__main__":
    unittest.main()
