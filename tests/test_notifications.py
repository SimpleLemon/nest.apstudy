import tempfile
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from services.database import init_db
from services import notifications


def notification_app():
    path = tempfile.mktemp(suffix=".sqlite3")
    app = Flask(__name__)
    app.config["DATABASE_PATH"] = path
    init_db(app, path)
    return app, path


def test_preferences_subscription_feed_and_mutations():
    app, path = notification_app()
    try:
        with app.app_context():
            prefs = notifications.update_preferences("u1", {"calendar_lead_minutes": [5, 60], "dm_enabled": False})
            assert prefs["calendar_lead_minutes"] == [5, 60]
            assert prefs["dm_enabled"] is False
            subscription_id = notifications.upsert_subscription("u1", {"endpoint": "https://push.example/sub", "keys": {"p256dh": "key", "auth": "auth"}}, "Laptop")
            assert notifications.list_subscriptions("u1")[0]["id"] == subscription_id
            notification_id = notifications.create_feed_item("u1", "calendar", "Exam", "Starts tomorrow.", "/dashboard", dedupe_key="exam-1")
            assert notifications.create_feed_item("u1", "calendar", "Exam", "Starts tomorrow.", "https://evil.example", dedupe_key="exam-1") == notification_id
            assert notifications.unread_count("u1") == 1
            assert notifications.list_feed("u1")["notifications"][0]["target_url"] == "/dashboard"
            notifications.mutate_feed("u1", [notification_id], read=True)
            assert notifications.unread_count("u1") == 0
            notifications.mutate_feed("u1", [notification_id], delete=True)
            assert notifications.list_feed("u1")["notifications"] == []
    finally:
        Path(path).unlink(missing_ok=True)


def test_delivery_removes_expired_subscription():
    app, path = notification_app()
    try:
        with app.app_context():
            notifications.upsert_subscription("u1", {"endpoint": "https://push.example/gone", "keys": {"p256dh": "key", "auth": "auth"}}, "Phone")
            notification_id = notifications.create_feed_item("u1", "test", "Test", "Body", "/notifications")
            with patch.object(notifications, "_send", return_value=201):
                result = notifications.deliver("u1", notification_id, "test", "Test", "Body", "/notifications")
            assert result == {"accepted": 1, "failed": 0}
    finally:
        Path(path).unlink(missing_ok=True)


def test_calendar_reminder_is_claimed_once():
    app, path = notification_app()
    try:
        with app.app_context():
            from services.database import db_connection
            with db_connection() as conn:
                conn.execute("INSERT INTO user_settings (id,user_id,created_at,timezone) VALUES ('s1','u1','2026-01-01T00:00:00Z','UTC')")
                conn.execute("INSERT INTO user_events (id,user_id,title,start,end,is_all_day,created_at) VALUES ('e1','u1','Exam','2026-07-11T12:10:00Z','2026-07-11T13:00:00Z',0,'2026-01-01T00:00:00Z')")
            with patch.object(notifications, "notify", return_value=("n1", {"accepted": 1, "failed": 0})) as send:
                now = datetime(2026, 7, 11, 12, 0, tzinfo=timezone.utc)
                assert notifications.check_calendar_reminders(now) == 1
                assert notifications.check_calendar_reminders(now) == 0
            assert send.call_count == 1
    finally:
        Path(path).unlink(missing_ok=True)
