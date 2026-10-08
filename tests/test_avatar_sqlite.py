"""Profile objects and their public image route on an isolated SQLite store."""

import base64
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

from flask import Flask, session
from PIL import Image
from appwrite.exception import AppwriteException

import blueprints.auth as auth
import blueprints.settings as settings
from avatar_images import avatar_url_for_size
from extensions import login_manager
from models import User, user_from_doc
from services import avatar_storage, database, entitlements, storage_objects
from services.storage_errors import StorageIntegrityError, StorageMutationPaused, StorageUnavailable


def png_bytes(size=(12, 12)):
    output = io.BytesIO()
    Image.new("RGB", size, "#334455").save(output, format="PNG")
    return output.getvalue()


class AvatarSqliteTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = os.path.join(directory.name, "avatars.sqlite3")
        keyring = os.path.join(directory.name, "upload-keys.json")
        with open(keyring, "w") as handle:
            json.dump({"active_key_id": "fixture", "keys": {"fixture": base64.b64encode(b"k" * 32).decode()}}, handle)
        os.chmod(keyring, 0o600)
        self.app = Flask(__name__)
        self.app.config.update(
            TESTING=True, SECRET_KEY="avatar-fixture", DATABASE_PATH=self.path,
            NEST_STORAGE_BACKEND="sqlite", NEST_STORAGE_READ_LEGACY=False,
            NEST_UPLOAD_KEYRING_PATH=keyring,
        )
        database.init_db(path=self.path)
        self.app.register_blueprint(settings.settings_bp, url_prefix="/settings")
        self.app.register_blueprint(settings.avatars_bp)
        self.app.register_blueprint(auth.auth_bp)
        login_manager.init_app(self.app)
        old_loader = login_manager._user_callback
        old_view = login_manager.login_view
        self.addCleanup(setattr, login_manager, "_user_callback", old_loader)
        self.addCleanup(setattr, login_manager, "login_view", old_view)
        login_manager.login_view = None
        login_manager._user_callback = lambda uid: user_from_doc(database.get_row("users", uid, path=self.path))
        stack = self.enterContext(ExitStack())
        self.scanner = stack.enter_context(patch.object(storage_objects, "scan_upload"))
        self.transport = stack.enter_context(patch.object(avatar_storage, "Storage", side_effect=AssertionError("Appwrite transport unavailable")))
        stack.enter_context(patch.object(settings, "emit_creation_event"))
        stack.enter_context(patch.object(settings, "sync_chat_presence_labels_for_user"))
        with self.app.app_context():
            database.create_row("users", "one", {"google_id": "one", "email": "one@example.test",
                "name": "One", "username": "one", "created_at": "2026-10-01T00:00:00Z", "tier": "free"})
        self.client = self.app.test_client()
        with self.client.session_transaction() as client_session:
            client_session["_user_id"] = "one"
            client_session["_fresh"] = True

    def upload(self, data=None, *, mime="image/png", filename="avatar.png"):
        data = png_bytes() if data is None else data
        return self.client.post("/settings/api/avatar-upload", data={"avatar": (io.BytesIO(data), filename, mime)})

    def row(self):
        return database.get_row("users", "one", path=self.path)

    def object_count(self):
        with database.db_connection(self.path) as conn:
            return conn.execute("SELECT COUNT(*) FROM storage_objects WHERE namespace='avatars'").fetchone()[0]

    def prepare(self, *, user_id="one", backend="sqlite"):
        with self.app.app_context(), patch.object(avatar_storage, "ENDPOINT", "https://legacy.example/v1"), patch.object(avatar_storage, "PROJECT_ID", "fixture"):
            return avatar_storage.prepare_avatar_upload(user_id, png_bytes(), filename="avatar.png", mime_type="image/png", backend=backend)

    def assert_writer_available(self, *_args, **_kwargs):
        with database.db_connection(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")

    def test_upload_encrypted_image_and_public_range_cache_contract(self):
        data = png_bytes()
        response = self.upload(data)
        self.assertEqual(response.status_code, 200, response.json)
        url = response.json["picture_url"]
        self.assertTrue(url.startswith("/api/avatars/"))
        row = self.row()
        self.assertEqual(row["avatar_storage_backend"], "sqlite")
        self.assertEqual(row["avatar_file_size_bytes"], len(data))
        with database.db_connection(self.path) as conn:
            stored = conn.execute("SELECT payload, byte_length FROM storage_objects").fetchone()
            self.assertNotEqual(stored["payload"], data)
            self.assertEqual(stored["byte_length"], len(data))
            owned = dict(conn.execute("SELECT * FROM storage_avatar_ownership").fetchone())
            self.assertEqual(owned, {"object_id": row["avatar_file_id"], "user_id": "one",
                                    "size_bytes": len(data), "storage_backend": "sqlite"})
        anonymous = self.app.test_client()
        downloaded = anonymous.get(url)
        self.assertEqual(downloaded.data, data)
        self.assertEqual(downloaded.headers["Content-Type"], "image/png")
        self.assertEqual(downloaded.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("inline", downloaded.headers["Content-Disposition"])
        self.assertIn("public", downloaded.headers["Cache-Control"])
        ranged = anonymous.get(url, headers={"Range": "bytes=0-7"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.data, data[:8])
        conditional = anonymous.get(url, headers={"If-None-Match": downloaded.headers["ETag"]})
        self.assertEqual(conditional.status_code, 304)
        self.assertEqual(anonymous.head(url).headers["Content-Length"], str(len(data)))
        self.assertEqual(anonymous.get(url, headers={"Range": "bytes=999999-"}).status_code, 416)
        self.transport.assert_not_called()

    def test_valid_upload_above_old_three_mib_bucket_limit(self):
        # A valid uncompressed PNG is larger than the legacy bucket's 3 MiB cap.
        output = io.BytesIO()
        Image.new("RGB", (1100, 1100), "#123456").save(output, format="PNG", compress_level=0)
        data = output.getvalue()
        self.assertGreater(len(data), 3 * 1024 * 1024)
        self.assertLess(len(data), avatar_storage.MAX_AVATAR_BYTES)
        response = self.upload(data)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.app.test_client().get(response.json["picture_url"]).data, data)
        self.scanner.assert_called_once_with(data)

    def test_invalid_image_mime_and_oversize_never_persist(self):
        cases = [(b"not an image", "image/png"), (png_bytes(), "image/jpeg"),
                 (b"x" * (avatar_storage.MAX_AVATAR_BYTES + 1), "image/png")]
        for data, mime in cases:
            with self.subTest(mime=mime, byte_count=len(data)):
                response = self.upload(data, mime=mime)
                self.assertEqual(response.status_code, 400, response.json)
                self.assertEqual(self.object_count(), 0)
        self.scanner.assert_not_called()
        self.assertIsNone(self.row()["avatar_file_id"])

    def test_scanner_unavailable_leaves_profile_and_object_unchanged(self):
        with patch.object(storage_objects, "scan_upload", side_effect=StorageUnavailable("Scanner is unavailable.")):
            response = self.upload()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.object_count(), 0)
        self.assertIsNone(self.row()["avatar_file_id"])

    def test_profile_failure_rolls_back_uploaded_payload(self):
        old = self.upload()
        self.assertEqual(old.status_code, 200)
        old_id = old.json["avatar_file_id"]
        with patch.object(avatar_storage, "_write_user", side_effect=sqlite3.OperationalError("fixture profile failure")):
            response = self.upload()
        self.assertEqual(response.status_code, 503, response.json)
        self.assertEqual(self.object_count(), 1)
        with database.db_connection(self.path) as conn:
            self.assertEqual(conn.execute("SELECT object_id FROM storage_avatar_ownership").fetchone()[0], old_id)
        self.assertEqual(self.row()["avatar_file_id"], old_id)
        self.assertEqual(self.app.test_client().get(old.json["picture_url"]).status_code, 200)

    def test_quota_is_rechecked_under_profile_write_lock(self):
        snapshots = []
        checker = entitlements.check_storage_transaction
        def check(conn, user_id, additional_bytes, **kwargs):
            snapshots.append((conn.in_transaction, kwargs["replacing_bytes"]))
            return checker(conn, user_id, additional_bytes, **kwargs)
        self.upload()
        with patch.object(entitlements, "check_storage_transaction", side_effect=check):
            response = self.upload()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(snapshots, [(True, len(png_bytes()))])
        self.assertEqual(self.object_count(), 1)

    def test_replacement_retains_historical_chat_avatar(self):
        old = self.upload().json
        with database.db_connection(self.path) as conn:
            for index in range(3):
                conn.execute("INSERT INTO chat_messages (id, user_id, author_avatar_url, content, created_at) VALUES (?, ?, ?, ?, ?)",
                             (f"history-{index}", "one", old["picture_url"], "Historical avatar", "2026-10-01T00:00:00Z"))
        new = self.upload()
        self.assertEqual(new.status_code, 200)
        self.assertNotEqual(old["avatar_file_id"], new.json["avatar_file_id"])
        self.assertEqual(self.object_count(), 2)
        with database.db_connection(self.path) as conn:
            self.assertEqual(entitlements.storage_usage_transaction(conn, "one"), 2 * len(png_bytes()))
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_avatar_ownership").fetchone()[0], 2)
        self.assertEqual(self.app.test_client().get(old["picture_url"]).data, png_bytes())

    def test_retained_history_cannot_use_replacement_credit_to_exceed_quota(self):
        old = self.upload().json
        with database.db_connection(self.path) as conn:
            conn.execute("INSERT INTO chat_messages (id,user_id,author_avatar_url,content,created_at) VALUES (?,?,?,?,?)",
                         ("history", "one", old["picture_url"], "keep", "2026-10-01T00:00:00Z"))
            conn.execute("INSERT INTO chat_bridge_config (id,config_key,config_value,created_at) VALUES (?,?,?,?)",
                         ("limits", "tier_entitlements", json.dumps({"free": {"storage_bytes": len(png_bytes())}}), "2026-10-01"))
        response = self.upload()
        self.assertEqual(response.status_code, 403, response.json)
        self.assertEqual(self.row()["avatar_file_id"], old["avatar_file_id"])
        self.assertEqual(self.object_count(), 1)
        with database.db_connection(self.path) as conn:
            self.assertEqual(entitlements.storage_usage_transaction(conn, "one"), len(png_bytes()))

    def test_replacement_cannot_credit_another_uploaders_current_avatar(self):
        old = self.upload().json
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE storage_avatar_ownership SET user_id = 'original-uploader' WHERE object_id = ?", [old["avatar_file_id"]])
        checker = entitlements.check_storage_transaction
        credits = []
        def check(conn, user_id, additional_bytes, **kwargs):
            credits.append(kwargs["replacing_bytes"])
            return checker(conn, user_id, additional_bytes, **kwargs)
        with patch.object(entitlements, "check_storage_transaction", side_effect=check):
            response = self.upload()
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(credits, [0])

    def test_url_only_borrower_does_not_suppress_baseline_uploader_charge(self):
        old = self.upload().json
        with database.db_connection(self.path) as conn:
            conn.execute("DELETE FROM storage_avatar_ownership")
            conn.execute("INSERT INTO users(id,google_id,email,picture_url,created_at) VALUES (?,?,?,?,?)",
                         ("borrower", "borrower", "borrower@example.test", old["picture_url"], "2026-10-01"))
        self.assertEqual(self.upload().status_code, 200)
        with database.db_connection(self.path) as conn:
            self.assertEqual(entitlements.storage_usage_transaction(conn, "one"), 2 * len(png_bytes()))
            self.assertEqual(entitlements.storage_usage_transaction(conn, "borrower"), 0)
            self.assertEqual(conn.execute("SELECT user_id FROM storage_avatar_ownership WHERE object_id = ?", [old["avatar_file_id"]]).fetchone()[0], "one")

    def test_historical_canonical_legacy_avatar_reads_through_compatibility_gate(self):
        legacy = self.prepare(backend="appwrite")
        canonical = f"/api/avatars/{legacy['file_id']}"
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=Mock()):
            avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(legacy, "upload"), prepared=legacy)
        with database.db_connection(self.path) as conn:
            conn.execute("INSERT INTO chat_messages(id,user_id,author_avatar_url,content,created_at) VALUES (?,?,?,?,?)",
                         ("legacy-history", "one", canonical, "retain", "2026-10-01"))
        self.assertEqual(self.upload().status_code, 200)
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        with patch("services.storage_legacy_transport.read_legacy_file", return_value=png_bytes()) as read:
            response = self.app.test_client().get(canonical)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, png_bytes())
        self.assertEqual(read.call_args.kwargs["expected_bytes"], len(png_bytes()))
        self.app.config["NEST_STORAGE_READ_LEGACY"] = False
        with patch("services.storage_legacy_transport.read_legacy_file") as read:
            self.assertEqual(self.app.test_client().get(canonical).status_code, 503)
        read.assert_not_called()

    def test_owned_sqlite_avatar_missing_payload_never_falls_back_for_history(self):
        old = self.upload().json
        with database.db_connection(self.path) as conn:
            conn.execute("INSERT INTO chat_messages(id,user_id,author_avatar_url,content,created_at) VALUES (?,?,?,?,?)",
                         ("local-history", "one", old["picture_url"], "retain", "2026-10-01"))
        self.assertEqual(self.upload().status_code, 200)
        with database.db_connection(self.path) as conn:
            conn.execute("DELETE FROM storage_objects WHERE object_id = ?", [old["avatar_file_id"]])
            conn.execute("UPDATE chat_messages SET author_avatar_url = ? WHERE id = 'local-history'",
                         [f"https://legacy.example/v1/storage/buckets/profile_avatars/files/{old['avatar_file_id']}/view?project=fixture"])
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        with patch.object(avatar_storage, "ENDPOINT", "https://legacy.example/v1"), patch.object(avatar_storage, "PROJECT_ID", "fixture"), \
                patch("services.storage_legacy_transport.read_legacy_file") as read:
            self.assertEqual(self.app.test_client().get(old["picture_url"]).status_code, 404)
        read.assert_not_called()

    def test_pending_legacy_retirement_remains_billed_until_scoped_retry_succeeds(self):
        legacy = self.prepare(backend="appwrite")
        transport = Mock()
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
            avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(legacy, "upload"), prepared=legacy)
        transport.delete_file.side_effect = AppwriteException("offline", 503)
        checker = entitlements.check_storage_transaction
        credits = []
        def check(conn, user_id, additional_bytes, **kwargs):
            credits.append(kwargs["replacing_bytes"])
            return checker(conn, user_id, additional_bytes, **kwargs)
        with patch.object(avatar_storage, "Storage", return_value=transport), patch.object(entitlements, "check_storage_transaction", side_effect=check):
            response = self.upload()
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(credits, [0])
        with database.db_connection(self.path) as conn:
            pending = dict(conn.execute("SELECT * FROM storage_legacy_deletions").fetchone())
            self.assertEqual((pending["object_id"], pending["account_user_id"]), (legacy["file_id"], "one"))
            self.assertEqual(entitlements.storage_usage_transaction(conn, "one"), 2 * len(png_bytes()))
        transport.delete_file.side_effect = self.assert_writer_available
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
            self.assertEqual(avatar_storage.cleanup_legacy_avatars(account_user_id="different-account"), {"completed": 0, "pending": 0})
            self.assertEqual(avatar_storage.cleanup_legacy_avatars(account_user_id="one"), {"completed": 1, "pending": 0})
        with database.db_connection(self.path) as conn:
            self.assertEqual(entitlements.storage_usage_transaction(conn, "one"), len(png_bytes()))
            self.assertIsNone(conn.execute("SELECT 1 FROM storage_avatar_ownership WHERE object_id = ?", [legacy["file_id"]]).fetchone())

    def test_pending_retirement_blocks_profile_resurrection_and_rechecks_other_refs(self):
        legacy = self.prepare(backend="appwrite")
        transport = Mock()
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
            avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(legacy, "upload"), prepared=legacy)
        transport.delete_file.side_effect = AppwriteException("offline", 503)
        with patch.object(avatar_storage, "Storage", return_value=transport):
            self.assertEqual(self.upload().status_code, 200)
        with self.app.app_context():
            with self.assertRaises(StorageUnavailable):
                avatar_storage.persist_avatar_user("one", {"avatar_file_id": legacy["file_id"], "picture_url": legacy["view_url"]})
        with database.db_connection(self.path) as conn:
            conn.execute("INSERT INTO users(id,google_id,email,avatar_file_id,created_at) VALUES (?,?,?,?,?)",
                         ("peer", "peer", "peer@example.test", legacy["file_id"], "2026-10-01"))
        transport.delete_file.reset_mock()
        transport.delete_file.side_effect = None
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
            result = avatar_storage.cleanup_legacy_avatars(object_ids=[legacy["file_id"]])
        self.assertEqual(result, {"completed": 0, "pending": 1})
        transport.delete_file.assert_not_called()
        with database.db_connection(self.path) as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM storage_avatar_ownership WHERE object_id = ?", [legacy["file_id"]]).fetchone())

    def test_prepared_avatar_cannot_publish_for_a_different_account(self):
        prepared = self.prepare(user_id="different-uploader")
        with self.app.app_context():
            with self.assertRaises(storage_objects.StorageValidationError):
                avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(prepared), prepared=prepared)
        self.assertEqual(self.object_count(), 0)

    def test_profile_removal_is_atomic_and_pause_preserves_avatar(self):
        old = self.upload().json
        data = {"name": "One", "username": "one", "picture_url": "https://provider.example/avatar.png",
                "avatar_source": "url", "school": "", "major": ""}
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        response = self.client.post("/settings/api/profile", json=data)
        self.assertEqual(response.status_code, 503, response.json)
        self.assertEqual(self.row()["avatar_file_id"], old["avatar_file_id"])
        self.assertEqual(self.object_count(), 1)
        self.assertEqual(self.upload().status_code, 503)
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
        response = self.client.post("/settings/api/profile", json=data)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertIsNone(self.row()["avatar_file_id"])
        self.assertEqual(self.object_count(), 0)

    def test_missing_and_corrupt_local_objects_never_use_legacy_transport(self):
        self.assertEqual(self.app.test_client().get("/api/avatars/missing").status_code, 404)
        old = self.upload().json
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE storage_objects SET payload = ?", [b"z" * (len(png_bytes()) + 16)])
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        response = self.app.test_client().get(old["picture_url"])
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json["code"], "storage_integrity_error")
        self.transport.assert_not_called()

    def test_provider_prepare_has_no_partial_object_then_atomic_profile_commit(self):
        with self.app.app_context(), patch.object(avatar_storage, "_download_provider_avatar", return_value=(png_bytes(), "image/png")):
            prepared = avatar_storage.prepare_avatar_from_url("one", "https://provider.example/avatar")
            self.assertEqual(self.object_count(), 0)
            avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(prepared), prepared=prepared)
        self.assertEqual(self.object_count(), 1)
        self.assertEqual(self.row()["avatar_source"], "provider")

    def test_provider_copy_cannot_override_manual_upload_during_download(self):
        with self.app.app_context(), patch.object(avatar_storage, "_download_provider_avatar", return_value=(png_bytes(), "image/png")):
            prepared = avatar_storage.prepare_avatar_from_url("one", "https://provider.example/avatar")
        chosen = self.upload().json
        with self.app.app_context():
            avatar_storage.persist_avatar_user("one", {**avatar_storage.avatar_profile_fields(prepared), "last_login": "2026-10-01T01:00:00Z"}, prepared=prepared)
        self.assertEqual(self.object_count(), 1)
        self.assertEqual(self.row()["avatar_file_id"], chosen["avatar_file_id"])
        self.assertEqual(self.row()["last_login"], "2026-10-01T01:00:00Z")

    def test_oauth_prepares_and_persists_sqlite_avatar_before_login(self):
        with self.app.test_request_context("/auth/session", method="POST"), ExitStack() as stack:
            stack.enter_context(patch.object(auth, "_provider_access_token_from_identities", return_value={}))
            stack.enter_context(patch.object(auth, "_fetch_provider_profile", return_value={"avatar_url": "https://provider.example/avatar"}))
            stack.enter_context(patch.object(avatar_storage, "_download_provider_avatar", return_value=(png_bytes(), "image/png")))
            stack.enter_context(patch.object(auth, "_find_user_by_email", return_value=None))
            stack.enter_context(patch.object(auth, "sync_chat_presence_labels_for_user"))
            stack.enter_context(patch.object(auth, "emit_user_event"))
            stack.enter_context(patch.object(auth, "_redirect_for_user_doc", return_value="/dashboard"))
            stack.enter_context(patch.object(auth.notes_collaboration, "claim_pending_invitations"))
            result = auth._complete_appwrite_login({"$id": "one", "email": "one@example.test"}, provider="google", provider_access_token="fixture")
            self.assertEqual(session["_user_id"], "one")
            self.assertEqual(result["user_doc"]["avatar_storage_backend"], "sqlite")
        self.assertEqual(self.object_count(), 1)
        self.assertEqual(self.row()["picture_url"], result["user_doc"]["picture_url"])
        self.transport.assert_not_called()

    def test_signup_settings_failure_rolls_back_profile_avatar_and_ownership(self):
        prepared = self.prepare(user_id="new-user")
        with self.app.app_context(), patch.object(avatar_storage, "_write_initial_settings", side_effect=sqlite3.OperationalError("fixture settings failure")):
            with self.assertRaises(StorageUnavailable):
                avatar_storage.persist_avatar_user("new-user", {
                    **avatar_storage.avatar_profile_fields(prepared), "google_id": "new-user",
                    "email": "new-user@example.test", "created_at": "2026-10-01",
                }, prepared=prepared, create=True, initial_settings={"created_at": "2026-10-01"})
        with database.db_connection(self.path) as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM users WHERE id = 'new-user'").fetchone())
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_avatar_ownership").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM user_settings").fetchone()[0], 0)
        self.assertEqual(self.object_count(), 0)

    def test_provider_download_and_backfill_stop_while_storage_mutations_paused(self):
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with self.app.app_context(), patch.object(avatar_storage, "_download_provider_avatar") as download:
            self.assertIsNone(avatar_storage.prepare_avatar_from_url("one", "https://provider.example/avatar"))
            result = auth._backfill_user_avatar(self.row())
        self.assertEqual(result["reason"], "storage_mutations_paused")
        download.assert_not_called()
        self.assertEqual(self.object_count(), 0)

    def test_appwrite_creation_and_failed_profile_rollback_do_not_hold_writer(self):
        prepared = self.prepare(backend="appwrite")
        transport = Mock()
        transport.create_file.side_effect = self.assert_writer_available
        transport.delete_file.side_effect = self.assert_writer_available
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport), \
                patch.object(avatar_storage, "_write_user", side_effect=sqlite3.OperationalError("fixture failed profile")):
            with self.assertRaises(StorageUnavailable):
                avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(prepared, "upload"), prepared=prepared)
        transport.create_file.assert_called_once()
        transport.delete_file.assert_called_once_with(avatar_storage.PROFILE_AVATAR_BUCKET_ID, prepared["file_id"])
        self.assertIsNone(self.row()["avatar_file_id"])
        self.assertEqual(self.object_count(), 0)

    def test_appwrite_quota_check_uses_live_profile_and_writer(self):
        old = self.upload().json
        prepared = self.prepare(backend="appwrite")
        transport = Mock()
        snapshots = []
        checker = entitlements.check_storage_transaction
        def check(conn, user_id, additional_bytes, **kwargs):
            snapshots.append((conn.in_transaction, kwargs["replacing_bytes"]))
            return checker(conn, user_id, additional_bytes, **kwargs)
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport), \
                patch.object(entitlements, "check_storage_transaction", side_effect=check):
            avatar_storage.persist_avatar_user("one", avatar_storage.avatar_profile_fields(prepared, "upload"), prepared=prepared)
        self.assertEqual(snapshots, [(True, len(png_bytes()))])
        self.assertEqual(self.row()["avatar_file_id"], prepared["file_id"])
        self.assertEqual(self.object_count(), 0)
        self.assertEqual(self.app.test_client().get(old["picture_url"]).status_code, 404)

    def test_appwrite_provider_copy_losing_to_manual_choice_removes_new_remote_file(self):
        prepared = self.prepare(backend="appwrite")
        chosen = self.upload().json
        transport = Mock()
        transport.delete_file.side_effect = self.assert_writer_available
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
            saved = avatar_storage.persist_avatar_user("one", {**avatar_storage.avatar_profile_fields(prepared), "last_login": "2026-10-01T01:00:00Z"},
                                                       prepared=prepared, provider_source_url="https://provider.example/avatar")
        self.assertEqual(saved["avatar_file_id"], chosen["avatar_file_id"])
        self.assertEqual(self.row()["last_login"], "2026-10-01T01:00:00Z")
        transport.delete_file.assert_called_once_with(avatar_storage.PROFILE_AVATAR_BUCKET_ID, prepared["file_id"])
        self.assertEqual(self.object_count(), 1)

    def test_deleted_accounts_reject_prepared_upload_and_oauth_recreation_on_both_backends(self):
        for backend in ("sqlite", "appwrite"):
            user_id = f"deleted-{backend}"
            prepared = self.prepare(user_id=user_id, backend=backend)
            with database.db_connection(self.path) as conn:
                conn.execute("INSERT INTO storage_account_deletions(user_id, deleted_at) VALUES (?, ?)",
                             (user_id, "2026-10-01T01:00:00Z"))
            transport = Mock()
            for create in (False, True):
                with self.subTest(backend=backend, create=create), self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
                    with self.assertRaises(StorageUnavailable):
                        avatar_storage.persist_avatar_user(user_id, {**avatar_storage.avatar_profile_fields(prepared, "upload"), "email": f"{user_id}@example.test"},
                                                           prepared=prepared, create=create)
                    self.assertIsNone(database.get_row("users", user_id, allow_missing=True, path=self.path))
            self.assertEqual(transport.delete_file.call_count, 2 if backend == "appwrite" else 0)
        self.assertEqual(self.object_count(), 0)

    def test_missing_live_user_rejects_upload_but_explicit_signup_can_create(self):
        for backend in ("sqlite", "appwrite"):
            user_id = f"new-{backend}"
            prepared = self.prepare(user_id=user_id, backend=backend)
            transport = Mock()
            with self.subTest(backend=backend), self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
                fields = {**avatar_storage.avatar_profile_fields(prepared), "google_id": user_id,
                          "email": f"{user_id}@example.test", "created_at": "2026-10-01T00:00:00Z"}
                with self.assertRaises(StorageUnavailable):
                    avatar_storage.persist_avatar_user(user_id, fields, prepared=prepared)
                self.assertIsNone(database.get_row("users", user_id, allow_missing=True, path=self.path))
                saved = avatar_storage.persist_avatar_user(user_id, fields, prepared=prepared, create=True)
                self.assertEqual(saved["avatar_file_id"], prepared["file_id"])

    def test_oauth_pause_preserves_existing_avatar_and_signs_in_on_both_backends(self):
        old = self.upload().json
        with self.app.app_context():
            database.update_row("users", "one", {"avatar_source": "provider"})
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        for backend in ("sqlite", "appwrite"):
            self.app.config["NEST_STORAGE_BACKEND"] = backend
            with self.subTest(backend=backend), self.app.test_request_context("/auth/session", method="POST"), ExitStack() as stack:
                stack.enter_context(patch.object(auth, "_provider_access_token_from_identities", return_value={}))
                stack.enter_context(patch.object(auth, "_fetch_provider_profile", return_value={"avatar_url": "https://provider.example/new"}))
                download = stack.enter_context(patch.object(avatar_storage, "_download_provider_avatar"))
                stack.enter_context(patch.object(auth, "sync_chat_presence_labels_for_user"))
                stack.enter_context(patch.object(auth, "_redirect_for_user_doc", return_value="/dashboard"))
                stack.enter_context(patch.object(auth.notes_collaboration, "claim_pending_invitations"))
                result = auth._complete_appwrite_login({"$id": "one", "email": "one@example.test"}, provider="google", provider_access_token="fixture")
                self.assertEqual(session["_user_id"], "one")
                self.assertEqual(result["user_doc"]["picture_url"], old["picture_url"])
                download.assert_not_called()
        self.assertEqual(self.row()["avatar_file_id"], old["avatar_file_id"])
        self.assertEqual(self.object_count(), 1)
        self.transport.assert_not_called()

    def test_appwrite_pause_during_remote_creation_keeps_profile_and_removes_uncommitted_image(self):
        prepared = self.prepare(backend="appwrite")
        transport = Mock()
        transport.create_file.side_effect = lambda *_args, **_kwargs: self.app.config.update(NEST_STORAGE_MUTATIONS_PAUSED=True)
        with self.app.app_context(), patch.object(avatar_storage, "Storage", return_value=transport):
            saved = avatar_storage.persist_avatar_user("one", {**avatar_storage.avatar_profile_fields(prepared), "last_login": "2026-10-01T01:00:00Z"},
                                                       prepared=prepared, provider_source_url="https://provider.example/avatar")
        self.assertIsNone(saved["avatar_file_id"])
        self.assertIsNone(self.row()["picture_url"])
        self.assertEqual(self.row()["last_login"], "2026-10-01T01:00:00Z")
        transport.delete_file.assert_called_once_with(avatar_storage.PROFILE_AVATAR_BUCKET_ID, prepared["file_id"])

    def test_account_pause_stops_cleanup_before_auth_deletion(self):
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with patch.object(settings, "delete_user_data") as cleanup, patch.object(settings, "Users") as users:
            response = self.client.post("/settings/api/account/delete")
        self.assertEqual(response.status_code, 503)
        cleanup.assert_not_called()
        users.assert_not_called()

    def test_avatar_identity_parsers_and_local_url_sizing_preserve_providers(self):
        with self.app.app_context(), patch.object(avatar_storage, "ENDPOINT", "https://legacy.example/v1"), patch.object(avatar_storage, "PROJECT_ID", "project"):
            legacy = "https://legacy.example/v1/storage/buckets/profile_avatars/files/one/view?project=project&width=32"
            self.assertEqual(avatar_storage.legacy_avatar_id(legacy), "one")
            for bad in [legacy.replace("legacy.example", "legacy.example.evil"), legacy.replace("project=project", "project=other"),
                        legacy.replace("profile_avatars", "notes"), legacy + "&project=project", legacy + "#fragment"]:
                self.assertIsNone(avatar_storage.legacy_avatar_id(bad))
            for bad in ["javascript:/api/avatars/one", "//nest.apstudy.org/api/avatars/one", "https://evil.example/api/avatars/one", "/api/avatars/one#fragment"]:
                self.assertIsNone(avatar_storage.local_avatar_id(bad))
            self.assertEqual(avatar_storage.local_avatar_id("/api/avatars/one"), "one")
            self.assertEqual(avatar_url_for_size("/api/avatars/one", 128), "/api/avatars/one")
            user = User({"id": "one", "avatar_file_id": "one", "avatar_storage_backend": "sqlite", "picture_url": legacy})
            self.assertEqual(user.picture_url, "/api/avatars/one")
            provider = "https://provider.example/avatar.png"
            self.assertEqual(User({"id": "one", "picture_url": provider}).picture_url, provider)


if __name__ == "__main__":
    unittest.main()
