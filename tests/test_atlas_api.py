import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from blueprints.atlas_api import atlas_bp
from services import atlas_client


class AtlasApiTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.register_blueprint(atlas_bp, url_prefix="/api/atlas")
        self.client = self.app.test_client()

    def test_omitted_terms_follow_the_discovered_catalog_default(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(atlas_client, "COURSE_DATA_ROOT", directory):
            Path(directory, "Spring_2027", "CHEM").mkdir(parents=True)
            Path(directory, "Fall_2026", "BIOL").mkdir(parents=True)
            atlas_client.invalidate_cache()
            self.addCleanup(atlas_client.invalidate_cache)
            with patch.object(atlas_client, "get_sections_index", return_value={"sections": [], "total": 0}) as sections:
                subjects = self.client.get("/api/atlas/subjects")
                search = self.client.get("/api/atlas/search?query=CHEM")
            self.assertEqual(subjects.status_code, 200)
            self.assertEqual(subjects.json, {"term": "Spring_2027", "subjects": ["CHEM"], "count": 1})
            self.assertEqual(search.status_code, 200)
            self.assertEqual(search.json["term"], "Spring_2027")
            self.assertEqual(sections.call_args.kwargs["term"], "Spring_2027")
            explicit = self.client.get("/api/atlas/subjects?term=Fall_2026")
            self.assertEqual(explicit.json["subjects"], ["BIOL"])
            self.assertEqual(explicit.json["term"], "Fall_2026")
            self.assertEqual(self.client.get("/api/atlas/subjects?term=Unknown_2027").status_code, 400)

    @patch("blueprints.atlas_api.merge_snapshots_into_sections")
    @patch("blueprints.atlas_api.get_sections_index")
    def test_status_filter_uses_live_snapshot_before_limit(self, get_sections_index, merge_snapshots):
        get_sections_index.return_value = {
            "term": "Fall_2026",
            "sections": [
                {"id": "cached-closed", "course_code": "CHEM 150", "enrollment_status": "Closed"},
                {"id": "still-closed", "course_code": "CHEM 151", "enrollment_status": "Closed"},
            ],
            "count": 2,
            "total": 2,
        }
        merge_snapshots.return_value = [
            {"id": "cached-closed", "course_code": "CHEM 150", "enrollment_status": "Open"},
            {"id": "still-closed", "course_code": "CHEM 151", "enrollment_status": "Closed"},
        ]

        response = self.client.get("/api/atlas/sections?term=Fall_2026&statuses=Open&limit=1")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["count"], 1)
        self.assertEqual(payload["sections"], [
            {"id": "cached-closed", "course_code": "CHEM 150", "enrollment_status": "Open", "professor_ratings": []},
        ])
        self.assertIsNone(get_sections_index.call_args.kwargs["limit"])
        self.assertEqual(get_sections_index.call_args.kwargs["offset"], 0)
        self.assertIsNone(get_sections_index.call_args.kwargs["statuses"])
