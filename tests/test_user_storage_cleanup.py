import base64
import json
import tempfile
import threading
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from appwrite.exception import AppwriteException
from appwrite.services.storage import Storage
from flask import Flask

from appwrite_helpers import create_row_safe, get_row_safe, update_row_safe
from services import avatar_storage, chat_attachments, database, entitlements, file_share_store, note_media, storage_objects
from services.user_cleanup import delete_user_data
from services.user_storage_cleanup import delete_user_storage


NOW = "2026-10-01T12:00:00Z"


class UserStorageCleanupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = str(Path(temporary.name) / "nest.sqlite3")
        keyring = Path(temporary.name) / "uploads.keys.json"
        keyring.write_text(json.dumps({"active_key_id": "test", "keys": {"test": base64.b64encode(b"k" * 32).decode()}}))
        keyring.chmod(0o600)
        self.app = Flask(__name__)
        self.app.config.update(
            DATABASE_PATH=self.path,
            NEST_STORAGE_BACKEND="sqlite",
            NEST_STORAGE_MUTATIONS_PAUSED=False,
            NEST_STORAGE_READ_LEGACY=False,
            NEST_CHAT_ATTACHMENTS_ENABLED=False,
            NEST_UPLOAD_KEYRING_PATH=str(keyring),
        )
        database.init_db(app=self.app)
        self.context = self.app.app_context()
        self.context.push()
        self.addCleanup(self.context.pop)
        self.patches = ExitStack()
        self.addCleanup(self.patches.close)
        self.patches.enter_context(patch.object(avatar_storage, "ENDPOINT", "https://legacy.example.test/v1"))
        self.patches.enter_context(patch.object(avatar_storage, "PROJECT_ID", "nest-project"))
        self.patches.enter_context(patch.object(avatar_storage, "PROFILE_AVATAR_BUCKET_ID", "profile-images"))
        for user_id in ("owner", "keeper", "collaborator"):
            create_row_safe("users", user_id, {
                "google_id": user_id, "email": f"{user_id}@example.test", "name": user_id, "created_at": NOW,
            })
        for note_id, user_id in (("owned-note", "owner"), ("keeper-note", "keeper")):
            create_row_safe("notes", note_id, {"user_id": user_id, "content": "[]", "created_at": NOW})

    def _object(self, namespace, object_id):
        with patch.object(storage_objects, "scan_upload"):
            prepared = storage_objects.prepare_object(
                namespace, object_id, f"bytes for {object_id}".encode(), filename=f"{object_id}.png", mime_type="image/png",
            )
        with storage_objects.write_transaction() as conn:
            storage_objects.put_object(conn, prepared)

    def _file(self, backend="sqlite", object_id="shared-object"):
        if backend == "sqlite":
            self._object("shared_files", object_id)
        return create_row_safe("shared_files", f"{object_id}-row", {
            "user_id": "owner", "original_filename": "study.txt", "stored_path": "",
            "storage_backend": backend, "storage_bucket_id": "source-shared-bucket", "storage_file_id": object_id,
            "file_size_bytes": 32, "mime_type": "text/plain", "expires_at": NOW, "created_at": NOW,
        })

    def _media(self, backend="sqlite", object_id="note-object", *, note_id="owned-note", user_id="collaborator"):
        if backend == "sqlite":
            self._object("note_media", object_id)
        return create_row_safe("note_media", f"{object_id}-row", {
            "note_id": note_id, "user_id": user_id, "storage_backend": backend,
            "storage_bucket_id": "source-note-bucket", "storage_file_id": object_id,
            "original_filename": "study.png", "mime_type": "image/png", "file_size_bytes": 32,
            "width": 2, "height": 2, "status": "active", "created_at": NOW,
        })

    def _message(self, message_id, user_id="owner", *, avatar_url=""):
        return create_row_safe("chat_messages", message_id, {
            "user_id": user_id, "author_avatar_url": avatar_url, "created_at": NOW,
        })

    def _attachment(self, backend="sqlite", object_id="chat-object", preview_id="chat-preview"):
        if backend == "sqlite":
            for identity in (object_id, preview_id):
                if identity:
                    self._object("chat_attachments", identity)
        return create_row_safe("chat_attachments", f"{object_id}-row", {
            "user_id": "owner", "scope_type": "channel", "scope_id": "study-channel",
            "message_id": "owned-message", "status": "active", "original_filename": "study.pdf",
            "mime_type": "application/pdf", "kind": "pdf", "original_size_bytes": 32, "stored_size_bytes": 32,
            "sha256": "a" * 64, "storage_backend": backend, "storage_bucket_id": "source-chat-bucket",
            "storage_file_id": object_id, "preview_file_id": preview_id, "preview_size_bytes": 32,
            "created_at": NOW, "updated_at": NOW,
        })

    def _avatar(self, file_id="current-avatar", *, backend="sqlite", user_id="owner"):
        if backend == "sqlite":
            self._object("avatars", file_id)
        update_row_safe("users", user_id, {
            "avatar_file_id": file_id, "avatar_storage_backend": backend, "avatar_file_size_bytes": 32,
            "picture_url": avatar_storage.build_avatar_view_url(file_id, backend=backend),
        })

    def _seed_uploads(self):
        self._file()
        self._media()
        self._message("owned-message")
        self._attachment()
        self._avatar()

    def _snapshot(self):
        with database.db_connection() as conn:
            tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
            return {table: [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')] for table in tables}

    def _object_ids(self):
        with database.db_connection() as conn:
            return {(row[0], row[1]) for row in conn.execute("SELECT namespace, object_id FROM storage_objects")}

    def _assert_legacy_intent_preserved(self, before, feature, row_id, object_id):
        after = self._snapshot()
        expected = dict(before)
        expected[feature] = [row for row in before[feature] if row[0] != row_id]
        expected["storage_legacy_deletions"] = after["storage_legacy_deletions"]
        self.assertEqual(after, expected)
        with database.db_connection() as conn:
            pending = conn.execute(
                "SELECT account_user_id FROM storage_legacy_deletions WHERE object_id=?", (object_id,),
            ).fetchone()
        self.assertEqual(pending[0], "owner")

    def test_pause_stops_before_invites_calendar_or_upload_changes(self):
        self._seed_uploads()
        before = self._snapshot()
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with patch("services.invites.anonymize_invitee") as invites, \
                patch("services.user_cleanup.delete_calendar_rows_by_user") as calendar, \
                patch("services.user_cleanup.shutil.rmtree") as remove_directory:
            with self.assertRaises(storage_objects.StorageMutationPaused):
                delete_user_data("owner")
        invites.assert_not_called()
        calendar.assert_not_called()
        remove_directory.assert_not_called()
        self.assertEqual(self._snapshot(), before)

    def test_sqlite_only_account_deletion_cleans_disabled_chat_and_collaborator_media(self):
        self._seed_uploads()
        self._media(object_id="keeper-media", note_id="keeper-note", user_id="keeper")
        self._object("avatars", "historical-avatar")
        self._message("historical-message", avatar_url=avatar_storage.build_avatar_view_url("historical-avatar", backend="appwrite"))
        self._object("avatars", "retained-avatar")
        self._message("old-owned-message", avatar_url="/api/avatars/retained-avatar")
        self._message("keeper-message", "keeper", avatar_url="/api/avatars/retained-avatar")
        self._object("avatars", "unreferenced-import")
        with patch.object(Storage, "delete_file", side_effect=AssertionError("Appwrite transport must not run")) as remote:
            self.assertEqual(delete_user_data("owner"), [])
        remote.assert_not_called()
        self.assertIsNone(get_row_safe("users", "owner", allow_missing=True))
        self.assertIsNone(get_row_safe("notes", "owned-note", allow_missing=True))
        self.assertIsNone(get_row_safe("note_media", "note-object-row", allow_missing=True))
        self.assertIsNotNone(get_row_safe("notes", "keeper-note", allow_missing=True))
        self.assertIsNotNone(get_row_safe("users", "collaborator", allow_missing=True))
        self.assertEqual(self._object_ids(), {
            ("note_media", "keeper-media"), ("avatars", "retained-avatar"), ("avatars", "unreferenced-import"),
        })
        self.assertEqual(storage_objects.read_object("avatars", "retained-avatar"), b"bytes for retained-avatar")

    def test_failure_after_payload_deletion_rolls_back_every_local_reference(self):
        self._seed_uploads()
        before = self._snapshot()
        real_delete = storage_objects.delete_object

        def fail_on_avatar(conn, namespace, object_id):
            real_delete(conn, namespace, object_id)
            if namespace == "avatars":
                raise storage_objects.StorageIntegrityError("simulated deletion failure")

        with patch.object(storage_objects, "delete_object", side_effect=fail_on_avatar), \
                patch("services.invites.anonymize_invitee") as invites, \
                patch("services.user_cleanup.delete_calendar_rows_by_user") as calendar:
            with self.assertRaises(storage_objects.StorageIntegrityError):
                delete_user_data("owner")
        self.assertEqual(self._snapshot(), before)
        invites.assert_called_once_with("owner")
        calendar.assert_called_once_with("owner")

    def test_legacy_shared_file_error_preserves_user_and_all_local_payloads(self):
        self._seed_uploads()
        self._file("appwrite", "legacy-file")
        before = self._snapshot()
        remote = Mock()
        remote.delete_file.side_effect = AppwriteException("transport unavailable", 503)
        with patch.object(file_share_store, "_storage", return_value=remote):
            with self.assertRaises(storage_objects.StorageUnavailable):
                delete_user_data("owner")
        self._assert_legacy_intent_preserved(before, "shared_files", "legacy-file-row", "legacy-file")
        self.assertTrue(remote.delete_file.called)
        self.assertTrue(all(call.args == ("source-shared-bucket", "legacy-file")
                            for call in remote.delete_file.call_args_list))
        remote.delete_file.side_effect = AppwriteException("already deleted", 404)
        with patch.object(file_share_store, "_storage", return_value=remote):
            delete_user_storage("owner")
        self.assertIsNone(get_row_safe("users", "owner", allow_missing=True))

    def test_legacy_collaborator_media_error_prevents_owned_note_cascade(self):
        self._seed_uploads()
        self._media("appwrite", "legacy-note-image")
        before = self._snapshot()
        remote = Mock()
        remote.delete_file.side_effect = AppwriteException("transport unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=remote):
            with self.assertRaises(storage_objects.StorageUnavailable):
                delete_user_data("owner")
        self._assert_legacy_intent_preserved(before, "note_media", "legacy-note-image-row", "legacy-note-image")
        remote.delete_file.side_effect = None
        with patch.object(note_media, "storage_service", return_value=remote):
            delete_user_storage("owner")
        self.assertIsNone(get_row_safe("users", "owner", allow_missing=True))

    def test_legacy_chat_payload_and_preview_delete_outside_writer_lock(self):
        self._message("owned-message")
        self._attachment("appwrite")
        for file_id in ("chat-object", "chat-preview"):
            self._object("chat_attachments", file_id)
        calls = []

        def remote_delete(bucket_id, file_id):
            # Acquiring another writer proves this callback holds no DB lock.
            with database.db_connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
            calls.append((bucket_id, file_id))

        remote = Mock()
        remote.delete_file.side_effect = remote_delete
        with patch.object(chat_attachments, "storage_service", return_value=remote):
            delete_user_storage("owner")
        self.assertEqual(calls, [("source-chat-bucket", "chat-object"), ("source-chat-bucket", "chat-preview")])
        self.assertEqual(self._object_ids(), set())
        self.assertIsNone(get_row_safe("chat_attachments", "chat-object-row", allow_missing=True))

    def test_legacy_avatar_error_retains_durable_account_retirement(self):
        self._avatar("legacy-avatar", backend="appwrite")
        self._message("owned-message", avatar_url=avatar_storage.build_avatar_view_url("legacy-avatar", backend="appwrite"))
        with patch.object(Storage, "delete_file", side_effect=AppwriteException("transport unavailable", 503)):
            with self.assertRaises(storage_objects.StorageUnavailable):
                delete_user_data("owner")
        self.assertIsNone(get_row_safe("users", "owner", allow_missing=True))
        self.assertIsNone(get_row_safe("chat_messages", "owned-message", allow_missing=True))
        with database.db_connection() as conn:
            self.assertIsNotNone(conn.execute("SELECT 1 FROM storage_account_deletions WHERE user_id='owner'").fetchone())
            queued = conn.execute(
                "SELECT account_user_id FROM storage_legacy_deletions WHERE namespace='avatars' AND object_id='legacy-avatar'",
            ).fetchone()
            self.assertEqual(queued[0], "owner")
        with patch.object(Storage, "delete_file", side_effect=AppwriteException("already deleted", 404)):
            delete_user_storage("owner")
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_legacy_deletions").fetchone()[0], 0)

    def test_unrelated_pending_account_cleanup_does_not_block_deletion(self):
        from services.storage_legacy_cleanup import enqueue_legacy_deletion
        self._seed_uploads()
        with storage_objects.write_transaction() as conn:
            enqueue_legacy_deletion(conn, "note_media", "source-note-bucket", "keeper-pending", account_user_id="keeper")
        with patch.object(Storage, "delete_file", side_effect=AssertionError("unrelated transport must not run")):
            delete_user_storage("owner")
        self.assertIsNone(get_row_safe("users", "owner", allow_missing=True))
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT object_id FROM storage_legacy_deletions").fetchone()[0], "keeper-pending")

    def test_other_profile_url_keeps_historical_avatar_without_file_id(self):
        self._object("avatars", "profile-shared-avatar")
        self._message("owned-message", avatar_url="/api/avatars/profile-shared-avatar")
        update_row_safe("users", "keeper", {"picture_url": "/api/avatars/profile-shared-avatar"})
        delete_user_storage("owner")
        self.assertEqual(self._object_ids(), {("avatars", "profile-shared-avatar")})

    def test_unrelated_avatar_origins_do_not_delete_local_candidate_objects(self):
        self._object("avatars", "external-avatar")
        self._message("foreign-origin-message", avatar_url=(
            "https://foreign.example.test/v1/storage/buckets/profile-images/files/external-avatar/view?project=nest-project"
        ))
        self._message("foreign-scheme-message", avatar_url="javascript:/api/avatars/external-avatar")
        with patch.object(Storage, "delete_file", side_effect=AssertionError("unrecognized identity")):
            delete_user_storage("owner")
        self.assertEqual(self._object_ids(), {("avatars", "external-avatar")})

    def test_new_legacy_upload_after_inventory_aborts_local_parent_deletion(self):
        self._seed_uploads()
        with patch("services.user_storage_cleanup._delete_legacy_rows", side_effect=lambda *_: self._media("appwrite", "new-legacy")):
            with self.assertRaises(storage_objects.StorageUnavailable):
                delete_user_storage("owner")
        self.assertIsNotNone(get_row_safe("notes", "owned-note", allow_missing=True))
        self.assertIsNotNone(get_row_safe("shared_files", "shared-object-row", allow_missing=True))
        self.assertIsNotNone(get_row_safe("note_media", "new-legacy-row", allow_missing=True))
        self.assertIn(("shared_files", "shared-object"), self._object_ids())

    def test_waiting_upload_cannot_write_after_atomic_profile_deletion(self):
        self._seed_uploads()
        entering_writer = threading.Event()
        outcomes = []

        def late_upload():
            with self.app.app_context():
                entering_writer.set()
                try:
                    with storage_objects.write_transaction() as conn:
                        entitlements.check_storage_transaction(conn, "owner", 1)
                        outcomes.append("quota check accepted a deleted owner")
                except Exception as exc:
                    outcomes.append(exc)

        real_delete = storage_objects.delete_object
        thread = threading.Thread(target=late_upload)

        def synchronize_writer(conn, namespace, object_id):
            deleted = real_delete(conn, namespace, object_id)
            if namespace == "avatars":
                thread.start()
                self.assertTrue(entering_writer.wait(2))
                self.assertTrue(conn.execute("SELECT 1 FROM storage_account_deletions WHERE user_id = 'owner'").fetchone())
            return deleted

        with patch.object(storage_objects, "delete_object", side_effect=synchronize_writer):
            delete_user_storage("owner")
        thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(outcomes), 1)
        self.assertIsInstance(outcomes[0], storage_objects.StorageUnavailable)
        self.assertIsNone(get_row_safe("users", "owner", allow_missing=True))
        self.assertEqual(self._object_ids(), set())

    def test_deleted_account_cannot_be_recreated_by_signup_storage_exception(self):
        delete_user_storage("owner")
        with storage_objects.write_transaction() as conn:
            with self.assertRaises(storage_objects.StorageUnavailable):
                entitlements.check_storage_transaction(conn, "owner", 1, allow_new_user=True)
            with self.assertRaises(storage_objects.StorageUnavailable):
                entitlements.assert_account_storage_active(conn, "owner")


if __name__ == "__main__":
    unittest.main()
