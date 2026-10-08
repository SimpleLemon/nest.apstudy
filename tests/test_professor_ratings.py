"""Synthetic offline fixtures; none of these identities or ratings are real."""
import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from services import professor_ratings as service
from services.professor_rating_identity import section_instructors, profile_url, search_url
from scripts.rmp.matching import refresh_entries, resolve, validate_overrides
from scripts.rmp.public_pages import FixturePages, PublicPages, SourceRefused, SourceUnavailable, parse_summary_page
from scripts.rmp.storage import atomic_write, load_roster
from scripts.rmp.refresh import main

STAMP = "2026-10-07T12:00:00+00:00"


def identity(name="Jane Example", campus="Atlanta", atlas_id=None):
    return next(section_instructors({"campus": campus, "instructors": [{"name": name, "atlas_id": atlas_id}]}))


def profile(identifier="100", school="340", name="Jane Example", **extra):
    return {"professor_id": identifier, "school_id": school, "name": name,
            "overall_rating": 4.2, "difficulty": 3.1, "rating_count": 12, **extra}


def source(*profiles, **extra):
    return FixturePages({"schema_version": 1, "profiles": list(profiles), **extra})


class RatingIdentityTests(unittest.TestCase):
    def test_school_separation_and_exact_names(self):
        data = source(profile(), profile("200", "2633"))
        self.assertEqual(resolve(identity(), data, None, STAMP)["professor_id"], "100")
        self.assertEqual(resolve(identity(campus="Oxford"), data, None, STAMP)["professor_id"], "200")
        self.assertEqual(resolve(identity("Janet Example"), data, None, STAMP)["status"], "unmatched")

    def test_initials_homonyms_and_duplicate_search_records(self):
        self.assertEqual(resolve(identity("J. Example"), source(profile()), None, STAMP)["status"], "ambiguous")
        self.assertEqual(resolve(identity(), source(profile(), profile("101")), None, STAMP)["status"], "ambiguous")
        self.assertEqual(resolve(identity(), source(profile(), profile()), None, STAMP)["status"], "matched")

    def test_multiple_instructors_keep_distinct_ids_and_ignore_custom_label(self):
        section = {"campus": "Atlanta", "instructor": "Edited Name", "instructors": [
            {"name": "Jane Example", "atlas_id": "a"}, {"name": "Jane Example", "atlas_id": "b"},
            {"name": "Jane Example", "atlas_id": "a"}, {"name": "John Example"}]}
        result = list(section_instructors(section))
        self.assertEqual(len(result), 3)
        self.assertEqual(result[0]["instructor_key"], "340:atlas:a")
        self.assertEqual(list(section_instructors({"instructor": "Edited Name"})), [])

    def test_conflicting_identity_cannot_read_name_or_id_cache_or_acquire_score(self):
        cases = (
            {"name": "Jane Example", "atlas_id_conflict": True},
            {"name": "Jane Example", "atlas_id": "old", "instructor_id": "new"},
        )
        for instructor in cases:
            with self.subTest(instructor=instructor):
                item = next(section_instructors({"campus": "Atlanta", "instructors": [instructor]}))
                self.assertTrue(item["atlas_id_conflict"])
                self.assertEqual(item["instructor_key"], "340:conflict:name:jane example")
                record = {**item, **profile(), "status": "matched", "verified": True, "fetched_at": STAMP}
                entry = service.public_entry(item, record)
                self.assertEqual(entry["status"], "ambiguous")
                self.assertIsNone(entry["overall_rating"])
                self.assertIsNone(entry["profile_url"])
                override = {"professor_id": "100", "school_id": "340", "expected_name": "Jane Example", "label": "Old override"}
                with patch.object(FixturePages, "search", side_effect=AssertionError("conflicting identity search")), \
                        patch.object(FixturePages, "profile", side_effect=AssertionError("conflicting identity profile")):
                    resolved = resolve(item, source(profile()), override, STAMP)
                self.assertEqual(resolved["status"], "ambiguous")
                self.assertFalse(resolved["verified"])
                self.assertIsNone(resolved["overall_rating"])

    def test_equivalent_explicit_id_aliases_remain_one_identity(self):
        item = next(section_instructors({"campus": "Atlanta", "instructors": [
            {"name": "Jane Example", "atlas_id": "500", "instructor_id": 500, "id": "500"}]}))
        self.assertEqual(item["instructor_key"], "340:atlas:500")
        self.assertNotIn("atlas_id_conflict", item)

    def test_explicit_override_initials_cross_school_and_label(self):
        item = identity("J. Example")
        override = {"professor_id": "200", "school_id": "2633", "expected_name": "Jane Example", "label": "Confirmed by department"}
        with self.assertRaises(ValueError):
            validate_overrides({"schema_version": 1, "mappings": {item["instructor_key"]: override}})
        override["allow_cross_school"] = True
        validate_overrides({"schema_version": 1, "mappings": {item["instructor_key"]: override}})
        result = resolve(item, source(profile("200", "2633")), override, STAMP)
        self.assertEqual(result["override_label"], override["label"])
        self.assertEqual(result["status"], "matched")
        wrong = resolve(item, source(profile("200", "2633", "Someone Else")), override, STAMP)
        self.assertEqual(wrong["status"], "ambiguous")
        self.assertIsNone(wrong["overall_rating"])

    def test_links_never_trust_external_urls(self):
        self.assertIsNone(profile_url("https://evil.test/100"))
        self.assertIsNone(profile_url("100/../../admin"))
        self.assertNotIn("&redirect=", search_url("Jane&redirect=https://evil.test", "340"))
        record = resolve(identity(), source(profile()), None, STAMP)
        record["profile_url"] = "javascript:alert(1)"
        safe = service.public_entry(identity(), record)
        self.assertEqual(safe["profile_url"], "https://www.ratemyprofessors.com/professor/100")

    def test_unknown_campus_needs_an_explicit_school_override(self):
        item = identity(campus="Online")
        self.assertEqual(resolve(item, source(profile()), None, STAMP)["status"], "unavailable")
        override = {"professor_id": "100", "school_id": "340", "expected_name": "Jane Example",
                    "label": "Confirmed Atlanta instructor teaching online", "allow_cross_school": True}
        validate_overrides({"schema_version": 1, "mappings": {item["instructor_key"]: override}})
        result = resolve(item, source(profile()), override, STAMP)
        self.assertEqual(service.public_entry(item, result)["overall_rating"], 4.2)


class ExternalSchoolOverrideTests(unittest.TestCase):
    def setUp(self):
        self.item = identity("J. Example", atlas_id="reviewed")
        self.override = {"professor_id": "200", "school_id": "9999", "expected_name": "Jane Example",
                         "label": "Department confirmed former institution profile", "allow_cross_school": True}

    def resolve_override(self):
        return resolve(self.item, source(profile("200", "9999")), self.override, STAMP)

    def test_reviewed_external_profile_is_public_without_search_or_network(self):
        mappings = validate_overrides({"schema_version": 1, "mappings": {self.item["instructor_key"]: self.override}})
        self.assertEqual(mappings[self.item["instructor_key"]], self.override)
        with patch.object(FixturePages, "search", side_effect=AssertionError("override must not search")), \
                patch("requests.Session.get", side_effect=AssertionError("network")):
            record = self.resolve_override()
            entry = service.public_entry(self.item, record)
        self.assertTrue(record["verified"])
        self.assertTrue(record["cross_school_override"])
        self.assertEqual(entry["status"], "matched")
        self.assertEqual(entry["school_id"], "9999")
        self.assertEqual(entry["overall_rating"], 4.2)
        self.assertEqual(entry["profile_url"], "https://www.ratemyprofessors.com/professor/200")
        self.assertEqual(entry["override_label"], self.override["label"])
        self.assertIn("/search/professors/340?", entry["search_url"])

    def test_external_override_requires_literal_approval_and_nonblank_label(self):
        from unittest.mock import Mock
        invalid = [{**self.override, "allow_cross_school": value} for value in (None, False, "true", 1)]
        invalid.extend({**self.override, "label": value} for value in (None, "", " \t\n", 123))
        invalid.extend([{key: value for key, value in self.override.items() if key != "allow_cross_school"},
                        {key: value for key, value in self.override.items() if key != "label"}])
        for override in invalid:
            with self.subTest(override=override):
                client = Mock()
                with self.assertRaises(ValueError):
                    validate_overrides({"schema_version": 1, "mappings": {self.item["instructor_key"]: override}})
                with self.assertRaises(ValueError):
                    resolve(self.item, client, override, STAMP)
                client.search.assert_not_called()
                client.profile.assert_not_called()

    def test_external_cache_requires_review_and_original_instructor_identity(self):
        record = self.resolve_override()
        invalid = [{**record, "cross_school_override": value} for value in (None, False, "true", 1)]
        invalid.extend({**record, "override_label": value} for value in (None, "", " \t\n", 123))
        invalid.extend([{**record, "verified": False}, {**record, "name": "Someone Else"},
                        {**record, "instructor_key": "340:atlas:someone-else"}])
        for stored in invalid:
            with self.subTest(stored=stored):
                entry = service.public_entry(self.item, stored)
                self.assertEqual(entry["status"], "unavailable")
                for field in ("overall_rating", "difficulty", "rating_count", "professor_id", "profile_url"):
                    self.assertIsNone(entry[field])

    def test_school_ids_must_be_canonical_positive_numeric_identifiers(self):
        record = self.resolve_override()
        for school in (None, "", 0, "0", -1, "-1", True, 9999.0, "09999", " 9999", "9999 ",
                       "+9999", "9.999e3", "9999/path", "https://example.test/9999", "9" * 13):
            with self.subTest(school=school):
                override = {**self.override, "school_id": school}
                with self.assertRaises(ValueError):
                    validate_overrides({"schema_version": 1, "mappings": {self.item["instructor_key"]: override}})
                entry = service.public_entry(self.item, {**record, "school_id": school})
                self.assertIsNone(entry["profile_url"])
                self.assertIsNone(entry["overall_rating"])
        self.override["school_id"] = 9999
        self.assertEqual(self.resolve_override()["school_id"], "9999")

    def test_external_profile_must_verify_exact_id_school_and_expected_full_name(self):
        from unittest.mock import Mock
        for wrong in (profile("201", "9999"), profile("200", "340"), profile("200", "9999", "Someone Else")):
            with self.subTest(profile=wrong):
                client = Mock()
                client.profile.return_value = wrong
                result = resolve(self.item, client, self.override, STAMP)
                self.assertEqual(result["status"], "ambiguous")
                self.assertFalse(result["verified"])
                self.assertIsNone(result["overall_rating"])
                self.assertIsNone(service.public_entry(self.item, result)["profile_url"])
                client.search.assert_not_called()
        with self.assertRaisesRegex(ValueError, "full expected RMP name"):
            resolve(self.item, source(profile("200", "9999", "J. Example")),
                    {**self.override, "expected_name": "J. Example"}, STAMP)

    def test_automatic_matching_remains_restricted_to_atlas_school(self):
        from unittest.mock import Mock
        client = Mock()
        client.search.return_value = [profile("200", "9999")]
        result = resolve(identity(), client, None, STAMP)
        self.assertEqual(result["status"], "unmatched")
        client.search.assert_called_once_with("340", "Jane Example")
        client.profile.assert_not_called()
        client.reset_mock()
        result = resolve({**identity(), "school_id": "9999"}, client, None, STAMP)
        self.assertEqual(result["status"], "unavailable")
        client.search.assert_not_called()
        client.profile.assert_not_called()

    def test_failed_refresh_preserves_reviewed_external_profile_and_timestamp(self):
        record = self.resolve_override()
        ratings, report = refresh_entries([self.item], {self.item["instructor_key"]: record},
                                          source(unavailable=True), {self.item["instructor_key"]: self.override},
                                          "2026-11-09T00:00:00+00:00")
        entry = service.public_entry(self.item, ratings[self.item["instructor_key"]])
        self.assertEqual(entry["status"], "unavailable")
        self.assertTrue(entry["stale"])
        self.assertEqual(entry["school_id"], "9999")
        self.assertEqual(entry["overall_rating"], 4.2)
        self.assertEqual(entry["fetched_at"], STAMP)
        self.assertEqual(len(report["failures"]), 1)


class RatingCacheTests(unittest.TestCase):
    def test_failure_preserves_numbers_and_original_timestamp(self):
        item = identity()
        old = resolve(item, source(profile()), None, STAMP)
        ratings, report = refresh_entries([item], {item["instructor_key"]: old}, source(unavailable=True), {}, "2026-11-09T00:00:00+00:00")
        cached = ratings[item["instructor_key"]]
        self.assertEqual(cached["fetched_at"], STAMP)
        self.assertEqual(cached["overall_rating"], 4.2)
        self.assertTrue(cached["stale"])
        self.assertEqual(cached["status"], "unavailable")
        self.assertEqual(len(report["failures"]), 1)
        self.assertEqual(service.public_entry(item, cached)["overall_rating"], 4.2)

    def test_ambiguous_never_leaks_prior_numbers(self):
        item = identity()
        old = resolve(item, source(profile()), None, STAMP)
        new, _ = refresh_entries([item], {item["instructor_key"]: old}, source(profile(), profile("101")), {}, STAMP)
        self.assertIsNone(new[item["instructor_key"]]["overall_rating"])
        old["status"] = "ambiguous"
        self.assertIsNone(service.public_entry(item, old)["overall_rating"])

    def test_missing_cache_immutable_sections_and_zero_network(self):
        original = [{"campus": "Atlanta", "instructors": [{"name": "Jane Example"}]}]
        before = copy.deepcopy(original)
        with tempfile.TemporaryDirectory() as directory, patch.object(service, "SNAPSHOT_PATH", Path(directory) / "missing.json"), patch("requests.Session.get", side_effect=AssertionError("network")):
            result = service.enrich_sections_with_professor_ratings(original)
        self.assertEqual(original, before)
        self.assertIsNot(result[0], original[0])
        self.assertEqual(result[0]["professor_ratings"][0]["status"], "unavailable")
        self.assertIsNone(result[0]["professor_ratings"][0]["overall_rating"])

    def test_age_stale_unrated_and_atomic_cache_invalidation(self):
        item = identity()
        record = resolve(item, source(profile(rating_count=0)), None, STAMP)
        entry = service.public_entry(item, record, datetime(2026, 11, 9, tzinfo=timezone.utc))
        self.assertEqual(entry["status"], "unrated")
        self.assertTrue(entry["stale"])
        self.assertIsNone(entry["overall_rating"])
        with tempfile.TemporaryDirectory() as directory, patch.object(service, "SNAPSHOT_PATH", Path(directory) / "ratings.json"):
            snapshot = {"schema_version": 1, "ratings": {item["instructor_key"]: record}}
            atomic_write(service.SNAPSHOT_PATH, snapshot)
            self.assertEqual(service._ratings_index()[item["instructor_key"]]["rating_count"], 0)
            snapshot["ratings"][item["instructor_key"]]["rating_count"] = 1
            atomic_write(service.SNAPSHOT_PATH, snapshot)
            self.assertEqual(service._ratings_index()[item["instructor_key"]]["rating_count"], 1)
            with patch("scripts.rmp.storage.os.replace", side_effect=OSError("interrupted")):
                with self.assertRaises(OSError):
                    atomic_write(service.SNAPSHOT_PATH, {"broken": True})
            self.assertEqual(service.read_snapshot(service.SNAPSHOT_PATH)["schema_version"], 1)
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])


class PublicPageTests(unittest.TestCase):
    def test_embedded_relay_fields_only(self):
        store = {"Teacher:100": {"__typename": "Teacher", "legacyId": 100, "firstName": "Jane", "lastName": "Example",
                                "avgRating": 4.2, "avgDifficulty": 3.1, "numRatings": 12,
                                "school": {"__ref": "School:340"}, "reviews": [{"comment": "must not persist"}]},
                 "School:340": {"legacyId": 340}, "page": {"hasNextPage": False},
                 "connection": {"__typename": "TeacherConnection", "pageInfo": {"__ref": "page"},
                                "edges": [{"node": {"__ref": "Teacher:100"}}]}}
        markup = f'<script>window.__RELAY_STORE__ = {json.dumps(store)};</script>'
        self.assertEqual(parse_summary_page(markup, search=True), [profile()])
        store["page"]["hasNextPage"] = True
        with self.assertRaises(SourceUnavailable):
            parse_summary_page(f'<script>{json.dumps(store)}</script>', search=True)

    def test_unknown_markup_and_challenge_are_not_unmatched(self):
        with self.assertRaises(SourceUnavailable):
            parse_summary_page("<html>Unexpected content</html>", search=True)
        with self.assertRaises(SourceRefused):
            parse_summary_page("<title>Just a moment...</title>")

    def test_http_refusal_stops_all_later_requests(self):
        from unittest.mock import MagicMock
        session = MagicMock()
        session.get.return_value.__enter__.return_value.status_code = 403
        client = PublicPages(session=session)
        with self.assertRaises(SourceRefused):
            client.search("340", "Jane Example")
        with self.assertRaises(SourceRefused):
            client.search("340", "John Example")
        self.assertEqual(session.get.call_count, 1)


class RosterTests(unittest.TestCase):
    def test_certified_scope_includes_every_official_undergraduate_career(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, career in enumerate(["UCOL", "UOXF", "UBUS", "UNUR"]):
                atomic_write(root / f"data/atlas/snapshots/Fall_2026/test/TEST/{700 + index}.json", {
                    "campus": "Oxford" if career == "UOXF" else "Atlanta",
                    "sections": [{"academic_career": career, "instructors": [{"name": f"Jane Example{index}"}]}]})
            atomic_write(root / "data/atlas/manifest.json", {"terms": {"Fall_2026": {
                "status": "complete", "generation": "test", "coverage": {"scope": "undergraduate"}}}})
            roster, metadata = load_roster(root, ["Fall_2026"], with_metadata=True)
            self.assertEqual(len(roster), 4)
            self.assertEqual(metadata["roster_scope"]["Fall_2026"], {
                "scope": "undergraduate", "unknown_career_sections": 0, "excluded_sections": 0})

    def test_legacy_uses_career_metadata_instead_of_course_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_write(root / "data/atlas/registry.json", {"careers": [
                {"value": "UCOL", "label": "Emory College", "undergraduate": True},
                {"value": "G", "label": "Graduate", "undergraduate": False}]})
            for number, career, name in [(700, "UCOL", "Jane Example"), (100, "G", "Graduate Example")]:
                atomic_write(root / f"Fall_2026/TEST/{number}.json", {"campus": "Atlanta", "sections": [
                    {"academic_career": career, "instructors": [{"name": name}]}]})
            roster, metadata = load_roster(root, ["Fall_2026"], with_metadata=True)
            self.assertEqual([person["name"] for person in roster], ["Jane Example"])
            self.assertEqual(metadata["roster_scope"]["Fall_2026"]["excluded_sections"], 1)

    def test_active_snapshot_preferred_and_term_paths_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "Fall_2026/BIOL/141.json"
            atomic_write(legacy, {"campus": "Atlanta", "sections": [{"instructors": [{"name": "Legacy Example"}]}]})
            current = root / "data/atlas/snapshots/Fall_2026/test/BIOL/141.json"
            atomic_write(current, {"campus": "Oxford", "sections": [{"instructors": [{"name": "Current Example"}]}]})
            atomic_write(root / "data/atlas/manifest.json", {"terms": {"Fall_2026": {"status": "complete", "generation": "test", "coverage": {"scope": "undergraduate"}}}})
            self.assertEqual(load_roster(root, ["Fall_2026"])[0]["name"], "Current Example")
            with self.assertRaises(ValueError):
                load_roster(root, ["../Fall_2026"])
            (root / "data/atlas/manifest.json").unlink()
            self.assertEqual(load_roster(root, ["Fall_2026"])[0]["name"], "Legacy Example")
            atomic_write(root / "Fall_2026/BIOL/700.json", {"campus": "Atlanta", "sections": [{"instructors": [{"name": "Graduate Example"}]}]})
            roster, metadata = load_roster(root, ["Fall_2026"], with_metadata=True)
            self.assertEqual(len(roster), 2)
            self.assertEqual(metadata["roster_scope"]["Fall_2026"]["scope"], "legacy/unverified")
            self.assertEqual(metadata["roster_scope"]["Fall_2026"]["unknown_career_sections"], 2)

    def test_full_offline_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_write(root / "Fall_2026/BIOL/141.json", {"campus": "Atlanta", "sections": [{"instructors": [{"name": "Jane Example"}]}]})
            atomic_write(root / "input.json", {"schema_version": 1, "profiles": [profile()]})
            with patch("requests.Session.get", side_effect=AssertionError("network")), patch("builtins.print"):
                status = main(["--terms", "Fall_2026", "--root", str(root), "--input", str(root / "input.json"), "--output-dir", str(root / "output")])
            self.assertEqual(status, 0)
            snapshot = service.read_snapshot(root / "output/ratings.json")
            self.assertEqual(snapshot["source"], "offline-import")
            self.assertEqual(snapshot["report"]["counts"], {"matched": 1})


class RatingSafetyTests(unittest.TestCase):
    def test_wrong_cached_name_school_and_untyped_fields_do_not_leak(self):
        item = identity(atlas_id="123")
        record = resolve(item, source(profile()), None, STAMP)
        wrong_name = {**item, "name": "Someone Else"}
        self.assertIsNone(service.public_entry(wrong_name, record)["overall_rating"])
        self.assertIsNone(service.public_entry(item, {**record, "school_id": "2633"})["overall_rating"])
        self.assertIsNone(service.public_entry(item, {**record, "status": []})["overall_rating"])
        self.assertIsNone(service.public_entry(item, {**record, "rating_count": 12.5})["rating_count"])
        self.assertTrue(service.public_entry(item, {**record, "fetched_at": 123})["stale"])
        self.assertTrue(service.public_entry(item, {**record, "fetched_at": "2026-10-07"})["stale"])
        self.assertTrue(service.public_entry(item, {**record, "fetched_at": None})["stale"])

    def test_changed_atlas_name_does_not_retain_summary_on_failure(self):
        item = identity(atlas_id="123")
        old = resolve(item, source(profile()), None, STAMP)
        changed = {**item, "name": "Someone Else"}
        ratings, _ = refresh_entries([changed], {item["instructor_key"]: old}, source(unavailable=True), {}, STAMP)
        self.assertIsNone(service.public_entry(changed, ratings[item["instructor_key"]])["overall_rating"])

    def test_wrong_profile_school_and_name_are_not_verified(self):
        from unittest.mock import Mock
        client = Mock()
        client.search.return_value = [profile()]
        for wrong in (profile(school="2633"), profile(name="Someone Else")):
            client.profile.return_value = wrong
            result = resolve(identity(), client, None, STAMP)
            self.assertEqual(result["status"], "ambiguous")
            self.assertFalse(result["verified"])
            self.assertIsNone(result["professor_id"])

    def test_invalid_cache_root_and_entry_types(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ratings.json"
            for document in ([], None, 1, "invalid", {"schema_version": 1, "ratings": []}):
                atomic_write(path, document)
                self.assertEqual(service.read_snapshot(path), {})
        self.assertEqual(service.public_entry(identity(), ["invalid"])["status"], "unavailable")

    def test_empty_search_requires_explicit_complete_connection(self):
        empty = {"__typename": "TeacherConnection", "edges": [], "pageInfo": {"hasNextPage": False}}
        self.assertEqual(parse_summary_page(f'<script>{json.dumps(empty)}</script>', search=True), [])
        for page_info in ({}, {"hasNextPage": None}, {"hasNextPage": True}, {"hasNextPage": False, "hasPreviousPage": True}):
            with self.assertRaises(SourceUnavailable):
                parse_summary_page(f'<script>{json.dumps({**empty, "pageInfo": page_info})}</script>', search=True)
        with self.assertRaises(SourceUnavailable):
            parse_summary_page('<script>{"__typename":"TeacherConnection","unrelated":{"hasNextPage":false}}</script>', search=True)
        with self.assertRaises(SourceUnavailable):
            parse_summary_page('<script>{"__typename":"TeacherConnection","edges":[{}],"pageInfo":{"hasNextPage":false}}</script>', search=True)

    def test_parser_bounds_and_fixture_validation(self):
        from scripts.rmp.public_pages import _walk
        with self.assertRaises(SourceUnavailable):
            parse_summary_page(" " * 5_000_001)
        deeply_nested = {}
        for _ in range(102):
            deeply_nested = {"x": deeply_nested}
        with self.assertRaises(SourceUnavailable):
            list(_walk(deeply_nested))
        with self.assertRaises(ValueError):
            FixturePages([])
        with self.assertRaises(ValueError):
            source(profile(), profile(name="Someone Else"))
        for delay in (0, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                PublicPages(delay=delay)
        with self.assertRaises(ValueError):
            PublicPages(max_requests=0)

    def test_redirect_challenge_size_and_request_budget_stop_safely(self):
        from unittest.mock import MagicMock
        session = MagicMock()
        response = session.get.return_value.__enter__.return_value
        response.status_code = 302
        client = PublicPages(session=session)
        with self.assertRaises(SourceRefused):
            client.search("340", "Jane Example")
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])
        response.status_code = 200
        response.iter_content.return_value = [b'<title>Just a moment...</title>']
        client = PublicPages(session=session)
        with self.assertRaises(SourceRefused):
            client.search("340", "Jane Example")
        self.assertTrue(client.stopped)
        response.iter_content.return_value = [b'x' * 5_000_001]
        client = PublicPages(session=session, max_requests=1)
        with self.assertRaisesRegex(SourceUnavailable, "5 MB"):
            client.search("340", "Jane Example")
        with self.assertRaisesRegex(SourceUnavailable, "request limit"):
            client.search("340", "John Example")

    def test_cli_failure_preserves_cache_and_writes_failure_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_write(root / "Fall_2026/BIOL/141.json", {"campus": "Atlanta", "sections": [{"instructors": [{"name": "Jane Example"}]}]})
            item = identity()
            old = resolve(item, source(profile()), None, STAMP)
            atomic_write(root / "output/ratings.json", {"schema_version": 1, "ratings": {item["instructor_key"]: old}})
            atomic_write(root / "input.json", {"schema_version": 1, "profiles": [], "unavailable": True})
            with patch("requests.Session.get", side_effect=AssertionError("network")), patch("builtins.print"):
                status = main(["--terms", "Fall_2026", "--root", str(root), "--input", str(root / "input.json"), "--output-dir", str(root / "output")])
            self.assertEqual(status, 2)
            snapshot = service.read_snapshot(root / "output/ratings.json")
            cached = snapshot["ratings"][item["instructor_key"]]
            self.assertEqual(cached["fetched_at"], STAMP)
            self.assertEqual(cached["overall_rating"], 4.2)
            self.assertTrue(cached["stale"])
            self.assertEqual(snapshot["report"]["roster_scope"]["Fall_2026"]["scope"], "legacy/unverified")
            self.assertEqual(json.loads((root / "output/last-refresh-report.json").read_text()), snapshot["report"])

    def test_cli_empty_roster_does_not_overwrite_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atomic_write(root / "Fall_2026/BIOL/141.json", {"sections": []})
            atomic_write(root / "output/ratings.json", {"schema_version": 1, "ratings": {"old": {}}})
            before = (root / "output/ratings.json").read_bytes()
            with patch("builtins.print"):
                status = main(["--terms", "Fall_2026", "--root", str(root), "--output-dir", str(root / "output")])
            self.assertEqual(status, 1)
            self.assertEqual((root / "output/ratings.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
