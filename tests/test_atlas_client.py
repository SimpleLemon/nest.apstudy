import unittest

from services.atlas_client import (
    _filter_sections_result,
    get_sections_index,
    get_starred_general_ed_requirements,
    is_section_trackable,
    search_courses,
)


class AtlasClientTests(unittest.TestCase):
    def test_zero_seat_sections_are_trackable_even_with_status_mismatch(self):
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": 0,
        }))
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Open",
            "seats_available": "0 seats",
        }))
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Waitlist",
            "seats_available": "0",
        }))

    def test_positive_seat_sections_are_not_trackable(self):
        self.assertFalse(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": 1,
        }))
        self.assertFalse(is_section_trackable({
            "enrollment_status": "Open",
            "seats_available": 3,
        }))

    def test_closed_sections_without_explicit_seats_are_trackable(self):
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": None,
        }))

    def test_cancelled_sections_are_not_trackable(self):
        self.assertFalse(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": 0,
            "is_cancelled": True,
        }))

    def test_section_search_exact_code_and_no_space_query(self):
        spaced = get_sections_index(term="Fall_2026", include_cancelled=False, query="CHEM 150", limit=10)
        compact = get_sections_index(term="Fall_2026", include_cancelled=False, query="chem150", limit=10)

        self.assertGreater(spaced["total"], 0)
        self.assertGreater(compact["total"], 0)
        self.assertEqual(spaced["sections"][0]["course_code"], "CHEM 150")
        self.assertEqual(compact["sections"][0]["course_code"], "CHEM 150")

    def test_section_search_crn_title_instructor_and_limit(self):
        chem = get_sections_index(term="Fall_2026", include_cancelled=False, query="CHEM 150", limit=1)
        self.assertEqual(chem["count"], 1)
        crn = chem["sections"][0]["crn"]
        if crn:
            by_crn = get_sections_index(term="Fall_2026", include_cancelled=False, query=crn, limit=5)
            self.assertEqual(by_crn["sections"][0]["crn"], crn)

        title = get_sections_index(term="Fall_2026", include_cancelled=False, query="structure and properties", limit=10)
        self.assertGreater(title["total"], 0)
        self.assertTrue(any("CHEM 150" == section["course_code"] for section in title["sections"]))

    def test_cancelled_filter_excludes_cancelled_sections(self):
        result = get_sections_index(term="Fall_2026", include_cancelled=False, query="CHEM", limit=50)
        self.assertTrue(result["sections"])
        self.assertFalse(any(section["is_cancelled"] for section in result["sections"]))

    def test_onboarding_search_uses_indexed_results(self):
        result = search_courses("CHEM 150", term="Fall_2026")
        self.assertGreater(result["count"], 0)
        self.assertEqual(result["results"][0]["course_code"], "CHEM 150")

    def test_campus_filter_treats_existing_unknown_corpus_as_atlanta(self):
        atlanta = get_sections_index(term="Fall_2026", include_cancelled=False, query="CHEM 150", campus="atlanta", limit=10)
        oxford = get_sections_index(term="Fall_2026", include_cancelled=False, query="CHEM 150", campus="oxford", limit=10)

        self.assertGreater(atlanta["total"], 0)
        self.assertEqual(oxford["total"], 0)

    def test_synthetic_oxford_and_starred_requirement_filters(self):
        result = {
            "term": "Fall_2026",
            "terms": ["Fall_2026"],
            "sections": [
                {"course_code": "CS 170", "subject": "CS", "catalog_number": "170", "section_number": "1", "crn": "1", "campus": "Atlanta", "requirement_designation": "QR"},
                {"course_code": "OXBI 141", "subject": "OXBI", "catalog_number": "141", "section_number": "1", "crn": "2", "campus": "Oxford", "requirement_designation": "NS*"},
            ],
            "count": 2,
        }

        oxford = _filter_sections_result(result, campus="oxford", requirement="starred")

        self.assertEqual(oxford["total"], 1)
        self.assertEqual(oxford["sections"][0]["course_code"], "OXBI 141")

    def test_exact_starred_general_ed_requirement_filter(self):
        requirement = "First Year Writing(*)"
        self.assertIn(requirement, get_starred_general_ed_requirements())
        result = {
            "term": "Fall_2026",
            "terms": ["Fall_2026"],
            "sections": [
                {"course_code": "ENG 101", "subject": "ENG", "catalog_number": "101", "section_number": "1", "crn": "1", "requirements": [requirement]},
                {"course_code": "ENG 181", "subject": "ENG", "catalog_number": "181", "section_number": "1", "crn": "2", "requirements": ["First Year Seminar(*)"]},
            ],
            "count": 2,
        }

        filtered = _filter_sections_result(result, requirement=requirement)

        self.assertEqual(filtered["total"], 1)
        self.assertEqual(filtered["sections"][0]["course_code"], "ENG 101")


if __name__ == "__main__":
    unittest.main()
