"""Direct provider-seam regressions for admin projections, without Flask."""
import json
import unittest
from unittest.mock import Mock, patch

from appwrite.exception import AppwriteException
from services import admin_course_tracking, admin_storage_usage, admin_tracking_terms, admin_user_directory


class AdminProjectionServiceTests(unittest.TestCase):
    def directory(self, **overrides):
        args = dict(table_id="users", query="", field="all", sort_key="created", sort_order="desc",
                    page=1, per_page=2, allowed_per_page={2, 10},
                    list_rows_safe=Mock(return_value={"rows": [], "total": 0}), list_rows_all=Mock(return_value=[]))
        args.update(overrides)
        return admin_user_directory.load_user_directory(**args)

    def test_provider_pagination_fetches_clamped_page(self):
        provider = Mock(side_effect=[{"rows": [], "total": 3},
                                     {"rows": [{"id": "last", "name": "Last user"}], "total": 3}])
        result = self.directory(page=99, list_rows_safe=provider)
        self.assertEqual(result["page"], 2)
        self.assertEqual(result["total_pages"], 2)
        self.assertEqual([row["id"] for row in result["users"]], ["last"])
        queries = [json.loads(value) for value in provider.call_args.args[1]]
        self.assertIn({"method": "offset", "values": [2]}, queries)

    def test_empty_directory_clamps_page_without_extra_query(self):
        provider = Mock(return_value={"rows": [], "total": 0})
        result = self.directory(page=99, list_rows_safe=provider)
        self.assertEqual(result["page"], 1)
        provider.assert_called_once()

    def test_search_order_and_pagination_use_injected_full_directory(self):
        provider = Mock(return_value=[{"id": "u1", "name": "ALPHA", "email": "one@example.test"},
                                      {"id": "u2", "name": "beta", "email": "two@example.test"},
                                      {"id": "u3", "name": "alpha two", "email": "three@example.test"}])
        page_provider = Mock()
        result = self.directory(query="aLpHa", field="name", sort_key="identity", sort_order="asc",
                                per_page=1, page=2, list_rows_all=provider, list_rows_safe=page_provider)
        self.assertEqual(result["total_users"], 2)
        self.assertEqual([row["id"] for row in result["users"]], ["u3"])
        page_provider.assert_not_called()

    def test_directory_provider_failure_is_bounded(self):
        result = self.directory(list_rows_safe=Mock(side_effect=AppwriteException("provider unavailable", 503)))
        self.assertEqual(result["users"], [])
        self.assertEqual(result["error"], "Unable to load users right now.")

    def test_storage_usage_handles_invalid_sizes_and_avatar_provider_failure(self):
        provider = Mock(side_effect=[[{"file_size_bytes": "1024"}, {"file_size_bytes": "unknown"}, {}], RuntimeError("users unavailable")])
        summary = admin_storage_usage.storage_usage_summary(
            collections={"shared_files": "files", "users": "users"}, list_rows_all=provider, sanitize_error=str,
        )
        self.assertEqual(summary, dict(bytes=1024, formatted="1.0 KB", file_count=3, avatar_count=None, error="users unavailable"))
        self.assertEqual([call.args[0] for call in provider.call_args_list], ["files", "users"])

    def test_avatar_failure_is_sanitized_without_discarding_known_file_totals(self):
        failure = RuntimeError("private provider detail")
        sanitize = Mock(return_value="Service unavailable")
        summary = admin_storage_usage.storage_usage_summary(
            collections={"shared_files": "files", "users": "users"},
            list_rows_all=Mock(side_effect=[[{"file_size_bytes": 9}], failure]),
            sanitize_error=sanitize,
        )
        self.assertEqual((summary["bytes"], summary["file_count"], summary["formatted"]), (9, 1, "9 B"))
        self.assertIsNone(summary["avatar_count"])
        self.assertEqual(summary["error"], "Service unavailable")
        sanitize.assert_called_once_with(failure)

    def test_storage_usage_reports_sanitized_file_provider_failure(self):
        sanitize = Mock(return_value="Service unavailable")
        failure = RuntimeError("private provider detail")
        summary = admin_storage_usage.storage_usage_summary(
            collections={"shared_files": "files", "users": "users"},
            list_rows_all=Mock(side_effect=failure), sanitize_error=sanitize,
        )
        self.assertEqual(summary["error"], "Service unavailable")
        self.assertEqual(summary["formatted"], "--")
        sanitize.assert_called_once_with(failure)

    def test_tracking_groups_preserve_counts_and_term_effective_policy(self):
        rows = [{"id": "one", "user_id": "u1", "term": "Spring_2027", "subject": "cs", "catalog": "170", "crn": "123", "enabled": True},
                {"id": "two", "user_id": "u2", "term": "Spring_2027", "subject": "CS", "catalog": "170", "crn": "123", "enabled": False},
                {"id": "bad", "term": "", "subject": "CS", "catalog": "170"}]
        def fields(row):
            return {"effective_enabled": False, "tracking_state": "queued" if row["enabled"] else "paused"}
        with patch.object(admin_course_tracking, "track_policy_fields", side_effect=fields), \
                patch.object(admin_course_tracking, "term_policy", return_value={"can_enable": True}):
            groups, error = admin_course_tracking.course_tracking_groups(table_id="tracks", list_rows_all=Mock(return_value=rows))
        self.assertIsNone(error)
        self.assertEqual(len(groups), 1)
        group = groups[0]
        self.assertEqual(group["subject"], "CS")
        self.assertEqual((group["track_count"], group["active_count"], group["waiting_count"], group["paused_count"], group["user_count"]), (2, 0, 1, 1, 2))
        self.assertTrue(group["can_enable"])
        self.assertEqual(group["users"], ["u1", "u2"])

    def test_policy_gate_returns_plain_payload_without_request_context(self):
        closed = dict(term="Fall_2026", label="Fall 2026", effective_state="closed", can_enable=False, available=True)
        with patch.object(admin_tracking_terms, "term_policy", return_value=closed):
            body, status = admin_tracking_terms.enabling_error([{"term": "Fall_2026"}], True)
        self.assertEqual(status, 403)
        self.assertEqual(body["code"], "course_tracking_closed")
        self.assertIsNone(admin_tracking_terms.enabling_error([{"term": "Fall_2026"}], False))

    def test_policy_gate_reports_unavailable_policy_without_enabling(self):
        unavailable = dict(term="Spring_2027", can_enable=False, available=False)
        with patch.object(admin_tracking_terms, "term_policy", return_value=unavailable):
            body, status = admin_tracking_terms.enabling_error([{"term": "Spring_2027"}], True)
        self.assertEqual(status, 503)
        self.assertEqual(body["code"], "course_tracking_unavailable")

    def test_normalize_oauth_provider(self):
        self.assertEqual(admin_user_directory.normalize_oauth_provider({"provider": "Google"}), "google")
        self.assertEqual(admin_user_directory.normalize_oauth_provider({"provider": "discord"}), "discord")
        self.assertEqual(admin_user_directory.normalize_oauth_provider({"provider": "github"}), "github")
        self.assertEqual(admin_user_directory.normalize_oauth_provider({"google_id": "legacy"}), "google")
        self.assertEqual(admin_user_directory.normalize_oauth_provider({}), "other")

