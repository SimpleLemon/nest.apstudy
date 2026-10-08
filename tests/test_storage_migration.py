import base64
import gzip
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.storage_migration import manifest
from scripts.storage_migration import promotion, runner
from scripts.storage_migration.promotion import promote
from scripts.storage_migration.references import Reference, scan_content
from scripts.storage_migration.runner import run_stage
from scripts.storage_migration.source import AppwriteSource, MAX_BYTES, MigrationError, SourceConfig, SourceObject
from services import storage_objects
from services.storage_errors import StorageNotFound, StorageUnavailable


class LocalSource:
    def __init__(self, config, payloads):
        self.config = config
        self.payloads = payloads
        self.inventory_calls = 0

    def inventory(self):
        self.inventory_calls += 1
        for (namespace, file_id), data in self.payloads.items():
            yield SourceObject(namespace, self.config.buckets[namespace], file_id,
                               file_id + ".bin", "application/octet-stream", len(data), "created", "updated")

    def download(self, obj):
        return self.payloads[obj.namespace, obj.file_id]


class StorageMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.path = self.directory / "nest.sqlite3"
        self.keyring = self.directory / "keys.json"
        self.keyring.write_text(json.dumps({"active_key_id": "test", "keys": {
            "test": base64.b64encode(b"t" * 32).decode("ascii")}}))
        self.keyring.chmod(0o600)
        environment = patch.dict(os.environ, {"NEST_UPLOAD_KEYRING_PATH": str(self.keyring),
                                              "NEST_STORAGE_MUTATIONS_PAUSED": "false"})
        environment.start()
        self.addCleanup(environment.stop)
        scanner = patch.object(storage_objects, "scan_upload")
        self.scanner = scanner.start()
        self.addCleanup(scanner.stop)
        self.config = SourceConfig("https://storage.example.test/v1", "test-project", {
            "avatars": "avatars", "shared_files": "files", "note_media": "notes", "chat_attachments": "chat"})
        with closing(sqlite3.connect(self.path)) as conn:
            conn.executescript("""
                CREATE TABLE users(id TEXT PRIMARY KEY,avatar_file_id TEXT,picture_url TEXT);
                CREATE TABLE shared_files(id TEXT PRIMARY KEY,storage_file_id TEXT,storage_bucket_id TEXT,
                                          storage_backend TEXT,stored_path TEXT,expires_at TEXT);
                CREATE TABLE note_media(id TEXT PRIMARY KEY,storage_file_id TEXT,storage_bucket_id TEXT);
                CREATE TABLE chat_attachments(id TEXT PRIMARY KEY,storage_file_id TEXT,storage_bucket_id TEXT,
                        preview_file_id TEXT,compression_encoding TEXT,original_size_bytes INTEGER,sha256 TEXT);
                CREATE TABLE chat_messages(id TEXT PRIMARY KEY,author_avatar_url TEXT);
            """)
            conn.executescript((Path(__file__).resolve().parents[1] / "migrations/028_sqlite_upload_storage.sql").read_text())
            conn.commit()

    def execute(self, sql, parameters=()):
        with closing(sqlite3.connect(self.path)) as conn:
            conn.row_factory = sqlite3.Row
            result = conn.execute(sql, parameters).fetchall()
            conn.commit()
            return [dict(row) for row in result]

    def test_dry_run_is_read_only_and_lists_unreferenced_objects(self):
        source = LocalSource(self.config, {("avatars", "orphan"): b"original"})
        result = run_stage("dry-run", source, self.path)
        self.assertEqual(result["writes"], 0)
        self.assertEqual(result["namespaces"]["avatars"]["unreferenced"], 1)
        self.assertEqual(result["namespaces"]["chat_attachments"], {"objects": 0, "bytes": 0, "unreferenced": 0})
        self.assertEqual(result["bytes"], len(b"original"))
        self.assertEqual(self.execute("SELECT * FROM storage_migration_manifest"), [])
        self.assertEqual(self.execute("SELECT * FROM storage_objects"), [])

    def test_copy_rerun_verifies_existing_bytes_without_replacing_ciphertext(self):
        source = LocalSource(self.config, {("shared_files", "file"): b"original"})
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 1)
        self.assertEqual(run_stage("verify", source, self.path)["verified"], 1)
        original = self.execute("SELECT nonce,payload FROM storage_objects")[0]
        self.assertEqual(run_stage("copy", source, self.path)["matched"], 1)
        self.assertEqual(original, self.execute("SELECT nonce,payload FROM storage_objects")[0])
        self.assertEqual(self.scanner.call_count, 1)
        self.assertEqual(source.inventory_calls, 3)

    def test_changed_source_fails_without_overwrite_and_cannot_promote(self):
        source = LocalSource(self.config, {("shared_files", "file"): b"original"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        source.payloads["shared_files", "file"] = b"changed"
        self.assertEqual(run_stage("copy", source, self.path)["failed"], 1)
        self.assertEqual(storage_objects.read_object("shared_files", "file", path=self.path), b"original")
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            with self.assertRaises(MigrationError):
                promote(self.path, self.config)

    def test_scanner_failure_is_resumable_and_never_exposes_an_object(self):
        source = LocalSource(self.config, {("note_media", "image"): b"generated-content"})
        self.scanner.side_effect = StorageUnavailable("secret test scanner response")
        self.assertEqual(run_stage("copy", source, self.path)["failed"], 1)
        self.assertEqual(self.execute("SELECT id FROM storage_objects"), [])
        self.assertNotIn("secret", self.execute("SELECT error FROM storage_migration_manifest")[0]["error"])
        self.scanner.side_effect = None
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 1)
        self.assertEqual(run_stage("verify", source, self.path)["verified"], 1)

    def test_copy_and_manifest_rollback_together(self):
        source = LocalSource(self.config, {("shared_files", "file"): b"original"})
        with patch.object(manifest, "result", side_effect=RuntimeError("commit-stage failure")):
            with self.assertRaises(RuntimeError):
                run_stage("copy", source, self.path)
        self.assertEqual(self.execute("SELECT id FROM storage_objects"), [])

    def test_import_attribution_bills_current_and_historical_avatars_once_but_not_orphans(self):
        self.execute("ALTER TABLE chat_messages ADD COLUMN user_id TEXT")
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('current','current-avatar')")
        for message_id in ("history-1", "history-2"):
            self.execute("INSERT INTO chat_messages(id,user_id,author_avatar_url) VALUES (?,'original',?)",
                         (message_id, self.config.file_url("avatars", "historical-avatar")))
        source = LocalSource(self.config, {("avatars", "current-avatar"): b"current",
                                          ("avatars", "historical-avatar"): b"history",
                                          ("avatars", "orphan"): b"orphan"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        run_stage("copy", source, self.path)
        self.assertEqual(self.execute("SELECT object_id,user_id,size_bytes FROM storage_avatar_ownership ORDER BY object_id"),
                         [{"object_id": "current-avatar", "user_id": "current", "size_bytes": 7},
                          {"object_id": "historical-avatar", "user_id": "original", "size_bytes": 7}])
        self.assertEqual({row["storage_backend"] for row in self.execute("SELECT storage_backend FROM storage_avatar_ownership")},
                         {"appwrite"})
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        self.assertEqual(len(self.execute("SELECT * FROM storage_avatar_ownership")), 2)
        self.assertEqual({row["storage_backend"] for row in self.execute("SELECT storage_backend FROM storage_avatar_ownership")},
                         {"sqlite"})

    def test_import_does_not_invent_an_owner_for_ambiguous_avatar_references(self):
        self.execute("ALTER TABLE chat_messages ADD COLUMN user_id TEXT")
        for user_id in ("a", "b"):
            self.execute("INSERT INTO users(id,avatar_file_id) VALUES (?,'shared-current')", (user_id,))
            self.execute("INSERT INTO chat_messages(id,user_id,author_avatar_url) VALUES (?,?,?)",
                         (user_id, user_id, self.config.file_url("avatars", "shared-history")))
        source = LocalSource(self.config, {("avatars", "shared-current"): b"current",
                                          ("avatars", "shared-history"): b"history"})
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 2)
        self.assertEqual(self.execute("SELECT * FROM storage_avatar_ownership"), [])

    def test_import_attributes_stored_ids_before_url_borrowers_and_history_before_url_only_profiles(self):
        self.execute("ALTER TABLE chat_messages ADD COLUMN user_id TEXT")
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('uploader','current')")
        for file_id in ("current", "historical", "url-only"):
            self.execute("INSERT INTO users(id,picture_url) VALUES (?,?)",
                         ("borrower-" + file_id, self.config.file_url("avatars", file_id)))
        self.execute("INSERT INTO chat_messages(id,user_id,author_avatar_url) VALUES ('m','original',?)",
                     (self.config.file_url("avatars", "historical"),))
        source = LocalSource(self.config, {("avatars", "current"): b"current",
                                          ("avatars", "historical"): b"history",
                                          ("avatars", "url-only"): b"borrowed"})
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 3)
        self.assertEqual(self.execute("SELECT object_id,user_id FROM storage_avatar_ownership ORDER BY object_id"),
                         [{"object_id": "current", "user_id": "uploader"},
                          {"object_id": "historical", "user_id": "original"}])

    def test_import_preserves_existing_owner_and_promotes_its_backend(self):
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('current','avatar')")
        self.execute("INSERT INTO storage_avatar_ownership VALUES ('avatar','original',6,'appwrite')")
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        self.assertEqual(self.execute("SELECT user_id,size_bytes,storage_backend FROM storage_avatar_ownership")[0],
                         {"user_id": "original", "size_bytes": 6, "storage_backend": "sqlite"})

    def test_import_ownership_size_disagreement_rolls_back_payload_and_manifest_success(self):
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('u','avatar')")
        self.execute("INSERT INTO storage_avatar_ownership VALUES ('avatar','u',1,'appwrite')")
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        self.assertEqual(run_stage("copy", source, self.path)["failed"], 1)
        self.assertEqual(self.execute("SELECT * FROM storage_objects"), [])
        self.assertEqual(self.execute("SELECT status FROM storage_migration_manifest")[0]["status"], "failed")

    def test_import_attributes_against_current_references_after_download(self):
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('removed','avatar')")
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        original = source.download

        def changed(obj):
            self.execute("DELETE FROM users")
            return original(obj)

        source.download = changed
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 1)
        self.assertEqual(self.execute("SELECT * FROM storage_avatar_ownership"), [])

    def test_promote_preserves_ids_expired_files_and_external_urls(self):
        avatar_url = self.config.file_url("avatars", "avatar")
        self.execute("INSERT INTO users(id,avatar_file_id,picture_url) VALUES ('u','avatar',?)", (avatar_url,))
        self.execute("INSERT INTO users(id,avatar_file_id,picture_url) VALUES ('external',NULL,'https://provider.test/image')")
        self.execute("INSERT INTO shared_files VALUES ('shared','file','files','appwrite','appwrite://files/file','2000-01-01')")
        self.execute("INSERT INTO note_media(id,storage_file_id,storage_bucket_id) VALUES ('media','image','notes')")
        self.execute("INSERT INTO chat_messages(id,author_avatar_url) VALUES ('historical',?)", (avatar_url,))
        self.execute("INSERT INTO chat_messages(id,author_avatar_url) VALUES ('baseline',?)", (self.config.file_url("avatars", "missing"),))
        self.execute("INSERT INTO chat_messages(id,author_avatar_url) VALUES ('other-project',?)", (avatar_url.replace("test-project", "other"),))
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar", ("avatars", "orphan"): b"orphan",
                                          ("shared_files", "file"): b"expired", ("note_media", "image"): b"image"})
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 4)
        self.assertEqual(run_stage("verify", source, self.path)["verified"], 4)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            summary = promote(self.path, self.config)
            promote(self.path, self.config)
        self.assertEqual(summary["missing_historical_avatars_fallback"], 1)
        self.assertEqual(self.execute("SELECT picture_url,avatar_storage_backend FROM users WHERE id='u'")[0],
                         {"picture_url": "/api/avatars/avatar", "avatar_storage_backend": "sqlite"})
        self.assertEqual(self.execute("SELECT picture_url FROM users WHERE id='external'")[0]["picture_url"], "https://provider.test/image")
        self.assertIsNone(self.execute("SELECT author_avatar_url FROM chat_messages WHERE id='baseline'")[0]["author_avatar_url"])
        self.assertIn("other", self.execute("SELECT author_avatar_url FROM chat_messages WHERE id='other-project'")[0]["author_avatar_url"])
        self.assertEqual(self.execute("SELECT id,storage_file_id,storage_backend,stored_path FROM shared_files")[0],
                         {"id": "shared", "storage_file_id": "file", "storage_backend": "sqlite", "stored_path": "appwrite://files/file"})
        self.assertEqual(self.execute("SELECT id,storage_file_id,storage_backend FROM note_media")[0],
                         {"id": "media", "storage_file_id": "image", "storage_backend": "sqlite"})
        self.assertEqual(len(self.execute("SELECT id FROM storage_objects")), 4)

    def test_promotion_requires_pause_and_is_all_or_nothing_for_missing_feature(self):
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        self.execute("INSERT INTO users(id,avatar_file_id,picture_url) VALUES ('u','avatar',?)",
                     (self.config.file_url("avatars", "avatar"),))
        self.execute("INSERT INTO note_media(id,storage_file_id,storage_bucket_id) VALUES ('missing','absent','notes')")
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        with self.assertRaises(MigrationError):
            promote(self.path, self.config)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            with self.assertRaises(MigrationError):
                promote(self.path, self.config)
        self.assertEqual(self.execute("SELECT avatar_storage_backend FROM users")[0]["avatar_storage_backend"], "appwrite")

    def test_rerun_after_cutover_ignores_new_sqlite_only_avatar_references(self):
        source = LocalSource(self.config, {("avatars", "legacy"): b"legacy"})
        self.execute("INSERT INTO users(id,avatar_file_id,picture_url) VALUES ('old','legacy',?)",
                     (self.config.file_url("avatars", "legacy"),))
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        self.execute("INSERT INTO users(id,avatar_file_id,picture_url,avatar_storage_backend) "
                     "VALUES ('new','sqlite-only','/api/avatars/sqlite-only','sqlite')")
        self.assertEqual(run_stage("copy", source, self.path)["missing_references"], 0)
        self.assertEqual(run_stage("verify", source, self.path)["verified"], 1)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        self.assertEqual(self.execute("SELECT avatar_file_id FROM users WHERE id='new'")[0]["avatar_file_id"], "sqlite-only")

    def test_gzip_is_scanned_as_original_while_storage_hash_stays_compressed(self):
        original = b"local text fixture\n" * 200
        compressed = gzip.compress(original)
        digest = hashlib.sha256(original).hexdigest()
        self.execute("INSERT INTO chat_attachments(id,storage_file_id,storage_bucket_id,preview_file_id,"
                     "compression_encoding,original_size_bytes,sha256) VALUES ('attachment','gzip','chat','','gzip',?,?)",
                     (len(original), digest))
        source = LocalSource(self.config, {("chat_attachments", "gzip"): compressed})
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 1)
        self.scanner.assert_called_once_with(original)
        self.assertEqual(self.execute("SELECT sha256 FROM storage_objects")[0]["sha256"], hashlib.sha256(compressed).hexdigest())
        self.assertEqual(self.execute("SELECT sha256 FROM chat_attachments")[0]["sha256"], digest)

    def test_corrupt_decrypted_destination_blocks_verification(self):
        source = LocalSource(self.config, {("shared_files", "file"): b"original"})
        run_stage("copy", source, self.path)
        self.execute("UPDATE storage_objects SET payload=zeroblob(length(payload))")
        self.assertEqual(run_stage("verify", source, self.path)["failed"], 1)

    def test_promotion_rechecks_ciphertext_after_authentication_before_writer_lock(self):
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('u','avatar')")
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        original = promotion._verified_destinations

        def race(*args):
            result = original(*args)
            self.execute("UPDATE storage_objects SET payload=zeroblob(length(payload))")
            return result

        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}), \
                patch.object(promotion, "_verified_destinations", side_effect=race):
            with self.assertRaises(MigrationError):
                promote(self.path, self.config)
        self.assertEqual(self.execute("SELECT avatar_storage_backend FROM users")[0]["avatar_storage_backend"], "appwrite")
        self.assertEqual(self.execute("SELECT status FROM storage_migration_manifest")[0]["status"], "verified")

    def test_promotion_rechecks_full_manifest_and_destination_metadata(self):
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        original = promotion._verified_destinations
        for sql in ("UPDATE storage_objects SET original_filename='changed.bin'",
                    "UPDATE storage_migration_manifest SET reference_status='referenced'"):
            with self.subTest(sql=sql):
                def race(*args):
                    result = original(*args)
                    self.execute(sql)
                    return result
                with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}), \
                        patch.object(promotion, "_verified_destinations", side_effect=race):
                    with self.assertRaises(MigrationError):
                        promote(self.path, self.config)

    def test_removed_destination_during_promotion_raises_missing_without_fallback(self):
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        original = promotion._verified_destinations

        def race(*args):
            result = original(*args)
            self.execute("DELETE FROM storage_objects")
            return result

        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}), \
                patch.object(promotion, "_verified_destinations", side_effect=race):
            with self.assertRaises(StorageNotFound):
                promote(self.path, self.config)

    def test_verify_rechecks_destination_before_marking_it_verified(self):
        source = LocalSource(self.config, {("shared_files", "file"): b"original"})
        run_stage("copy", source, self.path)
        original = runner.verified_fingerprint

        def race(*args, **kwargs):
            result = original(*args, **kwargs)
            self.execute("UPDATE storage_objects SET payload=zeroblob(length(payload))")
            return result

        with patch.object(runner, "verified_fingerprint", side_effect=race):
            self.assertEqual(run_stage("verify", source, self.path)["failed"], 1)
        self.assertEqual(self.execute("SELECT status,verified_at FROM storage_migration_manifest")[0],
                         {"status": "failed", "verified_at": None})

    def test_intentional_legacy_deletion_during_copy_does_not_block_final_delta(self):
        source = LocalSource(self.config, {("shared_files", "deleted"): b"expired", ("avatars", "orphan"): b"orphan"})
        self.execute("INSERT INTO shared_files VALUES ('shared','deleted','files','appwrite','source','2000-01-01')")
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        # Feature cleanup writes this durable receipt in the same transaction
        # as deleting its local copy and feature record, before remote deletion.
        self.execute("UPDATE storage_migration_manifest SET status='removed',error='Intentional local storage deletion' "
                     "WHERE source_file_id='deleted'")
        self.execute("DELETE FROM storage_objects WHERE object_id='deleted'")
        self.execute("DELETE FROM shared_files")
        del source.payloads["shared_files", "deleted"]
        self.assertEqual(run_stage("copy", source, self.path)["failed"], 0)
        self.assertEqual(run_stage("verify", source, self.path)["verified"], 1)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        receipt = self.execute("SELECT status,reference_status,sha256 FROM storage_migration_manifest WHERE source_file_id='deleted'")[0]
        self.assertEqual(receipt["status"], "removed")
        self.assertEqual(receipt["reference_status"], "source_disappeared")
        self.assertEqual(receipt["sha256"], hashlib.sha256(b"expired").hexdigest())

    def test_intentionally_deleted_copy_is_recopied_if_source_still_exists(self):
        source = LocalSource(self.config, {("avatars", "orphan"): b"orphan"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        self.execute("UPDATE storage_migration_manifest SET status='removed'")
        self.execute("DELETE FROM storage_objects")
        self.assertEqual(run_stage("copy", source, self.path)["copied"], 1)
        self.assertEqual(run_stage("verify", source, self.path)["verified"], 1)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        self.assertEqual(storage_objects.read_object("avatars", "orphan", path=self.path), b"orphan")

    def test_unexpected_source_disappearance_cannot_be_accepted_as_deletion(self):
        source = LocalSource(self.config, {("avatars", "orphan"): b"orphan"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        source.payloads.clear()
        run_stage("verify", source, self.path)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            with self.assertRaises(MigrationError):
                promote(self.path, self.config)

    def test_deletion_receipt_cannot_hide_a_remaining_live_reference(self):
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        self.execute("INSERT INTO users(id,avatar_file_id) VALUES ('u','avatar')")
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        self.execute("UPDATE storage_migration_manifest SET status='removed'")
        self.execute("DELETE FROM storage_objects")
        source.payloads.clear()
        run_stage("verify", source, self.path)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            with self.assertRaises(MigrationError):
                promote(self.path, self.config)

    def test_attachment_original_size_and_hash_are_checked_separately(self):
        original = b"fixture" * 50
        compressed = gzip.compress(original)
        obj = SourceObject("chat_attachments", "chat", "file", "file.gz", "text/plain", len(compressed))
        for claimed, digest in ((len(original) + 1, hashlib.sha256(original).hexdigest()),
                                (len(original), "0" * 64)):
            ref = Reference("chat_attachments", "chat", "file", "chat_attachments", "row", "storage_file_id",
                            {"compression_encoding": "gzip", "original_size_bytes": claimed, "sha256": digest})
            with self.assertRaises(MigrationError):
                scan_content(obj, compressed, [ref])

    def test_url_parser_rejects_lookalike_origins_paths_and_projects(self):
        url = self.config.file_url("avatars", "a")
        self.assertEqual(self.config.parse_file_url(url), ("avatars", "a"))
        self.assertEqual(self.config.parse_file_url(url.replace("storage.example.test", "STORAGE.EXAMPLE.TEST")), ("avatars", "a"))
        for altered in (url.replace("storage.example.test", "storage.example.test.evil"),
                        url + "&project=test-project", url.replace("test-project", "wrong"),
                        url.replace("/v1/", "/v1/../v1/"), url.replace("files/a/", "files/a%2Fb/"), "http://["):
            self.assertIsNone(self.config.parse_file_url(altered))

    def test_malformed_external_and_uppercase_legacy_avatar_urls_are_reconciled(self):
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        malformed = "http://["
        self.execute("INSERT INTO users(id,picture_url) VALUES ('external',?)", (malformed,))
        self.execute("INSERT INTO chat_messages(id,author_avatar_url) VALUES ('malformed',?)", (malformed,))
        self.execute("INSERT INTO chat_messages(id,author_avatar_url) VALUES ('legacy',?)",
                     (self.config.file_url("avatars", "avatar").replace("storage.example.test", "STORAGE.EXAMPLE.TEST"),))
        self.assertEqual(run_stage("dry-run", source, self.path)["missing_references"], 0)
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            promote(self.path, self.config)
        self.assertEqual(self.execute("SELECT picture_url FROM users")[0]["picture_url"], malformed)
        self.assertEqual(self.execute("SELECT author_avatar_url FROM chat_messages WHERE id='malformed'")[0]["author_avatar_url"], malformed)
        self.assertEqual(self.execute("SELECT author_avatar_url FROM chat_messages WHERE id='legacy'")[0]["author_avatar_url"], "/api/avatars/avatar")

    def test_optional_historical_picture_column_is_promoted_with_normal_missing_fallback(self):
        self.execute("ALTER TABLE chat_messages ADD COLUMN author_picture_url TEXT")
        self.execute("INSERT INTO chat_messages(id,author_picture_url) VALUES ('legacy',?)",
                     (self.config.file_url("avatars", "avatar"),))
        self.execute("INSERT INTO chat_messages(id,author_picture_url) VALUES ('missing',?)",
                     (self.config.file_url("avatars", "baseline"),))
        source = LocalSource(self.config, {("avatars", "avatar"): b"avatar"})
        run_stage("copy", source, self.path)
        run_stage("verify", source, self.path)
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            result = promote(self.path, self.config)
        self.assertEqual(result["missing_historical_avatars_fallback"], 1)
        self.assertEqual(self.execute("SELECT author_picture_url FROM chat_messages WHERE id='legacy'")[0]["author_picture_url"], "/api/avatars/avatar")
        self.assertIsNone(self.execute("SELECT author_picture_url FROM chat_messages WHERE id='missing'")[0]["author_picture_url"])


class AppwriteTransportTests(unittest.TestCase):
    def config(self):
        return SourceConfig("https://storage.example.test/v1", "test", {
            "avatars": "avatars", "shared_files": "files", "note_media": "notes", "chat_attachments": "chat"})

    def response(self, *, rows=None, data=b""):
        response = MagicMock()
        response.status_code = 200
        response.__enter__.return_value = response
        response.json.return_value = {"files": rows or []}
        response.raw = io.BytesIO(data)
        return response

    def test_inventory_paginates_until_empty_for_every_bucket(self):
        session = MagicMock()
        row = {"$id": "first", "sizeOriginal": 3, "name": "safe", "mimeType": "text/plain"}
        session.get.side_effect = [self.response(rows=[row]), self.response(rows=[{**row, "$id": "second"}]),
                                   self.response(), self.response(), self.response(), self.response()]
        objects = list(AppwriteSource(self.config(), "never-print-me", session=session).inventory())
        self.assertEqual([obj.file_id for obj in objects], ["first", "second"])
        self.assertIn("cursorAfter", str(session.get.call_args_list[1].kwargs["params"]))
        self.assertFalse(session.get.call_args.kwargs["allow_redirects"])

    def test_download_checks_limit_before_request_and_streams_actual_size(self):
        session = MagicMock()
        source = AppwriteSource(self.config(), "never-print-me", session=session)
        oversized = SourceObject("shared_files", "files", "large", "large", "text/plain", MAX_BYTES + 1)
        with self.assertRaises(MigrationError):
            source.download(oversized)
        session.get.assert_not_called()
        obj = SourceObject("shared_files", "files", "small", "small", "text/plain", 3)
        session.get.return_value = self.response(data=b"four")
        with self.assertRaises(MigrationError):
            source.download(obj)


if __name__ == "__main__":
    unittest.main()
