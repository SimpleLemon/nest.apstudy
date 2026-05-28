import os
import html
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask, session
from appwrite.exception import AppwriteException
from werkzeug.exceptions import NotFound

import blueprints.auth as auth
from app import create_app
from extensions import login_manager


class AppwriteOauthRouteTestCase(unittest.TestCase):
    def setUp(self):
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(project_root, "templates"),
            static_folder=os.path.join(project_root, "static"),
        )
        self.app.secret_key = "test"
        login_manager.init_app(self.app)
        self.app.register_blueprint(auth.auth_bp)

    def assert_login_error_is_rendered_and_consumed(self, error_code):
        with self.app.test_client() as client:
            with client.session_transaction() as client_session:
                client_session[auth.AUTH_ERROR_SESSION_KEY] = error_code

            response = client.get("/login")
            body = html.unescape(response.get_data(as_text=True))

            self.assertEqual(response.status_code, 200)
            self.assertIn(auth.AUTH_ERROR_MESSAGE, body)
            self.assertIn(f"Error code: {error_code}", body)
            with client.session_transaction() as client_session:
                self.assertNotIn(auth.AUTH_ERROR_SESSION_KEY, client_session)

    def test_login_renders_and_consumes_session_error_code(self):
        self.assert_login_error_is_rendered_and_consumed(auth.AUTH_ERROR_OAUTH_CALLBACK)

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
        self.assertIn("/auth/appwrite/failure/", calls[0]["failure"])
        self.assertNotIn("auth_error", calls[0]["failure"])

    def test_oauth_start_logs_missing_sessions_scope_without_secret(self):
        error = AppwriteException(
            "<html>missing scopes ([\"sessions.write\"]) secret=super-secret-token</html>",
            401,
            "general_unauthorized_scope",
        )
        fake_account = SimpleNamespace(create_o_auth2_token=lambda **_kwargs: (_ for _ in ()).throw(error))

        with self.app.test_request_context("/auth/appwrite/google"):
            with patch.object(auth, "Account", return_value=fake_account), \
                    patch.object(auth, "emit_server_log_event") as emit_server_log, \
                    self.assertLogs("blueprints.auth", level="ERROR") as logs:
                response = auth.appwrite_oauth_start("google")
                state_present = auth.APPWRITE_OAUTH_STATE_KEY in session
                provider_present = auth.APPWRITE_OAUTH_PROVIDER_KEY in session
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)

        output = "\n".join(logs.output)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_START_SCOPE)
        self.assertFalse(state_present)
        self.assertFalse(provider_present)
        self.assertIn("general_unauthorized_scope", output)
        self.assertIn("sessions.write", output)
        self.assertNotIn("super-secret-token", output)
        emit_server_log.assert_called_once()
        self.assertEqual(emit_server_log.call_args.args[0], "OAuth Login Error: Missing Appwrite Scope")
        self.assertEqual(emit_server_log.call_args.kwargs["metadata"]["error_code"], auth.AUTH_ERROR_OAUTH_START_SCOPE)
        self.assertIn("sessions.write", str(emit_server_log.call_args.kwargs["metadata"]["appwrite_error"]))
        self.assert_login_error_is_rendered_and_consumed(auth.AUTH_ERROR_OAUTH_START_SCOPE)

    def test_oauth_start_uses_generic_code_for_other_start_failures(self):
        fake_account = SimpleNamespace(
            create_o_auth2_token=lambda **_kwargs: (_ for _ in ()).throw(RuntimeError("network down"))
        )

        with self.app.test_request_context("/auth/appwrite/google"):
            with patch.object(auth, "Account", return_value=fake_account), \
                    patch.object(auth, "emit_server_log_event") as emit_server_log, \
                    self.assertLogs("blueprints.auth", level="ERROR"):
                response = auth.appwrite_oauth_start("google")
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_START)
        emit_server_log.assert_called_once()

    def test_appwrite_oauth_preflight_reports_missing_sessions_scope(self):
        error = AppwriteException(
            "app role missing scopes ([\"sessions.write\"])",
            401,
            "general_unauthorized_scope",
        )
        fake_account = SimpleNamespace(create_o_auth2_token=lambda **_kwargs: (_ for _ in ()).throw(error))

        with patch.object(auth, "Account", return_value=fake_account), \
                self.assertLogs("blueprints.auth", level="ERROR"):
            result = self.app.test_cli_runner().invoke(
                args=[
                    "auth",
                    "appwrite-oauth-preflight",
                    "--provider",
                    "google",
                    "--base-url",
                    "https://nest.apstudy.org",
                ],
            )

        self.assertNotEqual(result.exit_code, 0)
        self.assertIn("Appwrite OAuth preflight failed.", result.output)
        self.assertIn("general_unauthorized_scope", result.output)
        self.assertIn("required_scope_hint: sessions.write", result.output)

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
        self.assertRegex(calls[0]["failure"], r"^https://nest\.apstudy\.org/auth/appwrite/failure/")
        self.assertNotIn("auth_error", calls[0]["failure"])

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
        self.assertRegex(calls[0]["failure"], r"^http://localhost:8000/auth/appwrite/failure/")
        self.assertNotIn("auth_error", calls[0]["failure"])

    def test_invalid_provider_is_rejected(self):
        with self.app.test_request_context("/auth/appwrite/not-real"):
            with self.assertRaises(NotFound):
                auth.appwrite_oauth_start("not-real")

    def test_callback_rejects_mismatched_state(self):
        with self.app.test_request_context("/auth/appwrite/callback/bad?userId=user-1&secret=secret"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "good"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "google"
            with patch.object(auth, "Account") as account_class, \
                    patch.object(auth, "emit_server_log_event") as emit_server_log:
                response = auth.appwrite_oauth_callback("bad")
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_STATE)
        account_class.assert_not_called()
        emit_server_log.assert_called_once()

    def test_callback_rejects_missing_credentials(self):
        with self.app.test_request_context("/auth/appwrite/callback/state?userId=user-1"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "state"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "google"
            with patch.object(auth, "emit_server_log_event") as emit_server_log:
                response = auth.appwrite_oauth_callback("state")
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_CREDENTIALS)
        emit_server_log.assert_called_once()

    def test_callback_completion_failure_uses_callback_error_code(self):
        fake_account = SimpleNamespace(
            create_session=lambda user_id, secret: {
                "provider": "google",
                "providerAccessToken": "provider-token",
                "userId": user_id,
            },
        )
        with self.app.test_request_context("/auth/appwrite/callback/state?userId=user-1&secret=secret"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "state"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "google"
            with patch.object(auth, "Account", return_value=fake_account), \
                    patch.object(auth, "_account_from_user_id", return_value={"$id": "user-1"}), \
                    patch.object(auth, "_complete_appwrite_login", side_effect=RuntimeError("profile create failed")), \
                    patch.object(auth, "emit_server_log_event") as emit_server_log, \
                    self.assertLogs("blueprints.auth", level="ERROR"):
                response = auth.appwrite_oauth_callback("state")
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_CALLBACK)
        emit_server_log.assert_called_once()

    def test_provider_failure_route_sets_provider_error_and_clears_state(self):
        with self.app.test_request_context("/auth/appwrite/failure/state"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "state"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "discord"
            with patch.object(auth, "emit_server_log_event") as emit_server_log, \
                    self.assertLogs("blueprints.auth", level="WARNING") as logs:
                response = auth.appwrite_oauth_failure("state")
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)
                state_present = auth.APPWRITE_OAUTH_STATE_KEY in session
                provider_present = auth.APPWRITE_OAUTH_PROVIDER_KEY in session

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_PROVIDER)
        self.assertFalse(state_present)
        self.assertFalse(provider_present)
        self.assertIn("provider=discord", "\n".join(logs.output))
        emit_server_log.assert_called_once()

    def test_provider_failure_route_rejects_invalid_state(self):
        with self.app.test_request_context("/auth/appwrite/failure/bad"):
            session[auth.APPWRITE_OAUTH_STATE_KEY] = "good"
            session[auth.APPWRITE_OAUTH_PROVIDER_KEY] = "github"
            with patch.object(auth, "emit_server_log_event") as emit_server_log, \
                    self.assertLogs("blueprints.auth", level="WARNING"):
                response = auth.appwrite_oauth_failure("bad")
                error_code = session.get(auth.AUTH_ERROR_SESSION_KEY)
                state_present = auth.APPWRITE_OAUTH_STATE_KEY in session
                provider_present = auth.APPWRITE_OAUTH_PROVIDER_KEY in session

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/login")
        self.assertEqual(error_code, auth.AUTH_ERROR_OAUTH_STATE)
        self.assertFalse(state_present)
        self.assertFalse(provider_present)
        emit_server_log.assert_called_once()

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
