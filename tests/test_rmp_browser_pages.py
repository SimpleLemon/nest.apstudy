import copy
import unittest

from scripts.rmp.browser_pages import BrowserPages
from scripts.rmp.matching import refresh_entries
from services.professor_rating_identity import section_instructors

STAMP = "2026-10-07T15:00:00Z"


def document():
    return {"schema_version": 1, "source": "public-rmp-brave", "directories": [
        {"school_id": school, "url": f"https://www.ratemyprofessors.com/search/professors/{school}?q=*",
         "complete": True, "declared_count": 1, "profiles": [
             {"professor_id": identifier, "profile_url": f"https://www.ratemyprofessors.com/professor/{identifier}",
              "school_id": school, "name": "Jane Example", "overall_rating": 4.2,
              "difficulty": 3.1, "rating_count": 12, "fetched_at": STAMP}]} for school, identifier in [("340", "100"), ("2633", "200")]
    ]}


class BrowserSummaryTests(unittest.TestCase):
    def test_online_sections_use_explicit_atlas_campus_codes_without_guessing(self):
        from services.professor_rating_identity import school_for_section
        self.assertEqual(school_for_section({"campus": "Online", "campus_description": "ATL@ONLINE"}), "340")
        self.assertEqual(school_for_section({"campus": "Online", "campus_description": "OXF@ONLINE"}), "2633")
        self.assertIsNone(school_for_section({"campus": "Online"}))
        self.assertIsNone(school_for_section({"campus": "Oxford", "campus_description": "ATL@ATLANTA"}))

    def test_full_first_and_last_names_with_middle_initials_still_require_an_exact_match(self):
        from scripts.rmp.matching import resolve
        changed = document()
        changed["directories"][0]["profiles"][0]["name"] = "Jane Q. Example"
        source = BrowserPages(changed)
        identity = next(section_instructors({"campus": "Atlanta", "instructors": [{"name": "Jane Q Example"}]}))
        self.assertEqual(resolve(identity, source, None, STAMP)["status"], "matched")
        identity["name"] = "J. Q. Example"
        self.assertEqual(resolve(identity, source, None, STAMP)["status"], "ambiguous")
        identity["name"] = "Jane Example"
        self.assertEqual(resolve(identity, source, None, STAMP)["status"], "unmatched")

    def test_official_career_identifies_online_school_without_merging_campuses(self):
        from services.professor_rating_identity import school_for_section
        for career, school in [("UCOL", "340"), ("UAH", "340"), ("UBUS", "340"),
                              ("UNUR", "340"), ("UOXF", "2633")]:
            with self.subTest(career=career):
                section = {"campus": "Online", "campus_description": "ONLIN@ONLINE",
                           "academic_career": career, "instructors": [{"name": "Jane Example", "atlas_id": "500"}]}
                self.assertEqual(school_for_section(section), school)
                self.assertEqual(next(section_instructors(section))["instructor_key"], f"{school}:atlas:500")
        self.assertIsNone(school_for_section({"campus": "Online", "academic_career": "UGRD"}))
        self.assertIsNone(school_for_section({"campus": "Oxford", "academic_career": "UBUS"}))
        self.assertIsNone(school_for_section({"campus_description": "ATL@ATLANTA", "academic_career": "UOXF"}))

    def test_repeated_public_profile_ids_require_complete_native_pagination_proof(self):
        changed = document()
        directory = changed["directories"][0]
        directory["declared_count"] = 3
        directory["rendered_profiles"] = {"source_url": directory["url"],
                                           "verification": "exact_profile_id_set", "unique_count": 1,
                                           "fetched_at": STAMP}
        directory["pages"] = [
            {"kind": "initial_public_cards", "source_url": directory["url"], "first_position": 0, "last_position": 0, "rows": 1},
            {"source_url": "https://www.ratemyprofessors.com/graphql", "status": 200,
             "first_position": 1, "last_position": 2, "rows": 2, "result_count": 3,
             "end_cursor": "YXJyYXljb25uZWN0aW9uOjI=", "has_next_page": False},
        ]
        source = BrowserPages(changed)
        self.assertEqual(source.directory_reports[0]["duplicate_positions"], 2)
        for field, value in [("unique_count", 2), ("fetched_at", "bad"), ("source_url", "https://evil.test")]:
            incomplete = copy.deepcopy(changed)
            incomplete["directories"][0]["rendered_profiles"][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                BrowserPages(incomplete)
        incomplete = copy.deepcopy(changed)
        incomplete["directories"][0]["profiles"] = []
        incomplete["directories"][0]["rendered_profiles"]["unique_count"] = 0
        with self.assertRaises(ValueError):
            BrowserPages(incomplete)
        incomplete = copy.deepcopy(changed)
        del incomplete["directories"][0]["rendered_profiles"]
        with self.assertRaises(ValueError):
            BrowserPages(incomplete)
        with_ids = copy.deepcopy(changed)
        with_ids["directories"][0]["pages"][0]["profile_ids"] = ["100"]
        with_ids["directories"][0]["pages"][1]["profile_ids"] = ["100", "100"]
        BrowserPages(with_ids)
        with_ids["directories"][0]["pages"][1]["profile_ids"] = ["100", "999"]
        with self.assertRaises(ValueError):
            BrowserPages(with_ids)
        for field, value in [("has_next_page", True), ("end_cursor", "wrong"), ("first_position", 2), ("status", 403)]:
            incomplete = copy.deepcopy(changed)
            incomplete["directories"][0]["pages"][1][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                BrowserPages(incomplete)

    def test_complete_school_scoped_summaries_preserve_original_timestamp(self):
        source = BrowserPages(document())
        identity = next(section_instructors({"campus": "Oxford", "instructors": [{"name": "Jane Example", "atlas_id": "500"}]}))
        ratings, report = refresh_entries([identity], {}, source, {}, "2026-10-08T15:00:00Z")
        entry = ratings[identity["instructor_key"]]
        self.assertEqual(entry["professor_id"], "200")
        self.assertEqual(entry["fetched_at"], STAMP)
        self.assertEqual(entry["overall_rating"], 4.2)
        self.assertEqual(report["failures"], [])

    def test_partial_directories_wrong_schools_and_unsafe_links_cannot_publish(self):
        cases = []
        for field, value in [("complete", False), ("declared_count", 2), ("url", "https://evil.test/search/professors/340?q=*")]:
            changed = document()
            changed["directories"][0][field] = value
            cases.append(changed)
        for field, value in [("school_id", "2633"), ("profile_url", "javascript:alert(1)"), ("fetched_at", "not-a-date")]:
            changed = document()
            changed["directories"][0]["profiles"][0][field] = value
            cases.append(changed)
        changed = document()
        changed["directories"] = changed["directories"][:1]
        cases.append(changed)
        changed = document()
        directory = changed["directories"][0]
        directory["profiles"].append(copy.deepcopy(directory["profiles"][0]))
        directory["declared_count"] = 2
        cases.append(changed)
        for changed in cases:
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                BrowserPages(changed)
