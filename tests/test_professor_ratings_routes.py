"""Rating projections stay attached to authoritative section identities."""

import unittest
from unittest.mock import patch

from flask import Flask

from blueprints import atlas_api, courses
from services import saved_courses


SECTION_ID = "Fall_2026|CHEM|150|2760|1"


def section_fixture():
    return {
        "id": SECTION_ID,
        "term": "Fall_2026",
        "subject": "CHEM",
        "catalog_number": "150",
        "campus": "Atlanta",
        "instructor": "Example Professor",
        "instructors": [{"name": "Example Professor"}],
        "enrollment_status": "Open",
        "seats_available": 3,
    }


def add_fixture_ratings(sections):
    return [{**section, "professor_ratings": [{
        "name": section["instructors"][0]["name"],
        "status": "matched", "overall_rating": 4.0, "rating_count": 12,
    }]} for section in sections]


class ProfessorRatingsRouteTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.register_blueprint(atlas_api.atlas_bp, url_prefix="/api/atlas")
        self.client = self.app.test_client()

    def test_sections_and_by_id_add_ratings_after_live_merge(self):
        for method, url in (
            ("get", "/api/atlas/sections?term=Fall_2026"),
            ("post", "/api/atlas/sections/by-id"),
        ):
            with self.subTest(method=method):
                section = section_fixture()
                result = {"sections": [section], "count": 1, "total": 1}
                with patch.object(atlas_api, "get_sections_index", return_value=result), \
                        patch.object(atlas_api, "get_sections_by_ids", return_value=result), \
                        patch.object(atlas_api, "merge_snapshots_into_sections", return_value=[{
                            **section, "seats_available": 7,
                        }]), \
                        patch.object(atlas_api, "enrich_sections_with_professor_ratings", side_effect=add_fixture_ratings) as enrich:
                    response = getattr(self.client, method)(url, json={"section_ids": [SECTION_ID]})
                self.assertEqual(response.status_code, 200)
                row = response.json["sections"][0]
                self.assertEqual(row["seats_available"], 7)
                self.assertEqual(row["professor_ratings"][0]["name"], "Example Professor")
                self.assertEqual(enrich.call_args.args[0][0]["seats_available"], 7)
                self.assertNotIn("professor_ratings", section)

    def test_detail_refresh_and_batch_return_cached_rating_projection(self):
        section = section_fixture()
        for view, body in (
            (courses.section_status, {"section_id": SECTION_ID}),
            (courses.section_status_batch, {"section_ids": [SECTION_ID]}),
        ):
            with self.subTest(view=view.__name__), self.app.test_request_context("/", method="POST", json=body):
                with patch.object(courses, "_require_emory_student", return_value=None), \
                        patch.object(courses, "_get_section_by_id", return_value=section), \
                        patch.object(courses, "_merge_live_section", return_value=(section, None, "2026-10-06T12:00:00Z", False)), \
                        patch.object(courses, "enrich_sections_with_professor_ratings", side_effect=add_fixture_ratings):
                    response = view.__wrapped__()
                payload = response.json
                row = payload.get("section") or payload["sections_by_id"][SECTION_ID]
                self.assertEqual(row["professor_ratings"][0]["overall_rating"], 4.0)
                self.assertEqual(row["seats_available"], 3)

    def test_saved_course_display_override_cannot_reassign_a_professor_rating(self):
        section = section_fixture()
        course = {
            "id": "saved-course", "term": "Fall_2026", "subject": "CHEM", "catalog": "150",
            "course_overrides_json": {"instructor_name": "My custom label"},
        }
        with patch.object(saved_courses, "enrich_sections_with_professor_ratings", side_effect=add_fixture_ratings) as enrich:
            row = saved_courses._serialize_course(course, section)
        self.assertEqual(row["instructor"], "My custom label")
        self.assertEqual(row["professor_ratings"][0]["name"], "Example Professor")
        self.assertEqual(enrich.call_args.args[0][0], section)


if __name__ == "__main__":
    unittest.main()
