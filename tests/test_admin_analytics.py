import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from flask import Flask
from flask_login import UserMixin

from extensions import csrf, login_manager
from services import database
from services import admin_analytics
import blueprints.admin as admin


class TestUser(UserMixin):
    def __init__(self, user_id):
        self.id = user_id
        self.email = "admin@example.com"
        self.name = "Admin User"


class AdminAnalyticsRouteTestCase(unittest.TestCase):
    def setUp(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(root, "templates"),
            static_folder=os.path.join(root, "static"),
        )
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.app.config["WTF_CSRF_CHECK_DEFAULT"] = False
        login_manager.unauthorized_callback = None
        login_manager.login_view = None
        login_manager.init_app(self.app)
        csrf.init_app(self.app)
        self.app.jinja_env.filters["avatar_url"] = lambda url, size=32: url
        self.app.register_blueprint(admin.admin_bp)
        os.environ["ADMIN_USER_IDS"] = "admin-1"

        @login_manager.user_loader
        def load_user(user_id):
            if user_id == "admin-1":
                return TestUser("admin-1")
            return None

    def tearDown(self):
        os.environ.pop("ADMIN_USER_IDS", None)

    def _login(self, client):
        with client.session_transaction() as session:
            session["_user_id"] = "admin-1"
            session["_fresh"] = True

    def _metrics(self):
        return {
            "total_users": 3,
            "emory_users": 2,
            "non_emory_users": 1,
            "pending_requests": 1,
            "saved_courses": 4,
            "active_course_tracks": 5,
            "paused_course_tracks": 6,
            "file_storage": {"formatted": "1.5 MB", "file_count": 7, "avatar_count": 2, "error": None},
        }

    def test_admin_analytics_requires_admin(self):
        with self.app.test_client() as client:
            response = client.get("/admin/analytics")

        self.assertIn(response.status_code, {302, 401})

    def test_admin_analytics_page_renders_moved_metrics_and_sidebar_order(self):
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "_admin_home_metrics", return_value=self._metrics()), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=0):
                response = client.get("/admin/analytics")

        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("System Numbers", html)
        self.assertIn("Total Users", html)
        self.assertIn("1.5 MB", html)
        self.assertIn("admin-analytics.js", html)
        self.assertLess(html.index(">Auth<"), html.index(">Analytics<"))
        self.assertLess(html.index(">Analytics<"), html.index(">APSwiftly<"))

    def test_admin_analytics_data_normalizes_range_and_timezone(self):
        payload = {"range": "30d", "timezone": "UTC"}
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "analytics_payload", return_value=payload) as analytics_payload:
                response = client.get("/admin/analytics/data?range=bogus&tz=America/Phoenix")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), payload)
        analytics_payload.assert_called_once_with(range_key="30d", tz_name="America/Phoenix")


class AdminAnalyticsServiceTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = os.path.join(self.temp_dir.name, "nest.sqlite3")
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        with database.db_connection(self.db_path) as conn:
            for filename in ("001_initial_schema.sql", "0003_daily_active_users.sql", "0004_admin_analytics.sql"):
                with open(os.path.join(root, "migrations", filename), "r", encoding="utf-8") as handle:
                    conn.executescript(handle.read())

    def tearDown(self):
        self.temp_dir.cleanup()

    def _insert_fixture_data(self):
        with database.db_connection(self.db_path) as conn:
            conn.executemany(
                """
                INSERT INTO users (
                    id, google_id, email, name, onboarding_complete, onboarding_step,
                    education_level, school, school_key, emory_student, created_at, last_login, provider
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    ("user-1", "google-1", "one@example.com", "One", 1, 1, "Undergraduate", "Emory University", "emory-university", 1, "2026-05-01T12:00:00Z", "2026-05-03T12:00:00Z", "google"),
                    ("user-2", "discord-2", "two@example.com", "Two", 0, 2, "High School", "Example High", "example-high", 0, "2026-05-02T12:00:00Z", "2026-05-03T13:00:00Z", "discord"),
                    ("user-3", "github-3", "three@example.com", "Three", 1, 1, "Graduate", "Example University", "example-university", 0, "2026-05-03T12:00:00Z", "2026-05-03T14:00:00Z", "github"),
                ],
            )
            conn.executemany(
                """
                INSERT INTO analytics_events (id, user_id, event_type, path, endpoint, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    ("event-1", "user-1", "page_view", "/dashboard", "dashboard.dashboard", "2026-05-03T12:05:00Z"),
                    ("event-2", "user-2", "page_view", "/notes", "dashboard.notes", "2026-05-03T13:05:00Z"),
                    ("event-3", "user-1", "page_view", "/notes", "dashboard.notes", "2026-05-03T13:20:00Z"),
                ],
            )
            conn.execute(
                "INSERT INTO daily_active_users (user_id, active_date) VALUES (?, ?)",
                ["user-3", "2026-05-03"],
            )
            conn.execute(
                "INSERT INTO tasks (id, user_id, list_id, title, created_at) VALUES (?, ?, ?, ?, ?)",
                ["task-1", "user-1", "list-1", "Read", "2026-05-03T12:10:00Z"],
            )
            conn.execute(
                "INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                ["note-1", "user-1", "Note", "[]", "2026-05-03T12:10:00Z", "2026-05-03T12:10:00Z"],
            )
            conn.execute(
                """
                INSERT INTO user_courses (id, user_id, term, subject, catalog, added_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ["course-1", "user-1", "Fall_2026", "CHEM", "150", "2026-05-03T12:10:00Z"],
            )

    def test_analytics_payload_aggregates_requested_sections(self):
        self._insert_fixture_data()
        now = datetime(2026, 5, 3, 15, 0, tzinfo=timezone.utc)

        payload = admin_analytics.analytics_payload(
            range_key="7d",
            tz_name="America/Phoenix",
            include_ga=False,
            now=now,
            path=self.db_path,
        )

        self.assertEqual(payload["range"], "7d")
        self.assertEqual(payload["timezone"], "America/Phoenix")
        self.assertEqual(payload["cards"]["totalUsers"], 3)
        self.assertEqual(payload["cards"]["pageViews"], 3)
        oauth = {row["key"]: row["value"] for row in payload["breakdowns"]["oauth"]}
        self.assertEqual(oauth["google"], 1)
        self.assertEqual(oauth["discord"], 1)
        self.assertEqual(oauth["github"], 1)
        uni_type = {row["key"]: row["value"] for row in payload["breakdowns"]["uniType"]}
        self.assertEqual(uni_type["emory"], 1)
        self.assertEqual(uni_type["high_school"], 1)
        self.assertEqual(uni_type["graduate"], 1)
        self.assertEqual(payload["engagement"]["onboarding"]["complete"], 2)
        feature_usage = {row["label"]: row["value"] for row in payload["engagement"]["featureUsage"]}
        self.assertEqual(feature_usage["Tasks"], 1)
        self.assertEqual(feature_usage["Courses"], 1)
        self.assertEqual(feature_usage["Notes"], 1)

    def test_missing_ga_credentials_returns_non_failing_state(self):
        with patch.dict(os.environ, {}, clear=True):
            payload = admin_analytics.analytics_payload(
                range_key="30d",
                tz_name="UTC",
                now=datetime(2026, 5, 3, 15, 0, tzinfo=timezone.utc),
                path=self.db_path,
            )

        self.assertFalse(payload["ga4"]["configured"])
        self.assertEqual(payload["ga4"]["status"], "not_configured")


if __name__ == "__main__":
    unittest.main()
