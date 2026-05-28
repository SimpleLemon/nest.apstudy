import os
import re
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from flask import Flask
from flask_login import UserMixin
from werkzeug.middleware.proxy_fix import ProxyFix

from app import create_app
from extensions import csrf, login_manager
import blueprints.admin as admin


class TestUser(UserMixin):
    def __init__(self, user_id, email="admin@example.com"):
        self.id = user_id
        self.email = email
        self.name = "Admin User"


class AdminSecurityTestCase(unittest.TestCase):
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
        self.app.config["SESSION_COOKIE_SECURE"] = True
        self.app.config["SESSION_COOKIE_HTTPONLY"] = True
        self.app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
        login_manager.init_app(self.app)
        csrf.init_app(self.app)
        self.app.register_blueprint(admin.admin_bp)
        os.environ["ADMIN_USER_IDS"] = "admin-1"

        @login_manager.user_loader
        def load_user(user_id):
            if user_id == "admin-1":
                return TestUser("admin-1")
            return None

        self.user_doc = {
            "$id": "user-1",
            "id": "user-1",
            "name": "Test User",
            "email": "user@example.com",
            "username": "testuser",
            "school": "Emory University",
            "major": "Computer Science",
            "graduation_year": 2028,
            "created_at": "2026-05-25T00:00:00Z",
            "last_login": "2026-05-25T01:00:00Z",
            "onboarding_complete": False,
            "onboarding_step": 2,
            "emory_student": True,
        }
        self.settings_doc = {"user_id": "user-1", "ics_secret_token": "secret-token"}

    def tearDown(self):
        os.environ.pop("ADMIN_USER_IDS", None)

    def _login(self, client):
        with client.session_transaction() as session:
            session["_user_id"] = "admin-1"
            session["_fresh"] = True

    def _get_csrf_token(self, client, url, patches):
        with ExitStack() as stack:
            for patcher in patches:
                stack.enter_context(patcher)
            response = client.get(url)
        html = response.get_data(as_text=True)
        match = re.search(r'name="csrf_token" value="([^"]+)"', html)
        self.assertIsNotNone(match, f"No CSRF token found in {url}")
        return match.group(1)

    def test_session_cookie_flags_are_hardened(self):
        self.assertTrue(self.app.config["SESSION_COOKIE_SECURE"])
        self.assertTrue(self.app.config["SESSION_COOKIE_HTTPONLY"])
        self.assertEqual(self.app.config["SESSION_COOKIE_SAMESITE"], "Lax")

    def test_app_factory_hardens_production_session_and_url_scheme(self):
        with patch.dict(os.environ, {
            "APSTUDY_ALLOW_INSECURE_HTTP": "0",
            "FLASK_DEBUG": "0",
        }, clear=False), \
                patch("services.scheduler.init_scheduler"), \
                patch("services.discord_audit.init_discord_audit"):
            app = create_app()

        self.assertTrue(app.config["SESSION_COOKIE_SECURE"])
        self.assertTrue(app.config["SESSION_COOKIE_HTTPONLY"])
        self.assertEqual(app.config["SESSION_COOKIE_SAMESITE"], "Lax")
        self.assertEqual(app.config["PREFERRED_URL_SCHEME"], "https")
        self.assertIsInstance(app.wsgi_app, ProxyFix)

    def test_admin_detail_renders_csrf_tokens(self):
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "get_row_safe", return_value=self.user_doc), \
                    patch.object(admin, "first_row", return_value=self.settings_doc), \
                    patch.object(admin, "_theme_preference", return_value=None):
                response = client.get("/admin/user-1?section=settings")

        html = response.get_data(as_text=True)
        self.assertGreaterEqual(html.count('name="csrf_token"'), 2)

    def test_admin_requests_renders_csrf_tokens(self):
        requests_rows = [{
            "$id": "request-1",
            "id": "request-1",
            "label": "University Channel",
            "request_type": "uni_channel_approval",
            "school_name": "Emory University",
            "status": "pending",
            "request_count": 1,
            "created_at": "2026-05-25T00:00:00Z",
            "resolved_at": None,
        }]
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "list_rows_all", return_value=requests_rows), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=1):
                response = client.get("/admin/requests")

        html = response.get_data(as_text=True)
        self.assertGreaterEqual(html.count('name="csrf_token"'), 2)

    def test_admin_export_requires_post_and_csrf(self):
        export_payload = {"user": self.user_doc, "settings": self.settings_doc}
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "get_row_safe", return_value=self.user_doc), \
                    patch.object(admin, "first_row", return_value=self.settings_doc), \
                    patch.object(admin, "_theme_preference", return_value=None):
                detail_html = client.get("/admin/user-1?section=settings").get_data(as_text=True)

            token_match = re.search(r'name="csrf_token" value="([^"]+)"', detail_html)
            self.assertIsNotNone(token_match)
            token = token_match.group(1)

            with patch.object(admin, "_export_payload", return_value=export_payload):
                missing_token = client.post("/admin/user-1.json", data={})
                self.assertEqual(missing_token.status_code, 400)

                response = client.post("/admin/user-1.json", data={"csrf_token": token})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), export_payload)

    def test_admin_delete_logs_action_details(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(
                client,
                "/admin/user-1?section=settings",
                [
                    patch.object(admin, "get_row_safe", return_value=self.user_doc),
                    patch.object(admin, "first_row", return_value=self.settings_doc),
                    patch.object(admin, "_theme_preference", return_value=None),
                ],
            )
            with patch.object(admin, "get_row_safe", return_value=self.user_doc), \
                    patch.object(admin, "Users") as users_cls, \
                    patch.object(admin, "_delete_user_rows"), \
                    patch.object(admin, "delete_row_safe"), \
                    patch.object(admin, "_storage_service"), \
                    patch.object(admin, "_theme_preference", return_value=None):
                users_cls.return_value.delete.return_value = None
                with self.assertLogs("admin_actions", level="INFO") as logs:
                    response = client.post(
                        "/admin/user-1/delete",
                        data={"confirm": "DELETE", "csrf_token": token},
                    )

        self.assertEqual(response.status_code, 302)
        joined = "\n".join(logs.output)
        self.assertIn("admin_id=admin-1", joined)
        self.assertIn("action=delete_user", joined)
        self.assertIn("target=user:user-1", joined)

    def test_admin_requests_post_without_csrf_is_rejected(self):
        requests_rows = [{
            "$id": "request-1",
            "id": "request-1",
            "label": "University Channel",
            "request_type": "uni_channel_approval",
            "school_name": "Emory University",
            "status": "pending",
            "request_count": 1,
            "created_at": "2026-05-25T00:00:00Z",
            "resolved_at": None,
        }]
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "list_rows_all", return_value=requests_rows), \
                    patch.object(admin, "get_row_safe", return_value=requests_rows[0]), \
                    patch.object(admin, "update_row_safe"), \
                    patch.object(admin, "create_university_channel", return_value={"$id": "channel-1"}), \
                    patch.object(admin, "emit_chat_event"), \
                    patch.object(admin, "sync_chat_presence_labels_for_school"), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=1):
                response = client.post("/admin/requests/request-1/approve", data={})

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
