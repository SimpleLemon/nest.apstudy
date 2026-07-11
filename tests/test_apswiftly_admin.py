import os
import re
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from flask import Blueprint, Flask
from flask_login import UserMixin
from werkzeug.middleware.proxy_fix import ProxyFix

from extensions import csrf, login_manager
import blueprints.admin as admin
import services.apswiftly_control as apswiftly_control
from services.apswiftly_control import format_checked_at_display, format_service_state_display


class TestUser(UserMixin):
    def __init__(self, user_id, email="admin@example.com"):
        self.id = user_id
        self.email = email
        self.name = "Admin User"


class APSwiftlyAdminTestCase(unittest.TestCase):
    def setUp(self):
        previous_loader = login_manager._user_callback
        self.addCleanup(setattr, login_manager, "_user_callback", previous_loader)
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(root, "templates"),
            static_folder=os.path.join(root, "static"),
        )
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.app.config["WTF_CSRF_CHECK_DEFAULT"] = False
        self.app.config["SESSION_COOKIE_SECURE"] = True
        self.app.config["SESSION_COOKIE_HTTPONLY"] = True
        self.app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
        login_manager.init_app(self.app)
        csrf.init_app(self.app)
        self.app.jinja_env.filters["avatar_url"] = lambda url, size=32: url
        dashboard_bp = Blueprint("dashboard", __name__)

        @dashboard_bp.route("/dashboard")
        def dashboard():
            return "dashboard"

        self.app.register_blueprint(dashboard_bp)
        self.app.register_blueprint(admin.admin_bp)
        os.environ["ADMIN_USER_IDS"] = "admin-1"

        @login_manager.user_loader
        def load_user(user_id):
            if user_id == "admin-1":
                return TestUser("admin-1")
            if user_id == "user-2":
                return TestUser("user-2", email="user@example.com")
            return None

        self.status_payload = {
            "service_name": "apswiftly",
            "service_state": "active",
            "service_state_display": "Active",
            "service_active": True,
            "api_reachable": True,
            "api_payload": {"ok": True},
            "control_url": "http://127.0.0.1:3921",
            "checked_at": "2026-06-21T12:00:00Z",
            "checked_at_display": "20 minutes ago",
        }
        self.page_patches = [
            patch.object(admin, "_theme_preference", return_value=None),
            patch.object(admin, "_pending_admin_request_count", return_value=0),
            patch.object(admin, "apswiftly_status", return_value=self.status_payload),
            patch.object(admin, "_log_admin_action"),
        ]

    def tearDown(self):
        os.environ.pop("ADMIN_USER_IDS", None)

    def _login(self, client):
        with client.session_transaction() as session:
            session["_user_id"] = "admin-1"
            session["_fresh"] = True

    def _get_csrf_token(self, client):
        with ExitStack() as stack:
            for patcher in self.page_patches:
                stack.enter_context(patcher)
            response = client.get("/admin/apswiftly")
        html = response.get_data(as_text=True)
        match = re.search(r'id="admin-apswiftly-csrf-token"[^>]*value="([^"]+)"', html)
        self.assertIsNotNone(match, "No APSwiftly CSRF token found")
        return match.group(1)

    def test_non_admin_cannot_access_apswiftly_page(self):
        with self.app.test_client() as client:
            with client.session_transaction() as session:
                session["_user_id"] = "user-2"
                session["_fresh"] = True
            response = client.get("/admin/apswiftly")
        self.assertEqual(response.status_code, 302)
        self.assertIn("/dashboard", response.location)

    def test_admin_apswiftly_page_renders_controls(self):
        with self.app.test_client() as client:
            self._login(client)
            with ExitStack() as stack:
                for patcher in self.page_patches:
                    stack.enter_context(patcher)
                response = client.get("/admin/apswiftly")

        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("APSwiftly", html)
        self.assertIn("Hot-reload", html)
        self.assertIn("slash commands", html)
        self.assertIn("Shutdown", html)
        self.assertIn("Restart", html)
        self.assertIn("apswiftly://operations", html)
        self.assertIn("Active", html)
        self.assertIn(">checked<", html)
        self.assertIn('data-apswiftly-action="reload"', html)
        self.assertIn('href="/admin/apswiftly"', html)
        self.assertIn("admin-apswiftly.js", html)
        self.assertIn(">Active<", html)
        self.assertIn(">20 minutes ago<", html)

    def test_admin_apswiftly_status_returns_json(self):
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "apswiftly_status", return_value=self.status_payload):
                response = client.get("/admin/apswiftly/status")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["service_active"])
        self.assertTrue(payload["api_reachable"])
        self.assertEqual(payload["service_state"], "active")
        self.assertEqual(payload["service_state_display"], "Active")

    def test_format_service_state_display_active(self):
        self.assertEqual(format_service_state_display("active"), "Active")

    def test_format_checked_at_relative_units(self):
        now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(
            format_checked_at_display(now - timedelta(minutes=20), now=now),
            "20 minutes ago",
        )
        self.assertEqual(
            format_checked_at_display(now - timedelta(hours=5), now=now),
            "5 hours ago",
        )
        self.assertEqual(
            format_checked_at_display(now - timedelta(days=3), now=now),
            "3 days ago",
        )

    def test_format_checked_at_absolute_after_five_days(self):
        now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(
            format_checked_at_display(now - timedelta(days=6), now=now),
            "June 16, 2026",
        )

    def test_admin_apswiftly_reload_requires_csrf_and_calls_service(self):
        with self.app.test_client() as client:
            self._login(client)
            response = client.post("/admin/apswiftly/reload", json={})
            self.assertEqual(response.status_code, 400)
            token = self._get_csrf_token(client)
            with patch.object(apswiftly_control, "apswiftly_reload", return_value={"message": "Commands hot-reloaded."}) as reload_mock, \
                    patch.object(admin, "_log_admin_action") as log_action:
                reload_response = client.post(
                    "/admin/apswiftly/reload",
                    json={},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(reload_response.status_code, 200)
        reload_mock.assert_called_once_with()
        self.assertEqual(log_action.call_args.args[0], "apswiftly_reload")

    def test_admin_apswiftly_restart_requires_confirm(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(client)
            with patch.object(apswiftly_control, "apswiftly_service_restart", return_value={"message": "Restarted."}) as restart_mock:
                missing_confirm = client.post(
                    "/admin/apswiftly/restart",
                    json={},
                    headers={"X-CSRFToken": token},
                )
                wrong_confirm = client.post(
                    "/admin/apswiftly/restart",
                    json={"confirm": "NOPE"},
                    headers={"X-CSRFToken": token},
                )
                valid_confirm = client.post(
                    "/admin/apswiftly/restart",
                    json={"confirm": "RESTART"},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(missing_confirm.status_code, 400)
        self.assertEqual(wrong_confirm.status_code, 400)
        self.assertEqual(valid_confirm.status_code, 200)
        restart_mock.assert_called_once_with()

    def test_admin_apswiftly_shutdown_requires_confirm(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(client)
            with patch.object(apswiftly_control, "apswiftly_shutdown", return_value={"message": "Shutting down."}) as shutdown_mock:
                missing_confirm = client.post(
                    "/admin/apswiftly/shutdown",
                    json={},
                    headers={"X-CSRFToken": token},
                )
                valid_confirm = client.post(
                    "/admin/apswiftly/shutdown",
                    json={"confirm": "SHUTDOWN"},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(missing_confirm.status_code, 400)
        self.assertEqual(valid_confirm.status_code, 200)
        shutdown_mock.assert_called_once_with()

    def test_admin_apswiftly_unknown_action_returns_404(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(client)
            response = client.post(
                "/admin/apswiftly/unknown",
                json={},
                headers={"X-CSRFToken": token},
            )
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
