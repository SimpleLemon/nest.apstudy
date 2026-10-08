import unittest
from unittest.mock import Mock

from services import saved_courses


class SavedCoursesServiceTests(unittest.TestCase):
    def test_owner_read_keeps_live_section_fields_and_saved_overrides(self):
        course = {"id": "course-1", "term": "Fall_2026", "subject": "MATH", "catalog": "111",
                  "color_key": "course-color-01", "course_overrides_json": '{"course_title":"My class","instructor_name":"My professor"}'}
        section = {"id": "sec-1", "course_title": "Calculus", "instructor": "Original professor",
                   "meetings": [{"day": "Mon", "start": "0900", "end": "0950"}],
                   "date_range": {"start": "2026-08-01", "end": "2026-12-01"}}
        list_rows = Mock(return_value=[course])
        find_section = Mock(return_value=section)
        ensure_colors = Mock()
        rows = saved_courses.list_saved_courses_for_user(
            "owner", list_rows=list_rows, ensure_colors=ensure_colors, find_section=find_section,
        )
        self.assertEqual(rows[0]["course_title"], "My class")
        self.assertEqual(rows[0]["course_name"], "My class")
        self.assertEqual(rows[0]["instructor"], "My professor")
        self.assertEqual(rows[0]["meetings"], section["meetings"])
        self.assertEqual(rows[0]["date_range"], section["date_range"])
        self.assertEqual(list_rows.call_args.args[0], saved_courses.COLLECTIONS["user_courses"])
        self.assertIn('"owner"', " ".join(list_rows.call_args.args[1]))
        ensure_colors.assert_called_once_with("owner", [course])
        find_section.assert_called_once_with(course, {})

    def test_unresolved_live_section_retains_saved_course_identity(self):
        course = {"id": "saved-1", "subject": "MATH", "catalog": "111", "course_name": "My course"}
        rows = saved_courses.list_saved_courses_for_user(
            "owner", list_rows=lambda *_: [course], ensure_colors=lambda *_: None,
            find_section=lambda *_: None,
        )
        self.assertEqual(rows[0]["id"], "saved-1")
        self.assertEqual(rows[0]["course_title"], "My course")
        self.assertEqual(rows[0]["course_code"], "MATH 111")
        self.assertEqual(rows[0]["meetings"], [])

    def test_section_fallback_caches_the_term_index_for_multiple_saved_courses(self):
        index = Mock(return_value={"sections": [{"id": "section-1", "term": "Fall_2026", "subject": "MATH", "catalog_number": "111"}]})
        cache = {}
        course = {"term": "Fall_2026", "subject": "MATH", "catalog": "111"}
        for _ in range(2):
            result = saved_courses._find_section_for_course(course, cache, get_index=index)
            self.assertEqual(result["id"], "section-1")
        index.assert_called_once_with(term="Fall_2026", include_cancelled=True)
