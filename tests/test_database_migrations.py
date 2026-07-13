import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services import database


class DatabaseMigrationSafetyTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "nest-test.sqlite3"

    def tearDown(self):
        self.temp_dir.cleanup()

    def _expected_versions(self):
        return {filename[:-4] for filename in database._migration_filenames()}

    def _assert_database_healthy(self):
        with database.db_connection(self.db_path) as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])

    def test_clean_database_initializes_and_reinitializes_without_schema_changes(self):
        database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            versions_before = dict(
                connection.execute(
                    "SELECT version, applied_at FROM schema_migrations ORDER BY version"
                ).fetchall()
            )
            schema_before = connection.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master "
                "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
            ).fetchall()
            user_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(users)").fetchall()
            }
            note_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(notes)").fetchall()
            }

        self.assertEqual(set(versions_before), self._expected_versions())
        self.assertIn("discord_id", user_columns)
        self.assertIn("preview_text", note_columns)
        self.assertIn("004_notes_media", versions_before)
        self.assertIn("tier", user_columns)
        self.assertIn("avatar_file_size_bytes", user_columns)
        with database.db_connection(self.db_path) as connection:
            note_media_exists = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'note_media'"
            ).fetchone()
        self.assertIsNotNone(note_media_exists)

        with database.db_connection(self.db_path) as connection:
            connection.execute(
                "INSERT INTO users (id, google_id, email, username, created_at) VALUES (?, ?, ?, ?, ?)",
                ("new-user", "google-new", "new@example.com", "new-user", "2026-01-01Z"),
            )
            new_user = connection.execute(
                "SELECT tier, avatar_file_size_bytes FROM users WHERE id = ?",
                ("new-user",),
            ).fetchone()
        self.assertEqual(tuple(new_user), ("free", 0))

        database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            versions_after = dict(
                connection.execute(
                    "SELECT version, applied_at FROM schema_migrations ORDER BY version"
                ).fetchall()
            )
            schema_after = connection.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master "
                "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
            ).fetchall()

        self.assertEqual(versions_after, versions_before)
        self.assertEqual(schema_after, schema_before)
        self._assert_database_healthy()

    def test_representative_baseline_schema_migrates_without_losing_seeded_data(self):
        baseline_path = Path(database.migrations_path()) / database.BASELINE_MIGRATION
        legacy_content = '[{"type":"paragraph","content":[{"text":"Legacy note body"}]}]'
        with database.db_connection(self.db_path) as connection:
            connection.executescript(baseline_path.read_text(encoding="utf-8"))
            connection.execute(
                "INSERT INTO users (id, google_id, email, name, username, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("user-1", "google-1", "legacy@example.com", "Legacy User", "legacy", "2026-01-01Z"),
            )
            connection.execute(
                "INSERT INTO notes (id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)",
                ("note-1", "user-1", "Kept note", legacy_content, "2026-01-02Z"),
            )
            connection.execute(
                "INSERT INTO notes (id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)",
                ("note-empty", "user-1", "Empty note", "", "2026-01-02Z"),
            )
            connection.execute(
                "INSERT INTO chat_messages (id, external_id, content, created_at) VALUES (?, ?, ?, ?)",
                ("message-1", "external-1", "Kept message", "2026-01-03Z"),
            )
            connection.execute(
                "INSERT INTO tasks (id, user_id, list_id, title, deadline_at, deadline_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("task-timed", "user-1", "list-1", "Timed", "2026-02-01T12:00:00Z", "12:00", "2026-01-03Z"),
            )
            connection.execute(
                "INSERT INTO tasks (id, user_id, list_id, title, deadline_at, deadline_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("task-date", "user-1", "list-1", "Date only", "2026-02-02T00:00:00Z", None, "2026-01-03Z"),
            )
            connection.commit()

        database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            user = connection.execute(
                "SELECT id, google_id, email, name, username, discord_id FROM users"
            ).fetchone()
            note = connection.execute(
                "SELECT id, user_id, title, content, preview_text FROM notes WHERE id = 'note-1'"
            ).fetchone()
            empty_note = connection.execute(
                "SELECT id, content, preview_text FROM notes WHERE id = 'note-empty'"
            ).fetchone()
            message = connection.execute(
                "SELECT id, external_id, content FROM chat_messages"
            ).fetchone()
            versions = {
                row[0] for row in connection.execute("SELECT version FROM schema_migrations")
            }
            task_reminders = dict(connection.execute("SELECT id, reminder_minutes FROM tasks").fetchall())

        self.assertEqual(tuple(user), ("user-1", "google-1", "legacy@example.com", "Legacy User", "legacy", None))
        self.assertEqual(tuple(note[:4]), ("note-1", "user-1", "Kept note", legacy_content))
        self.assertEqual(note[4], "Legacy note body")
        self.assertEqual(tuple(empty_note), ("note-empty", "", "Blank note"))
        self.assertEqual(tuple(message), ("message-1", "external-1", "Kept message"))
        self.assertEqual(versions, self._expected_versions())
        self.assertEqual(task_reminders, {"task-timed": 10, "task-date": -1})
        self._assert_database_healthy()

    def test_current_unique_indexes_reject_duplicate_identity_course_and_external_ids(self):
        database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            connection.execute(
                "INSERT INTO users (id, google_id, email, username, created_at) VALUES (?, ?, ?, ?, ?)",
                ("user-1", "google-1", "one@example.com", "one", "2026-01-01Z"),
            )
            connection.execute(
                "INSERT INTO chat_messages (id, external_id, created_at) VALUES (?, ?, ?)",
                ("message-1", "external-1", "2026-01-01Z"),
            )
            connection.execute(
                "INSERT INTO user_courses "
                "(id, user_id, term, subject, catalog, crn, added_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("course-1", "user-1", "Fall_2026", "CS", "170", "12345", "2026-01-01Z"),
            )
            connection.commit()

            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO users (id, google_id, email, username, created_at) VALUES (?, ?, ?, ?, ?)",
                    ("user-2", "google-1", "two@example.com", "two", "2026-01-01Z"),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO chat_messages (id, external_id, created_at) VALUES (?, ?, ?)",
                    ("message-2", "external-1", "2026-01-01Z"),
                )
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO user_courses "
                    "(id, user_id, term, subject, catalog, crn, added_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    ("course-2", "user-1", "Fall_2026", "CS", "170", "12345", "2026-01-02Z"),
                )

        self._assert_database_healthy()

    def test_external_id_migration_reconciles_legacy_duplicate_messages(self):
        baseline_path = Path(database.migrations_path()) / database.BASELINE_MIGRATION
        with database.db_connection(self.db_path) as connection:
            connection.executescript(baseline_path.read_text(encoding="utf-8"))
            connection.execute(
                "INSERT INTO chat_messages "
                "(id, source, external_id, content, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("message-old", "discord", "discord:channel:message", "old", "2026-01-01Z", "2026-01-02Z"),
            )
            connection.execute(
                "INSERT INTO chat_messages "
                "(id, source, external_id, content, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("message-new", "discord", "discord:channel:message", "new", "2026-01-01Z", "2026-02-01Z"),
            )
            connection.execute(
                "INSERT INTO chat_events (id, scope_type, scope_id, event_type, message_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("event-1", "channel", "channel", "message", "message-old", "2026-01-03Z"),
            )
            connection.execute(
                "INSERT INTO chat_read_states "
                "(id, user_id, scope_type, scope_id, read_key, last_read_message_id) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("read-1", "user-1", "channel", "channel", "user-1:channel", "message-old"),
            )
            connection.commit()

        database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            messages = connection.execute(
                "SELECT id, content FROM chat_messages WHERE external_id = ?",
                ["discord:channel:message"],
            ).fetchall()
            event_message_id = connection.execute(
                "SELECT message_id FROM chat_events WHERE id = 'event-1'"
            ).fetchone()[0]
            read_message_id = connection.execute(
                "SELECT last_read_message_id FROM chat_read_states WHERE id = 'read-1'"
            ).fetchone()[0]

        self.assertEqual([tuple(row) for row in messages], [("message-new", "new")])
        self.assertEqual(event_message_id, "message-new")
        self.assertEqual(read_message_id, "message-new")
        self._assert_database_healthy()

    def test_failed_migration_rolls_back_ddl_and_is_not_recorded(self):
        migrations_dir = Path(self.temp_dir.name) / "broken-migrations"
        migrations_dir.mkdir()
        (migrations_dir / "999_broken.sql").write_text(
            "CREATE TABLE should_roll_back (id TEXT PRIMARY KEY);\n"
            "INSERT INTO missing_table (id) VALUES ('boom');\n",
            encoding="utf-8",
        )

        with patch.object(database, "migrations_path", return_value=str(migrations_dir)):
            with self.assertRaises(sqlite3.OperationalError):
                database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            partial_table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'should_roll_back'"
            ).fetchone()
            marker = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = '999_broken'"
            ).fetchone()
            self.assertIsNone(partial_table)
            self.assertIsNone(marker)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_migration_transaction_control_is_rejected_before_any_ddl_runs(self):
        migrations_dir = Path(self.temp_dir.name) / "transaction-migrations"
        migrations_dir.mkdir()
        (migrations_dir / "999_forbidden_commit.sql").write_text(
            "CREATE TABLE must_not_commit (id TEXT PRIMARY KEY);\n"
            "COMMIT;\n",
            encoding="utf-8",
        )

        with patch.object(database, "migrations_path", return_value=str(migrations_dir)):
            with self.assertRaisesRegex(sqlite3.OperationalError, "forbidden transaction statement COMMIT"):
                database.init_db(path=self.db_path)

        with database.db_connection(self.db_path) as connection:
            partial_table = connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'must_not_commit'"
            ).fetchone()
            marker = connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = '999_forbidden_commit'"
            ).fetchone()
            self.assertIsNone(partial_table)
            self.assertIsNone(marker)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")


if __name__ == "__main__":
    unittest.main()
