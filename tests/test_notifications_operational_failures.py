"""Notification delivery must not treat unavailable SQLite state as a default."""

import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from services import focus_mode, notifications
from blueprints import notifications_api
from tests.test_notifications import notification_app


class NotificationOperationalFailureTests(unittest.TestCase):
    def setUp(self):
        self.app, self.path = notification_app()
        self.addCleanup(Path(self.path).unlink, missing_ok=True)
        context = self.app.app_context()
        context.push()
        self.addCleanup(context.pop)

    def test_known_unmigrated_tables_retain_compatibility_defaults(self):
        for table in ("notification_preferences", "notification_web_presence", "focus_sessions"):
            with notifications.db_connection() as conn:
                conn.execute(f"DROP TABLE {table}")
        self.assertEqual(notifications.preferences("u1"), notifications.DEFAULT_PREFERENCES)
        self.assertFalse(notifications.has_active_web_session("u1"))
        self.assertFalse(notifications.notification_focus_active("u1"))
        self.assertTrue(notifications.focus_delivery_enabled("u1", "chat_dm"))
    def test_active_sync_allows_only_absent_preference_table(self):
        with notifications.db_connection() as conn:
            conn.execute("DROP TABLE notification_preferences")
        state = notifications.sync_foreground_state(
            "u1", "tab-1", active=True, device_class="desktop_tablet",
        )
        self.assertEqual(state["preferences"], notifications.DEFAULT_PREFERENCES)

    def test_state_reads_propagate_operational_errors_and_unrelated_tables(self):
        for message in ("database is locked", "disk I/O error", "unable to open database file",
                        "no such table: unrelated", "no such column: push_enabled"):
            with self.subTest(message=message):
                error = sqlite3.OperationalError(message)
                for read in (notifications.preferences, notifications.has_active_web_session):
                    with patch.object(notifications, "db_connection", side_effect=error):
                        with self.assertRaises(sqlite3.OperationalError) as raised:
                            read("u1")
                    self.assertIs(raised.exception, error)
                with patch.object(focus_mode, "reconcile_focus_mode_status", side_effect=error):
                    with self.assertRaises(sqlite3.OperationalError) as raised:
                        notifications.focus_delivery_enabled("u1", "chat_dm")
                self.assertIs(raised.exception, error)

    def test_active_sync_does_not_hide_failed_preference_read(self):
        original_connection = notifications.db_connection
        error = sqlite3.OperationalError("database is locked")

        @contextmanager
        def failing_preference_connection():
            with original_connection() as conn:
                class Connection:
                    def execute(self, sql, args):
                        if "SELECT * FROM notification_preferences" in sql:
                            raise error
                        return conn.execute(sql, args)
                yield Connection()

        with patch.object(notifications, "db_connection", failing_preference_connection):
            with self.assertRaises(sqlite3.OperationalError) as raised:
                notifications.sync_foreground_state(
                    "u1", "tab-1", active=True, device_class="desktop_tablet",
                )
        self.assertIs(raised.exception, error)

    def test_foreground_api_does_not_enable_delivery_when_focus_read_fails(self):
        user = type("User", (), {"id": "u1", "is_authenticated": True})()
        result = {"active": True, "preferences": dict(notifications.DEFAULT_PREFERENCES),
                  "notifications": [{"category": "chat_dm"}]}
        error = sqlite3.OperationalError("disk I/O error")
        with self.app.test_request_context("/api/notifications/sync", method="POST", json={}), \
                patch.object(notifications_api, "current_user", user), \
                patch.object(notifications, "sync_foreground_state", return_value=result), \
                patch.object(focus_mode, "reconcile_focus_mode_status", side_effect=error):
            with self.assertRaises(sqlite3.OperationalError) as raised:
                notifications_api.sync_foreground.__wrapped__()
        self.assertIs(raised.exception, error)
        self.assertNotIn("foreground_enabled", result["notifications"][0])

    def test_delivery_state_failure_logs_and_never_sends(self):
        notifications.update_preferences("u1", {"push_enabled": True})
        for read in ("preferences", "focus_delivery_enabled", "has_active_web_session"):
            with self.subTest(read=read):
                error = sqlite3.OperationalError("database is locked")
                with patch.object(notifications, read, side_effect=error), \
                        patch.object(notifications, "_send") as send, \
                        self.assertLogs(notifications.logger, level="ERROR") as logs:
                    with self.assertRaises(sqlite3.OperationalError) as raised:
                        notifications.deliver("u1", "n1", "chat_dm", "Message", "Body", "/chat")
                self.assertIs(raised.exception, error)
                send.assert_not_called()
                self.assertIn("delivery deferred", logs.output[0])

    def test_failed_foreground_fallback_releases_claim_and_retries_once(self):
        notifications.upsert_subscription(
            "u1", {"endpoint": "https://push.example/device", "keys": {"p256dh": "key", "auth": "auth"}}, "Laptop",
        )
        notification_id = notifications.create_feed_item("u1", "chat_dm", "Message", "Body", "/chat")
        notifications._queue_foreground_delivery("u1", notification_id, "chat_dm", "Message", "Body", "/chat", None)
        with notifications.db_connection() as conn:
            conn.execute("UPDATE notification_foreground_queue SET deliver_after='2020-01-01T00:00:00Z'")
        now = datetime(2026, 10, 6, tzinfo=timezone.utc)
        with patch.object(focus_mode, "reconcile_focus_mode_status", side_effect=sqlite3.OperationalError("database is locked")), \
                patch.object(notifications, "_send") as send, \
                self.assertLogs(notifications.logger, level="ERROR"):
            self.assertEqual(notifications.flush_foreground_queue(now), 0)
        send.assert_not_called()
        with notifications.db_connection() as conn:
            self.assertIsNone(conn.execute("SELECT fallback_at FROM notification_foreground_queue").fetchone()[0])
        with patch.object(notifications, "_send", return_value=201) as send:
            self.assertEqual(notifications.flush_foreground_queue(now), 1)
            self.assertEqual(notifications.flush_foreground_queue(now), 0)
        send.assert_called_once()
