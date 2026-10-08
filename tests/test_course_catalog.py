import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock, patch

import requests

from services import course_catalog


CATALOG_PAGE = (
    '<div class="card"><div class="card-header">'
    '<button>MATH 111: Calculus I</button></div>'
    '<div class="card-body"><p class="card-text">Limits and derivatives.</p>'
    '</div></div></div>'
)


class CourseCatalogRecoveryTests(unittest.TestCase):
    def setUp(self):
        cache = patch.object(course_catalog, "_cache", {})
        cache.start()
        self.addCleanup(cache.stop)
        diagnostics = patch.object(course_catalog.logger, "exception")
        self.diagnostics = diagnostics.start()
        self.addCleanup(diagnostics.stop)
        self.response = Mock(text=CATALOG_PAGE)
        self.path = course_catalog.CATALOG_SUBJECT_PATHS["MATH"]

    def test_uncached_transport_failure_retries_and_recovers_next_call(self):
        with patch.object(course_catalog.requests, "get", side_effect=[
            requests.ConnectionError("offline"), self.response,
        ]) as fetch:
            self.assertEqual(course_catalog.get_course_catalog_metadata("MATH", "111"), {})
            self.assertNotIn(self.path, course_catalog._cache)
            recovered = course_catalog.get_course_catalog_metadata("MATH", "111")
            self.assertEqual(recovered["course_description"], "Limits and derivatives.")
            self.assertEqual(course_catalog.get_course_catalog_metadata("MATH", "111"), recovered)

        self.assertEqual(fetch.call_count, 2)
        self.diagnostics.assert_called_once()

    def test_expired_success_survives_http_failure_without_becoming_fresh(self):
        stale = {("MATH", "111"): {"course_title": "Previous Calculus"}}
        expired = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=13)
        entry = {"ts": expired, "courses": stale}
        course_catalog._cache[self.path] = entry
        unavailable = Mock()
        unavailable.raise_for_status.side_effect = requests.HTTPError("503 unavailable")

        with patch.object(course_catalog.requests, "get", side_effect=[
            unavailable, self.response,
        ]) as fetch:
            self.assertEqual(
                course_catalog.get_course_catalog_metadata("MATH", "111"),
                stale[("MATH", "111")],
            )
            self.assertIs(course_catalog._cache[self.path], entry)
            self.assertEqual(course_catalog._cache[self.path]["ts"], expired)
            recovered = course_catalog.get_course_catalog_metadata("MATH", "111")

        self.assertEqual(fetch.call_count, 2)
        self.assertEqual(recovered["course_title"], "Calculus I")
        self.assertGreater(course_catalog._cache[self.path]["ts"], expired)
        self.diagnostics.assert_called_once()

    def test_successful_empty_department_is_cached(self):
        with patch.object(course_catalog.requests, "get", return_value=Mock(text="")) as fetch:
            self.assertEqual(course_catalog.get_course_catalog_metadata("MATH", "111"), {})
            self.assertEqual(course_catalog.get_course_catalog_metadata("MATH", "111"), {})

        fetch.assert_called_once()
        self.assertEqual(course_catalog._cache[self.path]["courses"], {})
        self.diagnostics.assert_not_called()
