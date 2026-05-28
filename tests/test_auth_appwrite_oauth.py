import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask, session
from werkzeug.exceptions import NotFound

import blueprints.auth as auth
from app import create_app
from extensions import login_manager


class AppwriteOauthRouteTestCase(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        login_manager.init_app(self.app)
        self.app.register_blueprint(auth.auth_bp)

    def test_valid_provider_initiates_appwrite_oauth_token_flow(self):
        calls = []

        def create_o_auth2_token(**kwargs):
            calls.append(kwargs)
            return "https://appwrite.example/oauth"

        fake_account = SimpleNamespace(create_o_auth2_token=create_o_auth2_token)
        with self.app.test_request_context("/auth/appwrite/google"):
            with patch.object(auth, "Account", return_value=fake_account):
                response = auth.appwrite_oauth_start("google")

            self.assertEqual(response.status_code, 302)
            self.assertEqual(response.headers["Location"], "https://appwrite.example/oauth")
            self.assertEqual(session[auth.APPWRITE_OAUTH_PROVIDER_KEY], "google")
            self.assertIn(auth.APPWRITE_OAUTH_STATE_KEY, session)

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["provider"], auth.OAuthProvider.GOOGLE)
        self.assertIn("/auth/appwrite/callback/", calls[0]["success"])
        self.assertIn("/login?auth_error=1", calls[0]["failure"])

    def test_app_factory_oauth_urls_use_forwarded_https(self):
        calls = []

        def create_o_auth2_token(**kwargs):
            calls.append(kwargs)
            return "https://appwrite.example/oauth"

        fake_account = SimpleNamespace(create_o_auth2_token=create_o_auth2_token)
        with patch("services.scheduler.init_scheduler"), \
                patch("services.discord_audit.init_discord_audit"), \
                patch.object(auth, "Account", return_value=fake_account):
            app = create_app()
            app.config["SERVER_NAME"] = "nest.apstudy.org"
            app.config["TESTING"] = True
            response = app.test_client().get(
                "/auth/appwrite/google",
                headers={
                    "Host": "nest.apstudy.org",
                    "X-Forwarded-Proto": "https",
                    "X-Forwarded-Host": "nest.apstudy.org",
                },
            )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "https://appwrite.example/oauth")
        self.assertEqual(len(calls), 1)
        self.assertRegex(calls[0]["success"], r"^https://nest\.apstudy\.org/auth/appwrite/callback/")
        self.assertEqual(calls[0]["failure"], "https://nest.apstudy.org/login?auth_error=1")

    def test_app_factory_oauth_urls_allow_local_insecure_http(self):
        calls = []

        def create_o_auth2_token(**kwargs):
            calls.append(kwargs)
            return "https://appwrite.example/oauth"

        fake_account = SimpleNamespace(create_o_auth2_token=create_o_auth2_token)
        with patch.dict(os.environ, {
            "APSTUDY_ALLOW_INSECURE_HTTP": "1",
            "FLASK_DEBUG": "0",
        }, clear=False), \
                patch("services.scheduler.init_scheduler"), \
                patch("services.discord_audit.init_discord_audit"), \
                patch.object(auth, "Account", return_value=fake_account):
            app = create_app()
            app.config["TESTING"] = True
            response = app.test_client().get(
                "/auth/appwrite/google",
                base_url="http://localhost:8000",
            )

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "https://appwrite.example/oauth")
        self.assertEqual(len(calls), 1)
        self.assertRegex(calls[0]["success"], r"^http://localhost:8000/auth/appwrite/callback/")
        self.assertEqual(calls[0]["failure"], "http://localhost:8000/login?auth_error=1")

    def test_invalid_provider_is_rejected(self):
        with self.app.test_request_context("/auth/appwrite/not-real"):
            with self.assertRaises(NotFound):
                auth.appwrite_oauth_start("not-real")

    def test_callback_rejects_mismatched_state(self):
        with self.app.test_request_context("/auth/appwrite/callback/bad?userId=user-1&secret=secret"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "good"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "google"
            with patch.object(auth, "Account") as account_class:
                response = auth.appwrite_oauth_callback("bad")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login?auth_error=1", response.headers["Location"])
        account_class.assert_not_called()

    def test_callback_rejects_missing_credentials(self):
        with self.app.test_request_context("/auth/appwrite/callback/state?userId=user-1"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "state"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "google"
            response = auth.appwrite_oauth_callback("state")

        self.assertEqual(response.status_code, 302)
        self.assertIn("/login?auth_error=1", response.headers["Location"])

    def test_valid_callback_creates_session_and_completes_login(self):
        fake_account = SimpleNamespace(
            create_session=lambda user_id, secret: {
                "provider": "google",
                "providerAccessToken": "provider-token",
                "userId": user_id,
            },
        )
        remote_user = {"$id": "user-1", "email": "student@example.com", "name": "Student"}

        with self.app.test_request_context("/auth/appwrite/callback/state?userId=user-1&secret=secret"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "state"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "google"
            with patch.object(auth, "Account", return_value=fake_account), \
                    patch.object(auth, "_account_from_user_id", return_value=remote_user) as account_from_user_id, \
                    patch.object(auth, "_complete_appwrite_login", return_value={"redirect": "/dashboard", "user_id": "user-1"}) as complete_login:
                response = auth.appwrite_oauth_callback("state")
                state_present = auth.APPWRITE_OAUTH_STATE_KEY in session
                provider_present = auth.APPWRITE_OAUTH_PROVIDER_KEY in session

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/dashboard")
        self.assertFalse(state_present)
        self.assertFalse(provider_present)
        account_from_user_id.assert_called_once_with("user-1")
        complete_login.assert_called_once_with(
            remote_user,
            provider="google",
            provider_access_token="provider-token",
            page_context="auth/appwrite/callback",
        )


if __name__ == "__main__":
    unittest.main()
