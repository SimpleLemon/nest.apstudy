"""Regression coverage for atomic catalog publication and saved section history."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote

from services import atlas_client
from services.atlas_catalog_store import CatalogStore


class AtlasCatalogStoreTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.atlas = self.root / "data" / "atlas"
        self.atlas.mkdir(parents=True)
        self.write(self.atlas / "registry.json", {"version": 1, "terms": {
            "Fall_2026": {"srcdb": "5269", "label": "Fall 2026"},
            "Spring_2027": {"srcdb": "5271", "label": "Spring 2027"},
        }})
        data_root = patch.object(atlas_client, "COURSE_DATA_ROOT", str(self.root))
        data_root.start()
        self.addCleanup(data_root.stop)
        self.addCleanup(atlas_client.invalidate_cache)
        atlas_client.invalidate_cache()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def course(self, directory, crn, *, catalog="150", title="Chemistry", cancelled=False):
        self.write(directory / "CHEM" / f"{catalog}.json", {
            "term": "Fall_2026", "course_code": f"CHEM {catalog}",
            "catalog_number": catalog, "course_title": title,
            "sections": [{"crn": crn, "section_number": "1", "is_cancelled": cancelled}],
        })

    def snapshot(self, generation, crn, **kwargs):
        directory = self.atlas / "snapshots" / "Fall_2026" / generation
        self.course(directory, crn, **kwargs)
        return directory

    def publish(self, generation, previous=()):
        temporary = self.atlas / "manifest.next.json"
        self.write(temporary, {"version": 1, "terms": {"Fall_2026": {
            "srcdb": "5269", "status": "complete", "generation": generation,
            "path": f"snapshots/Fall_2026/{generation}",
            "last_successful_refresh": "2026-10-07T10:00:00Z",
            "coverage": {"sections": 1},
            "previous_generations": [{"generation": old, "path": f"snapshots/Fall_2026/{old}"} for old in previous],
        }}})
        os.replace(temporary, self.atlas / "manifest.json")

    def ids(self, result):
        return {section["crn"] for section in result["sections"]}

    def test_registry_only_and_unpublished_staging_are_not_searchable(self):
        self.snapshot("unpublished", "staging")
        result = atlas_client.get_terms()
        self.assertEqual(result["terms"], [])
        self.assertEqual(result["term_metadata"]["Spring_2027"]["status"], "unavailable")
        self.assertEqual(atlas_client.get_sections_index(term="Spring_2027"), {"error": "No term directories found"})
        self.assertEqual(atlas_client.get_atlas_term_srcdb(), {})

    def test_snapshot_replaces_search_while_history_and_legacy_resolve_saved_ids(self):
        self.course(self.root / "Fall_2026", "legacy")
        self.snapshot("old", "retired")
        self.snapshot("new", "current")
        self.publish("new", ["old"])
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"current"})
        requested = [atlas_client.build_section_id("Fall_2026", "CHEM", "150", crn, "1") for crn in ("current", "retired", "legacy")]
        self.assertEqual(self.ids(atlas_client.get_sections_by_ids(requested)), {"current", "retired", "legacy"})
        self.assertEqual(self.ids(atlas_client.get_course("CHEM", "150", "Fall_2026")), {"current", "retired", "legacy"})
        metadata = atlas_client.get_terms()["term_metadata"]["Fall_2026"]
        self.assertEqual(metadata["status"], "complete")
        self.assertEqual(metadata["generation"], "new")
        self.assertEqual(metadata["coverage"], {"sections": 1})

    def test_republished_manifest_invalidates_cache_even_with_same_size_and_mtime(self):
        self.snapshot("one", "old")
        self.snapshot("two", "new")
        self.publish("one")
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"old"})
        old_stat = (self.atlas / "manifest.json").stat()
        self.publish("two")
        os.utime(self.atlas / "manifest.json", ns=(old_stat.st_atime_ns, old_stat.st_mtime_ns))
        self.assertEqual((self.atlas / "manifest.json").stat().st_size, old_stat.st_size)
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"new"})
        self.assertEqual(CatalogStore(self.root).view().term_metadata()["Fall_2026"]["generation"], "two")

    def test_empty_complete_roster_does_not_restore_removed_courses_to_search(self):
        self.course(self.root / "Fall_2026", "legacy")
        self.snapshot("old", "retired")
        (self.atlas / "snapshots" / "Fall_2026" / "empty").mkdir()
        self.publish("empty", ["old"])
        self.assertEqual(atlas_client.get_sections_index()["sections"], [])
        self.assertEqual(atlas_client.search_courses("CHEM")["results"], [])
        self.assertEqual(atlas_client.get_terms()["terms"], ["Fall_2026"])
        self.assertEqual(atlas_client.get_terms()["term_metadata"]["Fall_2026"]["generation"], "empty")
        requested = [atlas_client.build_section_id("Fall_2026", "CHEM", "150", crn, "1") for crn in ("retired", "legacy")]
        self.assertEqual(self.ids(atlas_client.get_sections_by_ids(requested)), {"retired", "legacy"})

    def test_incomplete_snapshot_is_never_searchable_or_labeled_complete(self):
        self.snapshot("partial", "not-published")
        self.publish("partial")
        manifest = json.loads((self.atlas / "manifest.json").read_text())
        manifest["terms"]["Fall_2026"]["status"] = "incomplete"
        self.write(self.atlas / "manifest.json", manifest)
        self.assertEqual(atlas_client.get_terms()["terms"], [])
        self.assertEqual(atlas_client.get_terms()["term_metadata"]["Fall_2026"]["status"], "unavailable")
        self.course(self.root / "Fall_2026", "legacy")
        atlas_client.invalidate_cache()
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"legacy"})
        self.assertEqual(atlas_client.get_terms()["term_metadata"]["Fall_2026"]["status"], "legacy/unverified")

    def test_instructor_ids_and_roles_survive_course_and_live_normalization(self):
        instructor = {"name": "Ada Example", "instructor_id": "123", "atlas_id": "456", "id": "789", "role": "Primary"}
        course = {"sections": [{"instructors": [instructor]}]}
        local = atlas_client._section_row_from_course_data("Fall_2026", "CHEM", "150", course, course["sections"][0])
        live = atlas_client._live_row_from_raw("Fall_2026", {"code": "CHEM 150", "instructors": [instructor]})
        self.assertEqual(local["instructors"], [{**instructor, "email": None}])
        self.assertEqual(live["instructors"], local["instructors"])
        merged = atlas_client.merge_section_with_details({"code": "CHEM 150", "instructors": [instructor]}, {})
        self.assertEqual(merged["instructors"], local["instructors"])
        with patch.object(atlas_client, "parse_atlas_details_payload", return_value={"instructors": [{"name": "Ada Example", "email": "ada@example.test", "role": "Primary"}]}):
            merged = atlas_client.merge_section_with_details({"code": "CHEM 150", "instructors": [instructor]}, {})
        self.assertEqual(merged["instructors"][0]["instructor_id"], "123")
        self.assertEqual(merged["instructors"][0]["atlas_id"], "456")
        self.assertEqual(merged["instructors"][0]["id"], "789")
        self.assertTrue(merged["instructors"][0]["atlas_id_conflict"])
        self.assertEqual(merged["instructors"][0]["email"], "ada@example.test")

    def test_operation_pins_generation_when_manifest_changes_during_scan(self):
        old = self.snapshot("old", "old-150")
        self.course(old, "old-151", catalog="151")
        new = self.snapshot("new", "new-150")
        self.course(new, "new-151", catalog="151")
        self.publish("old")
        normalize = atlas_client._section_row_from_course_data
        def publish_during_read(*args):
            self.publish("new", ["old"])
            return normalize(*args)
        with patch.object(atlas_client, "_section_row_from_course_data", side_effect=publish_during_read):
            self.assertEqual(self.ids(atlas_client.get_sections_index()), {"old-150", "old-151"})
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"new-150", "new-151"})

    def test_current_cancelled_section_does_not_resurrect_historical_active_copy(self):
        self.snapshot("old", "same")
        self.snapshot("new", "same", cancelled=True)
        self.publish("new", ["old"])
        identifier = atlas_client.build_section_id("Fall_2026", "CHEM", "150", "same", "1")
        self.assertEqual(atlas_client.get_sections_by_ids([identifier], include_cancelled=False)["count"], 0)
        self.assertTrue(atlas_client.get_sections_by_ids([identifier])["sections"][0]["is_cancelled"])

    def test_invalid_manifest_paths_never_read_unpublished_or_external_files(self):
        self.snapshot("hidden", "secret")
        self.write(self.atlas / "manifest.json", {"terms": {"Fall_2026": {
            "status": "complete", "generation": "public", "path": "snapshots/Fall_2026/hidden",
        }}})
        self.assertEqual(atlas_client.get_terms()["terms"], [])
        self.assertEqual(CatalogStore(self.root).view().course_paths("../Fall_2026", "CHEM", "150", include_history=True), [])
        self.assertEqual(CatalogStore(self.root).view().course_paths("Fall_2026", "../CHEM", "150", include_history=True), [])

    def test_legacy_roots_work_without_manifest_and_retain_unverified_status(self):
        self.course(self.root / "Fall_2026", "legacy")
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"legacy"})
        self.assertEqual(atlas_client.get_terms()["term_metadata"]["Fall_2026"]["status"], "legacy/unverified")
        self.assertEqual(atlas_client.get_atlas_term_srcdb(), {"Fall_2026": "5269"})

    def test_malformed_manifest_and_history_are_ignored_without_crashing(self):
        self.course(self.root / "Fall_2026", "legacy")
        for document in ({"terms": []}, {"terms": {"Fall_2026": None}}, {"terms": {"Fall_2026": {"previous_generations": 7}}}):
            with self.subTest(document=document):
                self.write(self.atlas / "manifest.json", document)
                self.assertEqual(len(CatalogStore(self.root).view().course_paths("Fall_2026", "CHEM", "150", include_history=True)), 1)
        (self.atlas / "manifest.json").write_text("{broken", encoding="utf-8")
        self.assertEqual(self.ids(atlas_client.get_sections_index()), {"legacy"})

    def test_snapshot_symlinks_cannot_select_another_generation(self):
        hidden = self.snapshot("hidden", "secret")
        (hidden.parent / "published").symlink_to(hidden, target_is_directory=True)
        self.publish("published")
        self.assertEqual(atlas_client.get_terms()["terms"], [])

    def test_new_term_live_lookup_uses_registry_without_source_code_changes(self):
        (self.root / "Spring_2027" / "CHEM").mkdir(parents=True)
        with patch.object(atlas_client.requests, "post") as post:
            post.return_value.json.return_value = {"srcdb": "5271", "results": []}
            self.assertEqual(atlas_client.fetch_live_subject_sections("Spring_2027", "CHEM")["count"], 0)
        self.assertEqual(json.loads(unquote(post.call_args.kwargs["data"]))["other"]["srcdb"], "5271")


if __name__ == "__main__":
    unittest.main()
