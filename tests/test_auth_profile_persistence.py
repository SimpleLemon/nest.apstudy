"""Exercise login against a disposable SQLite database, never the live VPS."""
import sqlite3
import unittest
from contextlib import ExitStack
from unittest.mock import patch

import blueprints.auth as auth
from flask import session
from models import user_from_doc
from extensions import login_manager
from tests import test_extension_calendar_routes as routes


class ProfilePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.fixture = routes.ExtensionCalendarRouteTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.app = self.fixture.app

    def login(self, *, stored_avatar=None, fail_write=False):
        with self.app.test_request_context("/auth/session", method="POST"), ExitStack() as stack:
            for name in ("sync_chat_presence_labels_for_user", "emit_user_event"):
                stack.enter_context(patch.object(auth, name))
            stack.enter_context(patch.object(auth, "_find_user_by_email", return_value=None))
            stack.enter_context(patch.object(auth, "_fetch_provider_profile", return_value={}))
            stack.enter_context(patch.object(auth, "_redirect_for_user_doc", return_value="/dashboard"))
            stack.enter_context(patch.object(auth.notes_collaboration, "claim_pending_invitations"))
            stack.enter_context(patch.object(auth.invites, "attribute_signup"))
            stored = stack.enter_context(patch.object(auth, "_store_provider_avatar", return_value=stored_avatar or ("https://nest.apstudy.org/avatar/one", "avatar-1", "stored", 128)))
            deleted = stack.enter_context(patch.object(auth, "delete_avatar_file"))
            if fail_write:
                stack.enter_context(patch.object(auth, "update_row_safe", side_effect=sqlite3.OperationalError("database is locked")))
                with self.assertRaises(sqlite3.OperationalError):
                    auth._complete_appwrite_login({"$id": "profile-user", "name": "Provider Name", "email": "fixture@example.test", "picture_url": "https://provider.example/avatar"}, provider="google", provider_access_token="fixture-provider")
                self.assertNotIn("_user_id", session)
                deleted.assert_not_called()
                return None
            result = auth._complete_appwrite_login({"$id": "profile-user", "name": "Provider Name", "email": "fixture@example.test", "picture_url": "https://provider.example/avatar"}, provider="google", provider_access_token="fixture-provider")
            self.assertEqual(session["_user_id"], "profile-user")
            return result, stored, deleted

    def row(self):
        # A newly opened connection establishes that login committed its data.
        with sqlite3.connect(self.fixture.db_path) as connection:
            connection.row_factory = sqlite3.Row
            return dict(connection.execute("SELECT * FROM users WHERE id = ?", ["profile-user"]).fetchone())

    def test_new_login_commits_profile_before_session_and_identity_uses_saved_values(self):
        self.login()
        row = self.row()
        self.assertEqual(row["name"], "Provider Name")
        self.assertEqual(row["email"], "fixture@example.test")
        self.assertEqual(row["picture_url"], "https://nest.apstudy.org/avatar/one")
        with self.app.app_context():
            login_manager._user_callback = lambda uid: user_from_doc(auth.get_row_safe(auth.COLLECTIONS["users"], uid))
            response = self.fixture.client("profile-user").get("/api/extension/identity")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["profile"]["avatarUrl"], row["picture_url"])

    def test_returning_login_preserves_chosen_name_and_uploaded_avatar(self):
        self.login()
        with self.app.app_context():
            auth.update_row_safe(auth.COLLECTIONS["users"], "profile-user", {"name": "Chosen Name", "picture_url": "https://nest.apstudy.org/avatar/custom", "avatar_source": "upload"})
        _, stored, deleted = self.login()
        stored.assert_not_called()
        deleted.assert_not_called()
        self.assertEqual(self.row()["name"], "Chosen Name")
        self.assertEqual(self.row()["picture_url"], "https://nest.apstudy.org/avatar/custom")

    def test_failed_provider_copy_keeps_existing_avatar(self):
        self.login()
        _, _, deleted = self.login(stored_avatar=("https://provider.example/new", None, "provider_url_fallback", 0))
        deleted.assert_not_called()
        self.assertEqual(self.row()["picture_url"], "https://nest.apstudy.org/avatar/one")
        self.assertEqual(self.row()["avatar_file_id"], "avatar-1")

    def test_failed_profile_write_does_not_create_session_or_delete_old_avatar(self):
        self.login()
        self.login(stored_avatar=("https://nest.apstudy.org/avatar/two", "avatar-2", "stored", 256), fail_write=True)
        self.assertEqual(self.row()["avatar_file_id"], "avatar-1")

    def test_replaced_avatar_is_retired_only_after_successful_write(self):
        self.login()
        _, _, deleted = self.login(stored_avatar=("https://nest.apstudy.org/avatar/two", "avatar-2", "stored", 256))
        self.assertEqual(self.row()["avatar_file_id"], "avatar-2")
        deleted.assert_called_once_with("avatar-1")
