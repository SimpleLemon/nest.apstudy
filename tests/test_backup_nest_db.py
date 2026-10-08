import os
import base64
import json
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scripts import backup_nest_db
from scripts.storage_backup import BackupVerificationError, verify_backup
from services import database, storage_objects


class BackupNestDbTestCase(unittest.TestCase):
    def test_backup_database_rejects_foreign_key_violations(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source.sqlite3"
            destination = Path(temp_dir) / "backup" / "source.sqlite3"
            with closing(sqlite3.connect(source)) as connection:
                connection.execute("CREATE TABLE parents (id INTEGER PRIMARY KEY)")
                connection.execute(
                    "CREATE TABLE children ("
                    "id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))"
                )
                connection.execute("INSERT INTO children (parent_id) VALUES (999)")
                connection.commit()

            ok, message = backup_nest_db._backup_database(source, destination)

            self.assertFalse(ok)
            self.assertIn("foreign_key_check failed", message)
            self.assertFalse(destination.exists())

    def test_run_backup_creates_snapshot_and_notifies_discord(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            instance_dir.mkdir()

            db_path = instance_dir / "nest.sqlite3"
            with closing(sqlite3.connect(instance_dir / "calendar.sqlite3")) as calendar:
                calendar.execute("CREATE TABLE events (id INTEGER PRIMARY KEY)")
                calendar.commit()
            connection = sqlite3.connect(db_path)
            try:
                connection.execute("PRAGMA journal_mode = WAL")
                connection.execute("PRAGMA wal_autocheckpoint = 0")
                connection.execute("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)")
                connection.execute("INSERT INTO notes (title) VALUES ('hello')")
                connection.commit()

                with patch.object(backup_nest_db, "send_audit_event_sync", return_value=True) as notify:
                    exit_code = backup_nest_db.run_backup(
                        instance_dir=instance_dir,
                        backup_dir=backup_dir,
                        max_backups=3,
                        notify_discord=True,
                    )
            finally:
                connection.close()

            self.assertEqual(exit_code, 0)
            backup_sets = list(backup_dir.glob("backup_*"))
            self.assertEqual(len(backup_sets), 1)
            copied = backup_sets[0] / "nest.sqlite3"
            self.assertTrue(copied.is_file())
            self.assertFalse((backup_sets[0] / "nest.sqlite3-wal").exists())
            self.assertFalse((backup_sets[0] / "nest.sqlite3-shm").exists())
            with closing(sqlite3.connect(f"file:{copied}?mode=ro", uri=True)) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                row = connection.execute("SELECT title FROM notes").fetchone()
            self.assertEqual(row[0], "hello")

            restored = Path(temp_dir) / "restore" / "nest.sqlite3"
            restored.parent.mkdir()
            shutil.copy2(copied, restored)
            with closing(sqlite3.connect(f"file:{restored}?mode=ro", uri=True)) as restored_connection:
                self.assertEqual(restored_connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(
                    restored_connection.execute("SELECT title FROM notes").fetchone()[0],
                    "hello",
                )
            notify.assert_called_once()
            event = notify.call_args.args[0]
            self.assertEqual(event.channel, "server_logs")
            self.assertEqual(event.title, "Database Backup Created With Optional Data Skipped")

    def test_initialized_database_backup_restores_and_reinitializes_without_data_loss(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            source = instance_dir / "nest.sqlite3"
            database.init_db(path=source)
            with closing(sqlite3.connect(instance_dir / "calendar.sqlite3")) as calendar:
                calendar.execute("CREATE TABLE events (id INTEGER PRIMARY KEY)")
                calendar.commit()

            with database.db_connection(source) as connection:
                connection.execute(
                    "INSERT INTO users (id, google_id, email, username, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    ("user-1", "google-1", "restore@example.com", "restore", "2026-01-01Z"),
                )
                connection.execute(
                    "INSERT INTO notes (id, user_id, title, content, preview_text, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("note-1", "user-1", "Restore me", "body", "body", "2026-01-02Z"),
                )

            exit_code = backup_nest_db.run_backup(
                instance_dir=instance_dir,
                backup_dir=backup_dir,
                max_backups=3,
                notify_discord=False,
            )
            self.assertEqual(exit_code, 0)

            backup = next(backup_dir.glob("backup_*")) / "nest.sqlite3"
            restored = Path(temp_dir) / "restore" / "nest.sqlite3"
            restored.parent.mkdir()
            shutil.copy2(backup, restored)

            database.init_db(path=restored)
            database.init_db(path=restored)
            with database.db_connection(restored) as connection:
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
                self.assertEqual(
                    tuple(connection.execute(
                        "SELECT id, user_id, title, content, preview_text FROM notes"
                    ).fetchone()),
                    ("note-1", "user-1", "Restore me", "body", "body"),
                )
                versions = {
                    row[0] for row in connection.execute("SELECT version FROM schema_migrations")
                }
                self.assertEqual(
                    versions,
                    {filename[:-4] for filename in database._migration_filenames()},
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    connection.execute(
                        "INSERT INTO users (id, google_id, email, username, created_at) "
                        "VALUES (?, ?, ?, ?, ?)",
                        ("user-2", "google-1", "other@example.com", "other", "2026-01-03Z"),
                    )

    def test_run_backup_includes_apswiftly_database(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            apswiftly_dir = instance_dir / "apswiftly"
            (apswiftly_dir / "main").mkdir(parents=True)
            (apswiftly_dir / "main" / "main_scheme_1.sql").write_text("sample", encoding="utf-8")

            for relative_path in ("nest.sqlite3", "calendar.sqlite3"):
                db_path = instance_dir / relative_path
                db_path.parent.mkdir(parents=True, exist_ok=True)
                with closing(sqlite3.connect(db_path)) as connection:
                    connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)")
                    connection.commit()

            with patch.object(backup_nest_db, "send_audit_event_sync", return_value=True) as notify:
                exit_code = backup_nest_db.run_backup(
                    instance_dir=instance_dir,
                    backup_dir=backup_dir,
                    max_backups=3,
                    notify_discord=True,
                )

            self.assertEqual(exit_code, 0)
            backup_set = next(backup_dir.glob("backup_*"))
            for relative_path in ("nest.sqlite3", "calendar.sqlite3"):
                self.assertTrue((backup_set / relative_path).is_file())
            self.assertTrue((backup_set / "apswiftly" / "main" / "main_scheme_1.sql").is_file())
            event = notify.call_args.args[0]
            self.assertIn("apswiftly", event.metadata["databases"])
            self.assertEqual(event.metadata["apswiftly_included"], "yes")
            self.assertEqual(event.metadata["skipped"], "none")

    def test_run_backup_reports_missing_apswiftly_in_discord_metadata(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"

            for relative_path in ("nest.sqlite3", "calendar.sqlite3"):
                db_path = instance_dir / relative_path
                db_path.parent.mkdir(parents=True, exist_ok=True)
                with closing(sqlite3.connect(db_path)) as connection:
                    connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)")
                    connection.commit()

            with patch.object(backup_nest_db, "send_audit_event_sync", return_value=True) as notify:
                exit_code = backup_nest_db.run_backup(
                    instance_dir=instance_dir,
                    backup_dir=backup_dir,
                    max_backups=3,
                    notify_discord=True,
                )

            self.assertEqual(exit_code, 0)
            event = notify.call_args.args[0]
            self.assertEqual(event.metadata["apswiftly_included"], "no")
            self.assertIn("apswiftly", event.metadata["skipped"])

    def test_run_backup_reports_missing_database(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            instance_dir.mkdir()

            with patch.object(backup_nest_db, "send_audit_event_sync", return_value=True) as notify:
                exit_code = backup_nest_db.run_backup(
                    instance_dir=instance_dir,
                    backup_dir=backup_dir,
                    max_backups=3,
                    notify_discord=True,
                )

            self.assertEqual(exit_code, 1)
            notify.assert_called_once()
            self.assertEqual(notify.call_args.args[0].title, "Database Backup Failed")
            self.assertEqual(list(backup_dir.glob("backup_*")), [])
            self.assertEqual(list(backup_dir.glob("*.incomplete")), [])

    def test_preserve_history_diagnostic_never_rotates_existing_sets(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir, backup_dir = Path(temp_dir) / "instance", Path(temp_dir) / "backups"
            instance_dir.mkdir()
            backup_dir.mkdir()
            for index in range(3):
                (backup_dir / f"backup_2000-01-0{index + 1}_00-00-00").mkdir()
            for name in ("nest.sqlite3", "calendar.sqlite3"):
                with closing(sqlite3.connect(instance_dir / name)) as conn:
                    conn.execute("CREATE TABLE sample(id INTEGER PRIMARY KEY)")
                    conn.commit()
            with patch.object(backup_nest_db, "send_audit_event_sync") as notify:
                code = backup_nest_db.run_backup(instance_dir=instance_dir, backup_dir=backup_dir,
                                                 max_backups=1, notify_discord=False, preserve_history=True)
            self.assertEqual(code, 0)
            self.assertEqual(len(list(backup_dir.glob("backup_*"))), 4)
            notify.assert_not_called()


class EncryptedUploadBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.instance = self.directory / "instance"
        self.backups = self.directory / "backups"
        self.keyring = self.directory / "protected" / "keys.json"
        self.keyring.parent.mkdir(mode=0o700)
        self.keyring.write_text(json.dumps({"active_key_id": "backup-test", "keys": {
            "backup-test": base64.b64encode(b"k" * 32).decode("ascii")}}))
        self.keyring.chmod(0o600)
        environment = patch.dict(os.environ, {"NEST_UPLOAD_KEYRING_PATH": str(self.keyring),
                                              "NEST_STORAGE_MUTATIONS_PAUSED": "false"})
        environment.start()
        self.addCleanup(environment.stop)
        scanner = patch.object(storage_objects, "scan_upload")
        scanner.start()
        self.addCleanup(scanner.stop)
        database.init_db(path=self.instance / "nest.sqlite3")
        with closing(sqlite3.connect(self.instance / "calendar.sqlite3")) as conn:
            conn.execute("CREATE TABLE events(id INTEGER PRIMARY KEY)")
            conn.commit()
        for namespace in ("avatars", "shared_files", "note_media", "chat_attachments"):
            prepared = storage_objects.prepare_object(namespace, "fixture", (namespace + " local fixture").encode(),
                                                       filename="fixture.bin", mime_type="application/octet-stream")
            with storage_objects.write_transaction(path=self.instance / "nest.sqlite3") as conn:
                storage_objects.put_object(conn, prepared)

    def backup(self):
        return backup_nest_db.run_backup(instance_dir=self.instance, backup_dir=self.backups,
                                         max_backups=1, notify_discord=False, storage_keyring=self.keyring)

    def test_restore_authenticates_all_uploads_with_independently_recovered_keyring(self):
        self.assertEqual(self.backup(), 0)
        backup_set = next(self.backups.glob("backup_*"))
        recovered = self.directory / "recovered-keyring.json"
        shutil.copy2(self.keyring, recovered)
        self.keyring.unlink()
        restored = self.directory / "restored"
        result = verify_backup(backup_set, keyring_path=recovered, restore_dir=restored)
        self.assertEqual(result["objects"], 4)
        self.assertEqual(result["databases"], 2)
        self.assertEqual(set(result["namespaces"]), {"avatars", "shared_files", "note_media", "chat_attachments"})
        self.assertEqual(sorted(path.name for path in backup_set.iterdir()), ["calendar.sqlite3", "nest.sqlite3"])
        self.assertNotIn(base64.b64encode(b"k" * 32), (backup_set / "nest.sqlite3").read_bytes())
        self.assertEqual(backup_set.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup_set / "nest.sqlite3").stat().st_mode & 0o777, 0o600)

    def test_live_sqlite_avatar_reference_must_resolve_in_the_restore(self):
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("INSERT INTO users(id,google_id,email,username,created_at,avatar_file_id,avatar_storage_backend) "
                         "VALUES ('u','google','restore@test.invalid','restore','now','missing','sqlite')")
        self.assertEqual(self.backup(), 1)
        self.assertEqual(list(self.backups.glob("backup_*")), [])

    def test_historical_canonical_avatar_reference_is_verified(self):
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("INSERT INTO chat_messages(id,user_id,channel_id,content,created_at,author_avatar_url) "
                         "VALUES ('m','u','test','body','now','/api/avatars/missing')")
        self.assertEqual(self.backup(), 1)

    def test_legacy_url_only_and_historical_avatars_are_counted_for_cutover(self):
        source_url = "https://source.test/v1/storage/buckets/profile_avatars/files/legacy/view?project=source"
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("INSERT INTO users(id,google_id,email,username,created_at,picture_url) "
                         "VALUES ('u','google','legacy@test.invalid','legacy','now',?)", (source_url,))
            conn.execute("INSERT INTO chat_messages(id,user_id,channel_id,content,created_at,author_avatar_url) "
                         "VALUES ('m','u','test','body','now',?)", (source_url,))
            conn.execute("INSERT INTO storage_migration_manifest(source_endpoint,source_project_id,source_bucket_id,"
                         "source_file_id,namespace,object_id,status,created_at,updated_at) "
                         "VALUES ('https://source.test/v1','source','profile_avatars','legacy','avatars','legacy',"
                         "'pending','now','now')")
        self.assertEqual(self.backup(), 0)
        result = verify_backup(next(self.backups.glob("backup_*")), keyring_path=self.keyring)
        self.assertEqual(result["coverage"]["legacy_references"], 2)

    def test_restore_checks_manifest_hashes_but_preserves_retired_source_history(self):
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("INSERT INTO storage_migration_manifest(source_bucket_id,source_file_id,namespace,object_id,"
                         "byte_length,sha256,status,created_at,updated_at) "
                         "SELECT namespace,object_id,namespace,object_id,byte_length,sha256,'promoted','now','now' FROM storage_objects")
        self.assertEqual(self.backup(), 0)
        backup_set = next(self.backups.glob("backup_*"))
        result = verify_backup(backup_set, keyring_path=self.keyring)
        self.assertEqual(result["coverage"]["manifest_hashes_verified"], 4)
        with storage_objects.write_transaction(path=backup_set / "nest.sqlite3") as conn:
            storage_objects.delete_object(conn, "avatars", "fixture")
        result = verify_backup(backup_set, keyring_path=self.keyring)
        self.assertEqual(result["coverage"]["manifest_hashes_verified"], 3)
        self.assertEqual(result["coverage"]["retired_manifest_objects"], 1)
        with closing(sqlite3.connect(backup_set / "nest.sqlite3")) as conn:
            conn.execute("UPDATE storage_migration_manifest SET sha256=? WHERE namespace='shared_files'", ("0" * 64,))
            conn.commit()
        with self.assertRaises(BackupVerificationError):
            verify_backup(backup_set, keyring_path=self.keyring)

    def test_missing_promoted_orphan_without_removal_receipt_fails_restore(self):
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("INSERT INTO storage_migration_manifest(source_bucket_id,source_file_id,namespace,object_id,"
                         "byte_length,sha256,status,created_at,updated_at) "
                         "SELECT namespace,object_id,namespace,object_id,byte_length,sha256,'promoted','now','now' FROM storage_objects")
        self.assertEqual(self.backup(), 0)
        backup_set = next(self.backups.glob("backup_*"))
        with closing(sqlite3.connect(backup_set / "nest.sqlite3")) as conn:
            conn.execute("DELETE FROM storage_objects WHERE namespace='avatars'")
            conn.commit()
        with self.assertRaises(BackupVerificationError):
            verify_backup(backup_set, keyring_path=self.keyring)

    def test_retained_avatar_ownership_requires_payload_and_matching_size(self):
        for object_id, size in (("missing", 1), ("fixture", 1)):
            with self.subTest(object_id=object_id):
                with database.db_connection(self.instance / "nest.sqlite3") as conn:
                    conn.execute("DELETE FROM storage_avatar_ownership")
                    conn.execute("INSERT INTO storage_avatar_ownership VALUES (?,'owner',?,'sqlite')", (object_id, size))
                self.assertEqual(self.backup(), 1)
                self.assertEqual(list(self.backups.glob("backup_*")), [])

    def test_pending_uncopied_manifest_is_reported_without_claiming_recovery(self):
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("INSERT INTO storage_migration_manifest(source_bucket_id,source_file_id,namespace,object_id,"
                         "status,created_at,updated_at) VALUES ('avatars','pending','avatars','pending','pending','now','now')")
        self.assertEqual(self.backup(), 0)
        result = verify_backup(next(self.backups.glob("backup_*")), keyring_path=self.keyring)
        self.assertEqual(result["coverage"]["unrecovered_manifest_objects"], 1)

    def test_wrong_recovered_key_fails_without_modifying_the_backup(self):
        self.assertEqual(self.backup(), 0)
        backup_set = next(self.backups.glob("backup_*"))
        original = (backup_set / "nest.sqlite3").read_bytes()
        wrong = self.directory / "wrong.json"
        wrong.write_text(json.dumps({"active_key_id": "backup-test", "keys": {
            "backup-test": base64.b64encode(b"w" * 32).decode("ascii")}}))
        wrong.chmod(0o600)
        with self.assertRaises(BackupVerificationError):
            verify_backup(backup_set, keyring_path=wrong)
        self.assertEqual(original, (backup_set / "nest.sqlite3").read_bytes())

    def test_payload_corruption_prevents_publication_and_preserves_history(self):
        self.backups.mkdir()
        existing = self.backups / "backup_2000-01-01_00-00-00"
        existing.mkdir()
        with database.db_connection(self.instance / "nest.sqlite3") as conn:
            conn.execute("UPDATE storage_objects SET payload=zeroblob(length(payload))")
        self.assertEqual(self.backup(), 1)
        self.assertEqual(list(self.backups.glob("backup_*")), [existing])
        self.assertEqual(list(self.backups.glob("*.incomplete")), [])

    def test_upload_keys_inside_backed_up_directory_are_rejected(self):
        apswiftly = self.instance / "apswiftly"
        apswiftly.mkdir()
        keys_inside_data = apswiftly / "keys.json"
        shutil.copy2(self.keyring, keys_inside_data)
        code = backup_nest_db.run_backup(instance_dir=self.instance, backup_dir=self.backups,
                                         max_backups=1, notify_discord=False, storage_keyring=keys_inside_data)
        self.assertEqual(code, 1)
        self.assertEqual(list(self.backups.glob("backup_*")), [])

    def test_keyring_symlink_or_hardlink_cannot_leak_into_optional_backup(self):
        apswiftly = self.instance / "apswiftly"
        apswiftly.mkdir()
        link = apswiftly / "linked-keyring.json"
        for kind in ("symlink", "hardlink"):
            with self.subTest(kind=kind):
                if kind == "symlink":
                    link.symlink_to(self.keyring)
                else:
                    os.link(self.keyring, link)
                self.assertEqual(self.backup(), 1)
                self.assertEqual(list(self.backups.glob("backup_*")), [])
                link.unlink()

    def test_verifier_rejects_keyring_bundled_inside_database_snapshot(self):
        self.assertEqual(self.backup(), 0)
        backup_set = next(self.backups.glob("backup_*"))
        bundled = backup_set / "keys.json"
        shutil.copy2(self.keyring, bundled)
        with self.assertRaises(BackupVerificationError):
            verify_backup(backup_set, keyring_path=bundled)

    def test_partial_backup_does_not_rotate_known_good_backups(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            instance_dir.mkdir()
            backup_dir.mkdir()
            existing = [backup_dir / f"backup_2026-01-0{day}_00-00-00" for day in range(1, 4)]
            for backup_set in existing:
                backup_set.mkdir()

            with closing(sqlite3.connect(instance_dir / "nest.sqlite3")) as connection:
                connection.execute("CREATE TABLE sample (id INTEGER PRIMARY KEY)")
                connection.commit()

            exit_code = backup_nest_db.run_backup(
                instance_dir=instance_dir,
                backup_dir=backup_dir,
                max_backups=3,
                notify_discord=False,
            )

            self.assertEqual(exit_code, 1)
            self.assertEqual(sorted(backup_dir.glob("backup_*")), existing)
            self.assertEqual(list(backup_dir.glob("*.incomplete")), [])


if __name__ == "__main__":
    unittest.main()
