import base64
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, EnvironmentConfig
from services import database, storage_backend, storage_crypto, storage_objects, storage_rows
from services.storage_errors import (
    StorageIntegrityError, StorageMutationPaused, StorageNotFound,
    StorageUnavailable, StorageValidationError,
)


class StorageObjectTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "uploads.sqlite3"
        self.keyring = Path(self.directory.name) / "upload-keys.json"
        self.write_keys("test", {"test": b"k" * 32})
        self.app = Flask(__name__)
        self.app.config.update(
            DATABASE_PATH=str(self.path), NEST_STORAGE_BACKEND="sqlite",
            NEST_UPLOAD_KEYRING_PATH=str(self.keyring), NEST_STORAGE_MUTATIONS_PAUSED=False,
        )
        self.context = self.app.app_context()
        self.context.push()
        self.addCleanup(self.context.pop)
        database.init_db(app=self.app)
        self.scan = patch.object(storage_objects, "scan_upload").start()
        self.addCleanup(patch.stopall)

    def write_keys(self, active, keys):
        self.keyring.write_text(json.dumps({
            "active_key_id": active,
            "keys": {key_id: base64.b64encode(key).decode("ascii") for key_id, key in keys.items()},
        }))
        self.keyring.chmod(0o600)

    def prepare(self, object_id="file-1", data=b"confidential upload", namespace="shared_files", **kwargs):
        return storage_objects.prepare_object(namespace, object_id, data,
                                              filename="document.txt", mime_type="text/plain", **kwargs)

    def store(self, prepared=None):
        prepared = prepared or self.prepare()
        with storage_objects.write_transaction() as conn:
            return storage_objects.put_object(conn, prepared)

    def tamper(self, assignment, parameters=()):
        with database.db_connection() as conn:
            conn.execute(f"UPDATE storage_objects SET {assignment} WHERE namespace='shared_files' AND object_id='file-1'", parameters)

    def test_encrypted_round_trip_and_metadata_excludes_payload(self):
        original = b"confidential upload"
        prepared = self.prepare(data=original)
        metadata = self.store(prepared)
        self.assertIsInstance(metadata["id"], int)
        self.assertNotIn("payload", metadata)
        self.assertEqual(metadata["byte_length"], len(original))
        self.assertEqual(metadata["sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(metadata["ciphertext_length"], len(original) + 16)
        self.assertEqual(metadata["encryption_key_id"], "test")
        self.assertEqual(storage_objects.read_object("shared_files", "file-1"), original)
        with database.db_connection() as conn:
            payload = conn.execute("SELECT payload FROM storage_objects").fetchone()[0]
        self.assertNotEqual(payload, original)
        self.assertNotIn(original, payload)
        self.scan.assert_called_once_with(original)

    def test_nonce_is_fresh_and_original_scan_bytes_are_distinct_from_stored_hash(self):
        first = self.prepare(data=b"optimized", scan_data=b"original image")
        second = self.prepare("file-2", data=b"optimized", scan_data=b"original image")
        self.assertNotEqual(first.nonce, second.nonce)
        self.assertEqual(first.sha256, hashlib.sha256(b"optimized").hexdigest())
        self.scan.assert_called_with(b"original image")

    def test_duplicate_identity_never_replaces_bytes(self):
        self.store(self.prepare(data=b"first"))
        with self.assertRaises(StorageIntegrityError):
            self.store(self.prepare(data=b"replacement"))
        self.assertEqual(storage_objects.read_object("shared_files", "file-1"), b"first")

    def test_same_public_id_in_different_namespaces_remains_isolated(self):
        self.store(self.prepare(data=b"shared"))
        self.store(self.prepare(namespace="note_media", data=b"note"))
        self.assertEqual(storage_objects.read_object("shared_files", "file-1"), b"shared")
        self.assertEqual(storage_objects.read_object("note_media", "file-1"), b"note")

    def test_feature_failure_rolls_back_payload_and_metadata(self):
        prepared = self.prepare()
        with self.assertRaisesRegex(RuntimeError, "feature failed"):
            with storage_objects.write_transaction() as conn:
                storage_objects.put_object(conn, prepared)
                storage_rows.insert_row(conn, "shared_files", "feature-1", {
                    "user_id": "owner", "original_filename": "document.txt", "stored_path": "file-1",
                    "storage_backend": "sqlite", "storage_file_id": "file-1", "file_size_bytes": prepared.byte_length,
                    "created_at": prepared.created_at, "expires_at": "2099-01-01T00:00:00Z",
                })
                raise RuntimeError("feature failed")
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM shared_files").fetchone()[0], 0)

    def test_feature_rows_share_conn_and_preserve_compatibility_fields(self):
        prepared = self.prepare()
        with storage_objects.write_transaction() as conn:
            storage_objects.put_object(conn, prepared)
            row = storage_rows.insert_row(conn, "shared_files", "feature-1", {
                "user_id": "owner", "original_filename": "document.txt", "stored_path": "file-1",
                "storage_backend": "sqlite", "storage_file_id": "file-1", "file_size_bytes": prepared.byte_length,
                "created_at": prepared.created_at, "expires_at": "2099-01-01T00:00:00Z", "is_public": True,
            })
            self.assertEqual(row["$id"], "feature-1")
            self.assertTrue(row["is_public"])
            updated = storage_rows.update_row(conn, "shared_files", "feature-1", {"downloaded_count": 2})
            self.assertEqual(updated["downloaded_count"], 2)
            self.assertTrue(storage_rows.delete_row(conn, "shared_files", "feature-1"))
            self.assertTrue(storage_objects.delete_object(conn, "shared_files", "file-1"))
        with self.assertRaises(StorageNotFound):
            storage_objects.read_object("shared_files", "file-1")

    def test_missing_metadata_and_payload_raise_not_found_delete_is_idempotent(self):
        with self.assertRaises(StorageNotFound):
            storage_objects.object_metadata("avatars", "missing")
        with self.assertRaises(StorageNotFound):
            storage_objects.read_object("avatars", "missing")
        with storage_objects.write_transaction() as conn:
            self.assertFalse(storage_objects.delete_object(conn, "avatars", "missing"))

    def test_mutations_require_explicit_caller_transaction(self):
        prepared = self.prepare()
        with database.db_connection() as conn:
            with self.assertRaises(StorageValidationError):
                storage_objects.put_object(conn, prepared)
            with self.assertRaises(StorageValidationError):
                storage_objects.delete_object(conn, "shared_files", "file-1")

    def test_pause_blocks_prepare_and_transactions_but_allows_existing_reads(self):
        self.store()
        self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with self.assertRaises(StorageMutationPaused):
            self.prepare("file-2")
        with self.assertRaises(StorageMutationPaused):
            with storage_objects.write_transaction():
                self.fail("Paused transaction must not yield")
        self.assertEqual(storage_objects.read_object("shared_files", "file-1"), b"confidential upload")

    def test_pause_is_rechecked_after_writer_lock(self):
        with patch.object(storage_objects, "require_mutations_enabled", side_effect=[None, StorageMutationPaused("paused")]):
            with self.assertRaises(StorageMutationPaused):
                with storage_objects.write_transaction():
                    self.fail("Pause changed while obtaining lock")
        with storage_objects.write_transaction() as conn:
            self.assertTrue(conn.in_transaction)

    def test_invalid_metadata_and_payload_limits_rejected_before_scanning(self):
        cases = [("unknown", "id", "file", "text/plain"), ("avatars", "../id", "file", "text/plain"),
                 ("avatars", "id", "unsafe\r\nfile", "text/plain"), ("avatars", "id", "file", "not-a-mime")]
        for namespace, object_id, filename, mime_type in cases:
            with self.subTest(namespace=namespace, object_id=object_id, filename=filename, mime_type=mime_type):
                with self.assertRaises(StorageValidationError):
                    storage_objects.prepare_object(namespace, object_id, b"data", filename=filename, mime_type=mime_type)
        with self.assertRaises(StorageValidationError):
            self.prepare(data=b"x" * (storage_objects.MAX_OBJECT_BYTES + 1))
        self.scan.assert_not_called()

    def test_malware_or_unavailable_scanner_prevents_encryption_and_write(self):
        for error in (StorageValidationError("malware"), StorageUnavailable("scanner down")):
            self.scan.side_effect = error
            with patch.object(storage_objects, "encrypt_payload") as encrypt:
                with self.assertRaises(type(error)):
                    self.prepare()
                encrypt.assert_not_called()
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 0)

    def test_ciphertext_tampering_fails_closed(self):
        prepared = self.prepare()
        self.store(prepared)
        altered = bytes([prepared.payload[0] ^ 1]) + prepared.payload[1:]
        self.tamper("payload = ?", (altered,))
        with self.assertRaises(StorageIntegrityError):
            storage_objects.read_object("shared_files", "file-1")

    def test_authenticated_routing_mime_and_length_cannot_be_changed(self):
        self.store()
        self.tamper("mime_type = 'application/octet-stream'")
        with self.assertRaises(StorageIntegrityError):
            storage_objects.read_object("shared_files", "file-1")
        self.tamper("mime_type = 'text/plain', namespace = 'avatars'")
        with self.assertRaises(StorageIntegrityError):
            storage_objects.read_object("avatars", "file-1")

    def test_hash_tampering_fails_closed(self):
        self.store()
        self.tamper("sha256 = ?", ("0" * 64,))
        with self.assertRaises(StorageIntegrityError):
            storage_objects.read_object("shared_files", "file-1")

    def test_corrupt_oversized_metadata_rejected_before_blob_allocation(self):
        self.store()
        with database.db_connection() as conn:
            conn.execute("PRAGMA ignore_check_constraints=ON")
            conn.execute("UPDATE storage_objects SET byte_length=?", (storage_objects.MAX_OBJECT_BYTES + 1,))
        with patch.object(storage_objects, "_read_ciphertext") as read:
            with self.assertRaises(StorageIntegrityError):
                storage_objects.read_object("shared_files", "file-1")
            read.assert_not_called()

    def test_missing_key_and_wrong_key_fail_closed(self):
        self.store()
        self.write_keys("new", {"new": b"n" * 32})
        with self.assertRaises(StorageUnavailable):
            storage_objects.read_object("shared_files", "file-1")
        self.write_keys("test", {"test": b"w" * 32})
        with self.assertRaises(StorageIntegrityError):
            storage_objects.read_object("shared_files", "file-1")

    def test_rotation_retains_old_objects_and_uses_active_key_for_new_objects(self):
        self.store()
        self.write_keys("new", {"test": b"k" * 32, "new": b"n" * 32})
        prepared = self.prepare("file-2")
        self.assertEqual(prepared.encryption_key_id, "new")
        self.store(prepared)
        self.assertEqual(storage_objects.read_object("shared_files", "file-1"), b"confidential upload")
        self.assertEqual(storage_objects.read_object("shared_files", "file-2"), b"confidential upload")

    def test_forged_prepared_lengths_versions_and_key_ids_are_rejected(self):
        prepared = self.prepare()
        mutations = [{"byte_length": storage_objects.MAX_OBJECT_BYTES + 1}, {"byte_length": True},
                     {"format_version": 2}, {"nonce": b"short"}, {"sha256": "invalid"},
                     {"encryption_key_id": "../../secret"}, {"payload": b"truncated"}]
        for changes in mutations:
            with self.subTest(changes=changes), self.assertRaises(StorageValidationError):
                with storage_objects.write_transaction() as conn:
                    storage_objects.put_object(conn, replace(prepared, **changes))

    def test_keyring_must_be_protected_and_never_auto_generated(self):
        self.keyring.chmod(0o644)
        with self.assertRaises(StorageUnavailable):
            self.prepare()
        self.keyring.unlink()
        with self.assertRaises(StorageUnavailable):
            self.prepare()
        self.assertFalse(self.keyring.exists())

    def test_malformed_keyring_and_key_sizes_are_rejected(self):
        documents = ["not-json", '{"active_key_id":"test","keys":{"test":"a"}}',
                     '{"active_key_id":"test","active_key_id":"other","keys":{}}']
        for document in documents:
            self.keyring.write_text(document)
            with self.subTest(document=document), self.assertRaises(StorageUnavailable):
                self.prepare()
        self.write_keys("test", {"test": b"x" * 16})
        with self.assertRaises(StorageUnavailable):
            self.prepare()

    def test_protected_app_group_can_read_keyring(self):
        self.keyring.chmod(0o640)
        self.assertEqual(storage_crypto.load_keyring()[0], "test")

    def test_keyring_symlink_is_rejected(self):
        target = self.keyring.with_name("linked-keys.json")
        target.symlink_to(self.keyring)
        self.app.config["NEST_UPLOAD_KEYRING_PATH"] = str(target)
        with self.assertRaises(StorageUnavailable):
            self.prepare()

    def test_metadata_query_does_not_select_blob(self):
        self.store()
        with database.db_connection() as conn:
            statements = []
            conn.set_trace_callback(statements.append)
            metadata = storage_objects.object_metadata("shared_files", "file-1", conn=conn)
        self.assertNotIn("payload", metadata)
        self.assertEqual(len(statements), 1)
        self.assertIn("length(payload)", statements[0])
        self.assertNotIn("SELECT *", statements[0])
        self.assertNotIn(", payload,", statements[0])

    def test_read_connection_is_closed_before_decryption(self):
        self.store()
        original_connect = database.connect
        connections = []

        def connect(path=None):
            connection = original_connect(path)
            connections.append(connection)
            return connection

        original_decrypt = storage_objects.decrypt_payload

        def decrypt(*args, **kwargs):
            with self.assertRaises(sqlite3.ProgrammingError):
                connections[-1].execute("SELECT 1")
            return original_decrypt(*args, **kwargs)

        with patch.object(database, "connect", side_effect=connect), patch.object(storage_objects, "decrypt_payload", side_effect=decrypt):
            self.assertEqual(storage_objects.read_object("shared_files", "file-1"), b"confidential upload")

    def test_concurrent_quota_recheck_serializes_feature_and_payload(self):
        prepared = [self.prepare("file-1", data=b"123456"), self.prepare("file-2", data=b"abcdef")]
        barrier = threading.Barrier(2)

        def upload(candidate):
            with self.app.app_context():
                barrier.wait(timeout=5)
                with storage_objects.write_transaction() as conn:
                    used = conn.execute("SELECT COALESCE(SUM(file_size_bytes),0) FROM shared_files WHERE user_id='owner'").fetchone()[0]
                    if used + candidate.byte_length > 10:
                        return "quota"
                    storage_objects.put_object(conn, candidate)
                    storage_rows.insert_row(conn, "shared_files", candidate.object_id, {
                        "user_id": "owner", "original_filename": candidate.original_filename,
                        "stored_path": candidate.object_id, "storage_backend": "sqlite",
                        "storage_file_id": candidate.object_id, "file_size_bytes": candidate.byte_length,
                        "created_at": candidate.created_at, "expires_at": "2099-01-01T00:00:00Z",
                    })
                    return "stored"

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(upload, prepared))
        self.assertCountEqual(results, ["stored", "quota"])
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_objects").fetchone()[0], 1)
            self.assertEqual(conn.execute("SELECT SUM(file_size_bytes) FROM shared_files").fetchone()[0], 6)

    def test_migration_is_additive_and_idempotent(self):
        database.init_db(app=self.app)
        with database.db_connection() as conn:
            self.assertIn("avatar_storage_backend", database.table_columns(conn, "users"))
            self.assertIn("storage_backend", database.table_columns(conn, "note_media"))
            self.assertIn("storage_backend", database.table_columns(conn, "chat_attachments"))
            defaults = {row["name"]: row["dflt_value"] for row in conn.execute("PRAGMA table_info(note_media)")}
            self.assertEqual(defaults["storage_backend"], "'appwrite'")
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM schema_migrations WHERE version='028_sqlite_upload_storage'").fetchone()[0], 1)

    def test_account_deletion_tombstone_survives_profile_removal_and_is_unique(self):
        with database.db_connection() as conn:
            conn.execute("INSERT INTO storage_account_deletions(user_id,deleted_at) VALUES (?,?)", ("deleted-owner", "2026-10-01T00:00:00Z"))
        database.init_db(app=self.app)
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_account_deletions WHERE user_id=?", ("deleted-owner",)).fetchone()[0], 1)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("INSERT INTO storage_account_deletions(user_id,deleted_at) VALUES (?,?)", ("deleted-owner", "2026-10-02T00:00:00Z"))

    def test_legacy_deletion_identity_is_durable_unique_and_namespace_scoped(self):
        values = ("note_media", "old-bucket", "old-file", "2026-10-01T00:00:00Z")
        insert = "INSERT INTO storage_legacy_deletions(namespace,bucket_id,object_id,created_at) VALUES (?,?,?,?)"
        with database.db_connection() as conn:
            conn.execute(insert, values)
        database.init_db(app=self.app)
        with database.db_connection() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_legacy_deletions").fetchone()[0], 1)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(insert, values)
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(insert, ("unknown", *values[1:]))
            conn.execute(insert, ("avatars", *values[1:]))
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM storage_legacy_deletions").fetchone()[0], 2)


class StorageBackendTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)

    def test_safe_compatibility_defaults_without_an_app_snapshot(self):
        with self.app.app_context(), patch.object(storage_backend, "load_environment_config", side_effect=AssertionError("unscoped environment read")):
            self.assertEqual(storage_backend.write_backend(), "appwrite")
            self.assertTrue(storage_backend.legacy_reads_enabled())
            self.assertTrue(storage_backend.chat_attachments_enabled())
            storage_backend.require_mutations_enabled()

    def test_app_snapshot_and_explicit_overrides(self):
        self.app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = EnvironmentConfig(
            flask_secret_key=None, flask_env="testing", appwrite_database_id="", allow_insecure_http=False,
            frontend_console_diagnostics_enabled=False, chat_attachments_enabled=False,
            upload_storage_settings={"NEST_STORAGE_BACKEND": "sqlite", "NEST_STORAGE_READ_LEGACY": "0"},
        )
        with self.app.app_context():
            self.assertEqual(storage_backend.write_backend(), "sqlite")
            self.assertFalse(storage_backend.legacy_reads_enabled())
            self.assertFalse(storage_backend.chat_attachments_enabled())
            with self.assertRaises(StorageUnavailable):
                storage_backend.require_legacy_reads()
            self.app.config.update(NEST_STORAGE_BACKEND="appwrite", NEST_STORAGE_READ_LEGACY=True, NEST_CHAT_ATTACHMENTS_ENABLED=True)
            self.assertEqual(storage_backend.write_backend(), "appwrite")
            self.assertTrue(storage_backend.legacy_reads_enabled())
            self.assertTrue(storage_backend.chat_attachments_enabled())

    def test_invalid_configuration_fails_closed(self):
        with self.app.app_context():
            self.app.config["NEST_STORAGE_BACKEND"] = "typo"
            with self.assertRaises(StorageUnavailable):
                storage_backend.write_backend()
            self.app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = "typo"
            with self.assertRaises(StorageUnavailable):
                storage_backend.require_mutations_enabled()


if __name__ == "__main__":
    unittest.main()
