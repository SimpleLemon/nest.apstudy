import os
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from scripts import backup_nest_db
from services import database


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
            self.assertEqual(event.title, "Database Backup Created")

    def test_initialized_database_backup_restores_and_reinitializes_without_data_loss(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            source = instance_dir / "nest.sqlite3"
            database.init_db(path=source)

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


if __name__ == "__main__":
    unittest.main()
