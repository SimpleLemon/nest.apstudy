import unittest
from unittest.mock import Mock, call, patch

from appwrite.exception import AppwriteException

from services import chat_presence


class ChatPresenceLabelRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.user = {"$id": "user-1", "school_key": "emory-university"}
        self.label = chat_presence.university_presence_label("emory-university")
        self.labels = ["student", self.label]
        self.users = Mock()
        self.users.get.return_value = {"labels": self.labels}
        service = patch.object(chat_presence, "Users", return_value=self.users)
        service.start()
        self.addCleanup(service.stop)
        diagnostics = patch.object(chat_presence.logger, "exception")
        self.diagnostics = diagnostics.start()
        self.addCleanup(diagnostics.stop)

    def test_failed_user_read_preserves_labels_and_next_call_recovers(self):
        with patch.object(chat_presence, "get_row_safe", side_effect=[
            AppwriteException("user database unavailable"), self.user,
        ]), patch.object(chat_presence, "first_row", return_value={"approved": True}):
            self.assertIsNone(chat_presence.sync_chat_presence_labels_for_user("user-1"))
            self.users.update_labels.assert_not_called()
            self.users.get.assert_not_called()
            self.diagnostics.assert_called_once_with("Failed to load user row for presence label sync")
            self.assertEqual(chat_presence.sync_chat_presence_labels_for_user("user-1"), self.labels)

        self.users.update_labels.assert_not_called()

    def test_failed_channel_read_preserves_labels_and_next_call_recovers(self):
        with patch.object(chat_presence, "first_row", side_effect=[
            AppwriteException("channel database unavailable"), {"approved": True},
        ]):
            self.assertIsNone(chat_presence.sync_chat_presence_labels_for_user("user-1", self.user))
            self.users.update_labels.assert_not_called()
            self.users.get.assert_not_called()
            self.diagnostics.assert_called_once_with(
                "Failed to check university chat approval for %s", "emory-university",
            )
            self.assertEqual(chat_presence.sync_chat_presence_labels_for_user("user-1", self.user), self.labels)

        self.users.update_labels.assert_not_called()

    def test_successfully_read_unapproved_school_removes_university_label(self):
        with patch.object(chat_presence, "first_row", return_value=None):
            result = chat_presence.sync_chat_presence_labels_for_user("user-1", self.user)

        self.assertEqual(result, ["student"])
        self.users.update_labels.assert_called_once_with("user-1", ["student"])
        self.diagnostics.assert_not_called()

    def test_successfully_read_missing_user_removes_university_label(self):
        with patch.object(chat_presence, "get_row_safe", return_value=None), \
                patch.object(chat_presence, "first_row") as channel_lookup:
            result = chat_presence.sync_chat_presence_labels_for_user("user-1")

        self.assertEqual(result, ["student"])
        self.users.update_labels.assert_called_once_with("user-1", ["student"])
        channel_lookup.assert_not_called()
        self.diagnostics.assert_not_called()

    def test_failed_account_read_reports_failure_and_next_call_recovers(self):
        self.users.get.side_effect = [AppwriteException("account unavailable"), {"labels": self.labels}]
        with patch.object(chat_presence, "first_row", return_value={"approved": True}):
            self.assertIsNone(chat_presence.sync_chat_presence_labels_for_user("user-1", self.user))
            self.users.update_labels.assert_not_called()
            self.assertEqual(chat_presence.sync_chat_presence_labels_for_user("user-1", self.user), self.labels)

        self.users.update_labels.assert_not_called()
        self.diagnostics.assert_called_once_with("Failed to load Appwrite user labels for %s", "user-1")

    def test_failed_label_update_reports_failure_and_next_call_recovers(self):
        self.users.update_labels.side_effect = [AppwriteException("write unavailable"), None]
        with patch.object(chat_presence, "first_row", return_value=None):
            self.assertIsNone(chat_presence.sync_chat_presence_labels_for_user("user-1", self.user))
            self.assertEqual(chat_presence.sync_chat_presence_labels_for_user("user-1", self.user), ["student"])

        self.assertEqual(self.users.update_labels.call_args_list, [
            call("user-1", ["student"]), call("user-1", ["student"]),
        ])
        self.diagnostics.assert_called_once_with("Failed to update Appwrite user labels for %s", "user-1")

    def test_bulk_sync_counts_empty_and_unchanged_successes_and_continues_after_failures(self):
        user_ids = ["channel-outage", "labels-outage", "update-outage", "unchanged", "empty", "updated"]
        user_docs = [{"$id": user_id, "school_key": "emory-university"} for user_id in user_ids]
        self.users.get.side_effect = [
            AppwriteException("account unavailable"),
            {"labels": ["student"]},
            {"labels": self.labels},
            {"labels": []},
            {"labels": ["student"]},
        ]
        self.users.update_labels.side_effect = [AppwriteException("write unavailable"), None]
        with patch.object(chat_presence, "list_rows_all", return_value=user_docs + [{}]), \
                patch.object(chat_presence, "first_row", side_effect=[
                    AppwriteException("channel unavailable"), {"approved": True}, {"approved": True},
                    {"approved": True}, None, {"approved": True},
                ]), patch.object(chat_presence, "get_row_safe") as user_lookup:
            result = chat_presence.sync_chat_presence_labels_for_school("emory-university")

        self.assertEqual(result, 3)
        user_lookup.assert_not_called()
        self.assertEqual(self.users.get.call_args_list, [call(user_id) for user_id in user_ids[1:]])
        self.assertEqual(self.users.update_labels.call_args_list, [
            call("update-outage", self.labels), call("updated", self.labels),
        ])
        self.assertEqual(self.diagnostics.call_count, 3)

    def test_failed_bulk_user_listing_reports_no_successes_without_account_access(self):
        with patch.object(chat_presence, "list_rows_all", side_effect=AppwriteException("users unavailable")):
            self.assertEqual(chat_presence.sync_chat_presence_labels_for_school("emory-university"), 0)

        self.users.get.assert_not_called()
        self.users.update_labels.assert_not_called()
        self.diagnostics.assert_called_once_with("Failed to list users for university presence label sync")

    def test_empty_user_id_reports_failure_without_account_access(self):
        with patch.object(chat_presence, "get_row_safe") as user_lookup:
            self.assertIsNone(chat_presence.sync_chat_presence_labels_for_user("  "))

        user_lookup.assert_not_called()
        self.users.get.assert_not_called()
        self.users.update_labels.assert_not_called()
