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
            no_link_id = notifications.create_feed_item("u1", "notes", "FYI", "No destination", None)
            no_link = next(item for item in notifications.list_feed("u1")["notifications"] if item["id"] == no_link_id)
            assert no_link["target_url"] is None
            assert [item["id"] for item in notifications.list_feed("u1", search="exam")["notifications"]] == [notification_id]
            notifications.mutate_feed("u1", ids=[], delete=True)
            assert len(notifications.list_feed("u1")["notifications"]) == 2
            notifications.mutate_feed("u1", read=True)
            assert notifications.unread_count("u1") == 0
            assert len(notifications.list_feed("u1", status="read")["notifications"]) == 2
            assert notifications.list_feed("u1", status="unread")["notifications"] == []
            notifications.mutate_feed("u1", delete=True)
            assert notifications.list_feed("u1")["notifications"] == []
    finally:
        Path(path).unlink(missing_ok=True)


def test_push_configuration_requires_public_and_readable_private_key():
    with patch.dict("os.environ", {"VAPID_PUBLIC_KEY": "public", "VAPID_PRIVATE_KEY": "/missing/key.pem"}, clear=False):
        assert notifications.push_configuration() == {"configured": False, "public_key": ""}
    with tempfile.NamedTemporaryFile() as private_key:
        with patch.dict("os.environ", {"VAPID_PUBLIC_KEY": "public", "VAPID_PRIVATE_KEY": private_key.name}, clear=False):
            assert notifications.push_configuration() == {"configured": True, "public_key": "public"}


def test_delivery_removes_expired_subscription():
    app, path = notification_app()
    try:
        with app.app_context():
            notifications.upsert_subscription("u1", {"endpoint": "https://push.example/gone", "keys": {"p256dh": "key", "auth": "auth"}}, "Phone")
            notification_id = notifications.create_feed_item("u1", "test", "Test", "Body", "/dashboard?notifications=open")
            with patch.object(notifications, "_send", return_value=201):
                result = notifications.deliver("u1", notification_id, "test", "Test", "Body", "/dashboard?notifications=open")
            assert result == {"accepted": 1, "failed": 0}
    finally:
        Path(path).unlink(missing_ok=True)


def test_active_laptop_session_uses_in_app_delivery_before_push():
    app, path = notification_app()
    try:
        with app.app_context():
            notifications.upsert_subscription("u1", {"endpoint": "https://push.example/device", "keys": {"p256dh": "key", "auth": "auth"}}, "Laptop")
            notifications.touch_web_presence("u1", "tab-1", active=True, device_class="desktop_tablet")
            with patch.object(notifications, "_send") as send:
                result = notifications.deliver("u1", "n1", "calendar", "Exam", "Starts soon", "/dashboard")
            assert result == {"accepted": 1, "failed": 0}
            send.assert_not_called()

            with patch.object(notifications, "_send", return_value=201) as send:
                result = notifications.deliver("u1", "n-test", "test", "Test", "Browser delivery", "/settings#notifications", force_push=True)
            assert result == {"accepted": 1, "failed": 0}
            send.assert_called_once()

            notifications.touch_web_presence("u1", "tab-1", active=False, device_class="desktop_tablet")
            with patch.object(notifications, "_send", return_value=201) as send:
                result = notifications.deliver("u1", "n2", "calendar", "Exam", "Starts soon", "/dashboard")
            assert result == {"accepted": 1, "failed": 0}
            send.assert_called_once()
    finally:
        Path(path).unlink(missing_ok=True)


def test_foreground_delivery_is_acknowledged_or_released_to_push():
    app, path = notification_app()
    try:
        with app.app_context():
            from services.database import db_connection

            notifications.upsert_subscription("u1", {"endpoint": "https://push.example/device", "keys": {"p256dh": "key", "auth": "auth"}}, "Laptop")
            notifications.touch_web_presence("u1", "tab-1", active=True, device_class="desktop_tablet")
            with patch.object(notifications, "_send") as send:
                notifications.deliver("u1", "n-ack", "calendar", "Exam", "Starts soon", "/dashboard")
            send.assert_not_called()
            assert notifications.pending_foreground_ids("u1") == ["n-ack"]
            assert notifications.acknowledge_foreground("u1", ["n-ack"]) == 1
            assert notifications.pending_foreground_ids("u1") == []

            notifications.deliver("u1", "n-fallback", "calendar", "Lab", "Starts soon", "/dashboard")
            with db_connection() as conn:
                conn.execute("UPDATE notification_foreground_queue SET deliver_after='2020-01-01T00:00:00Z' WHERE notification_id='n-fallback'")
            with patch.object(notifications, "_send", return_value=201) as send:
                assert notifications.flush_foreground_queue(datetime(2026, 7, 11, tzinfo=timezone.utc)) == 1
            send.assert_called_once()
            assert notifications.pending_foreground_ids("u1") == []

            notifications.deliver("u1", "n-read", "calendar", "Review", "Starts soon", "/dashboard")
            assert notifications.pending_foreground_ids("u1") == ["n-read"]
            notifications.mutate_feed("u1", ["n-read"], read=True)
            assert notifications.pending_foreground_ids("u1") == []
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
