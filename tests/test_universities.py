"""School lookup results cannot change the shared cached catalog."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from services import universities


class UniversityCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)

    def catalog(self, name, rows):
        path = self.directory / name
        path.write_text(json.dumps(rows), encoding="utf-8")
        return str(path)

    def test_different_catalog_paths_do_not_reuse_the_first_snapshot(self):
        first = self.catalog("first.json", [{"id": "one", "name": "First University"}])
        second = self.catalog("second.json", [{"id": "two", "name": "Second University"}])
        with patch.object(universities, "DATA_PATH", first):
            self.assertEqual(universities.load_universities()[0]["name"], "First University")
        with patch.object(universities, "DATA_PATH", second):
            self.assertEqual(universities.load_universities()[0]["name"], "Second University")

    def test_returned_rows_and_lists_cannot_mutate_later_lookups(self):
        path = self.catalog("schools.json", [{"id": "emory", "name": "Emory University"}])
        with patch.object(universities, "DATA_PATH", path):
            rows = universities.load_universities()
            rows[0]["name"] = "Changed"
            rows.clear()
            universities.search_universities("Emory")[0]["key"] = "wrong"
            universities.match_university("Emory University")["id"] = "wrong"
            self.assertEqual(universities.school_payload("Emory University"), {
                "school": "Emory University", "school_key": "emory-university",
                "school_source": "scorecard", "scorecard_id": "emory",
            })

    def test_a_read_failure_is_retried_when_the_catalog_becomes_available(self):
        path = self.directory / "recovered.json"
        with patch.object(universities, "DATA_PATH", str(path)):
            self.assertEqual(universities.load_universities(), [])
            path.write_text(json.dumps([{"id": "one", "name": "Recovered University"}]), encoding="utf-8")
            self.assertEqual(universities.load_universities()[0]["name"], "Recovered University")

    def test_malformed_rows_are_skipped_and_bad_catalog_shapes_remain_retryable(self):
        path = self.directory / "repaired.json"
        path.write_text('{"unexpected":"shape"}', encoding="utf-8")
        with patch.object(universities, "DATA_PATH", str(path)):
            self.assertEqual(universities.load_universities(), [])
            path.write_text(json.dumps([None, 3, {"name": ""}, {"id": "one", "name": "Valid University"}]), encoding="utf-8")
            self.assertEqual([row["name"] for row in universities.load_universities()], ["Valid University"])
