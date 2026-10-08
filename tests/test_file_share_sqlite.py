import base64
import copy
import io
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask, g
from flask_login import LoginManager, UserMixin

from appwrite.exception import AppwriteException
from appwrite_helpers import format_datetime
import blueprints.file_share as fs
from services import database, file_cleanup, file_share_metadata, file_share_store, file_share_uploads, storage_objects, storage_rows
from services.entitlements import DEFAULT_TIER_DEFINITIONS, TIER_CONFIG_KEY
from services.storage_legacy_cleanup import pending_legacy_deletions
from services.storage_objects import StorageMutationPaused, StorageNotFound, StorageUnavailable, StorageValidationError
from services.time_utils import utcnow


class _TestUser(UserMixin, SimpleNamespace):
    pass


class FileShareSqliteTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        database_path = os.path.join(temporary.name, "nest.sqlite3")
        keyring_path = os.path.join(temporary.name, "upload-keys.json")
        with open(keyring_path, "w", encoding="utf-8") as keyring:
            json.dump({"active_key_id": "test", "keys": {"test": base64.b64encode(b"k" * 32).decode()}}, keyring)
        os.chmod(keyring_path, 0o600)

        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.app = Flask(__name__, template_folder=os.path.join(root, "templates"), static_folder=os.path.join(root, "static"))
        self.app.config.update(
            TESTING=True,
            SECRET_KEY="test",
            DATABASE_PATH=database_path,
            NEST_STORAGE_BACKEND="sqlite",
            NEST_STORAGE_MUTATIONS_PAUSED=False,
            NEST_STORAGE_READ_LEGACY=False,
            NEST_UPLOAD_KEYRING_PATH=keyring_path,
        )
        self.app.register_blueprint(fs.file_share_bp)
        login_manager = LoginManager(self.app)

        @self.app.before_request
        def reset_request_user():
            # The test keeps one application context for database helpers.
            # LoginManager's cache normally disappears with each request's
            # application context; emulate that boundary for separate clients.
            g.pop("_login_user", None)

        @login_manager.user_loader
        def load_user(user_id):
            return _TestUser(id=user_id, name="Test User", email=f"{user_id}@example.test", picture_url="", emory_student=False)

        context = self.app.app_context()
        context.push()
        self.addCleanup(context.pop)
        database.init_db(path=database_path)
        database.create_row("users", "owner", {
            "google_id": "owner", "email": "owner@example.test", "name": "Test User",
            "tier": "developer", "created_at": format_datetime(utcnow()),
        })

        self.entitlements = {"key": "developer", "limits": copy.deepcopy(DEFAULT_TIER_DEFINITIONS["developer"]), "usage": {"storage_bytes": 0}}
        for target, options in (
            ("services.storage_objects.scan_upload", {"return_value": None}),
            ("services.file_share_uploads.request_entitlements", {"return_value": self.entitlements}),
            ("services.file_share_uploads.emit_creation_event", {}),
            ("services.file_share_uploads._storage", {"side_effect": AssertionError("Appwrite Storage must be unavailable")}),
            ("services.file_share_store._storage", {"side_effect": AssertionError("Appwrite Storage must be unavailable")}),
            ("services.file_share_store.read_legacy_file", {"side_effect": AssertionError("Legacy Storage reads must be unavailable")}),
        ):
            patched = patch(target, **options)
            self.addCleanup(patched.stop)
            patched.start()
        self.client = self.app.test_client()
        self._login(self.client)

    def _login(self, client, user_id="owner"):
        with client.session_transaction() as session:
            session["_user_id"] = user_id
            session["_fresh"] = True

    def _upload(self, data=b"hello", *, client=None, filename="notes.txt", visibility="private", folder_id=None):
        form = {"file": (io.BytesIO(data), filename), "visibility": visibility, "expiryDays": "1"}
        if folder_id:
            form["folderId"] = folder_id
        response = (client or self.client).post("/api/files/upload", data=form)
        status, payload = response.status_code, response.get_json()
        response.close()
        response.request.environ["wsgi.input"].close()
        return status, payload

    def _uploaded_id(self, **kwargs):
        status, payload = self._upload(**kwargs)
        self.assertEqual(status, 201, payload)
        return payload["files"][0]["id"]

    def _counts(self):
        with database.db_connection() as conn:
            return (
                conn.execute("SELECT COUNT(*) FROM shared_files").fetchone()[0],
                conn.execute("SELECT COUNT(*) FROM storage_objects WHERE namespace='shared_files'").fetchone()[0],
            )

    def _set_limits(self, **limits):
        definitions = copy.deepcopy(DEFAULT_TIER_DEFINITIONS)
        definitions["developer"].update(limits)
        database.create_row("chat_bridge_config", "limits", {
            "config_key": TIER_CONFIG_KEY, "config_value": json.dumps(definitions), "created_at": format_datetime(utcnow()),
        })

    def _folder(self, folder_id="folder", *, user_id="owner", public=False, parent_folder_id=None):
        return database.create_row("file_folders", folder_id, {
            "user_id": user_id, "name": "Shared Notes", "is_public": public,
            "parent_folder_id": parent_folder_id,
            "share_code": "FOLDERSHARE" if public else None, "created_at": format_datetime(utcnow()),
        })

    def _legacy_file(self, file_id="legacy", *, user_id="owner", folder_id=None):
        now = utcnow()
        return database.create_row("shared_files", file_id, {
            "user_id": user_id, "folder_id": folder_id,
            "original_filename": "legacy.txt", "stored_path": f"appwrite://files/{file_id}",
            "storage_backend": "appwrite", "storage_bucket_id": "legacy-bucket", "storage_file_id": file_id,
            "file_size_bytes": 5, "mime_type": "text/plain", "is_public": False,
            "expires_at": format_datetime(now + timedelta(days=1)), "created_at": format_datetime(now),
        })

    def test_upload_encrypts_sqlite_object_and_keeps_download_url(self):
        file_id = self._uploaded_id()
        row = database.get_row("shared_files", file_id)
        self.assertEqual(row["storage_backend"], "sqlite")
        self.assertEqual(row["stored_path"], f"sqlite://shared_files/{file_id}")
        self.assertIsNone(row["storage_bucket_id"])
        self.assertEqual(storage_objects.read_object("shared_files", file_id), b"hello")
        with database.db_connection() as conn:
            ciphertext = conn.execute("SELECT payload FROM storage_objects WHERE object_id=?", (file_id,)).fetchone()[0]
        self.assertNotEqual(ciphertext, b"hello")
        self.assertEqual(self._counts(), (1, 1))

    def test_metadata_failure_rolls_back_uploaded_object(self):
        real_insert = storage_rows.insert_row

        def failing_insert(*args, **kwargs):
            real_insert(*args, **kwargs)
            raise sqlite3.IntegrityError("forced metadata failure")

        with patch.object(storage_rows, "insert_row", side_effect=failing_insert):
            status, payload = self._upload()
        self.assertEqual(status, 503, payload)
        self.assertEqual(payload["errors"][0]["code"], "storage_unavailable")
        self.assertEqual(self._counts(), (0, 0))

    def test_delete_failure_rolls_back_content_and_metadata(self):
        file_id = self._uploaded_id()
        with patch.object(storage_rows, "delete_row", side_effect=sqlite3.OperationalError("forced delete failure")):
            response = self.client.delete(f"/api/files/my/{file_id}")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(storage_objects.read_object("shared_files", file_id), b"hello")

    def test_sqlite_delete_retains_imported_appwrite_source_copy(self):
        file_id = self._uploaded_id()
        database.update_row("shared_files", file_id, {"storage_bucket_id": "legacy-source-bucket"})
        response = self.client.delete(f"/api/files/my/{file_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self._counts(), (0, 0))
        self.assertEqual(pending_legacy_deletions("shared_files"), 0)

    def test_stale_request_usage_cannot_bypass_sqlite_quota(self):
        self._set_limits(storage_bytes=7)
        self._uploaded_id(data=b"first")
        status, payload = self._upload(data=b"next")
        self.assertEqual(status, 400)
        self.assertEqual(payload["errors"][0]["code"], "tier_limit")
        self.assertEqual(payload["errors"][0]["current"], 5)
        self.assertEqual(self._counts(), (1, 1))

    def test_concurrent_uploads_serialize_quota_checks(self):
        self._set_limits(storage_bytes=5)
        barrier = threading.Barrier(2)

        def scan_before_lock(_data):
            barrier.wait(timeout=10)

        def upload():
            with self.app.test_client() as client:
                self._login(client)
                return self._upload(data=b"four", client=client)[0]

        with patch.object(storage_objects, "scan_upload", side_effect=scan_before_lock):
            with ThreadPoolExecutor(max_workers=2) as pool:
                statuses = list(pool.map(lambda _: upload(), range(2)))
        self.assertEqual(sorted(statuses), [201, 400])
        self.assertEqual(self._counts(), (1, 1))

    def test_current_tier_size_and_batch_limits_are_rechecked_inside_writer(self):
        self._set_limits(max_file_size_bytes=4, max_upload_files=1)
        status, payload = self._upload(data=b"hello")
        self.assertEqual(status, 400)
        self.assertEqual(payload["errors"][0]["resource"], "file size bytes")
        response = self.client.post("/api/files/upload", data={"file": [(io.BytesIO(b"one"), "one.txt"), (io.BytesIO(b"two"), "two.txt")]})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["errors"][0]["resource"], "files per upload")
        self.assertEqual(self._counts(), (0, 0))

    def test_absolute_file_size_limit_is_preserved_for_unlimited_tier(self):
        self.assertEqual(fs.MAX_FILE_SIZE, 50 * 1024 * 1024)
        with patch.object(file_share_uploads, "MAX_FILE_SIZE", 4):
            status, payload = self._upload(data=b"hello")
        self.assertEqual(status, 400)
        self.assertEqual(payload["errors"][0]["code"], "file_too_large")
        self.assertEqual(self._counts(), (0, 0))

    def test_scanning_finishes_before_sqlite_writer_is_acquired(self):
        def inspect_scanner(_data):
            with database.db_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 0)

        with patch.object(storage_objects, "scan_upload", side_effect=inspect_scanner):
            self._uploaded_id()

    def test_scanner_rejection_and_unavailability_leave_no_upload(self):
        for error, status in ((StorageValidationError("Upload rejected by antivirus scan."), 400), (StorageUnavailable("Upload scanner is unavailable."), 503)):
            with self.subTest(status=status), patch.object(storage_objects, "scan_upload", side_effect=error):
                actual_status, payload = self._upload()
                self.assertEqual(actual_status, status, payload)
                self.assertEqual(self._counts(), (0, 0))

    def test_folder_ownership_is_rechecked_after_preparation(self):
        self._folder()

        def change_owner(_data):
            database.update_row("file_folders", "folder", {"user_id": "other"})

        with patch.object(storage_objects, "scan_upload", side_effect=change_owner):
            status, _payload = self._upload(folder_id="folder")
        self.assertEqual(status, 404)
        self.assertEqual(self._counts(), (0, 0))

    def test_private_download_ranges_conditional_requests_and_headers(self):
        file_id = self._uploaded_id(data=b"0123456789")
        url = f"/api/files/my/{file_id}/download"
        with self.client.get(url) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(), b"0123456789")
            self.assertTrue(response.headers["Content-Disposition"].startswith("attachment;"))
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertIn("private", response.headers["Cache-Control"])
            etag = response.headers["ETag"]
        with self.client.get(url, headers={"Range": "bytes=2-5"}) as response:
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.get_data(), b"2345")
            self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
        with self.client.get(url, headers={"If-None-Match": etag}) as response:
            self.assertEqual(response.status_code, 304)
            self.assertEqual(response.get_data(), b"")
        self.assertEqual(database.get_row("shared_files", file_id)["downloaded_count"], 2)

        other = self.app.test_client()
        self._login(other, "other")
        self.assertEqual(other.get(url, headers={"If-None-Match": etag}).status_code, 404)
        self.assertEqual(self.app.test_client().get(url, headers={"If-None-Match": etag}).status_code, 401)

    def test_download_sanitizes_active_mime_and_disposition(self):
        file_id = self._uploaded_id()
        database.update_row("shared_files", file_id, {"original_filename": "../bad\r\nname.html", "mime_type": "text/html"})
        with self.client.get(f"/api/files/my/{file_id}/download") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "application/octet-stream")
            self.assertNotIn("\r", response.headers["Content-Disposition"])
            self.assertNotIn("\n", response.headers["Content-Disposition"])
            self.assertNotIn("../", response.headers["Content-Disposition"])
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_corrupt_or_missing_sqlite_content_never_reads_appwrite(self):
        file_id = self._uploaded_id()
        with database.db_connection() as conn:
            payload = conn.execute("SELECT payload FROM storage_objects WHERE object_id=?", (file_id,)).fetchone()[0]
            conn.execute("UPDATE storage_objects SET payload=? WHERE object_id=?", (bytes([payload[0] ^ 1]) + payload[1:], file_id))
        response = self.client.get(f"/api/files/my/{file_id}/download")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["code"], "storage_integrity_error")
        with storage_objects.write_transaction() as conn:
            storage_objects.delete_object(conn, "shared_files", file_id)
        self.assertEqual(self.client.get(f"/api/files/my/{file_id}/download").status_code, 404)

    def test_public_share_expiry_is_checked_before_conditional_response(self):
        file_id = self._uploaded_id(visibility="public")
        row = database.get_row("shared_files", file_id)
        url = f"/files/share/{row['share_code']}?download=1"
        anonymous = self.app.test_client()
        with anonymous.get(url) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(), b"hello")
            etag = response.headers["ETag"]
        database.update_row("shared_files", file_id, {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        response = anonymous.get(url, headers={"If-None-Match": etag})
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"File not found or expired.", response.get_data())
        self.assertEqual(self.client.get(f"/api/files/my/{file_id}/download").status_code, 404)

    def test_public_folder_download_requires_membership_and_unexpired_file(self):
        self._folder(public=True)
        inside = self._uploaded_id(folder_id="folder")
        outside = self._uploaded_id()
        anonymous = self.app.test_client()
        url = f"/files/folder/FOLDERSHARE/download/{inside}"
        with anonymous.get(url) as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(), b"hello")
        self.assertEqual(anonymous.get(f"/files/folder/FOLDERSHARE/download/{outside}").status_code, 404)
        database.update_row("shared_files", inside, {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        self.assertEqual(anonymous.get(url).status_code, 404)

    def test_folder_zip_spools_to_disk_and_excludes_expired_files(self):
        self._folder(public=True)
        payload = os.urandom(2 * 1024 * 1024)
        self._uploaded_id(data=payload, folder_id="folder", filename="same.txt")
        expired = self._uploaded_id(folder_id="folder", filename="expired.txt")
        database.update_row("shared_files", expired, {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        buffers = []
        original_spool = tempfile.SpooledTemporaryFile

        def spool(*args, **kwargs):
            buffer = original_spool(*args, **kwargs)
            buffers.append(buffer)
            return buffer

        with patch.object(file_share_store.tempfile, "SpooledTemporaryFile", side_effect=spool):
            response = self.app.test_client().get("/files/folder/FOLDERSHARE?download=zip")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(buffers[-1]._rolled)
        with zipfile.ZipFile(io.BytesIO(response.get_data())) as archive:
            self.assertEqual(archive.namelist(), ["same.txt"])
            self.assertEqual(archive.read("same.txt"), payload)
        response.close()
        self.assertTrue(buffers[-1].closed)

    def test_cleanup_deletes_only_expired_objects_and_respects_pause(self):
        active = self._uploaded_id()
        expired = self._uploaded_id()
        database.update_row("shared_files", expired, {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        self.assertEqual(file_cleanup.cleanup_expired_files(), 0)
        self.assertEqual(self._counts(), (2, 2))
        self.assertEqual(self.client.delete(f"/api/files/my/{active}").status_code, 503)
        self.assertEqual(self._upload()[0], 503)
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
        self.assertEqual(file_cleanup.cleanup_expired_files(), 1)
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(storage_objects.read_object("shared_files", active), b"hello")

    def test_cleanup_rechecks_expiry_extended_after_listing(self):
        file_id = self._uploaded_id()
        database.update_row("shared_files", file_id, {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        real_list = file_cleanup.list_rows_all

        def extend_after_listing(*args, **kwargs):
            snapshot = real_list(*args, **kwargs)
            response = self.client.patch(f"/api/files/my/{file_id}", json={"expiryDays": "7"})
            self.assertEqual(response.status_code, 200)
            return snapshot

        with patch.object(file_cleanup, "list_rows_all", side_effect=extend_after_listing):
            self.assertEqual(file_cleanup.cleanup_expired_files(), 0)
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(storage_objects.read_object("shared_files", file_id), b"hello")

    def test_cleanup_counts_only_rows_still_present_after_listing(self):
        file_id = self._uploaded_id()
        database.update_row("shared_files", file_id, {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        real_list = file_cleanup.list_rows_all

        def delete_after_listing(*args, **kwargs):
            snapshot = real_list(*args, **kwargs)
            self.assertEqual(self.client.delete(f"/api/files/my/{file_id}").status_code, 200)
            return snapshot

        with patch.object(file_cleanup, "list_rows_all", side_effect=delete_after_listing):
            self.assertEqual(file_cleanup.cleanup_expired_files(), 0)
        self.assertEqual(self._counts(), (0, 0))

    def test_cleanup_rechecks_promoted_backend_without_deleting_source(self):
        legacy = self._legacy_file()
        database.update_row("shared_files", "legacy", {"expires_at": format_datetime(utcnow() - timedelta(days=1))})
        real_list = file_cleanup.list_rows_all

        def promote_after_listing(*args, **kwargs):
            snapshot = real_list(*args, **kwargs)
            prepared = storage_objects.prepare_object("shared_files", "legacy", b"hello", filename="legacy.txt", mime_type="text/plain")
            with storage_objects.write_transaction() as conn:
                storage_objects.put_object(conn, prepared)
                storage_rows.update_row(conn, "shared_files", legacy["id"], {"storage_backend": "sqlite"})
            return snapshot

        with patch.object(file_cleanup, "list_rows_all", side_effect=promote_after_listing), \
                patch.object(file_share_store, "_storage") as legacy_storage:
            self.assertEqual(file_cleanup.cleanup_expired_files(), 1)
        legacy_storage.assert_not_called()
        self.assertEqual(self._counts(), (0, 0))
        self.assertEqual(pending_legacy_deletions("shared_files"), 0)

    def test_folder_delete_includes_upload_committed_before_its_writer(self):
        self._folder()
        self._folder("child", parent_folder_id="folder")
        self._uploaded_id(folder_id="folder")
        deletion_ready = threading.Event()
        release_delete = threading.Event()
        real_writer = file_share_store.write_transaction

        @contextmanager
        def delayed_writer():
            deletion_ready.set()
            self.assertTrue(release_delete.wait(timeout=10))
            with real_writer() as conn:
                yield conn

        def delete():
            with self.app.test_client() as client:
                self._login(client)
                with client.delete("/api/files/folders/folder") as response:
                    return response.status_code

        with patch.object(file_share_store, "write_transaction", side_effect=delayed_writer):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(delete)
                try:
                    self.assertTrue(deletion_ready.wait(timeout=10))
                    self._uploaded_id(folder_id="child")
                finally:
                    release_delete.set()
                self.assertEqual(future.result(timeout=10), 200)
        self.assertEqual(self._counts(), (0, 0))
        self.assertEqual(database.list_rows("file_folders")["rows"], [])

    def test_upload_waiting_on_folder_delete_writer_cannot_create_orphan(self):
        self._folder()
        self._uploaded_id(folder_id="folder")
        deletion_locked = threading.Event()
        upload_prepared = threading.Event()
        real_delete = storage_rows.delete_row

        def pause_file_delete(conn, table_id, row_id):
            if table_id == "shared_files":
                deletion_locked.set()
                self.assertTrue(upload_prepared.wait(timeout=10))
            return real_delete(conn, table_id, row_id)

        def delete():
            with self.app.test_client() as client:
                self._login(client)
                with client.delete("/api/files/folders/folder") as response:
                    return response.status_code

        def upload():
            with self.app.test_client() as client:
                self._login(client)
                return self._upload(folder_id="folder", client=client)[0]

        with patch.object(storage_rows, "delete_row", side_effect=pause_file_delete), \
                patch.object(storage_objects, "scan_upload", side_effect=lambda _data: upload_prepared.set()):
            with ThreadPoolExecutor(max_workers=2) as pool:
                delete_future = pool.submit(delete)
                self.assertTrue(deletion_locked.wait(timeout=10))
                upload_future = pool.submit(upload)
                self.assertEqual(delete_future.result(timeout=10), 200)
                self.assertEqual(upload_future.result(timeout=10), 404)
        self.assertEqual(self._counts(), (0, 0))
        self.assertEqual(database.list_rows("file_folders")["rows"], [])

    def test_folder_delete_rolls_back_files_payloads_and_legacy_intent_together(self):
        self._folder()
        self._folder("child", parent_folder_id="folder")
        file_id = self._uploaded_id(folder_id="child")
        self._legacy_file(folder_id="folder")
        real_delete = storage_rows.delete_row

        def fail_root_delete(conn, table_id, row_id):
            if table_id == "file_folders" and row_id == "folder":
                raise sqlite3.OperationalError("forced folder deletion failure")
            return real_delete(conn, table_id, row_id)

        with patch.object(storage_rows, "delete_row", side_effect=fail_root_delete), \
                patch.object(file_share_store, "_storage") as legacy_storage:
            with self.client.delete("/api/files/folders/folder") as response:
                self.assertEqual(response.status_code, 503)
        legacy_storage.assert_not_called()
        self.assertEqual(self._counts(), (2, 1))
        self.assertEqual(storage_objects.read_object("shared_files", file_id), b"hello")
        self.assertEqual(len(database.list_rows("file_folders")["rows"]), 2)
        self.assertEqual(pending_legacy_deletions("shared_files"), 0)

    def test_folder_delete_removes_mixed_subtree_and_preserves_imported_sources(self):
        self._folder()
        self._folder("child", parent_folder_id="folder")
        outside = self._uploaded_id()
        imported = self._uploaded_id(folder_id="child")
        database.update_row("shared_files", imported, {
            "storage_bucket_id": "preserved-source", "expires_at": format_datetime(utcnow() - timedelta(days=1)),
        })
        self._legacy_file(folder_id="folder")
        storage = Mock()

        def fail_after_subtree_commit(bucket_id, object_id):
            with database.db_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM file_folders").fetchone()[0], 0)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM shared_files").fetchone()[0], 1)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 1)
            self.assertEqual((bucket_id, object_id), ("legacy-bucket", "legacy"))
            raise AppwriteException("remote unavailable", 503)

        storage.delete_file.side_effect = fail_after_subtree_commit
        with patch.object(file_share_store, "_storage", return_value=storage):
            counts = file_share_store._delete_folder_tree("folder", "owner")
        self.assertEqual(counts, {"deletedFiles": 2, "deletedFolders": 2})
        self.assertEqual(storage_objects.read_object("shared_files", outside), b"hello")
        self.assertEqual(pending_legacy_deletions("shared_files", account_user_id="owner"), 1)
        self.assertEqual(pending_legacy_deletions("shared_files", object_ids=[imported]), 0)

    def test_folder_delete_rechecks_current_owner_on_its_writer(self):
        self._folder()
        file_id = self._uploaded_id(folder_id="folder")
        real_writer = file_share_store.write_transaction

        @contextmanager
        def owner_changed_writer():
            database.update_row("file_folders", "folder", {"user_id": "other"})
            with real_writer() as conn:
                yield conn

        with patch.object(file_share_store, "write_transaction", side_effect=owner_changed_writer):
            with self.client.delete("/api/files/folders/folder") as response:
                self.assertEqual(response.status_code, 404)
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(storage_objects.read_object("shared_files", file_id), b"hello")

    def test_metadata_target_deletion_before_writer_cannot_leave_dangling_folder(self):
        self._folder("source")
        file_id = self._uploaded_id()
        requests = (
            ("POST", "/api/files/folders", {"name": "Child", "parentFolderId": "target"}),
            ("PATCH", "/api/files/folders/source", {"parentFolderId": "target"}),
            ("PATCH", f"/api/files/my/{file_id}", {"folderId": "target"}),
        )
        real_writer = file_share_metadata.write_transaction

        @contextmanager
        def target_removed_writer():
            database.delete_row("file_folders", "target")
            with real_writer() as conn:
                yield conn

        for method, url, body in requests:
            with self.subTest(method=method, url=url):
                self._folder("target")
                with patch.object(file_share_metadata, "write_transaction", side_effect=target_removed_writer), \
                        self.client.open(url, method=method, json=body) as response:
                    self.assertEqual(response.status_code, 404)
                self.assertIsNone(database.get_row("file_folders", "source")["parent_folder_id"])
                self.assertIsNone(database.get_row("shared_files", file_id)["folder_id"])
                self.assertEqual(len(database.list_rows("file_folders")["rows"]), 1)

    def test_metadata_rechecks_source_ownership_and_folder_cycles_on_writer(self):
        self._folder()
        self._folder("child", parent_folder_id="folder")
        file_id = self._uploaded_id()
        with self.client.patch("/api/files/folders/folder", json={"parentFolderId": "child"}) as response:
            self.assertEqual(response.status_code, 400)
        self.assertIsNone(database.get_row("file_folders", "folder")["parent_folder_id"])
        real_writer = file_share_metadata.write_transaction

        @contextmanager
        def owner_changed_writer():
            database.update_row("shared_files", file_id, {"user_id": "other"})
            with real_writer() as conn:
                yield conn

        with patch.object(file_share_metadata, "write_transaction", side_effect=owner_changed_writer), \
                self.client.patch(f"/api/files/my/{file_id}", json={"filename": "changed.txt"}) as response:
            self.assertEqual(response.status_code, 404)
        self.assertEqual(database.get_row("shared_files", file_id)["original_filename"], "notes.txt")

    def test_account_tombstone_blocks_folder_metadata_creation(self):
        with storage_objects.write_transaction() as conn:
            conn.execute("INSERT INTO storage_account_deletions (user_id, deleted_at) VALUES (?, ?)", ("owner", format_datetime(utcnow())))
        with self.client.post("/api/files/folders", json={"name": "New Folder"}) as response:
            self.assertEqual(response.status_code, 503)
        self.assertEqual(database.list_rows("file_folders")["rows"], [])

    def test_pause_blocks_file_and_folder_metadata_mutations_while_downloads_continue(self):
        self._folder(public=True)
        file_id = self._uploaded_id(folder_id="folder", visibility="public")
        before_folder = database.get_row("file_folders", "folder")
        before_file = database.get_row("shared_files", file_id)
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        mutations = (
            ("post", "/api/files/folders", {"name": "New Folder"}),
            ("patch", "/api/files/folders/folder", {"name": "Renamed Folder"}),
            ("post", "/api/files/folders/folder/visibility", {"visibility": "private"}),
            ("delete", "/api/files/folders/folder", None),
            ("patch", f"/api/files/my/{file_id}", {"filename": "renamed.txt", "expiryDays": "7"}),
            ("post", f"/api/files/my/{file_id}/visibility", {"visibility": "private"}),
            ("delete", f"/api/files/my/{file_id}", None),
        )
        for method, url, body in mutations:
            with self.subTest(method=method, url=url), self.client.open(url, method=method.upper(), json=body) as response:
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.get_json()["code"], "storage_mutations_paused")
        with self.client.get(f"/api/files/my/{file_id}/download") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(), b"hello")
        with self.app.test_client().get(f"/files/share/{before_file['share_code']}?download=1") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(), b"hello")
        self.assertEqual(database.get_row("file_folders", "folder"), before_folder)
        self.assertEqual(database.get_row("shared_files", file_id), before_file)
        self.assertEqual(self._counts(), (1, 1))

    def test_legacy_read_requires_explicit_compatibility_setting(self):
        self._legacy_file()
        url = "/api/files/my/legacy/download"
        self.assertEqual(self.client.get(url).status_code, 503)
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        with patch.object(file_share_store, "read_legacy_file", return_value=b"hello") as legacy_read:
            with self.client.get(url) as response:
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.get_data(), b"hello")
        legacy_read.assert_called_once_with("legacy-bucket", "legacy", max_bytes=50 * 1024 * 1024, expected_bytes=5)

    def test_legacy_download_checks_feature_ownership_and_size_before_transport(self):
        self._legacy_file()
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        url = "/api/files/my/legacy/download"
        other = self.app.test_client()
        self._login(other, "other")
        with patch.object(file_share_store, "read_legacy_file") as legacy_read:
            self.assertEqual(other.get(url, headers={"If-None-Match": "any"}).status_code, 404)
            self.assertEqual(self.app.test_client().get(url).status_code, 401)
            database.update_row("shared_files", "legacy", {"file_size_bytes": fs.MAX_FILE_SIZE + 1})
            response = self.client.get(url)
            self.assertEqual(response.status_code, 500)
            self.assertEqual(response.get_json()["code"], "storage_integrity_error")
        legacy_read.assert_not_called()

    def test_appwrite_upload_commits_local_metadata_without_holding_writer_during_transport(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        storage = Mock()

        def require_unlocked_writer(*_args, **_kwargs):
            with database.db_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM shared_files").fetchone()[0], 0)

        def generate_code():
            require_unlocked_writer()
            return "LEGACYUPLOADSHARE"

        storage.create_file.side_effect = require_unlocked_writer
        with patch.object(file_share_uploads, "_storage", return_value=storage), \
                patch.object(file_share_uploads, "_generate_share_code", side_effect=generate_code):
            file_id = self._uploaded_id(visibility="public")
        row = database.get_row("shared_files", file_id)
        self.assertEqual(row["storage_backend"], "appwrite")
        self.assertEqual(row["storage_file_id"], file_id)
        self.assertEqual(row["share_code"], "LEGACYUPLOADSHARE")
        self.assertEqual(self._counts(), (1, 0))
        storage.delete_file.assert_not_called()

    def test_appwrite_metadata_failure_rolls_back_row_and_removes_remote_object(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        storage = Mock()
        real_insert = storage_rows.insert_row

        def failing_insert(*args, **kwargs):
            real_insert(*args, **kwargs)
            raise sqlite3.IntegrityError("forced legacy metadata failure")

        with patch.object(file_share_uploads, "_storage", return_value=storage), \
                patch.object(storage_rows, "insert_row", side_effect=failing_insert):
            status, payload = self._upload()
        self.assertEqual(status, 503, payload)
        self.assertEqual(payload["errors"][0]["code"], "storage_unavailable")
        self.assertEqual(self._counts(), (0, 0))
        storage.delete_file.assert_called_once_with(*storage.create_file.call_args.args[:2])

    def test_appwrite_concurrent_uploads_serialize_quota_checks_and_clean_rejected_remote_file(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        self._set_limits(storage_bytes=5)
        barrier = threading.Barrier(2)
        storage = Mock()
        storage.create_file.side_effect = lambda *_args: barrier.wait(timeout=10)

        def upload():
            with self.app.test_client() as client:
                self._login(client)
                return self._upload(data=b"four", client=client)[0]

        with patch.object(file_share_uploads, "_storage", return_value=storage):
            with ThreadPoolExecutor(max_workers=2) as pool:
                statuses = list(pool.map(lambda _: upload(), range(2)))
        self.assertEqual(sorted(statuses), [201, 400])
        self.assertEqual(self._counts(), (1, 0))
        storage.delete_file.assert_called_once()
        surviving = database.list_rows("shared_files")["rows"][0]["storage_file_id"]
        self.assertNotEqual(storage.delete_file.call_args.args[1], surviving)

    def test_appwrite_current_tier_file_and_batch_limits_remove_rejected_remote_uploads(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        self._set_limits(max_file_size_bytes=4, max_upload_files=1)
        storage = Mock()
        with patch.object(file_share_uploads, "_storage", return_value=storage):
            status, payload = self._upload(data=b"hello")
            self.assertEqual(status, 400)
            self.assertEqual(payload["errors"][0]["resource"], "file size bytes")
            response = self.client.post("/api/files/upload", data={
                "file": [(io.BytesIO(b"one"), "one.txt"), (io.BytesIO(b"two"), "two.txt")],
            })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["errors"][0]["resource"], "files per upload")
        self.assertEqual(self._counts(), (0, 0))
        self.assertEqual(storage.delete_file.call_count, 3)

    def test_appwrite_folder_ownership_change_during_transport_removes_uploaded_object(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        self._folder()
        storage = Mock()
        storage.create_file.side_effect = lambda *_args: database.update_row("file_folders", "folder", {"user_id": "other"})
        with patch.object(file_share_uploads, "_storage", return_value=storage):
            status, _payload = self._upload(folder_id="folder")
        self.assertEqual(status, 404)
        self.assertEqual(self._counts(), (0, 0))
        storage.delete_file.assert_called_once()

    def test_appwrite_account_deletion_during_transport_cannot_recreate_feature_metadata(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        storage = Mock()

        def delete_account(*_args):
            with storage_objects.write_transaction() as conn:
                conn.execute("INSERT INTO storage_account_deletions (user_id, deleted_at) VALUES (?, ?)", ("owner", format_datetime(utcnow())))
                storage_rows.delete_row(conn, "users", "owner")

        storage.create_file.side_effect = delete_account
        with patch.object(file_share_uploads, "_storage", return_value=storage):
            status, payload = self._upload()
        self.assertEqual(status, 503, payload)
        self.assertEqual(payload["errors"][0]["code"], "storage_unavailable")
        self.assertEqual(self._counts(), (0, 0))
        storage.delete_file.assert_called_once()

    def test_appwrite_missing_user_and_account_tombstone_each_remove_uploaded_object(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        storage = Mock()
        with storage_objects.write_transaction() as conn:
            conn.execute("INSERT INTO storage_account_deletions (user_id, deleted_at) VALUES (?, ?)", ("owner", format_datetime(utcnow())))
        with patch.object(file_share_uploads, "_storage", return_value=storage):
            status, payload = self._upload()
            self.assertEqual(status, 503, payload)
            self.assertIn("deleted", payload["error"])
            with storage_objects.write_transaction() as conn:
                conn.execute("DELETE FROM storage_account_deletions WHERE user_id=?", ("owner",))
                storage_rows.delete_row(conn, "users", "owner")
            status, payload = self._upload()
        self.assertEqual(status, 503, payload)
        self.assertIn("unavailable", payload["error"])
        self.assertEqual(self._counts(), (0, 0))
        self.assertEqual(storage.delete_file.call_count, 2)

    def test_appwrite_pause_during_transport_removes_uploaded_object(self):
        self.app.config["NEST_STORAGE_BACKEND"] = "appwrite"
        storage = Mock()

        def pause_uploads(*_args):
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True

        storage.create_file.side_effect = pause_uploads
        with patch.object(file_share_uploads, "_storage", return_value=storage):
            status, payload = self._upload()
        self.assertEqual(status, 503, payload)
        self.assertEqual(payload["errors"][0]["code"], "storage_mutations_paused")
        self.assertEqual(self._counts(), (0, 0))
        storage.delete_file.assert_called_once()

    def test_legacy_delete_failure_retains_durable_scoped_intent_after_local_commit(self):
        self._folder()
        self._legacy_file(folder_id="folder")
        prepared = storage_objects.prepare_object("shared_files", "legacy", b"hello", filename="legacy.txt", mime_type="text/plain")
        with storage_objects.write_transaction() as conn:
            storage_objects.put_object(conn, prepared)
        storage = Mock()

        def fail_after_committed_delete(*_args):
            with database.db_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM shared_files").fetchone()[0], 0)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 0)
                queued = dict(conn.execute("SELECT * FROM storage_legacy_deletions").fetchone())
                self.assertEqual(queued["account_user_id"], "owner")
                self.assertEqual(queued["parent_id"], "folder")
            raise AppwriteException("remote unavailable", 503)

        storage.delete_file.side_effect = fail_after_committed_delete
        with patch.object(file_share_store, "_storage", return_value=storage):
            with self.client.delete("/api/files/my/legacy") as response:
                self.assertEqual(response.status_code, 200)
            self.assertEqual(self._counts(), (0, 0))
            self.assertEqual(pending_legacy_deletions("shared_files", account_user_id="owner"), 1)
            # No feature row remains to discover on the scheduler's next pass.
            self.assertEqual(file_cleanup.cleanup_expired_files(), 0)
            self.assertEqual(pending_legacy_deletions("shared_files"), 1)
            storage.delete_file.side_effect = None
            self.assertEqual(file_share_store.cleanup_legacy_files(account_user_id="owner"), {"completed": 1, "pending": 0})

    def test_legacy_deletion_queue_retries_after_post_commit_pause(self):
        self._legacy_file()
        storage = Mock()

        def pause_after_network(*_args):
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True

        storage.delete_file.side_effect = pause_after_network
        with patch.object(file_share_store, "_storage", return_value=storage):
            with self.client.delete("/api/files/my/legacy") as response:
                self.assertEqual(response.status_code, 200)
            self.assertEqual(self._counts(), (0, 0))
            self.assertEqual(pending_legacy_deletions("shared_files"), 1)
            with self.assertRaises(StorageMutationPaused):
                file_share_store.cleanup_legacy_files(account_user_id="owner")
            self.assertEqual(storage.delete_file.call_count, 1)
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
            storage.delete_file.side_effect = AppwriteException("already gone", 404)
            self.assertEqual(file_share_store.cleanup_legacy_files(account_user_id="owner"), {"completed": 1, "pending": 0})

    def test_legacy_deletion_rechecks_current_remote_identity_and_owner(self):
        stale = self._legacy_file()
        database.update_row("shared_files", "legacy", {"storage_bucket_id": "current-bucket", "storage_file_id": "current-id"})
        storage = Mock()
        with patch.object(file_share_store, "_storage", return_value=storage):
            self.assertTrue(file_share_store._delete_file_record(stale))
        storage.delete_file.assert_called_once_with("current-bucket", "current-id")
        stale = self._legacy_file("transferred")
        database.update_row("shared_files", "transferred", {"user_id": "other"})
        with self.assertRaises(StorageNotFound):
            file_share_store._delete_file_record(stale, account_user_id="owner")
        self.assertEqual(self._counts(), (1, 0))

    def test_legacy_cleanup_account_scope_does_not_process_other_account(self):
        owned = self._legacy_file()
        other = self._legacy_file("other-file", user_id="other")
        with storage_objects.write_transaction() as conn:
            file_share_store._delete_file_record(owned, conn=conn)
            file_share_store._delete_file_record(other, conn=conn)
        storage = Mock()
        with patch.object(file_share_store, "_storage", return_value=storage):
            result = file_share_store.cleanup_legacy_files(account_user_id="owner")
        self.assertEqual(result, {"completed": 1, "pending": 0})
        storage.delete_file.assert_called_once_with("legacy-bucket", "legacy")
        self.assertEqual(pending_legacy_deletions("shared_files", account_user_id="other"), 1)


if __name__ == "__main__":
    unittest.main()
