import json
import os
import unittest

from services.atlas_client import (
    build_section_id,
    merge_section_with_details,
    parse_atlas_details_payload,
    _parse_seats_html,
    _section_row_from_course_data,
)

FIXTURE_DIR = os.path.join(os.path.dirname(__file__), "fixtures", "atlas")


def load_fixture(name):
    with open(os.path.join(FIXTURE_DIR, name), "r", encoding="utf-8") as handle:
        return json.load(handle)


class AtlasDetailsParserTests(unittest.TestCase):
    def test_parse_seats_html(self):
        chem = _parse_seats_html(
            "<strong>Maximum Enrollment</strong>: 36 / <strong>Seats Avail</strong>: 34"
        )
        self.assertEqual(chem["enrollment_capacity"], 36)
        self.assertEqual(chem["seats_available"], 34)

        eng = _parse_seats_html(
            "<strong>Maximum Enrollment</strong>: 16 / <strong>Seats Avail</strong>: 16"
            "<br/><strong>Waitlist Total</strong>: 0 of 6, Auto-Enroll"
        )
        self.assertEqual(eng["waitlist_total"], 0)
        self.assertEqual(eng["waitlist_capacity"], 6)

    def test_parse_chem_150_details(self):
        search = load_fixture("search_chem_150_crn_2760.json")
        details = load_fixture("details_chem_150_key_3449.json")
        parsed = parse_atlas_details_payload(details, search)

        self.assertEqual(parsed["credit_hours"], "3")
        self.assertEqual(parsed["seats_available"], 34)
        self.assertEqual(parsed["enrollment_capacity"], 36)
        self.assertEqual(parsed["grading_mode"], "Student Option")
        self.assertEqual(parsed["instruction_method"], "In Person")
        self.assertEqual(parsed["requirement_designation"], "Natural Sciences(*)")
        self.assertEqual(parsed["campus_description"], "ATL@ATLANTA")
        self.assertEqual(parsed["location"], "Atwood Chemistry Bldg. 260")

    def test_parse_eng_ox_185_details(self):
        search = load_fixture("search_eng_ox_185_crn_4196.json")
        details = load_fixture("details_eng_ox_185_key_2463.json")
        parsed = parse_atlas_details_payload(details, search)

        self.assertEqual(parsed["requirement_designation"], "First-Year Writing(*)")
        self.assertEqual(parsed["campus_description"], "OXF@OXFORD")
        self.assertEqual(parsed["location"], "Humanities Hall 201")
        self.assertEqual(parsed["waitlist_capacity"], 6)

    def test_section_row_from_enriched_course_data(self):
        search = load_fixture("search_chem_150_crn_2760.json")
        details = load_fixture("details_chem_150_key_3449.json")
        merged = merge_section_with_details(search, details)
        course_data = {
            "course_code": "CHEM 150",
            "course_title": "Structure and Properties",
            "term": "Fall_2026",
            "credit_hours": "3",
            "date_range": {"start": "2026-08-26", "end": "2026-12-09"},
            "sections": [{
                "crn": merged["crn"],
                "section_number": merged["no"],
                "schedule_type": merged["schd"],
                "instructor": merged["instructor"],
                "instructors": merged["instructors"],
                "location": merged["location"],
                "campus": merged["campus"],
                "campus_description": merged["campus_description"],
                "credit_hours": merged["credit_hours"],
                "requirement_designation": merged["requirement_designation"],
                "requirements": merged["requirements"],
                "enrollment_status": merged["enrollment_status"],
                "enrollment_count": merged["total"],
                "enrollment_capacity": merged["enrollment_capacity"],
                "seats_available": merged["seats_available"],
                "grading_mode": merged["grading_mode"],
                "instruction_method": merged["instruction_method"],
                "is_cancelled": False,
                "schedule": {
                    "display": merged["meets"],
                    "meetings": [],
                },
            }],
        }
        section = course_data["sections"][0]
        row = _section_row_from_course_data("Fall_2026", "CHEM", "150", course_data, section)

        self.assertEqual(row["seats_available"], 34)
        self.assertEqual(row["enrollment_capacity"], 36)
        self.assertEqual(row["grading_mode"], "Student Option")
        self.assertEqual(row["instruction_method"], "In Person")
        self.assertEqual(row["campus"], "Atlanta")
        self.assertEqual(
            row["id"],
            build_section_id("Fall_2026", "CHEM", "150", "2760", "1"),
        )


if __name__ == "__main__":
    unittest.main()
