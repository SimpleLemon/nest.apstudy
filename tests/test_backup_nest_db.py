import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import backup_nest_db


class BackupNestDbTestCase(unittest.TestCase):
    def test_run_backup_creates_snapshot_and_notifies_discord(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            instance_dir.mkdir()

            db_path = instance_dir / "nest.sqlite3"
            with sqlite3.connect(db_path) as connection:
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

            self.assertEqual(exit_code, 0)
            backup_sets = list(backup_dir.glob("backup_*"))
            self.assertEqual(len(backup_sets), 1)
            copied = backup_sets[0] / "nest.sqlite3"
            self.assertTrue(copied.is_file())
            with sqlite3.connect(copied) as connection:
                row = connection.execute("SELECT title FROM notes").fetchone()
            self.assertEqual(row[0], "hello")
            notify.assert_called_once()
            event = notify.call_args.args[0]
            self.assertEqual(event.channel, "server_logs")
            self.assertEqual(event.title, "Database Backup Created")

    def test_run_backup_includes_apswiftly_database(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            instance_dir = Path(temp_dir) / "instance"
            backup_dir = Path(temp_dir) / "backups"
            apswiftly_dir = instance_dir / "apswiftly"
            apswiftly_dir.mkdir(parents=True)

            for relative_path in ("nest.sqlite3", "calendar.sqlite3", "apswiftly/aoi.db"):
                db_path = instance_dir / relative_path
                db_path.parent.mkdir(parents=True, exist_ok=True)
                with sqlite3.connect(db_path) as connection:
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
            for relative_path in ("nest.sqlite3", "calendar.sqlite3", "apswiftly/aoi.db"):
                self.assertTrue((backup_set / relative_path).is_file())
            event = notify.call_args.args[0]
            self.assertIn("apswiftly/aoi.db", event.metadata["databases"])

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
