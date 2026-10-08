import base64
import copy
import gzip
import hashlib
import io
import json
import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from appwrite.exception import AppwriteException
from flask import Flask
from flask_login import UserMixin
from PIL import Image
from werkzeug.datastructures import FileStorage

from blueprints import chat_api
from extensions import login_manager
from services import chat_attachments, database, storage_objects
from services.storage_legacy_cleanup import (
    drain_legacy_deletions, enqueue_legacy_deletion, pending_legacy_deletions,
)
from services import chat_attachment_validation as validation
from services.entitlements import DEFAULT_TIER_DEFINITIONS, EntitlementLimitError, TIER_CONFIG_KEY
from services.storage_errors import (
    StorageError, StorageIntegrityError, StorageMutationPaused, StorageNotFound,
    StorageUnavailable, StorageValidationError,
)


class _User(UserMixin):
    def __init__(self, user_id):
        self.id = user_id
        self.school = "Emory University"


class ChatAttachmentSQLiteTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db_path = str(Path(directory.name) / "attachments.sqlite3")
        keyring = Path(directory.name) / "upload-keys.json"
        keyring.write_text(json.dumps({
            "active_key_id": "test", "keys": {"test": base64.b64encode(b"k" * 32).decode()},
        }))
        keyring.chmod(0o600)
        database.init_db(path=self.db_path)
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.config.update(
            DATABASE_PATH=self.db_path, NEST_STORAGE_BACKEND="sqlite",
            NEST_UPLOAD_KEYRING_PATH=str(keyring), NEST_CHAT_ATTACHMENTS_ENABLED=True,
            NEST_STORAGE_MUTATIONS_PAUSED=False, NEST_STORAGE_READ_LEGACY=False,
        )
        for user_id in ("owner", "participant", "outsider"):
            database.create_row("users", user_id, {
                "google_id": user_id, "email": f"{user_id}@example.test", "tier": "free",
                "school": "Emory University", "created_at": database.utcnow_iso(),
            }, path=self.db_path)
        database.create_row("chat_channels", "room", {
            "kind": "discord", "name": "Room", "created_at": database.utcnow_iso(),
        }, path=self.db_path)
        database.create_row("chat_dm_threads", "thread", {
            "participant_a": "owner", "participant_b": "participant",
            "participant_key": "owner:participant", "created_at": database.utcnow_iso(),
        }, path=self.db_path)
        self.entitlements = {
            "key": "free", "limits": DEFAULT_TIER_DEFINITIONS["free"],
            "usage": {"storage_bytes": 0},
        }
        self.scan = self._patch(chat_attachments, "scan_upload")
        self.object_scan = self._patch(storage_objects, "scan_upload")
        self.remote = self._patch(chat_attachments, "storage_service", side_effect=AssertionError("Appwrite unavailable"))
        self.legacy_read = self._patch(chat_attachments, "read_legacy_file", side_effect=AssertionError("Appwrite unavailable"))
        for name in ("_user_callback", "unauthorized_callback", "login_view"):
            self.addCleanup(setattr, login_manager, name, getattr(login_manager, name))
        login_manager.login_view = None
        login_manager.unauthorized_callback = None
        login_manager.init_app(self.app)
        login_manager.user_loader(lambda user_id: _User(user_id))
        self.app.register_blueprint(chat_api.chat_api_bp)

    def _patch(self, owner, name, **kwargs):
        patcher = patch.object(owner, name, **kwargs)
        self.addCleanup(patcher.stop)
        return patcher.start()

    def _upload(self, data=b"Study material", filename="notes.txt", **kwargs):
        with self.app.app_context():
            return chat_attachments.create_attachment(
                user_id="owner", scope_type="thread", scope_id="thread",
                uploaded_file=FileStorage(io.BytesIO(data), filename=filename),
                entitlements=self.entitlements, **kwargs,
            )

    def _counts(self):
        with database.db_connection(self.db_path) as conn:
            return tuple(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                         for table in ("storage_objects", "chat_attachments"))

    def _client(self, user_id="owner"):
        client = self.app.test_client()
        with client.session_transaction() as session:
            session["_user_id"] = user_id
            session["_fresh"] = True
        return client

    def _limits(self, **limits):
        definitions = copy.deepcopy(DEFAULT_TIER_DEFINITIONS)
        definitions["free"].update(limits)
        database.upsert_row("chat_bridge_config", "quotas", {
            "config_key": TIER_CONFIG_KEY, "config_value": json.dumps(definitions),
            "created_at": database.utcnow_iso(),
        }, path=self.db_path)

    def _message(self):
        return database.create_row("chat_messages", "message", {
            "thread_id": "thread", "user_id": "owner", "created_at": database.utcnow_iso(),
        }, path=self.db_path)

    def _bind(self, rows):
        self._message()
        with self.app.app_context():
            chat_attachments.bind_pending(
                [row["id"] for row in rows], user_id="owner", scope_type="thread",
                scope_id="thread", message_id="message",
            )

    def _legacy(self, row):
        changes = {"storage_backend": "appwrite", "storage_bucket_id": "legacy"}
        database.update_row("chat_attachments", row["id"], changes, path=self.db_path)
        return {**row, **changes}

    def _queue_unrelated(self):
        with self.app.app_context(), storage_objects.write_transaction() as conn:
            enqueue_legacy_deletion(
                conn, "chat_attachments", "other-bucket", "unrelated",
                account_user_id="outsider", parent_id="unrelated-message",
            )

    def _pdf(self):
        output = io.BytesIO()
        Image.new("RGB", (120, 160), "white").save(output, format="PDF")
        return output.getvalue()

    def test_gzip_is_restored_and_original_hash_is_distinct_from_stored_hash(self):
        original = b"study notes\n" * 500
        row = self._upload(gzip.compress(original), upload_encoding="gzip")
        self.assertEqual(row["storage_backend"], "sqlite")
        self.assertEqual(row["compression_encoding"], "gzip")
        self.scan.assert_called_once_with(original)
        self.object_scan.assert_called_once_with(original)
        with self.app.app_context():
            metadata = storage_objects.object_metadata("chat_attachments", row["storage_file_id"])
            self.assertEqual(chat_attachments.attachment_bytes(row), original)
        self.assertEqual(row["sha256"], hashlib.sha256(original).hexdigest())
        self.assertNotEqual(row["sha256"], metadata["sha256"])
        self.remote.assert_not_called()
        self.legacy_read.assert_not_called()

    def test_malformed_and_oversized_gzip_never_creates_payloads(self):
        self.entitlements = {"limits": {"max_chat_attachment_size_bytes": 100}}
        for payload in (b"not gzip", gzip.compress(b"a" * 101), gzip.compress(b"body")[:-3]):
            with self.subTest(payload=payload[:10]), self.assertRaises(validation.AttachmentError):
                self._upload(payload, upload_encoding="gzip")
        self.assertEqual(self._counts(), (0, 0))
        self.scan.assert_not_called()

    def test_identity_upload_and_declared_size_are_bounded(self):
        self.entitlements = {"limits": {"max_chat_attachment_size_bytes": 10}}
        for kwargs, payload in (({}, b"a" * 11), ({"original_size": "11"}, b"body")):
            with self.subTest(kwargs=kwargs), self.assertRaises(EntitlementLimitError):
                self._upload(payload, **kwargs)
        for declared in ("nonnumeric", "-1"):
            with self.assertRaises(validation.AttachmentError):
                self._upload(original_size=declared)
        self.assertEqual(self._counts(), (0, 0))

    def test_global_limit_applies_even_if_tier_requests_unlimited(self):
        self.entitlements = {"limits": {"max_chat_attachment_size_bytes": None}}
        with self.assertRaises(EntitlementLimitError) as result:
            self._upload(original_size=validation.MAX_UPLOAD_BYTES + 1)
        self.assertEqual(result.exception.limit, 50 * 1024 * 1024)
        self.scan.assert_not_called()

    def test_original_scanner_failure_happens_before_image_processing(self):
        for error in (StorageValidationError("infected"), StorageUnavailable("scanner down")):
            self.scan.side_effect = error
            with patch.object(chat_attachments, "inspect_and_prepare") as prepare:
                with self.subTest(error=error), self.assertRaises(type(error)):
                    self._upload(b"unsafe", "image.png")
                prepare.assert_not_called()
        self.assertEqual(self._counts(), (0, 0))

    def test_preview_scanner_failure_has_no_partial_main_payload(self):
        self.object_scan.side_effect = [None, StorageUnavailable("preview scanner down")]
        with self.assertRaises(StorageUnavailable):
            self._upload(self._pdf(), "reading.pdf")
        self.assertEqual(self._counts(), (0, 0))

    def test_pdf_payload_preview_and_metadata_rollback_together(self):
        with patch.object(chat_attachments, "insert_attachment", side_effect=RuntimeError("metadata failed")):
            with self.assertRaises(RuntimeError):
                self._upload(self._pdf(), "reading.pdf")
        self.assertEqual(self._counts(), (0, 0))

    def test_current_tier_size_is_rechecked_after_original_scan(self):
        self.scan.side_effect = lambda _data: self._limits(max_chat_attachment_size_bytes=10)
        with self.assertRaises(EntitlementLimitError):
            self._upload(b"abcdefghijkl")
        self.assertEqual(self._counts(), (0, 0))

    def test_scope_membership_and_feature_flag_are_rechecked_after_preparation(self):
        self.scan.side_effect = lambda _data: database.delete_row("chat_dm_threads", "thread", path=self.db_path)
        with self.assertRaises(validation.AttachmentError):
            self._upload()
        self.assertEqual(self._counts(), (0, 0))

    def test_disable_during_preparation_prevents_commit(self):
        self.scan.side_effect = lambda _data: self.app.config.update(NEST_CHAT_ATTACHMENTS_ENABLED=False)
        with self.assertRaises(validation.AttachmentError):
            self._upload()
        self.assertEqual(self._counts(), (0, 0))

    def test_concurrent_uploads_cannot_overbook_stale_request_quota(self):
        body = b"abcdefghijklmn"
        self._limits(storage_bytes=len(body))
        barrier = threading.Barrier(2)
        prepare_object = storage_objects.prepare_object

        def synchronize(*args, **kwargs):
            prepared = prepare_object(*args, **kwargs)
            barrier.wait(timeout=10)
            return prepared

        def upload():
            try:
                return self._upload(body)
            except EntitlementLimitError as exc:
                return exc

        with patch.object(storage_objects, "prepare_object", side_effect=synchronize), ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _number: upload(), range(2)))
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertEqual(sum(isinstance(result, EntitlementLimitError) for result in results), 1)
        self.assertEqual(self._counts(), (1, 1))

    def test_gif_animation_survives_sqlite(self):
        first = Image.new("RGB", (8, 8), "red")
        second = Image.new("RGB", (8, 8), "blue")
        output = io.BytesIO()
        first.save(output, format="GIF", save_all=True, append_images=[second], duration=50, loop=0)
        original = output.getvalue()
        row = self._upload(original, "animated.gif")
        with self.app.app_context():
            restored = chat_attachments.attachment_bytes(row)
        self.assertEqual(original, restored)
        with Image.open(io.BytesIO(restored)) as image:
            self.assertEqual(image.n_frames, 2)

    def test_pdf_preview_and_original_download_use_private_safe_headers(self):
        original = self._pdf()
        row = self._upload(original, "reading.pdf")
        with self._client() as client:
            preview = client.get(f"/api/chat/attachments/{row['id']}/preview")
            download = client.get(f"/api/chat/attachments/{row['id']}/download")
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(preview.mimetype, "image/webp")
        self.assertEqual(download.data, original)
        self.assertEqual(download.mimetype, "application/pdf")
        for response in (preview, download):
            self.assertIn("private", response.headers["Cache-Control"])
            self.assertNotIn("public", response.headers["Cache-Control"])
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
            self.assertEqual(response.headers["Content-Security-Policy"], "default-src 'none'; sandbox")
            self.assertTrue(response.headers.get("ETag"))

    def test_private_ranges_and_conditional_requests_authorize_before_304(self):
        row = self._upload(b"abcdefghijklmnopqrstuvwxyz")
        self._bind([row])
        url = f"/api/chat/attachments/{row['id']}/download"
        with self._client("participant") as client:
            complete = client.get(url)
            ranged = client.get(url, headers={"Range": "bytes=2-5"})
            unchanged = client.get(url, headers={"If-None-Match": complete.headers["ETag"]})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.data, b"cdef")
        self.assertEqual(ranged.headers["Content-Range"], "bytes 2-5/26")
        self.assertEqual(unchanged.status_code, 304)
        with self._client("outsider") as client, patch.object(chat_api, "attachment_bytes") as read:
            denied = client.get(url, headers={"If-None-Match": complete.headers["ETag"]})
        self.assertEqual(denied.status_code, 404)
        read.assert_not_called()

    def test_pending_attachment_is_available_only_to_owner(self):
        row = self._upload()
        with self._client("participant") as client, patch.object(chat_api, "attachment_bytes") as read:
            denied = client.get(f"/api/chat/attachments/{row['id']}/download")
        self.assertEqual(denied.status_code, 404)
        read.assert_not_called()

    def test_pending_attachment_rechecks_owner_conversation_access_before_body(self):
        row = self._upload()
        database.delete_row("chat_dm_threads", "thread", path=self.db_path)
        with self._client() as client, patch.object(chat_api, "attachment_bytes") as read:
            denied = client.get(f"/api/chat/attachments/{row['id']}/download", headers={
                "If-None-Match": f"\"{row['sha256']}\"",
            })
        self.assertEqual(denied.status_code, 404)
        read.assert_not_called()

    def test_pending_download_rechecks_live_membership_after_payload_read(self):
        row = self._upload()
        read_bytes = chat_attachments.attachment_bytes

        def change_membership(candidate):
            data = read_bytes(candidate)
            database.update_row("chat_dm_threads", "thread", {
                "participant_a": "outsider",
            }, path=self.db_path)
            return data

        with self._client() as client, patch.object(chat_api, "attachment_bytes", side_effect=change_membership):
            response = client.get(f"/api/chat/attachments/{row['id']}/download")
        self.assertEqual(response.status_code, 404)
        self.assertNotIn(b"Study material", response.data)

    def test_disabled_server_upload_guard_prevents_scope_and_storage_work(self):
        self.app.config["NEST_CHAT_ATTACHMENTS_ENABLED"] = False
        with self._client() as client, patch.object(chat_api, "create_attachment") as create, \
                patch.object(chat_api, "_attachment_scope_access") as authorize:
            response = client.post("/api/chat/attachments", data={
                "scope_type": "thread", "scope_id": "thread", "file": (io.BytesIO(b"notes"), "notes.txt"),
            })
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["code"], "attachments_disabled")
        create.assert_not_called()
        authorize.assert_not_called()

    def test_disabled_service_guard_applies_before_content_for_both_backends(self):
        self.app.config["NEST_CHAT_ATTACHMENTS_ENABLED"] = False
        for backend in ("sqlite", "appwrite"):
            self.app.config["NEST_STORAGE_BACKEND"] = backend
            with self.subTest(backend=backend), patch.object(chat_attachments, "_read_upload") as read:
                with self.assertRaises(validation.AttachmentError):
                    self._upload()
                read.assert_not_called()
        self.assertEqual(self._counts(), (0, 0))
        self.scan.assert_not_called()
        self.remote.assert_not_called()

    def test_missing_or_corrupt_sqlite_never_falls_back_to_legacy(self):
        row = self._upload()
        with database.db_connection(self.db_path) as conn:
            payload = conn.execute("SELECT payload FROM storage_objects").fetchone()[0]
            conn.execute("UPDATE storage_objects SET payload = ?", [bytes([payload[0] ^ 1]) + payload[1:]])
        with self.app.app_context(), self.assertRaises(StorageIntegrityError):
            chat_attachments.attachment_bytes(row)
        with database.db_connection(self.db_path) as conn:
            conn.execute("DELETE FROM storage_objects")
        with self.app.app_context(), self.assertRaises(StorageNotFound):
            chat_attachments.attachment_bytes(row)
        self.remote.assert_not_called()
        self.legacy_read.assert_not_called()

    def test_explicit_legacy_read_is_bounded_by_main_or_preview_metadata(self):
        row = self._upload()
        row.update(storage_backend="appwrite", storage_bucket_id="legacy", preview_file_id="preview")
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        self.legacy_read.side_effect = None
        for preview, object_id, data in ((False, row["storage_file_id"], b"Study material"), (True, "preview", b"preview")):
            self.legacy_read.return_value = data
            if preview:
                row["preview_size_bytes"] = len(data)
            with self.subTest(preview=preview), self.app.app_context():
                self.assertEqual(chat_attachments.attachment_bytes(row, preview=preview), data)
            self.legacy_read.assert_called_with(
                "legacy", object_id, max_bytes=validation.MAX_UPLOAD_BYTES, expected_bytes=len(data),
            )
        self.remote.assert_not_called()

    def test_explicit_legacy_read_requires_compatibility_flag_before_transport(self):
        row = self._upload()
        row.update(storage_backend="appwrite", storage_bucket_id="legacy")
        with self.app.app_context(), self.assertRaises(StorageUnavailable):
            chat_attachments.attachment_bytes(row)
        self.legacy_read.assert_not_called()

    def test_oversized_legacy_metadata_is_rejected_before_transport(self):
        row = self._upload()
        row.update(storage_backend="appwrite", storage_bucket_id="legacy", stored_size_bytes=validation.MAX_UPLOAD_BYTES + 1)
        self.app.config["NEST_STORAGE_READ_LEGACY"] = True
        with self.app.app_context(), self.assertRaises(StorageIntegrityError):
            chat_attachments.attachment_bytes(row)
        self.legacy_read.assert_not_called()

    def test_stored_gzip_expansion_has_a_separate_original_size_bound(self):
        row = self._upload(b"notes\n" * 100)
        row["original_size_bytes"] = 5
        with self.app.app_context(), self.assertRaises(StorageIntegrityError):
            chat_attachments.attachment_bytes(row)

    def test_stored_gzip_metadata_errors_are_storage_integrity_errors(self):
        row = self._upload(b"notes\n" * 100)
        for field, value in (
            ("original_size_bytes", "invalid"),
            ("original_size_bytes", 0),
            ("original_size_bytes", validation.MAX_UPLOAD_BYTES + 1),
            ("stored_size_bytes", "invalid"),
        ):
            malformed = dict(row, **{field: value})
            with self.subTest(field=field, value=value), self.app.app_context():
                with self.assertRaises(StorageIntegrityError):
                    chat_attachments.attachment_bytes(malformed)

    def test_deletion_rolls_back_both_payloads_and_metadata_on_failure(self):
        row = self._upload(self._pdf(), "reading.pdf")
        delete_object = storage_objects.delete_object
        calls = []

        def fail_second(*args):
            calls.append(args)
            if len(calls) == 2:
                raise StorageUnavailable("second payload deletion failed")
            return delete_object(*args)

        with self.app.app_context(), patch.object(storage_objects, "delete_object", side_effect=fail_second):
            with self.assertRaises(StorageUnavailable):
                chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (2, 1))

    def test_cleanup_still_deletes_existing_main_and_preview_when_disabled(self):
        row = self._upload(self._pdf(), "reading.pdf")
        database.update_row("chat_attachments", row["id"], {
            "created_at": (datetime.now(timezone.utc) - timedelta(days=2)).isoformat(),
        }, path=self.db_path)
        self.app.config["NEST_CHAT_ATTACHMENTS_ENABLED"] = False
        with self.app.app_context():
            self.assertEqual(chat_attachments.cleanup_abandoned_attachments(), 1)
        self.assertEqual(self._counts(), (0, 0))
        self.remote.assert_not_called()

    def test_local_cleanup_preserves_imported_appwrite_source_copy(self):
        row = self._upload()
        row["storage_bucket_id"] = "old-source-bucket"
        database.update_row("chat_attachments", row["id"], {
            "storage_bucket_id": "old-source-bucket",
        }, path=self.db_path)
        with self.app.app_context():
            chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (0, 0))
        self.remote.assert_not_called()

    def test_bind_and_delete_respect_mutation_pause(self):
        row = self._upload()
        self._message()
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with self.app.app_context():
            with self.assertRaises(StorageMutationPaused):
                chat_attachments.bind_pending([row["id"]], user_id="owner", scope_type="thread",
                                              scope_id="thread", message_id="message")
            with self.assertRaises(StorageMutationPaused):
                chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(database.get_row("chat_attachments", row["id"], path=self.db_path)["status"], "pending")

    def test_upload_and_cleanup_respect_mutation_pause_before_preparation_and_listing(self):
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with patch.object(chat_attachments, "_read_upload") as read, \
                patch.object(chat_attachments, "list_rows_all") as rows:
            with self.assertRaises(StorageMutationPaused):
                self._upload()
            with self.app.app_context(), self.assertRaises(StorageMutationPaused):
                chat_attachments.cleanup_abandoned_attachments()
            read.assert_not_called()
            rows.assert_not_called()
        self.assertEqual(self._counts(), (0, 0))

    def test_binding_rechecks_all_attachments_before_any_status_change(self):
        first = self._upload()
        second = self._upload()
        database.update_row("chat_attachments", second["id"], {"user_id": "outsider"}, path=self.db_path)
        self._message()
        with self.app.app_context(), self.assertRaises(validation.AttachmentError):
            chat_attachments.bind_pending([first["id"], second["id"]], user_id="owner", scope_type="thread",
                                          scope_id="thread", message_id="message")
        for row in (first, second):
            self.assertEqual(database.get_row("chat_attachments", row["id"], path=self.db_path)["status"], "pending")

    def test_failed_legacy_delete_commits_durable_queue_before_transport(self):
        row = self._legacy(self._upload())
        self.remote.side_effect = None
        self.remote.return_value.delete_file.side_effect = AppwriteException("transport failed", 503)
        with self.app.app_context(), self.assertRaises(StorageUnavailable):
            chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (0, 0))
        with database.db_connection(self.db_path) as conn:
            queued = dict(conn.execute("SELECT * FROM storage_legacy_deletions").fetchone())
        self.assertEqual((queued["namespace"], queued["bucket_id"], queued["object_id"]),
                         ("chat_attachments", "legacy", row["storage_file_id"]))
        self.assertEqual(queued["account_user_id"], "owner")
        self.assertIsNone(queued["parent_id"])
        self.remote.return_value.delete_file.side_effect = None
        with self.app.app_context():
            self.assertFalse(chat_attachments.delete_attachment(row))
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 0)

    def test_legacy_cancel_rechecks_binding_before_deleting_any_payload(self):
        row = self._legacy(self._upload())
        self._bind([row])
        with self.app.app_context(), self.assertRaises(validation.AttachmentError):
            chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(database.get_row("chat_attachments", row["id"], path=self.db_path)["status"], "active")
        with self.app.app_context():
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 0)
        self.remote.assert_not_called()

    def test_legacy_cancel_rechecks_live_scope_inside_writer(self):
        row = self._legacy(self._upload())
        database.update_row("chat_dm_threads", "thread", {
            "participant_a": "outsider",
        }, path=self.db_path)
        with self._client() as client:
            response = client.delete(f"/api/chat/attachments/{row['id']}")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self._counts(), (1, 1))
        self.remote.assert_not_called()
        self.remote.side_effect = None
        with self.app.app_context():
            self.assertTrue(chat_attachments.delete_attachment(row, account_user_id="owner"))
        self.assertEqual(self._counts(), (0, 0))

    def test_legacy_cancel_rechecks_promotion_before_deleting_source(self):
        row = self._legacy(self._upload())
        database.update_row("chat_attachments", row["id"], {"storage_backend": "sqlite"}, path=self.db_path)
        with self.app.app_context(), self.assertRaises(validation.AttachmentError):
            chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (1, 1))
        self.remote.assert_not_called()

    def test_legacy_cancel_commit_releases_writer_before_scoped_transport(self):
        row = self._legacy(self._upload())
        self._queue_unrelated()
        self.remote.side_effect = None

        def delete_remote(bucket, object_id):
            self.assertEqual((bucket, object_id), ("legacy", row["storage_file_id"]))
            self.assertEqual(self._counts(), (0, 0))
            # A second writer succeeds while the network callback is running.
            database.update_row("users", "owner", {"name": "Updated"}, path=self.db_path)

        self.remote.return_value.delete_file.side_effect = delete_remote
        with self.app.app_context():
            self.assertTrue(chat_attachments.delete_attachment(row))
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 1)
            self.assertEqual(pending_legacy_deletions("chat_attachments", object_ids=["unrelated"]), 1)

    def test_message_cleanup_retries_parent_queue_after_metadata_is_gone(self):
        row = self._legacy(self._upload())
        self._bind([row])
        self._queue_unrelated()
        self.remote.side_effect = None
        self.remote.return_value.delete_file.side_effect = AppwriteException("transport failed", 503)
        for attempt in range(2):
            with self.subTest(attempt=attempt), self.app.app_context(), self.assertRaises(StorageUnavailable):
                chat_attachments.delete_message_attachments("message")
            self.assertEqual(self._counts(), (0, 0))
            parent = database.get_row("chat_messages", "message", path=self.db_path)
            self.assertIsNone(parent["deleted_at"])
            self.assertTrue(parent["delete_requested_at"])
            with self.app.app_context():
                self.assertEqual(pending_legacy_deletions("chat_attachments", parent_id="message"), 1)
        self.remote.return_value.delete_file.side_effect = None
        with self.app.app_context():
            chat_attachments.delete_message_attachments("message")
            self.assertEqual(pending_legacy_deletions("chat_attachments", parent_id="message"), 0)
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 1)
        self.assertEqual(self.remote.return_value.delete_file.call_count, 3)

    def test_delete_intent_blocks_binding_after_cleanup_starts(self):
        active = self._legacy(self._upload())
        pending = self._upload()
        self._bind([active])
        self.remote.side_effect = None
        self.remote.return_value.delete_file.side_effect = AppwriteException("transport failed", 503)
        with self.app.app_context():
            with self.assertRaises(StorageUnavailable):
                chat_attachments.delete_message_attachments("message")
            with self.assertRaises(validation.AttachmentError):
                chat_attachments.bind_pending(
                    [pending["id"]], user_id="owner", scope_type="thread", scope_id="thread", message_id="message",
                )
        self.assertEqual(self._counts(), (1, 1))
        self.assertEqual(database.get_row("chat_attachments", pending["id"], path=self.db_path)["status"], "pending")

    def test_user_delete_finishes_after_window_and_background_queue_drain(self):
        row = self._legacy(self._upload())
        self._bind([row])
        started = datetime(2026, 10, 1, 12, tzinfo=timezone.utc)
        database.update_row("chat_messages", "message", {
            "created_at": (started - timedelta(minutes=4)).isoformat(),
        }, path=self.db_path)
        self.app.errorhandler(StorageError)(lambda exc: ({"code": exc.code}, exc.status_code))
        self.remote.side_effect = None
        self.remote.return_value.delete_file.side_effect = AppwriteException("transport failed", 503)
        with self._client() as client, patch.object(chat_api.chat_message_delivery, "utcnow", return_value=started):
            failed = client.delete("/api/chat/messages/message")
        self.assertEqual(failed.status_code, 503)
        parent = database.get_row("chat_messages", "message", path=self.db_path)
        self.assertIsNone(parent["deleted_at"])
        self.assertTrue(parent["delete_requested_at"])
        self.remote.return_value.delete_file.side_effect = None
        with self.app.app_context():
            chat_attachments.cleanup_legacy_attachments(parent_id="message")
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 0)
        with self._client() as client, patch.object(chat_api.chat_message_delivery, "utcnow", return_value=started + timedelta(minutes=2)), \
                patch.object(chat_api, "emit_chat_event"), patch.object(chat_api, "_emit_chat_delete_audit"):
            finished = client.delete("/api/chat/messages/message")
        self.assertEqual(finished.status_code, 200)
        self.assertTrue(database.get_row("chat_messages", "message", path=self.db_path)["deleted_at"])

    def test_discord_soft_delete_retries_pending_parent_after_metadata_removal(self):
        row = self._legacy(self._upload())
        self._bind([row])
        self._queue_unrelated()
        database.update_row("chat_messages", "message", {
            "channel_id": "room", "source": "discord", "discord_message_id": "remote-message",
        }, path=self.db_path)
        channel = database.get_row("chat_channels", "room", path=self.db_path)
        self.remote.side_effect = None
        self.remote.return_value.delete_file.side_effect = AppwriteException("transport failed", 503)
        with self.app.app_context(), patch.object(chat_api, "logger"):
            for attempt in range(2):
                with self.subTest(attempt=attempt):
                    self.assertIsNone(chat_api._soft_delete_discord_message(channel, "remote-message"))
                    self.assertEqual(self._counts(), (0, 0))
                    self.assertIsNone(database.get_row("chat_messages", "message", path=self.db_path)["deleted_at"])
            self.remote.return_value.delete_file.side_effect = None
            self.assertIsNotNone(chat_api._soft_delete_discord_message(channel, "remote-message"))
            self.assertEqual(pending_legacy_deletions("chat_attachments", parent_id="message"), 0)
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 1)
        self.assertTrue(database.get_row("chat_messages", "message", path=self.db_path)["deleted_at"])

    def test_discord_prune_retries_pending_parent_after_metadata_removal(self):
        row = self._legacy(self._upload())
        self._bind([row])
        self._queue_unrelated()
        database.update_row("chat_messages", "message", {"channel_id": "room"}, path=self.db_path)
        for index in range(50):
            database.create_row("chat_messages", f"newer-{index}", {
                "channel_id": "room", "created_at": f"2099-01-01T00:00:{index:02d}Z",
            }, path=self.db_path)
        self.remote.side_effect = None
        self.remote.return_value.delete_file.side_effect = AppwriteException("transport failed", 503)
        with self.app.app_context(), patch.object(chat_api, "logger"):
            for attempt in range(2):
                with self.subTest(attempt=attempt):
                    chat_api._prune_discord_messages("room")
                    self.assertEqual(self._counts(), (0, 0))
                    self.assertIsNotNone(database.get_row("chat_messages", "message", path=self.db_path))
            self.remote.return_value.delete_file.side_effect = None
            chat_api._prune_discord_messages("room")
            self.assertEqual(pending_legacy_deletions("chat_attachments", parent_id="message"), 0)
            self.assertEqual(pending_legacy_deletions("chat_attachments"), 1)
        self.assertIsNone(database.get_row("chat_messages", "message", allow_missing=True, path=self.db_path))

    def test_chat_writers_refresh_stale_author_avatar_during_remote_retirement(self):
        old_url = "/api/avatars/retiring-avatar"
        fresh_url = "https://provider.example/current.png"
        database.update_row("users", "owner", {"picture_url": fresh_url}, path=self.db_path)
        with self.app.app_context(), storage_objects.write_transaction() as conn:
            enqueue_legacy_deletion(
                conn, "avatars", "legacy-avatars", "retiring-avatar", account_user_id="owner",
            )
        started, release = threading.Event(), threading.Event()

        def remote_delete(_bucket, _object_id):
            started.set()
            if not release.wait(timeout=10):
                raise RuntimeError("Chat writer did not complete during retirement")

        def retire():
            with self.app.app_context():
                return drain_legacy_deletions("avatars", remote_delete, account_user_id="owner")

        with ThreadPoolExecutor(1) as pool:
            cleanup = pool.submit(retire)
            try:
                self.assertTrue(started.wait(timeout=10))
                with self.app.app_context():
                    for row_id, writer in (("direct", database.create_row), ("discord", database.insert_row_ignore)):
                        writer("chat_messages", row_id, {
                            "thread_id": "thread", "user_id": "owner", "author_avatar_url": old_url,
                            "created_at": database.utcnow_iso(),
                        }, path=self.db_path)
                        row = database.get_row("chat_messages", row_id, path=self.db_path)
                        self.assertEqual(row["author_avatar_url"], fresh_url)
            finally:
                release.set()
            self.assertEqual(cleanup.result(timeout=10), {"completed": 1, "pending": 0})

    def test_chat_author_guard_preserves_nonretiring_history_and_text_during_pause(self):
        with self.app.app_context(), storage_objects.write_transaction() as conn:
            enqueue_legacy_deletion(conn, "avatars", "legacy-avatars", "retiring-avatar", account_user_id="owner")
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with self.app.app_context():
            for row_id, avatar_url in (("history", "/api/avatars/historical-avatar"), ("external", "https://cdn.discord.example/avatar.png")):
                row = database.create_row("chat_messages", row_id, {
                    "user_id": "owner", "author_avatar_url": avatar_url, "created_at": database.utcnow_iso(),
                })
                self.assertEqual(row["author_avatar_url"], avatar_url)
            row = database.create_row("chat_messages", "retiring", {
                "user_id": "owner", "author_avatar_url": "/api/avatars/retiring-avatar",
                "created_at": database.utcnow_iso(),
            })
            self.assertEqual(row["author_avatar_url"], "")

    def test_legacy_delete_removes_pre_copied_sqlite_object_in_metadata_transaction(self):
        row = self._upload()
        database.update_row("chat_attachments", row["id"], {"storage_backend": "appwrite", "storage_bucket_id": "legacy"}, path=self.db_path)
        row.update(storage_backend="appwrite", storage_bucket_id="legacy")
        self.remote.side_effect = None
        with self.app.app_context():
            chat_attachments.delete_attachment(row)
        self.assertEqual(self._counts(), (0, 0))


if __name__ == "__main__":
    unittest.main()
