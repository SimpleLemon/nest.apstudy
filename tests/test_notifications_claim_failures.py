"""Unexpected reminder claim failures stay observable and retryable."""

from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from flask import Flask

from services import database, notifications


class NotificationClaimFailureTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = str(Path(directory.name) / "notifications.sqlite3")
        self.app = Flask(__name__)
        self.app.config["DATABASE_PATH"] = self.path
        database.init_db(self.app, self.path)
        self.context = self.app.app_context()
        self.context.push()
        self.addCleanup(self.context.pop)
        self.now = datetime(2026, 7, 11, 12, 0, tzinfo=timezone.utc)
        with database.db_connection() as conn:
            conn.execute("INSERT INTO user_settings (id,user_id,created_at,timezone) VALUES ('s1','u1','2026-01-01T00:00:00Z','UTC')")
            conn.execute("INSERT INTO user_events (id,user_id,title,start,end,is_all_day,created_at) VALUES ('e1','u1','Exam','2026-07-11T12:10:00Z','2026-07-11T13:00:00Z',0,'2026-01-01T00:00:00Z')")

    def test_storage_claim_failure_is_logged_and_retry_can_deliver(self):
        with database.db_connection() as conn:
            conn.execute("CREATE TRIGGER reject_reminder_claim BEFORE INSERT ON calendar_reminder_claims BEGIN SELECT RAISE(ABORT, 'claim storage unavailable'); END")
        with patch.object(notifications, "notify", return_value=("n1", {"accepted": 1, "failed": 0})) as notify:
            with self.assertLogs(notifications.logger, level="ERROR") as logs:
                self.assertEqual(notifications.check_calendar_reminders(self.now), 0)
            self.assertIn("Calendar reminder claim failed", logs.output[0])
            self.assertIn("claim storage unavailable", logs.output[0])
            notify.assert_not_called()
            with database.db_connection() as conn:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM calendar_reminder_claims").fetchone()[0], 0)
                conn.execute("DROP TRIGGER reject_reminder_claim")
            self.assertEqual(notifications.check_calendar_reminders(self.now), 1)
            notify.assert_called_once()

    def test_duplicate_claim_stays_silent_and_prevents_duplicate_delivery(self):
        with patch.object(notifications, "notify", return_value=("n1", {"accepted": 1, "failed": 0})) as notify, \
                patch.object(notifications.logger, "exception") as log_error:
            self.assertEqual(notifications.check_calendar_reminders(self.now), 1)
            self.assertEqual(notifications.check_calendar_reminders(self.now), 0)
        notify.assert_called_once()
        log_error.assert_not_called()

    def test_missing_claim_storage_is_logged_and_retried_on_the_next_check(self):
        with database.db_connection() as conn:
            conn.execute("ALTER TABLE calendar_reminder_claims RENAME TO unavailable_claims")
        with patch.object(notifications, "notify", return_value=("n1", {"accepted": 1, "failed": 0})) as notify:
            with self.assertLogs(notifications.logger, level="ERROR") as logs:
                self.assertEqual(notifications.check_calendar_reminders(self.now), 0)
            self.assertIn("Calendar reminder claim failed", logs.output[0])
            self.assertIn("OperationalError", logs.output[0])
            notify.assert_not_called()
            with database.db_connection() as conn:
                conn.execute("ALTER TABLE unavailable_claims RENAME TO calendar_reminder_claims")
            self.assertEqual(notifications.check_calendar_reminders(self.now), 1)
            notify.assert_called_once()


if __name__ == "__main__":
    unittest.main()
