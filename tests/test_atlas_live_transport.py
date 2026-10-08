"""Keep native live Atlas requests and professor details in the selected term."""
import json
import unittest
from unittest.mock import Mock, patch
from urllib.parse import unquote

from services import atlas_client, atlas_live_verification, course_live_snapshots


class AtlasLiveTransportTests(unittest.TestCase):
    def setUp(self):
        view = Mock()
        view.srcdb.return_value = "5271"
        for patcher in (
            patch.object(atlas_client, "_catalog_view", return_value=view),
            patch.object(atlas_client, "_validate_term", side_effect=lambda term: term),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def response(self, payload):
        response = Mock()
        response.json.return_value = payload
        return response

    def details(self, **extra):
        return {"srcdb": "5271", "key": "live-100", "code": "TEST 100", "crn": "200", "section": "3", **extra}

    def test_details_use_top_level_term_and_native_encoded_body(self):
        payload = self.details()
        with patch.object(atlas_client.requests, "post", return_value=self.response(payload)) as post:
            result = atlas_client.fetch_atlas_section_details("Spring_2027", "live-100")
        self.assertEqual(result, payload)
        self.assertEqual(json.loads(unquote(post.call_args.kwargs["data"])), {
            "srcdb": "5271", "group": "key:live-100",
        })
        self.assertNotIn("json", post.call_args.kwargs)

    def test_search_preserves_verified_term_on_normalized_sections(self):
        payload = {"srcdb": "5271", "results": [{
            "key": "live-100", "code": "TEST 100", "crn": "200", "no": "3", "instr": "Jane Example",
        }]}
        with patch.object(atlas_client.requests, "post", return_value=self.response(payload)) as post:
            result = atlas_client.fetch_live_subject_sections("Spring_2027", "TEST")
        self.assertEqual(result["sections"][0]["atlas_srcdb"], "5271")
        self.assertEqual(json.loads(unquote(post.call_args.kwargs["data"])), {
            "other": {"srcdb": "5271"}, "criteria": [{"field": "subject", "value": "TEST"}],
        })

    def test_search_and_details_reject_the_default_term_response(self):
        for operation, args, payload in (
            (atlas_client.fetch_live_subject_sections, ("Spring_2027", "TEST"), {"srcdb": "5269", "results": []}),
            (atlas_client.fetch_atlas_section_details, ("Spring_2027", "live-100"), self.details(srcdb="5269")),
        ):
            with self.subTest(operation=operation.__name__), \
                    patch.object(atlas_client.requests, "post", return_value=self.response(payload)):
                result = operation(*args)
            self.assertIn("term did not match", result["error"])

    def test_details_require_the_requested_key_and_complete_identity(self):
        for payload in (self.details(key="unrelated"), self.details(crn=None)):
            with self.subTest(payload=payload), \
                    patch.object(atlas_client.requests, "post", return_value=self.response(payload)):
                result = atlas_client.fetch_atlas_section_details("Spring_2027", "live-100")
            self.assertIn("did not match", result["error"])

    def test_detail_identity_cannot_replace_another_courses_professor(self):
        original = {"key": "live-100", "code": "TEST 100", "crn": "200", "no": "3", "atlas_srcdb": "5271"}
        for field, value in {"key": "other", "code": "OTHER 200", "crn": "201", "section": "4", "srcdb": "5269"}.items():
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "did not match this section"):
                atlas_client.merge_section_with_details(original, self.details(**{field: value}))

    def test_missing_requested_crn_does_not_choose_the_first_result(self):
        payload = {"srcdb": "5271", "results": [{"code": "TEST 100", "crn": "unrelated", "no": "3"}]}
        with patch.object(atlas_client.requests, "post", return_value=self.response(payload)):
            self.assertIsNone(atlas_client._fetch_atlas_search_row("Spring_2027", crn="200"))

    def test_verification_retains_status_without_persisting_unrelated_details(self):
        row = {"id": "Spring_2027|TEST|100|200|3", "term": "Spring_2027", "subject": "TEST",
               "catalog_number": "100", "course_code": "TEST 100", "crn": "200", "section_number": "3",
               "atlas_key": "live-100", "atlas_srcdb": "5271", "enrollment_status": "Open"}
        with patch.object(atlas_live_verification, "_singleflight_subject_fetch", return_value=({"sections": [row]}, True)), \
                patch.object(atlas_live_verification, "_pace_atlas_call"), \
                patch.object(atlas_live_verification, "fetch_atlas_section_details", return_value=self.details(code="OTHER 200")), \
                patch.object(course_live_snapshots, "upsert_snapshot") as persist:
            result = atlas_live_verification.verify_sections_by_ids([row["id"]], [row["id"]])
        self.assertEqual(result["verified_by_id"][row["id"]]["enrollment_status"], "Open")
        self.assertEqual(result["details_by_id"], {})
        self.assertIn("did not match this section", result["detail_errors_by_id"][row["id"]])
        persist.assert_not_called()


if __name__ == "__main__":
    unittest.main()
