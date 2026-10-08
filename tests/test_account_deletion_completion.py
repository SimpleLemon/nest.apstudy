import io
import json
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, closing, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, call, patch

from appwrite.exception import AppwriteException
from appwrite.services.storage import Storage
from flask import Flask, g
from flask_login import LoginManager, UserMixin
from flask_wtf.csrf import generate_csrf

import blueprints.admin as admin
import blueprints.settings as settings
from extensions import csrf
from scripts import cleanup_deleted_accounts as cli
from services import account_deletion_completion as completion
from services import avatar_storage, database, storage_objects
from services.storage_legacy_cleanup import enqueue_legacy_deletion, pending_legacy_deletions
from services.user_storage_cleanup import delete_user_storage


NOW = "2026-10-01T12:00:00Z"
SECRET_RESPONSE = "private-sdk-response api-key=never-print-this"


class CompletionDatabaseTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "nest.sqlite3"
        self.app = Flask(__name__)
        self.app.config.update(
            DATABASE_PATH=str(self.path), NEST_STORAGE_BACKEND="sqlite",
            NEST_STORAGE_MUTATIONS_PAUSED=False, NEST_STORAGE_READ_LEGACY=False,
            NEST_CHAT_ATTACHMENTS_ENABLED=False,
        )
        database.init_db(app=self.app)
        context = self.app.app_context()
        context.push()
        self.addCleanup(context.pop)
        self.delete_auth = Mock()
        self.cleaners = {namespace: Mock(return_value={"completed": 0, "pending": 0})
                         for namespace in completion.NAMESPACES}

    def intent(self, user_id="owner", *, completed=False):
        with database.db_connection() as conn:
            conn.execute("INSERT INTO storage_account_deletions (user_id, deleted_at, auth_deleted_at) VALUES (?, ?, ?)",
                         [user_id, NOW, NOW if completed else None])

    def profile(self, user_id="owner"):
        with database.db_connection() as conn:
            conn.execute("INSERT INTO users (id, google_id, email, name, created_at) VALUES (?, ?, ?, ?, ?)",
                         [user_id, user_id, f"{user_id}@example.test", user_id, NOW])

    def record(self, user_id="owner"):
        with database.db_connection() as conn:
            row = conn.execute("SELECT * FROM storage_account_deletions WHERE user_id = ?", [user_id]).fetchone()
        return dict(row) if row else None

    def finish(self, user_id="owner"):
        return completion.complete_account_deletion(user_id, delete_auth=self.delete_auth,
                                                    cleanup_functions=self.cleaners)


class AccountDeletionCompletionTests(CompletionDatabaseTestCase):
    def test_auth_503_retains_durable_intent_and_successful_retry_marks_it(self):
        self.intent()
        before = self.record()
        self.delete_auth.side_effect = AppwriteException(SECRET_RESPONSE, 503)
        with self.assertRaises(storage_objects.StorageUnavailable) as raised:
            self.finish()
        self.assertNotIn(SECRET_RESPONSE, str(raised.exception))
        self.assertEqual(self.record(), before)
        self.assertTrue(completion.pending_account_deletion("owner"))
        self.delete_auth.side_effect = None
        self.assertTrue(self.finish())
        self.assertEqual(self.delete_auth.call_args_list, [call("owner")] * 2)
        self.assertIsNotNone(self.record()["auth_deleted_at"])
        self.assertEqual(self.record()["deleted_at"], NOW)
        self.assertFalse(completion.pending_account_deletion("owner"))

    def test_remote_404_is_idempotent_and_permanent_tombstone_skips_sdk_on_retry(self):
        self.intent()
        self.delete_auth.side_effect = AppwriteException(SECRET_RESPONSE, 404)
        self.assertTrue(self.finish())
        marked = self.record()
        self.assertFalse(self.finish())
        self.assertEqual(self.record(), marked)
        self.delete_auth.assert_called_once_with("owner")
        for cleaner in self.cleaners.values():
            cleaner.assert_called_once_with(account_user_id="owner")

    def test_no_intent_or_surviving_profile_never_reaches_cleanup_or_sdk(self):
        with self.assertRaises(storage_objects.StorageUnavailable):
            self.finish()
        self.profile()
        self.intent()
        self.assertFalse(completion.pending_account_deletion("owner"))
        with self.assertRaises(storage_objects.StorageUnavailable):
            self.finish()
        self.delete_auth.assert_not_called()
        for cleaner in self.cleaners.values():
            cleaner.assert_not_called()

    def test_pause_before_cleanup_preserves_intent(self):
        self.intent()
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with self.assertRaises(storage_objects.StorageMutationPaused):
            self.finish()
        self.delete_auth.assert_not_called()
        self.assertIsNone(self.record()["auth_deleted_at"])
        for cleaner in self.cleaners.values():
            cleaner.assert_not_called()

    def test_pause_after_final_cleanup_stops_before_sdk(self):
        self.intent()
        self.cleaners[completion.NAMESPACES[-1]].side_effect = lambda **_scope: self.app.config.update(
            NEST_STORAGE_MUTATIONS_PAUSED=True,
        )
        with self.assertRaises(storage_objects.StorageMutationPaused):
            self.finish()
        self.delete_auth.assert_not_called()
        self.assertIsNone(self.record()["auth_deleted_at"])

    def test_pause_after_auth_before_marker_preserves_retry_for_remote_404(self):
        self.intent()
        self.delete_auth.side_effect = lambda _user_id: self.app.config.update(NEST_STORAGE_MUTATIONS_PAUSED=True)
        with self.assertRaises(storage_objects.StorageMutationPaused):
            self.finish()
        self.assertIsNone(self.record()["auth_deleted_at"])
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
        self.delete_auth.side_effect = AppwriteException("already deleted", 404)
        self.assertTrue(self.finish())
        self.assertEqual(self.delete_auth.call_count, 2)

    def test_auth_network_call_holds_no_sqlite_writer_lock(self):
        self.intent()

        def delete_auth(_user_id):
            with closing(sqlite3.connect(self.path, timeout=0)) as conn:
                conn.execute("BEGIN IMMEDIATE")
                conn.rollback()

        self.delete_auth.side_effect = delete_auth
        self.assertTrue(self.finish())

    def test_pause_during_marker_checks_rolls_back_and_keeps_retry(self):
        self.intent()
        read_record = completion._deletion_record

        def pause_in_writer(conn, user_id):
            row = read_record(conn, user_id)
            if conn.in_transaction:
                self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
            return row

        with patch.object(completion, "_deletion_record", side_effect=pause_in_writer):
            with self.assertRaises(storage_objects.StorageMutationPaused):
                self.finish()
        self.delete_auth.assert_called_once_with("owner")
        self.assertIsNone(self.record()["auth_deleted_at"])
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
        self.delete_auth.side_effect = AppwriteException("already deleted", 404)
        self.assertTrue(self.finish())

    def test_marker_write_failure_can_retry_an_auth_account_already_deleted(self):
        self.intent()
        with database.db_connection() as conn:
            conn.execute("CREATE TRIGGER fail_completion BEFORE UPDATE OF auth_deleted_at "
                         "ON storage_account_deletions BEGIN SELECT RAISE(ABORT, 'marker write failed'); END")
        with self.assertRaises(storage_objects.StorageUnavailable):
            self.finish()
        self.assertIsNone(self.record()["auth_deleted_at"])
        with database.db_connection() as conn:
            conn.execute("DROP TRIGGER fail_completion")
        self.delete_auth.side_effect = AppwriteException("already deleted", 404)
        self.assertTrue(self.finish())
        self.assertEqual(self.delete_auth.call_count, 2)

    def test_profile_or_changed_intent_during_auth_prevents_stale_completion(self):
        for change in ("profile", "intent", "queue"):
            with self.subTest(change=change):
                user_id = f"owner-{change}"
                self.intent(user_id)

                def mutate(account_id):
                    if change == "profile":
                        self.profile(account_id)
                    elif change == "intent":
                        with database.db_connection() as conn:
                            conn.execute("UPDATE storage_account_deletions SET deleted_at = ? WHERE user_id = ?",
                                         ["2026-10-02T12:00:00Z", account_id])
                    else:
                        with storage_objects.write_transaction() as conn:
                            enqueue_legacy_deletion(conn, "avatars", "bucket", account_id, account_user_id=account_id)

                self.delete_auth.side_effect = mutate
                with self.assertRaises(storage_objects.StorageUnavailable):
                    self.finish(user_id)
                self.assertIsNone(self.record(user_id)["auth_deleted_at"])

    def test_all_four_real_queue_drains_are_scoped_and_unrelated_work_survives(self):
        self.intent()
        buckets = {namespace: f"{namespace}-bucket" for namespace in completion.NAMESPACES}
        buckets["avatars"] = avatar_storage.PROFILE_AVATAR_BUCKET_ID
        with storage_objects.write_transaction() as conn:
            for namespace in completion.NAMESPACES:
                for user_id in ("owner", "keeper"):
                    enqueue_legacy_deletion(conn, namespace, buckets[namespace], f"{user_id}-{namespace}",
                                            account_user_id=user_id)
        with patch.object(Storage, "delete_file") as delete_file:
            self.assertTrue(completion.complete_account_deletion("owner", delete_auth=self.delete_auth))
        self.assertEqual(set(tuple(call.args) for call in delete_file.call_args_list),
                         {(buckets[namespace], f"owner-{namespace}") for namespace in completion.NAMESPACES})
        self.assertEqual(pending_legacy_deletions(account_user_id="owner"), 0)
        self.assertEqual(pending_legacy_deletions(account_user_id="keeper"), 4)
        self.delete_auth.assert_called_once_with("owner")

    def test_remaining_queue_blocks_auth_even_if_cleaner_claims_success(self):
        self.intent()
        with storage_objects.write_transaction() as conn:
            enqueue_legacy_deletion(conn, "note_media", "bucket", "pending", account_user_id="owner")
        with self.assertRaises(storage_objects.StorageUnavailable):
            self.finish()
        self.delete_auth.assert_not_called()
        self.assertEqual(pending_legacy_deletions(account_user_id="owner"), 1)
        self.assertIsNone(self.record()["auth_deleted_at"])

    def test_cleanup_failures_preserve_retry_and_logs_exclude_remote_bodies(self):
        self.intent()
        self.cleaners["avatars"].side_effect = AppwriteException(SECRET_RESPONSE, 503)
        with self.assertLogs(completion.logger, level="WARNING") as captured:
            result = completion.cleanup_pending_accounts(delete_auth=self.delete_auth, cleanup_functions=self.cleaners)
        self.assertEqual((result["completed"], result["failed"], result["pending"]), (0, 1, 1))
        self.assertNotIn(SECRET_RESPONSE, "\n".join(captured.output))
        self.assertTrue(all(record.exc_info is None for record in captured.records))
        self.delete_auth.assert_not_called()
        self.assertTrue(completion.pending_account_deletion("owner"))

    def test_legacy_avatar_failure_after_profile_removal_is_completed_on_later_pass(self):
        self.profile()
        with ExitStack() as stack:
            for name, value in (("ENDPOINT", "https://legacy.example.test/v1"), ("PROJECT_ID", "nest-project"),
                                ("PROFILE_AVATAR_BUCKET_ID", "profile-images")):
                stack.enter_context(patch.object(avatar_storage, name, value))
            with database.db_connection() as conn:
                conn.execute("UPDATE users SET avatar_file_id = ?, avatar_storage_backend = 'appwrite', "
                             "picture_url = ? WHERE id = 'owner'",
                             ["legacy-avatar", avatar_storage.build_avatar_view_url("legacy-avatar", backend="appwrite")])
            with patch.object(Storage, "delete_file", side_effect=AppwriteException(SECRET_RESPONSE, 503)):
                with self.assertRaises(storage_objects.StorageUnavailable):
                    delete_user_storage("owner")
            with database.db_connection() as conn:
                self.assertIsNone(conn.execute("SELECT 1 FROM users WHERE id = 'owner'").fetchone())
            self.assertIsNone(self.record()["auth_deleted_at"])
            self.assertEqual(pending_legacy_deletions(account_user_id="owner"), 1)
            with patch.object(Storage, "delete_file", side_effect=AppwriteException("already absent", 404)):
                result = completion.cleanup_pending_accounts(delete_auth=self.delete_auth)
        self.assertEqual((result["completed"], result["failed"], result["pending"]), (1, 0, 0))
        self.assertEqual(pending_legacy_deletions(account_user_id="owner"), 0)
        self.delete_auth.assert_called_once_with("owner")

    def test_batch_scope_and_limit_skip_completed_and_profile_present_accounts(self):
        for user_id in ("owner", "keeper", "active"):
            self.intent(user_id)
        self.intent("done", completed=True)
        self.profile("active")
        result = completion.cleanup_pending_accounts(account_user_id="owner", delete_auth=self.delete_auth,
                                                     cleanup_functions=self.cleaners, limit=1)
        self.assertEqual(result, {"completed": 1, "pending": 0, "eligible": 0, "blocked": 0, "failed": 0})
        self.delete_auth.assert_called_once_with("owner")
        self.assertIsNone(self.record("keeper")["auth_deleted_at"])
        self.delete_auth.reset_mock()
        result = completion.cleanup_pending_accounts(delete_auth=self.delete_auth, cleanup_functions=self.cleaners, limit=1)
        self.delete_auth.assert_called_once_with("keeper")
        self.assertEqual(result, {"completed": 1, "pending": 1, "eligible": 0, "blocked": 1, "failed": 0})

    def test_failed_oldest_account_cannot_starve_a_later_batch(self):
        self.intent("oldest")
        self.intent("later")
        with database.db_connection() as conn:
            conn.execute("UPDATE storage_account_deletions SET deleted_at = ? WHERE user_id = 'later'",
                         ["2026-10-02T12:00:00Z"])

        def delete_auth(user_id):
            if user_id == "oldest":
                raise AppwriteException("temporarily unavailable", 503)

        self.delete_auth.side_effect = delete_auth
        first = completion.cleanup_pending_accounts(delete_auth=self.delete_auth, cleanup_functions=self.cleaners, limit=1)
        self.assertEqual((first["completed"], first["failed"]), (0, 1))
        self.assertIsNotNone(self.record("oldest")["last_attempt_at"])
        second = completion.cleanup_pending_accounts(delete_auth=self.delete_auth, cleanup_functions=self.cleaners, limit=1)
        self.assertEqual((second["completed"], second["failed"], second["pending"]), (1, 0, 1))
        self.assertEqual(self.delete_auth.call_args_list, [call("oldest"), call("later")])
        self.assertTrue(completion.pending_account_deletion("oldest"))
        third = completion.cleanup_pending_accounts(delete_auth=self.delete_auth, cleanup_functions=self.cleaners, limit=1)
        self.assertEqual((third["completed"], third["failed"]), (0, 1))
        self.assertEqual(self.delete_auth.call_args_list[-1], call("oldest"))

    def test_auth_batch_failure_is_sanitized_and_retry_remains_eligible(self):
        self.intent()
        self.delete_auth.side_effect = AppwriteException(SECRET_RESPONSE, 503)
        with self.assertLogs(completion.logger, level="WARNING") as captured:
            result = completion.cleanup_pending_accounts(delete_auth=self.delete_auth, cleanup_functions=self.cleaners)
        self.assertEqual(result, {"completed": 0, "pending": 1, "eligible": 1, "blocked": 0, "failed": 1})
        self.assertNotIn(SECRET_RESPONSE, "\n".join(captured.output))
        self.assertTrue(all(record.exc_info is None for record in captured.records))


class AccountDeletionRouteTests(CompletionDatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.app.secret_key = "test"
        self.app.config.update(TESTING=True, WTF_CSRF_ENABLED=False)
        csrf.init_app(self.app)
        login = LoginManager(self.app)

        @login.user_loader
        def load_user(user_id):
            user = UserMixin()
            user.id = user_id
            return user

        self.app.add_url_rule("/", endpoint="dashboard.dashboard", view_func=lambda: "home")
        self.app.add_url_rule("/csrf-test", view_func=lambda: {"token": generate_csrf()})
        self.app.register_blueprint(admin.admin_bp)
        self.app.register_blueprint(settings.settings_bp)
        patches = ExitStack()
        self.addCleanup(patches.close)
        patches.enter_context(patch.dict(os.environ, {"ADMIN_USER_IDS": "administrator"}))
        patches.enter_context(patch.object(completion, "_cleanup_functions", return_value=self.cleaners))
        self.admin_sdk = patches.enter_context(patch.object(admin, "Users"))
        self.settings_sdk = patches.enter_context(patch.object(settings, "Users"))
        self.audit = patches.enter_context(patch.object(admin, "_log_admin_action"))
        self.toast = patches.enter_context(patch.object(admin, "push_toast"))

    def login(self, client, user_id="administrator"):
        with client.session_transaction() as session:
            session["_user_id"], session["_fresh"] = user_id, True
        g.pop("_login_user", None)

    def admin_post(self, client, user_id="owner", confirm="DELETE"):
        token = client.get("/csrf-test").get_json()["token"]
        return client.post(f"/admin/{user_id}/delete", data={"confirm": confirm}, headers={"X-CSRFToken": token})

    def test_admin_missing_profile_pending_tombstone_can_retry_without_local_deletion(self):
        self.intent()
        self.admin_sdk.return_value.delete.side_effect = AppwriteException("already deleted", 404)
        with self.app.test_client() as client, patch.object(admin, "_delete_user_rows") as local_delete:
            self.login(client)
            response = self.admin_post(client)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.location, "/admin/auth?tab=users")
        local_delete.assert_not_called()
        self.admin_sdk.return_value.delete.assert_called_once_with("owner")
        self.assertIsNotNone(self.record()["auth_deleted_at"])
        self.audit.assert_called_once()

    def test_admin_missing_profile_without_pending_intent_returns_404_without_sdk(self):
        self.intent("done", completed=True)
        with self.app.test_client() as client, patch.object(admin, "_delete_user_rows") as local_delete:
            self.login(client)
            for user_id in ("no-intent", "done"):
                with self.subTest(user_id=user_id):
                    response = self.admin_post(client, user_id)
                    self.assertEqual(response.status_code, 404)
        local_delete.assert_not_called()
        self.admin_sdk.assert_not_called()
        self.audit.assert_not_called()

    def test_admin_retry_rejects_anonymous_and_non_admin_before_touching_intent(self):
        self.intent()
        with self.app.test_client() as client, patch.object(admin, "pending_account_deletion") as pending:
            response = self.admin_post(client)
            self.assertEqual(response.status_code, 401)
            self.login(client, "regular-user")
            response = self.admin_post(client)
            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.location, "/")
        pending.assert_not_called()
        self.admin_sdk.assert_not_called()
        self.audit.assert_not_called()

    def test_admin_retry_requires_confirmation_and_csrf_before_sdk(self):
        self.intent()
        with self.app.test_client() as client:
            self.login(client)
            response = self.admin_post(client, confirm="WRONG")
            self.assertEqual(response.status_code, 302)
            self.app.config["WTF_CSRF_ENABLED"] = True
            response = client.post("/admin/owner/delete", data={"confirm": "DELETE"})
            self.assertEqual(response.status_code, 400)
        self.admin_sdk.assert_not_called()
        self.assertIsNone(self.record()["auth_deleted_at"])

    def test_admin_auth_failure_keeps_pending_intent_and_does_not_audit_success(self):
        self.intent()
        self.admin_sdk.return_value.delete.side_effect = AppwriteException(SECRET_RESPONSE, 503)
        with self.app.test_client() as client, self.assertLogs(admin.logger, level="WARNING") as captured:
            self.login(client)
            response = self.admin_post(client)
        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/owner?section=overview", response.location)
        self.assertIsNone(self.record()["auth_deleted_at"])
        self.audit.assert_not_called()
        self.assertNotIn(SECRET_RESPONSE, "\n".join(captured.output))
        self.assertTrue(all(record.exc_info is None for record in captured.records))

    def test_settings_auth_retry_reports_sanitized_failure_then_completes_404(self):
        self.intent()
        self.settings_sdk.return_value.delete.side_effect = AppwriteException(SECRET_RESPONSE, 503)
        with self.app.test_client() as client, patch.object(settings, "delete_user_data", return_value=[]):
            self.login(client, "owner")
            with self.assertLogs(settings.logger, level="WARNING") as captured:
                response = client.post("/api/account/delete")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.get_json()["code"], "storage_unavailable")
            self.assertNotIn(SECRET_RESPONSE, response.get_data(as_text=True))
            self.assertNotIn(SECRET_RESPONSE, "\n".join(captured.output))
            self.assertTrue(all(record.exc_info is None for record in captured.records))
            self.assertIsNone(self.record()["auth_deleted_at"])
            self.settings_sdk.return_value.delete.side_effect = AppwriteException("already deleted", 404)
            response = client.post("/api/account/delete")
        self.assertEqual((response.status_code, response.get_json()), (200, {"status": "ok"}))
        self.assertIsNotNone(self.record()["auth_deleted_at"])
        self.assertEqual(self.settings_sdk.return_value.delete.call_count, 2)

    def test_settings_local_cleanup_failure_and_pause_never_call_sdk(self):
        with self.app.test_client() as client, patch.object(settings, "delete_user_data", return_value=["calendar"]) as local:
            self.login(client, "owner")
            self.assertEqual(client.post("/api/account/delete").status_code, 500)
            local.reset_mock()
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
            response = client.post("/api/account/delete")
            self.assertEqual((response.status_code, response.get_json()["code"]), (503, "storage_mutations_paused"))
            local.assert_not_called()
        self.settings_sdk.assert_not_called()


class AccountDeletionCliTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "nest.sqlite3"
        with closing(sqlite3.connect(self.path)) as conn:
            conn.execute("CREATE TABLE users(id TEXT PRIMARY KEY)")
            conn.execute("CREATE TABLE storage_account_deletions(user_id TEXT PRIMARY KEY, deleted_at TEXT, auth_deleted_at TEXT, last_attempt_at TEXT)")
            conn.executemany("INSERT INTO storage_account_deletions (user_id, deleted_at, auth_deleted_at) VALUES (?, ?, ?)",
                             [("owner", NOW, None), ("active", NOW, None), ("done", NOW, NOW)])
            conn.execute("INSERT INTO users VALUES ('active')")
            conn.execute("CREATE TABLE storage_legacy_deletions(account_user_id TEXT)")
            conn.commit()
        environment = patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "false"})
        environment.start()
        self.addCleanup(environment.stop)
        self.cleaners = {namespace: Mock(return_value={"completed": 0, "pending": 0})
                         for namespace in completion.NAMESPACES}

    def test_status_counts_are_scoped_read_only_and_need_no_sdk_or_schema_mutation(self):
        before = self.path.read_bytes()
        with patch.object(database, "connect") as connect, patch.object(database, "init_db") as init_db, \
                patch.object(completion, "_cleanup_functions") as cleaners, patch.object(completion, "_delete_auth_account") as auth:
            result = cli.run_cleanup(self.path, status_only=True)
            scoped = cli.run_cleanup(self.path, status_only=True, account_user_id="owner")
        self.assertEqual(result["accounts"], {"total": 3, "completed": 1, "pending": 2, "eligible": 1, "blocked": 1})
        self.assertEqual(scoped["accounts"], {"total": 1, "completed": 0, "pending": 1, "eligible": 1, "blocked": 0})
        self.assertEqual(self.path.read_bytes(), before)
        for mock in (connect, init_db, cleaners, auth):
            mock.assert_not_called()

    def test_missing_database_or_undeployed_schema_is_rejected_without_creation(self):
        absent = self.path.parent / "absent" / "nest.sqlite3"
        with self.assertRaises(sqlite3.Error):
            cli.run_cleanup(absent, status_only=True)
        self.assertFalse(absent.parent.exists())
        with closing(sqlite3.connect(self.path)) as conn:
            conn.execute("ALTER TABLE storage_account_deletions DROP COLUMN auth_deleted_at")
            conn.commit()
        before = self.path.read_bytes()
        with self.assertRaises(RuntimeError):
            cli.run_cleanup(self.path, status_only=True)
        self.assertEqual(self.path.read_bytes(), before)

    def test_pause_allows_status_and_blocks_mutation_without_calls(self):
        auth = Mock()
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            status = cli.run_cleanup(self.path, status_only=True, delete_auth=auth, cleanup_functions=self.cleaners)
            blocked = cli.run_cleanup(self.path, delete_auth=auth, cleanup_functions=self.cleaners)
        self.assertTrue(status["paused"])
        self.assertEqual(status["failed"], 0)
        self.assertEqual((blocked["paused"], blocked["failed"], blocked["pending"]), (True, 1, 2))
        auth.assert_not_called()
        for cleaner in self.cleaners.values():
            cleaner.assert_not_called()

    def test_offline_completion_uses_authoritative_final_counts_and_preserves_blocked_work(self):
        auth = Mock()
        result = cli.run_cleanup(self.path, account_user_id="owner", delete_auth=auth, cleanup_functions=self.cleaners)
        self.assertEqual((result["completed"], result["failed"], result["pending"]), (1, 0, 0))
        auth.assert_called_once_with("owner")
        final = cli.deletion_counts(self.path)
        self.assertEqual(final, {"total": 3, "completed": 2, "pending": 1, "eligible": 0, "blocked": 1})

    def test_main_loads_explicit_environment_before_sdk_and_emits_only_sanitized_json(self):
        env_file = self.path.parent / "completion.env"
        env_file.write_text("NEST_COMPLETION_TEST_VALUE=loaded-before-sdk\n")
        auth = Mock(side_effect=lambda _user_id: self.assertEqual(os.environ["NEST_COMPLETION_TEST_VALUE"], "loaded-before-sdk"))
        before_disable = logging.root.manager.disable
        with patch.dict(os.environ), patch.object(completion, "_delete_auth_account", auth), \
                patch.object(completion, "_cleanup_functions", return_value=self.cleaners), redirect_stdout(io.StringIO()) as output:
            code = cli.main(["--database-path", str(self.path), "--env-file", str(env_file), "--account-user-id", "owner"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["completed"], 1)
        self.assertEqual(logging.root.manager.disable, before_disable)
        with patch.object(cli, "run_cleanup", side_effect=AppwriteException(SECRET_RESPONSE, 503)), \
                redirect_stdout(io.StringIO()) as output:
            code = cli.main(["--database-path", str(self.path), "--env-file", str(env_file)])
        self.assertEqual(code, 1)
        self.assertNotIn(SECRET_RESPONSE, output.getvalue())
        self.assertEqual(json.loads(output.getvalue())["error_type"], "AppwriteException")
        self.assertEqual(logging.root.manager.disable, before_disable)

    def test_actual_status_cli_never_imports_clients_notifiers_or_opens_network(self):
        # Fresh-process coverage catches eager SDK imports hidden by the test
        # runner. Only --status runs here, with a disposable database.
        guard = """
import builtins, runpy, socket, sys
from services import database
def forbidden(*args, **kwargs):
    raise AssertionError('status attempted an external or mutating operation')
database.connect = forbidden
database.init_db = forbidden
socket.socket.connect = forbidden
socket.socket.connect_ex = forbidden
socket.socket.sendto = forbidden
original_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == 'appwrite_client' or name.startswith(('appwrite.services.', 'services.discord', 'services.notifications')):
        forbidden()
    return original_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
sys.argv = [sys.argv[1], *sys.argv[2:]]
runpy.run_path(sys.argv[0], run_name='__main__')
"""
        before, files = self.path.read_bytes(), set(self.path.parent.iterdir())
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run([sys.executable, "-c", guard, str(root / "scripts/cleanup_deleted_accounts.py"),
                                 "--status", "--database-path", str(self.path), "--env-file", str(self.path.parent / "absent.env")],
                                cwd=root, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(json.loads(result.stdout)["accounts"],
                         {"total": 3, "completed": 1, "pending": 2, "eligible": 1, "blocked": 1})
        self.assertEqual(result.stderr, "")
        self.assertEqual((self.path.read_bytes(), set(self.path.parent.iterdir())), (before, files))


if __name__ == "__main__":
    unittest.main()
