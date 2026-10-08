import base64
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask
from werkzeug.datastructures import FileStorage

from appwrite.exception import AppwriteException
import blueprints.notes_api as notes_api
from services import (
    database, entitlements, note_media, note_store, notes_collaboration,
    storage_legacy_cleanup, storage_objects,
)
from services.storage_objects import (
    StorageIntegrityError, StorageMutationPaused, StorageNotFound,
    StorageUnavailable, StorageValidationError,
)
from tests.test_notes_media import image_bytes


class NoteMediaSqliteTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "notes.sqlite3"
        keyring = Path(directory.name) / "uploads.json"
        keyring.write_text(json.dumps({
            "active_key_id": "test-key", "keys": {"test-key": base64.b64encode(b"k" * 32).decode()},
        }))
        keyring.chmod(0o600)
        self.app = Flask(__name__)
        self.app.secret_key = "notes-test"
        self.app.config.update(
            DATABASE_PATH=str(self.path), NEST_STORAGE_BACKEND="sqlite",
            NEST_UPLOAD_KEYRING_PATH=str(keyring), NEST_STORAGE_READ_LEGACY=False,
            NEST_STORAGE_MUTATIONS_PAUSED=False, LOGIN_DISABLED=True,
        )
        self.app.register_blueprint(notes_api.notes_api_bp)
        context = self.app.app_context()
        context.push()
        self.addCleanup(context.pop)
        database.init_db(app=self.app)
        with database.db_connection(self.path) as conn:
            conn.executemany(
                "INSERT INTO users (id, google_id, email, name, username, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(user, f"google-{user}", f"{user}@example.test", user, user, "2026-01-01T00:00:00Z")
                 for user in ("owner", "viewer", "outsider")],
            )
            conn.execute(
                "INSERT INTO note_folders (id, user_id, name, created_at) VALUES ('folder', 'owner', 'Folder', ?)",
                ["2026-01-01T00:00:00Z"],
            )
            conn.executemany(
                "INSERT INTO notes (id, user_id, folder_id, title, content, created_at) VALUES (?, 'owner', ?, 'Note', '[]', ?)",
                [("note", "folder", "2026-01-01T00:00:00Z"), ("other-note", None, "2026-01-01T00:00:00Z")],
            )
        self.scan_patch = patch.object(storage_objects, "scan_upload")
        self.scan = self.scan_patch.start()
        self.addCleanup(self.scan_patch.stop)
        self.storage_patch = patch.object(note_media, "storage_service", side_effect=AssertionError("Appwrite Storage unavailable"))
        self.legacy_transport = self.storage_patch.start()
        self.addCleanup(self.storage_patch.stop)
        self.user_patch = patch.object(notes_api, "current_user", SimpleNamespace(id="owner", is_authenticated=True))
        self.user_patch.start()
        self.addCleanup(self.user_patch.stop)
        self.client = self.app.test_client()
        self.data = image_bytes()

    def upload(self, data=None, mime="image/png"):
        return FileStorage(stream=io.BytesIO(self.data if data is None else data), filename="image.png", content_type=mime)

    def create(self, note_id="note"):
        return note_media.create_media(note_id, "owner", self.upload())

    def url(self, media, note_id="note"):
        return f"/api/notes/{note_id}/media/{media['id']}"

    def counts(self):
        with database.db_connection(self.path) as conn:
            return tuple(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                         for table in ("note_media", "storage_objects"))

    def deletion_queue(self, *, attribution=False):
        columns = "namespace, bucket_id, object_id" + (", account_user_id, parent_id" if attribution else "")
        with database.db_connection(self.path) as conn:
            return [dict(row) for row in conn.execute(
                f"SELECT {columns} FROM storage_legacy_deletions ORDER BY id",
            ).fetchall()]

    def legacy(self, media, *, status="pending", created_at="2026-10-01T00:00:00Z"):
        with database.db_connection(self.path) as conn:
            conn.execute(
                "UPDATE note_media SET storage_backend='appwrite', storage_bucket_id='legacy-bucket', "
                "status=?, created_at=? WHERE id=?", [status, created_at, media["id"]],
            )
        return note_media.get_media(media["id"])

    def content(self, media):
        return json.dumps([{"type": "paragraph", "content": [{"type": "inlineImage", "props": {"mediaId": media["id"]}}]}])

    def viewer(self, user_id):
        return patch.object(notes_api, "current_user", SimpleNamespace(id=user_id, is_authenticated=bool(user_id)))

    def test_local_upload_keeps_feature_urls_and_encrypts_payload(self):
        response = self.client.post("/api/notes/note/media", data={"file": self.upload()})
        self.assertEqual(response.status_code, 201)
        media = note_media.get_media(response.json["id"])
        self.assertEqual(response.json["url"], self.url(media))
        self.assertEqual(media["storage_backend"], "sqlite")
        self.assertEqual(media["storage_bucket_id"], "")
        self.scan.assert_called_once_with(self.data)
        with database.db_connection(self.path) as conn:
            payload = conn.execute("SELECT payload FROM storage_objects").fetchone()[0]
        self.assertNotEqual(payload, self.data)
        self.assertEqual(note_media.media_bytes(media), self.data)
        self.legacy_transport.assert_not_called()

    def test_authorization_precedes_media_lookup_even_for_matching_etag_and_range(self):
        media = self.create()
        etag = self.client.get(self.url(media)).headers["ETag"]
        for user_id, status in (("outsider", 404), (None, 401)):
            with self.subTest(user=user_id), self.viewer(user_id), patch.object(note_media, "get_media") as lookup:
                response = self.client.get(self.url(media), headers={"If-None-Match": etag, "Range": "bytes=0-4"})
            self.assertEqual(response.status_code, status)
            lookup.assert_not_called()

    def test_named_and_public_folder_shares_can_read_media(self):
        media = self.create()
        note_store.replace_resource_grants(
            "note", "note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner",
        )
        with self.viewer("viewer"):
            self.assertEqual(self.client.get(self.url(media)).data, self.data)
        with self.viewer("outsider"):
            self.assertEqual(self.client.get(self.url(media)).status_code, 404)
        note_store.replace_resource_grants(
            "folder", "folder", "owner", public=True, user_ids=[], granted_by_user_id="owner",
        )
        with self.viewer(None):
            self.assertEqual(self.client.get(self.url(media)).data, self.data)
        self.assertEqual(self.client.get(self.url(media, "other-note")).status_code, 404)

    def test_private_image_headers_conditionals_and_seekable_ranges(self):
        media = self.create()
        response = self.client.get(self.url(media))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["Cache-Control"], "private, no-cache")
        self.assertTrue(response.headers["Content-Disposition"].startswith("inline;"))
        etag = response.headers["ETag"]
        cached = self.client.get(self.url(media), headers={"If-None-Match": etag})
        self.assertEqual((cached.status_code, cached.data), (304, b""))
        self.assertEqual(cached.headers["Cache-Control"], "private, no-cache")
        for headers in ({"Range": "bytes=0-7"}, {"Range": "bytes=0-7", "If-Range": etag}):
            ranged = self.client.get(self.url(media), headers=headers)
            self.assertEqual((ranged.status_code, ranged.data), (206, self.data[:8]))
            self.assertEqual(ranged.headers["Content-Range"], f"bytes 0-7/{len(self.data)}")
        self.assertEqual(self.client.get(self.url(media), headers={"If-Match": '"different"'}).status_code, 412)
        self.assertEqual(self.client.get(self.url(media), headers={"Range": "bytes=0-7", "If-Range": '"different"'}).status_code, 200)

    def test_corrupt_and_missing_sqlite_objects_never_fall_back(self):
        media = self.create()
        with database.db_connection(self.path) as conn:
            payload = conn.execute("SELECT payload FROM storage_objects").fetchone()[0]
            conn.execute("UPDATE storage_objects SET payload=?", [bytes([payload[0] ^ 1]) + payload[1:]])
        response = self.client.get(self.url(media))
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json["code"], "storage_integrity")
        with database.db_connection(self.path) as conn:
            conn.execute("DELETE FROM storage_objects")
        self.assertEqual(self.client.get(self.url(media)).status_code, 404)
        self.legacy_transport.assert_not_called()

    def test_feature_mime_tampering_cannot_render_html_inline(self):
        media = self.create()
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_media SET mime_type='text/html' WHERE id=?", [media["id"]])
        self.assertEqual(self.client.get(self.url(media)).status_code, 500)
        self.legacy_transport.assert_not_called()

    def test_invalid_oversized_and_mismatched_images_fail_before_scanning_or_writing(self):
        cases = [
            (b"", "image/png"), (b"<svg><script>alert(1)</script></svg>", "image/svg+xml"),
            (self.data[:-12], "image/png"), (self.data, "image/jpeg"),
            (b"x" * (note_media.MAX_NOTE_IMAGE_BYTES + 1), "image/png"),
        ]
        with patch.object(note_media, "write_transaction", side_effect=AssertionError("Unexpected writer")):
            for data, mime in cases:
                with self.subTest(size=len(data), mime=mime), self.assertRaises(ValueError):
                    note_media.create_media("note", "owner", self.upload(data, mime))
        self.assertEqual(self.counts(), (0, 0))
        self.scan.assert_not_called()

    def test_scanner_and_encryption_failures_leave_no_visible_records(self):
        for failure, status in ((StorageValidationError("Rejected by scanner"), 400), (StorageUnavailable("Scanner unavailable"), 503)):
            with self.subTest(failure=type(failure).__name__):
                self.scan.side_effect = failure
                with patch.object(note_media, "write_transaction", side_effect=AssertionError("Unexpected writer")):
                    response = self.client.post("/api/notes/note/media", data={"file": self.upload()})
                self.assertEqual(response.status_code, status)
                self.assertEqual(self.counts(), (0, 0))
        self.scan.side_effect = None
        with patch.object(storage_objects, "encrypt_payload", side_effect=StorageUnavailable("Key unavailable")):
            self.assertEqual(self.client.post("/api/notes/note/media", data={"file": self.upload()}).status_code, 503)
        self.assertEqual(self.counts(), (0, 0))

    def test_metadata_insert_failure_rolls_back_payload(self):
        with patch.object(note_media, "_insert_media", side_effect=StorageUnavailable("Insert failed")):
            with self.assertRaises(StorageUnavailable):
                self.create()
        self.assertEqual(self.counts(), (0, 0))

    def test_quota_is_rechecked_under_writer_lock_and_ignores_stale_request_limits(self):
        entitlements.save_tier_definitions({"free": {"storage_bytes": len(self.data) * 2 - 1}})
        self.create()
        stale = {"key": "developer", "limits": {"storage_bytes": None}, "usage": {"storage_bytes": 0}}
        with self.assertRaises(entitlements.EntitlementLimitError):
            note_media.create_media("note", "owner", self.upload(), entitlements=stale)
        self.assertEqual(self.counts(), (1, 1))

    def test_note_deletion_during_preparation_leaves_no_orphan_object(self):
        def deleted_before_lock(data):
            with database.db_connection(self.path) as conn:
                conn.execute("DELETE FROM notes WHERE id='note'")
        self.scan.side_effect = deleted_before_lock
        with self.assertRaises(StorageNotFound):
            self.create()
        self.assertEqual(self.counts(), (0, 0))

    def test_note_transfer_during_preparation_rechecks_owner(self):
        def transferred_before_lock(data):
            with database.db_connection(self.path) as conn:
                conn.execute("UPDATE notes SET user_id='viewer' WHERE id='note'")
        self.scan.side_effect = transferred_before_lock
        with self.assertRaises(StorageNotFound):
            self.create()
        self.assertEqual(self.counts(), (0, 0))

    def test_content_sync_activates_and_atomically_removes_local_media(self):
        keep, remove, pending = [self.create() for _ in range(3)]
        note_store.update_note("note", {"content": self.content(remove)}, user_id="owner")
        self.assertEqual(note_media.get_media(remove["id"])["status"], "active")
        note_store.update_note("note", {"content": self.content(keep)}, user_id="owner")
        self.assertIsNone(note_media.get_media(remove["id"]))
        self.assertEqual(note_media.get_media(keep["id"])["status"], "active")
        self.assertEqual(note_media.get_media(pending["id"])["status"], "pending")
        self.assertEqual(self.counts(), (2, 2))
        self.legacy_transport.assert_not_called()

    def test_content_sync_failure_rolls_back_note_and_payload_deletion(self):
        media = self.create()
        original = self.content(media)
        note_store.update_note("note", {"content": original})
        actual_delete = note_media.delete_object
        def fail_after_payload_delete(conn, namespace, object_id):
            actual_delete(conn, namespace, object_id)
            raise StorageUnavailable("Delete failed")
        with patch.object(note_media, "delete_object", side_effect=fail_after_payload_delete):
            with self.assertRaises(StorageUnavailable):
                note_store.update_note("note", {"content": "[]"})
        self.assertEqual(note_store.get_note("note")["content"], original)
        self.assertEqual(self.counts(), (1, 1))
        self.assertEqual(note_media.media_bytes(media), self.data)

    def test_note_and_folder_deletes_remove_payloads_without_appwrite(self):
        first = self.create()
        self.create("other-note")
        note_store.delete_note("other-note", user_id="owner")
        self.assertEqual(self.counts(), (1, 1))
        note_store.delete_folder_and_notes("owner", "folder")
        self.assertEqual(self.counts(), (0, 0))
        self.assertIsNone(note_store.get_note("note"))
        self.assertIsNone(note_media.get_media(first["id"]))
        self.legacy_transport.assert_not_called()

    def test_note_delete_failure_rolls_back_payload_metadata_and_parent(self):
        media = self.create()
        with patch.object(note_store, "delete_note_collaboration_rows", side_effect=StorageUnavailable("Cleanup failed")):
            with self.assertRaises(StorageUnavailable):
                note_store.delete_note("note", user_id="owner")
        self.assertEqual(self.counts(), (1, 1))
        self.assertIsNotNone(note_store.get_note("note"))
        self.assertEqual(note_media.media_bytes(media), self.data)

    def test_pending_cleanup_deletes_only_old_pending_payloads(self):
        old, recent, active = [self.create() for _ in range(3)]
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_media SET created_at='2001-01-01T00:00:00Z' WHERE id IN (?, ?)", [old["id"], active["id"]])
            conn.execute("UPDATE note_media SET status='active' WHERE id=?", [active["id"]])
        self.assertEqual(note_media.cleanup_abandoned_media(), 1)
        self.assertIsNone(note_media.get_media(old["id"]))
        self.assertIsNotNone(note_media.get_media(recent["id"]))
        self.assertEqual(note_media.media_bytes(active), self.data)
        self.assertEqual(self.counts(), (2, 2))

    def test_pause_covers_upload_sync_delete_cleanup_and_note_collaboration_edits(self):
        media = self.create()
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        mutations = [
            lambda: self.create(), lambda: note_media.sync_note_media("note", "[]"),
            lambda: note_media.delete_media(media), lambda: note_media.delete_note_media("note"),
            lambda: note_media.cleanup_abandoned_media(),
            lambda: note_store.update_note("note", {"title": "Updated"}),
            lambda: note_store.delete_note("note"),
            lambda: note_store.delete_folder_and_notes("owner", "folder"),
            lambda: notes_collaboration.store_collaboration_document("note", b"doc", content="[]"),
            lambda: notes_collaboration.restore_version("note", "missing", "owner"),
            lambda: notes_collaboration.transfer_note("note", "owner", "viewer"),
            lambda: notes_collaboration.transfer_folder("folder", "owner", "viewer"),
        ]
        for mutate in mutations:
            with self.assertRaises(StorageMutationPaused):
                mutate()
        self.assertEqual(self.client.post("/api/notes/note/media", data={"file": self.upload()}).status_code, 503)
        self.assertEqual(self.client.patch("/api/notes/note", json={"title": "Changed"}).status_code, 503)
        self.assertEqual(self.client.delete(self.url(media)).status_code, 503)
        self.assertEqual(self.client.delete("/api/notes/note").status_code, 503)
        self.assertEqual(self.client.get(self.url(media)).status_code, 200)
        self.assertEqual(self.counts(), (1, 1))

    def test_collaboration_projection_syncs_media_in_its_transaction(self):
        media = self.create()
        notes_collaboration.store_collaboration_document("note", b"first", content=self.content(media))
        self.assertEqual(note_media.get_media(media["id"])["status"], "active")
        notes_collaboration.store_collaboration_document("note", b"next", content="[]")
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(notes_collaboration.get_collaboration_document("note")["ydoc_blob"], b"next")

    def test_transfer_moves_media_accounting_with_note(self):
        media = self.create()
        note_store.replace_resource_grants(
            "note", "note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        notes_collaboration.transfer_note("note", "owner", "viewer")
        self.assertEqual(note_media.get_media(media["id"])["user_id"], "viewer")
        self.assertEqual(note_store.get_note("note")["user_id"], "viewer")
        self.assertEqual(note_media.media_bytes(media), self.data)

    def test_imported_sqlite_delete_preserves_source_copy_for_observation(self):
        media = self.create()
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_media SET storage_bucket_id='legacy-bucket' WHERE id=?", [media["id"]])
        note_media.delete_media(note_media.get_media(media["id"]), user_id="owner")
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.deletion_queue(), [])
        self.legacy_transport.assert_not_called()

    def test_explicit_legacy_reads_require_compatibility_and_local_corruption_is_not_masked(self):
        media = self.create()
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_media SET storage_backend='appwrite', storage_bucket_id='legacy-bucket' WHERE id=?", [media["id"]])
        with patch.object(note_media, "read_legacy_file", return_value=self.data) as legacy_reader:
            self.assertEqual(self.client.get(self.url(media)).status_code, 503)
            legacy_reader.assert_not_called()
            self.app.config["NEST_STORAGE_READ_LEGACY"] = True
            self.assertEqual(self.client.get(self.url(media)).data, self.data)
            legacy_reader.assert_called_once_with(
                "legacy-bucket", media["storage_file_id"],
                max_bytes=note_media.MAX_NOTE_IMAGE_BYTES, expected_bytes=len(self.data),
            )
        self.legacy_transport.assert_not_called()

    def test_single_legacy_delete_failure_commits_local_deletion_and_keeps_retry_identity(self):
        media = self.create()
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_media SET storage_backend='appwrite', storage_bucket_id='legacy-bucket' WHERE id=?", [media["id"]])
        legacy_media = note_media.get_media(media["id"])
        legacy = Mock()
        legacy.delete_file.side_effect = AppwriteException("Storage unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=legacy):
            note_media.delete_media(legacy_media, user_id="owner")
            self.assertEqual(self.counts(), (0, 0))
            self.assertEqual(len(self.deletion_queue()), 1)
            legacy.delete_file.side_effect = AppwriteException("Not found", 404)
            self.assertEqual(note_media.cleanup_legacy_media(), {"completed": 1, "pending": 0})
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.deletion_queue(), [])

    def test_single_and_account_legacy_deletes_recheck_transfer_before_queue_or_network(self):
        media = self.legacy(self.create())
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET user_id='viewer' WHERE id='note'")
            conn.execute("UPDATE note_media SET user_id='viewer' WHERE id=?", [media["id"]])
        for authorization in ({"user_id": "owner"}, {"account_user_id": "owner"}):
            with self.subTest(authorization=authorization), self.assertRaises(StorageNotFound):
                note_media.delete_media(media, **authorization)
        self.assertEqual(self.counts(), (1, 1))
        self.assertEqual(self.deletion_queue(), [])
        self.assertEqual(storage_objects.read_object("note_media", media["storage_file_id"]), self.data)
        self.legacy_transport.assert_not_called()

    def test_account_delete_accepts_current_parent_ownership_after_media_snapshot_changes(self):
        media = self.legacy(self.create())
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_media SET user_id='viewer' WHERE id=?", [media["id"]])
        legacy = Mock()
        with patch.object(note_media, "storage_service", return_value=legacy):
            note_media.delete_media(media, account_user_id="owner")
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.deletion_queue(), [])
        legacy.delete_file.assert_called_once_with("legacy-bucket", media["storage_file_id"])

    def test_bulk_note_delete_retains_legacy_identity_when_remote_is_unavailable(self):
        media = self.legacy(self.create())
        legacy = Mock()
        legacy.delete_file.side_effect = AppwriteException("Storage unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=legacy):
            note_store.delete_note("note", user_id="owner")
        self.assertIsNone(note_store.get_note("note"))
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.deletion_queue(), [{
            "namespace": "note_media", "bucket_id": "legacy-bucket",
            "object_id": media["storage_file_id"],
        }])
        legacy.delete_file.assert_called_once_with("legacy-bucket", media["storage_file_id"])

    def test_content_update_commits_with_legacy_retry_and_remote_calls_outside_writer_lock(self):
        media = self.legacy(self.create(), status="active")
        original = self.content(media)
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET content=? WHERE id='note'", [original])
        legacy = Mock()
        committed_state = []
        def unavailable_after_local_commit(bucket_id, object_id):
            # BEGIN IMMEDIATE would fail if remote I/O still held a writer.
            conn = database.connect(self.path)
            try:
                conn.execute("PRAGMA busy_timeout = 0")
                conn.execute("BEGIN IMMEDIATE")
                committed_state.append((
                    conn.execute("SELECT content FROM notes WHERE id='note'").fetchone()[0],
                    conn.execute("SELECT COUNT(*) FROM note_media").fetchone()[0],
                    conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0],
                    conn.execute("SELECT COUNT(*) FROM storage_legacy_deletions").fetchone()[0],
                ))
            finally:
                conn.rollback()
                conn.close()
            raise AppwriteException("Storage unavailable", 503)
        legacy.delete_file.side_effect = unavailable_after_local_commit
        with patch.object(note_media, "storage_service", return_value=legacy):
            updated = note_store.update_note("note", {"content": "[]"}, user_id="owner")
        self.assertEqual(updated["content"], "[]")
        self.assertEqual(committed_state, [("[]", 0, 0, 1)])
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(len(self.deletion_queue()), 1)
        legacy.delete_file.assert_called_once_with("legacy-bucket", media["storage_file_id"])

    def test_abandoned_cleanup_retries_queue_without_new_rows_and_treats_missing_as_success(self):
        media = self.legacy(self.create(), created_at="2001-01-01T00:00:00Z")
        legacy = Mock()
        legacy.delete_file.side_effect = AppwriteException("Storage unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=legacy):
            self.assertEqual(note_media.cleanup_abandoned_media(), 1)
            self.assertEqual(self.counts(), (0, 0))
            self.assertEqual(len(self.deletion_queue()), 1)
            # Even when transport initialization fails, preserve retry identity.
            with patch.object(note_media, "storage_service", side_effect=ConnectionError("Transport unavailable")):
                self.assertEqual(note_media.cleanup_abandoned_media(), 0)
            self.assertEqual(len(self.deletion_queue()), 1)
            legacy.delete_file.side_effect = AppwriteException("Not found", 404)
            self.assertEqual(note_media.cleanup_abandoned_media(), 0)
        self.assertEqual(self.deletion_queue(), [])
        self.assertEqual(legacy.delete_file.call_count, 2)
        self.assertEqual(legacy.delete_file.call_args.args, ("legacy-bucket", media["storage_file_id"]))

    def test_bulk_deletion_rollback_restores_queue_media_payload_and_note(self):
        media = self.legacy(self.create())
        with patch.object(note_store, "delete_note_collaboration_rows", side_effect=StorageUnavailable("Cleanup failed")):
            with self.assertRaises(StorageUnavailable):
                note_store.delete_note("note", user_id="owner")
        self.assertEqual(self.counts(), (1, 1))
        self.assertIsNotNone(note_store.get_note("note"))
        self.assertEqual(self.deletion_queue(), [])
        self.assertEqual(storage_objects.read_object("note_media", media["storage_file_id"]), self.data)
        self.legacy_transport.assert_not_called()

    def test_content_update_rollback_keeps_legacy_row_copy_and_original_content(self):
        media = self.legacy(self.create(), status="active")
        original = self.content(media)
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET content=? WHERE id='note'", [original])
        delete_object = note_media.delete_object
        def fail_after_payload_delete(conn, namespace, object_id):
            delete_object(conn, namespace, object_id)
            raise StorageUnavailable("Delete failed")
        with patch.object(note_media, "delete_object", side_effect=fail_after_payload_delete):
            with self.assertRaises(StorageUnavailable):
                note_store.update_note("note", {"content": "[]"}, user_id="owner")
        self.assertEqual(note_store.get_note("note")["content"], original)
        self.assertEqual(self.counts(), (1, 1))
        self.assertEqual(self.deletion_queue(), [])
        self.assertEqual(storage_objects.read_object("note_media", media["storage_file_id"]), self.data)
        self.legacy_transport.assert_not_called()

    def test_folder_delete_keeps_durable_retries_for_each_legacy_image(self):
        media = [self.legacy(self.create()) for _ in range(2)]
        legacy = Mock()
        legacy.delete_file.side_effect = AppwriteException("Storage unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=legacy):
            note_store.delete_folder_and_notes("owner", "folder")
        self.assertIsNone(note_store.get_folder("folder"))
        self.assertIsNone(note_store.get_note("note"))
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual({row["object_id"] for row in self.deletion_queue()}, {row["storage_file_id"] for row in media})
        self.assertEqual(legacy.delete_file.call_count, 2)

    def test_bulk_imported_sqlite_deletion_keeps_remote_source_copies(self):
        for _ in range(2):
            media = self.create()
            with database.db_connection(self.path) as conn:
                conn.execute("UPDATE note_media SET storage_bucket_id='legacy-bucket' WHERE id=?", [media["id"]])
        note_store.delete_folder_and_notes("owner", "folder")
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.deletion_queue(), [])
        self.legacy_transport.assert_not_called()

    def test_pause_stops_queued_network_cleanup_and_leaves_retry_intent(self):
        media = self.legacy(self.create())
        legacy = Mock()
        legacy.delete_file.side_effect = AppwriteException("Storage unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=legacy):
            note_store.delete_note("note")
            legacy.reset_mock()
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
            for cleanup in (note_media.cleanup_legacy_media, note_media.cleanup_abandoned_media):
                with self.assertRaises(StorageMutationPaused):
                    cleanup()
            legacy.delete_file.assert_not_called()
            self.assertEqual(self.deletion_queue()[0]["object_id"], media["storage_file_id"])
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
            legacy.delete_file.side_effect = None
            self.assertEqual(note_media.cleanup_abandoned_media(), 0)
        self.assertEqual(self.deletion_queue(), [])

    def test_pause_before_acknowledgement_preserves_queue_for_missing_object_retry(self):
        media = self.legacy(self.create())
        with storage_objects.write_transaction() as conn:
            note_media.delete_note_media("note", conn=conn)
        legacy = Mock()
        def pause_after_remote_delete(*args):
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        legacy.delete_file.side_effect = pause_after_remote_delete
        with patch.object(note_media, "storage_service", return_value=legacy):
            with self.assertRaises(StorageMutationPaused):
                note_media.cleanup_legacy_media()
            self.assertEqual(len(self.deletion_queue()), 1)
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
            legacy.delete_file.side_effect = AppwriteException("Not found", 404)
            self.assertEqual(note_media.cleanup_legacy_media(), {"completed": 1, "pending": 0})
        self.assertEqual(self.deletion_queue(), [])
        self.assertEqual(legacy.delete_file.call_args.args, ("legacy-bucket", media["storage_file_id"]))

    def test_legacy_deletion_queue_is_idempotent_and_drain_is_scoped(self):
        with storage_objects.write_transaction() as conn:
            for _ in range(2):
                storage_legacy_cleanup.enqueue_legacy_deletion(conn, "note_media", "note-bucket", "note-object")
            storage_legacy_cleanup.enqueue_legacy_deletion(conn, "avatars", "avatar-bucket", "avatar-object")
        self.assertEqual(len(self.deletion_queue()), 2)
        legacy = Mock()
        with patch.object(note_media, "storage_service", return_value=legacy):
            self.assertEqual(note_media.cleanup_legacy_media(), {"completed": 1, "pending": 0})
        legacy.delete_file.assert_called_once_with("note-bucket", "note-object")
        self.assertEqual(self.deletion_queue(), [{
            "namespace": "avatars", "bucket_id": "avatar-bucket", "object_id": "avatar-object",
        }])

    def test_queue_filters_count_and_drain_only_the_selected_durable_scope(self):
        identities = [
            ("note_media", "first", "owner", "note"),
            ("note_media", "second", "owner", "other-note"),
            ("note_media", "third", "viewer", "note"),
            ("avatars", "avatar", "owner", None),
            ("note_media", "unknown", None, None),
        ]
        with storage_objects.write_transaction() as conn:
            for namespace, object_id, account, parent in identities:
                storage_legacy_cleanup.enqueue_legacy_deletion(
                    conn, namespace, "bucket", object_id, account_user_id=account, parent_id=parent,
                )
        pending = storage_legacy_cleanup.pending_legacy_deletions
        self.assertEqual(pending(), 5)
        self.assertEqual(pending("note_media"), 4)
        self.assertEqual(pending(account_user_id="owner"), 3)
        self.assertEqual(pending("note_media", account_user_id="owner"), 2)
        self.assertEqual(pending("note_media", parent_id="note"), 2)
        self.assertEqual(pending("note_media", object_ids="first"), 1)
        self.assertEqual(pending("note_media", object_ids=[]), 0)
        self.assertEqual(pending("note_media", account_user_id="viewer", object_ids=["first"]), 0)
        delete = Mock()
        result = storage_legacy_cleanup.drain_legacy_deletions(
            "note_media", delete, account_user_id="owner", parent_id="note",
            object_ids=(object_id for object_id in ("first", "second")),
        )
        self.assertEqual(result, {"completed": 1, "pending": 0})
        delete.assert_called_once_with("bucket", "first")
        self.assertEqual(pending(), 4)
        delete.reset_mock()
        self.assertEqual(storage_legacy_cleanup.drain_legacy_deletions(
            "note_media", delete, account_user_id="owner",
        ), {"completed": 1, "pending": 0})
        delete.assert_called_once_with("bucket", "second")
        self.assertEqual(pending("note_media"), 2)
        self.assertEqual(pending("avatars", account_user_id="owner"), 1)

    def test_duplicate_queue_intent_fills_missing_attribution_and_preserves_the_original_scope(self):
        with storage_objects.write_transaction() as conn:
            storage_legacy_cleanup.enqueue_legacy_deletion(conn, "note_media", "bucket", "image")
            created_at = conn.execute("SELECT created_at FROM storage_legacy_deletions").fetchone()[0]
            storage_legacy_cleanup.enqueue_legacy_deletion(
                conn, "note_media", "bucket", "image", account_user_id="owner", parent_id="note",
            )
            storage_legacy_cleanup.enqueue_legacy_deletion(
                conn, "note_media", "bucket", "image", account_user_id="viewer", parent_id="other-note",
            )
            self.assertEqual(conn.execute("SELECT created_at FROM storage_legacy_deletions").fetchone()[0], created_at)
        self.assertEqual(self.deletion_queue(attribution=True), [{
            "namespace": "note_media", "bucket_id": "bucket", "object_id": "image",
            "account_user_id": "owner", "parent_id": "note",
        }])
        self.assertEqual(storage_legacy_cleanup.pending_legacy_deletions(account_user_id="viewer"), 0)

    def test_paused_queue_can_be_inspected_but_cannot_enqueue_or_call_the_transport(self):
        with storage_objects.write_transaction() as conn:
            storage_legacy_cleanup.enqueue_legacy_deletion(
                conn, "note_media", "bucket", "image", account_user_id="owner", parent_id="note",
            )
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
            with self.assertRaises(StorageMutationPaused):
                storage_legacy_cleanup.enqueue_legacy_deletion(conn, "avatars", "bucket", "avatar")
        delete = Mock()
        with self.assertRaises(StorageMutationPaused):
            storage_legacy_cleanup.drain_legacy_deletions("note_media", delete, account_user_id="owner")
        delete.assert_not_called()
        self.assertEqual(storage_legacy_cleanup.pending_legacy_deletions(account_user_id="owner"), 1)
        self.assertEqual(storage_legacy_cleanup.pending_legacy_deletions("avatars"), 0)

    def test_acknowledgement_does_not_erase_a_reenqueued_identity_after_remote_io(self):
        with storage_objects.write_transaction() as conn:
            with patch.object(storage_legacy_cleanup, "utcnow_iso", return_value="2026-01-01T00:00:00Z"):
                storage_legacy_cleanup.enqueue_legacy_deletion(
                    conn, "note_media", "bucket", "image", account_user_id="owner", parent_id="note",
                )
        def reenqueued_during_transport(bucket_id, object_id):
            # The remote callback must run outside SQLite's writer lock.
            with storage_objects.write_transaction() as conn:
                conn.execute("DELETE FROM storage_legacy_deletions")
                with patch.object(storage_legacy_cleanup, "utcnow_iso", return_value="2026-01-02T00:00:00Z"):
                    storage_legacy_cleanup.enqueue_legacy_deletion(
                        conn, "note_media", bucket_id, object_id, account_user_id="owner", parent_id="note",
                    )
        self.assertEqual(storage_legacy_cleanup.drain_legacy_deletions(
            "note_media", reenqueued_during_transport, account_user_id="owner",
        ), {"completed": 0, "pending": 1})
        missing = Mock(side_effect=AppwriteException("Not found", 404))
        self.assertEqual(storage_legacy_cleanup.drain_legacy_deletions(
            "note_media", missing, account_user_id="owner",
        ), {"completed": 1, "pending": 0})
        missing.assert_called_once_with("bucket", "image")

    def test_note_queue_attribution_uses_fresh_parent_owner_and_survives_parent_deletion(self):
        media = self.legacy(self.create())
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET user_id='viewer' WHERE id='note'")
        with storage_objects.write_transaction() as conn:
            note_media.delete_media(media, conn=conn)
            conn.execute("DELETE FROM notes WHERE id='note'")
            conn.execute("DELETE FROM users WHERE id='viewer'")
        self.assertEqual(self.deletion_queue(attribution=True), [{
            "namespace": "note_media", "bucket_id": "legacy-bucket", "object_id": media["storage_file_id"],
            "account_user_id": "viewer", "parent_id": "note",
        }])
        self.assertEqual(storage_legacy_cleanup.pending_legacy_deletions(account_user_id="viewer"), 1)
        self.legacy_transport.assert_not_called()

    def test_account_queue_override_keeps_uploader_deletion_separate_from_new_note_owner(self):
        media = self.legacy(self.create())
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET user_id='viewer' WHERE id='note'")
        with storage_objects.write_transaction() as conn:
            note_media.delete_media(media, conn=conn, account_user_id="owner")
        self.assertEqual(self.deletion_queue(attribution=True)[0]["account_user_id"], "owner")
        self.assertEqual(storage_legacy_cleanup.pending_legacy_deletions(account_user_id="viewer"), 0)
        self.legacy_transport.assert_not_called()

    def test_missing_parent_queue_attribution_falls_back_to_the_uploader(self):
        media = self.legacy(self.create())
        with storage_objects.write_transaction() as conn:
            conn.execute("DELETE FROM notes WHERE id='note'")
            note_media._delete_media_record(conn, media)
        self.assertEqual(self.deletion_queue(attribution=True)[0]["account_user_id"], "owner")
        self.assertEqual(self.counts(), (0, 0))
        self.legacy_transport.assert_not_called()

    def test_note_edits_and_single_deletion_leave_unrelated_accounts_retry_work_untouched(self):
        with storage_objects.write_transaction() as conn:
            storage_legacy_cleanup.enqueue_legacy_deletion(
                conn, "note_media", "unrelated-bucket", "unrelated-image",
                account_user_id="viewer", parent_id="unrelated-note",
            )
        local = self.create()
        note_store.update_note("note", {"content": "[]"}, user_id="owner")
        note_media.delete_media(local, user_id="owner")
        self.legacy_transport.assert_not_called()
        media = self.legacy(self.create())
        legacy = Mock()
        with patch.object(note_media, "storage_service", return_value=legacy):
            note_media.delete_media(media, user_id="owner")
            legacy.delete_file.assert_called_once_with("legacy-bucket", media["storage_file_id"])
            self.assertEqual(note_media.cleanup_legacy_media(account_user_id="owner"), {"completed": 0, "pending": 0})
            self.assertEqual(note_media.cleanup_legacy_media(
                account_user_id="viewer", parent_id="unrelated-note", object_ids=["unrelated-image"],
            ), {"completed": 1, "pending": 0})
        self.assertEqual(legacy.delete_file.call_count, 2)
        self.assertEqual(self.deletion_queue(), [])

    def test_collaboration_projection_defers_legacy_cleanup_after_atomic_document_update(self):
        media = self.legacy(self.create())
        notes_collaboration.store_collaboration_document("note", b"first", content=self.content(media))
        legacy = Mock()
        legacy.delete_file.side_effect = AppwriteException("Storage unavailable", 503)
        with patch.object(note_media, "storage_service", return_value=legacy):
            notes_collaboration.store_collaboration_document("note", b"next", content="[]")
        self.assertEqual(notes_collaboration.get_collaboration_document("note")["ydoc_blob"], b"next")
        self.assertEqual(note_store.get_note("note")["content"], "[]")
        self.assertEqual(self.counts(), (0, 0))
        self.assertEqual(self.deletion_queue()[0]["object_id"], media["storage_file_id"])

    def test_collaboration_rollback_keeps_document_media_and_payload_without_queued_deletion(self):
        media = self.legacy(self.create())
        content = self.content(media)
        notes_collaboration.store_collaboration_document("note", b"first", content=content)
        delete_object = note_media.delete_object
        def fail_after_payload_delete(conn, namespace, object_id):
            delete_object(conn, namespace, object_id)
            raise StorageUnavailable("Delete failed")
        with patch.object(note_media, "delete_object", side_effect=fail_after_payload_delete):
            with self.assertRaises(StorageUnavailable):
                notes_collaboration.store_collaboration_document("note", b"next", content="[]")
        self.assertEqual(notes_collaboration.get_collaboration_document("note")["ydoc_blob"], b"first")
        self.assertEqual(note_store.get_note("note")["content"], content)
        self.assertEqual(self.counts(), (1, 1))
        self.assertEqual(self.deletion_queue(), [])
        self.assertEqual(storage_objects.read_object("note_media", media["storage_file_id"]), self.data)
        self.legacy_transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
