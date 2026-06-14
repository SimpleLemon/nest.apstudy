import os
import re
import subprocess
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
        self.app.jinja_env.filters["avatar_url"] = lambda url, size=32: url
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
        extra_patches = []
        if url == "/admin/requests":
            extra_patches.append(patch.object(admin, "get_course_tracking_refresh_minutes", return_value=5))
        with ExitStack() as stack:
            for patcher in [*patches, *extra_patches]:
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

    def test_app_factory_initializes_discord_audit_before_scheduler(self):
        calls = []

        with patch("services.discord_audit.init_discord_audit", side_effect=lambda app: calls.append("discord")), \
                patch("services.scheduler.init_scheduler", side_effect=lambda app: calls.append("scheduler")):
            create_app()

        self.assertEqual(calls, ["discord", "scheduler"])

    def test_admin_detail_renders_csrf_tokens(self):
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "get_row_safe", return_value=self.user_doc), \
                    patch.object(admin, "first_row", return_value=self.settings_doc), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=0):
                response = client.get("/admin/user-1?section=settings")

        html = response.get_data(as_text=True)
        self.assertGreaterEqual(html.count('name="csrf_token"'), 1)
        self.assertIn("May 25, 2026", html)
        self.assertIn("May 25, 2026 1:00 AM", html)
        self.assertIn("@testuser", html)

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

    def test_admin_home_renders_home_metrics(self):
        metrics = {
            "total_users": 3,
            "emory_users": 2,
            "non_emory_users": 1,
            "pending_requests": 1,
            "saved_courses": 4,
            "active_course_tracks": 5,
            "paused_course_tracks": 6,
            "file_storage": {"formatted": "1.5 MB", "file_count": 7, "avatar_count": 2, "error": None},
        }
        system_status = {
            "scheduler_enabled": True,
            "scheduler_running": True,
            "scheduler_lock_acquired": True,
            "scheduler_hostname": "nest-prod",
            "scheduler_process_id": 1234,
            "jobs": [{"id": "check_course_seat_tracks"}],
        }
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "_admin_home_metrics", return_value=metrics), \
                    patch.object(admin, "_system_status", return_value=system_status), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=1):
                response = client.get("/admin")

        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("System Numbers", html)
        self.assertIn("Total Users", html)
        self.assertIn("1.5 MB", html)
        self.assertIn("System Controls", html)
        self.assertLess(html.index("System Numbers"), html.index("System Controls"))
        self.assertNotIn("Registered Jobs", html)
        self.assertNotIn("admin-system-chips", html)
        self.assertIn('id="admin-system-csrf-token"', html)
        self.assertIn("Pause Scheduler", html)
        self.assertIn("Resume Scheduler", html)
        self.assertIn("Git Pull", html)
        self.assertRegex(html, r'data-scheduler-action="pause"[^>]*>')
        self.assertRegex(html, r'data-scheduler-action="resume"[^>]*hidden')
        self.assertNotIn('action="/admin"', html)

    def test_admin_home_disables_pause_when_scheduler_is_paused(self):
        metrics = {
            "total_users": 0,
            "emory_users": 0,
            "non_emory_users": 0,
            "pending_requests": 0,
            "saved_courses": 0,
            "active_course_tracks": 0,
            "paused_course_tracks": 0,
            "file_storage": {"formatted": "--", "file_count": 0, "avatar_count": 0, "error": None},
        }
        system_status = {"scheduler_enabled": False, "jobs": []}

        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "_admin_home_metrics", return_value=metrics), \
                    patch.object(admin, "_system_status", return_value=system_status), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=0):
                response = client.get("/admin")

        html = response.get_data(as_text=True)
        self.assertRegex(html, r'data-scheduler-action="pause"[^>]*hidden')
        self.assertRegex(html, r'data-scheduler-action="resume"[^>]*>')

    def test_admin_system_status_includes_scheduler_fields_without_secrets(self):
        scheduler_payload = {
            "scheduler_enabled": True,
            "scheduler_initialized": True,
            "scheduler_running": True,
            "scheduler_lock_acquired": True,
            "scheduler_lock_path": "/tmp/nest_apstudy_scheduler.lock",
            "scheduler_process_id": 1234,
            "scheduler_hostname": "nest-prod",
            "jobs": [{"id": "check_course_seat_tracks"}],
        }

        with self.app.test_client() as client:
            self._login(client)
            with patch("services.scheduler.scheduler_status", return_value=scheduler_payload), \
                    patch.object(admin, "psutil", None):
                response = client.get("/admin/system-status")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["scheduler_enabled"])
        self.assertTrue(payload["scheduler_running"])
        self.assertEqual(payload["scheduler_hostname"], "nest-prod")
        self.assertEqual(payload["jobs"][0]["id"], "check_course_seat_tracks")
        body = response.get_data(as_text=True)
        self.assertNotIn("SCHEDULER_ENABLED=1", body)
        self.assertNotIn("token-secret", body)

    def test_admin_scheduler_controls_require_csrf_and_run_fixed_commands(self):
        metrics = {
            "total_users": 0,
            "emory_users": 0,
            "non_emory_users": 0,
            "pending_requests": 0,
            "saved_courses": 0,
            "active_course_tracks": 0,
            "paused_course_tracks": 0,
            "file_storage": {"formatted": "--", "file_count": 0, "avatar_count": 0, "error": None},
        }
        patches = [
            patch.object(admin, "_admin_home_metrics", return_value=metrics),
            patch.object(admin, "_system_status", return_value={}),
            patch.object(admin, "_theme_preference", return_value=None),
            patch.object(admin, "_pending_admin_request_count", return_value=0),
        ]

        with self.app.test_client() as client:
            self._login(client)
            response = client.post("/admin/system-scheduler/pause", json={})
            self.assertEqual(response.status_code, 400)
            token = self._get_csrf_token(client, "/admin", patches)
            with patch.object(admin, "_resolve_scheduler_executable", side_effect=lambda name: f"/usr/bin/{name}"), \
                    patch.object(admin.subprocess, "run") as run_command, \
                    patch.object(admin, "_log_admin_action") as log_action:
                pause_response = client.post(
                    "/admin/system-scheduler/pause",
                    json={},
                    headers={"X-CSRFToken": token},
                )
                resume_response = client.post(
                    "/admin/system-scheduler/resume",
                    json={},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(pause_response.status_code, 200)
        self.assertEqual(resume_response.status_code, 200)
        expected_pause = ["/usr/bin/sed", "-i", "s/SCHEDULER_ENABLED=1/SCHEDULER_ENABLED=0/g", admin.SCHEDULER_ENV_PATH]
        expected_resume = ["/usr/bin/sed", "-i", "s/SCHEDULER_ENABLED=0/SCHEDULER_ENABLED=1/g", admin.SCHEDULER_ENV_PATH]
        expected_restart = ["/usr/bin/systemctl", "restart", admin.SCHEDULER_SERVICE_NAME]
        self.assertEqual(run_command.call_args_list[0].args[0], expected_pause)
        self.assertEqual(run_command.call_args_list[1].args[0], expected_restart)
        self.assertEqual(run_command.call_args_list[2].args[0], expected_resume)
        self.assertEqual(run_command.call_args_list[3].args[0], expected_restart)
        for call in run_command.call_args_list:
            self.assertTrue(call.kwargs["check"])
            self.assertTrue(call.kwargs["capture_output"])
            self.assertEqual(call.kwargs["timeout"], admin.SCHEDULER_COMMAND_TIMEOUT_SECONDS)
        self.assertEqual(log_action.call_count, 2)
        self.assertEqual(log_action.call_args_list[0].args[0], "scheduler_pause")
        self.assertEqual(log_action.call_args_list[1].args[0], "scheduler_resume")

    def test_admin_git_pull_requires_csrf_and_runs_fixed_command(self):
        metrics = {
            "total_users": 0,
            "emory_users": 0,
            "non_emory_users": 0,
            "pending_requests": 0,
            "saved_courses": 0,
            "active_course_tracks": 0,
            "paused_course_tracks": 0,
            "file_storage": {"formatted": "--", "file_count": 0, "avatar_count": 0, "error": None},
        }
        patches = [
            patch.object(admin, "_admin_home_metrics", return_value=metrics),
            patch.object(admin, "_system_status", return_value={}),
            patch.object(admin, "_theme_preference", return_value=None),
            patch.object(admin, "_pending_admin_request_count", return_value=0),
        ]
        completed = subprocess.CompletedProcess(
            ["/usr/bin/git", "-C", admin.SYSTEM_GIT_REPO_PATH, "pull"],
            0,
            stdout="Already up to date.\n",
            stderr="",
        )

        with self.app.test_client() as client:
            self._login(client)
            response = client.post("/admin/system-git-pull", json={})
            self.assertEqual(response.status_code, 400)
            token = self._get_csrf_token(client, "/admin", patches)
            with patch.object(admin, "_resolve_scheduler_executable", side_effect=lambda name: f"/usr/bin/{name}"), \
                    patch.object(admin.subprocess, "run", return_value=completed) as run_command, \
                    patch.object(admin, "_log_admin_action") as log_action:
                git_response = client.post(
                    "/admin/system-git-pull",
                    json={},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(git_response.status_code, 200)
        payload = git_response.get_json()
        self.assertEqual(payload["stdout"], "Already up to date.")
        self.assertEqual(payload["command"], f"cd {admin.SYSTEM_GIT_REPO_PATH} && git pull")
        self.assertEqual(
            run_command.call_args.args[0],
            ["/usr/bin/git", "-C", admin.SYSTEM_GIT_REPO_PATH, "pull"],
        )
        self.assertTrue(run_command.call_args.kwargs["check"])
        self.assertTrue(run_command.call_args.kwargs["capture_output"])
        self.assertEqual(run_command.call_args.kwargs["env"]["GIT_SSH"], "/usr/bin/ssh")
        self.assertIn("/usr/bin", run_command.call_args.kwargs["env"]["PATH"])
        self.assertEqual(run_command.call_args.kwargs["timeout"], admin.SYSTEM_GIT_COMMAND_TIMEOUT_SECONDS)
        log_action.assert_called_once()
        self.assertEqual(log_action.call_args.args[0], "system_git_pull")

    def test_admin_scheduler_control_failure_is_sanitized_and_logged(self):
        metrics = {
            "total_users": 0,
            "emory_users": 0,
            "non_emory_users": 0,
            "pending_requests": 0,
            "saved_courses": 0,
            "active_course_tracks": 0,
            "paused_course_tracks": 0,
            "file_storage": {"formatted": "--", "file_count": 0, "avatar_count": 0, "error": None},
        }
        patches = [
            patch.object(admin, "_admin_home_metrics", return_value=metrics),
            patch.object(admin, "_system_status", return_value={}),
            patch.object(admin, "_theme_preference", return_value=None),
            patch.object(admin, "_pending_admin_request_count", return_value=0),
        ]
        failure = subprocess.CalledProcessError(
            1,
            ["sed"],
            stderr="failed secret=token-secret",
        )

        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(client, "/admin", patches)
            with patch.object(admin, "_resolve_scheduler_executable", side_effect=lambda name: f"/usr/bin/{name}"), \
                    patch.object(admin.subprocess, "run", side_effect=failure), \
                    patch.object(admin, "_log_admin_action") as log_action:
                response = client.post(
                    "/admin/system-scheduler/pause",
                    json={},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(response.status_code, 500)
        body = response.get_data(as_text=True)
        self.assertIn("Scheduler command failed", body)
        self.assertNotIn("token-secret", body)
        log_action.assert_called_once()
        self.assertEqual(log_action.call_args.args[0], "scheduler_pause")
        self.assertEqual(log_action.call_args.kwargs["metadata"]["result"], "failed")

    def test_admin_scheduler_control_missing_executable_is_sanitized_and_logged(self):
        metrics = {
            "total_users": 0,
            "emory_users": 0,
            "non_emory_users": 0,
            "pending_requests": 0,
            "saved_courses": 0,
            "active_course_tracks": 0,
            "paused_course_tracks": 0,
            "file_storage": {"formatted": "--", "file_count": 0, "avatar_count": 0, "error": None},
        }
        patches = [
            patch.object(admin, "_admin_home_metrics", return_value=metrics),
            patch.object(admin, "_system_status", return_value={}),
            patch.object(admin, "_theme_preference", return_value=None),
            patch.object(admin, "_pending_admin_request_count", return_value=0),
        ]

        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(client, "/admin", patches)
            with patch.object(admin.shutil, "which", return_value=None), \
                    patch.object(admin.os.path, "exists", return_value=False), \
                    patch.object(admin, "_log_admin_action") as log_action:
                response = client.post(
                    "/admin/system-scheduler/pause",
                    json={},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(response.status_code, 500)
        body = response.get_data(as_text=True)
        self.assertIn("Required scheduler command not found: sed", body)
        self.assertNotIn("token-secret", body)
        log_action.assert_called_once()
        self.assertEqual(log_action.call_args.args[0], "scheduler_pause")
        self.assertEqual(log_action.call_args.kwargs["metadata"]["result"], "failed")

    def test_admin_users_renders_directory(self):
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "list_rows_all", return_value=[self.user_doc]), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=0):
                response = client.get("/admin/users")

        html = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn("User Directory", html)
        self.assertIn('action="/admin/users"', html)
        self.assertIn("user@example.com", html)
        self.assertIn("May 25, 2026", html)
        self.assertIn("May 25, 2026 1:00 AM", html)

    def test_admin_requests_places_course_tracking_before_university_requests(self):
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
        groups = [{
            "id": "Fall_2026|CHEM|150|1234",
            "term": "Fall_2026",
            "subject": "CHEM",
            "catalog": "150",
            "crn": "1234",
            "course_code": "CHEM 150",
            "course_title": "Structure and Properties",
            "active_count": 1,
            "paused_count": 0,
            "user_count": 1,
            "last_checked_at": "2026-05-25T00:00:00Z",
            "last_status": "Closed",
            "last_seats_available": 0,
            "tracks": [{
                "id": "track-1",
                "user_id": "user-1",
                "enabled": True,
                "last_status": "Closed",
                "last_seats_available": 0,
                "last_checked_at": "2026-05-25T00:00:00Z",
                "last_notified_at": None,
            }],
        }]
        with self.app.test_client() as client:
            self._login(client)
            with patch.object(admin, "list_rows_all", return_value=requests_rows), \
                    patch.object(admin, "_course_tracking_groups", return_value=(groups, None)), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "_pending_admin_request_count", return_value=1):
                response = client.get("/admin/requests")

        html = response.get_data(as_text=True)
        self.assertLess(html.index("Course Tracking"), html.index("University Channel Requests"))
        self.assertIn("CHEM 150", html)
        self.assertIn('id="admin-tracking-refresh"', html)
        self.assertIn("5m (default)", html)
        self.assertIn("60m", html)
        self.assertIn("Spring tracking", html)
        self.assertIn("Open Spring", html)

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

    def test_course_tracking_status_reports_secret_safe_diagnostics(self):
        scheduler_payload = {
            "scheduler_enabled": True,
            "scheduler_initialized": True,
            "scheduler_running": True,
            "jobs": [{"id": "check_course_seat_tracks", "name": "Check tracked Emory course seats every 5 min"}],
        }
        audit_payload = {
            "audit_enabled": True,
            "bot_token_present": True,
            "course_tracks_channel_present": True,
            "server_logs_channel_present": True,
            "service_initialized": True,
            "sender_thread_alive": True,
            "queue_length": 0,
            "fallback_path": "/tmp/discord_audit_fallback.jsonl",
            "fallback_line_count": 0,
        }

        with self.app.test_client() as client:
            self._login(client)
            with patch("services.scheduler.scheduler_status", return_value=scheduler_payload), \
                    patch.object(admin, "discord_audit_status", return_value=audit_payload), \
                    patch("services.course_tracking.get_last_course_tracking_poll", return_value={"atlas_checks_attempted": 1}), \
                    patch.object(admin, "list_rows_all", return_value=[{"$id": "track-1"}]):
                response = client.get("/admin/course-tracking-status")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertTrue(payload["scheduler_running"])
        self.assertTrue(payload["course_tracking_job_registered"])
        self.assertEqual(payload["enabled_track_count"], 1)
        self.assertTrue(payload["bot_token_present"])
        self.assertNotIn("DISCORD_BOT_TOKEN", payload)
        self.assertNotIn("token-secret", response.get_data(as_text=True))

    def test_course_tracking_run_now_calls_tracker_and_returns_diagnostics(self):
        diagnostics = {
            "scheduler_enabled": True,
            "scheduler_running": True,
            "jobs": [{"id": "check_course_seat_tracks"}],
            "audit_enabled": True,
            "bot_token_present": True,
            "course_tracks_channel_present": True,
            "enabled_track_count": 2,
            "last_course_tracking_poll": {"atlas_checks_attempted": 2},
            "course_tracking_job_registered": True,
        }

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
            with patch("services.course_tracking.check_course_seat_tracks", return_value=3) as run_tracker, \
                    patch.object(admin, "_course_tracking_diagnostics", return_value=diagnostics), \
                    patch.object(admin, "_log_admin_action") as log_action:
                response = client.post("/admin/course-tracking-run-now", data={"csrf_token": token})

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["notifications_sent"], 3)
        self.assertEqual(payload["diagnostics"]["enabled_track_count"], 2)
        run_tracker.assert_called_once()
        log_action.assert_called_once()

    def test_course_tracking_group_toggle_requires_csrf_and_updates_matching_rows(self):
        tracks = [
            {"$id": "track-1", "term": "Fall_2026", "subject": "CHEM", "catalog": "150", "crn": "1234", "enabled": True},
            {"$id": "track-2", "term": "Fall_2026", "subject": "CHEM", "catalog": "150", "crn": "1234", "enabled": True},
        ]
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(
                client,
                "/admin/requests",
                [
                    patch.object(admin, "list_rows_all", return_value=[]),
                    patch.object(admin, "_course_tracking_groups", return_value=([], None)),
                    patch.object(admin, "_theme_preference", return_value=None),
                    patch.object(admin, "_pending_admin_request_count", return_value=0),
                ],
            )
            with patch.object(admin, "list_rows_all", return_value=tracks), \
                    patch.object(admin, "update_row_safe", side_effect=lambda table, row_id, data: {"$id": row_id, **data}) as update_row, \
                    patch.object(admin, "_course_tracking_groups", return_value=([], None)), \
                    patch.object(admin, "_log_admin_action"):
                missing_token = client.post("/admin/course-tracking/groups/toggle", data={
                    "term": "Fall_2026",
                    "subject": "CHEM",
                    "catalog": "150",
                    "crn": "1234",
                    "enabled": "false",
                })
                response = client.post("/admin/course-tracking/groups/toggle", data={
                    "csrf_token": token,
                    "term": "Fall_2026",
                    "subject": "CHEM",
                    "catalog": "150",
                    "crn": "1234",
                    "enabled": "false",
                })

        self.assertEqual(missing_token.status_code, 400)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([call.args[1] for call in update_row.call_args_list], ["track-1", "track-2"])
        for call in update_row.call_args_list:
            self.assertEqual(call.args[2]["enabled"], False)

    def test_course_tracking_track_toggle_updates_single_row(self):
        track = {"$id": "track-1", "term": "Fall_2026", "subject": "CHEM", "catalog": "150", "crn": "1234", "enabled": True}
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(
                client,
                "/admin/requests",
                [
                    patch.object(admin, "list_rows_all", return_value=[]),
                    patch.object(admin, "_course_tracking_groups", return_value=([], None)),
                    patch.object(admin, "_theme_preference", return_value=None),
                    patch.object(admin, "_pending_admin_request_count", return_value=0),
                ],
            )
            with patch.object(admin, "get_row_safe", return_value=track), \
                    patch.object(admin, "update_row_safe", side_effect=lambda table, row_id, data: {"$id": row_id, **track, **data}) as update_row, \
                    patch.object(admin, "_log_admin_action"):
                response = client.post(
                    "/admin/course-tracking/tracks/track-1/toggle",
                    data={"csrf_token": token, "enabled": "false"},
                )

        self.assertEqual(response.status_code, 200)
        update_row.assert_called_once()
        self.assertEqual(update_row.call_args.args[1], "track-1")
        self.assertEqual(update_row.call_args.args[2]["enabled"], False)

    def test_course_tracking_refresh_interval_requires_csrf_and_logs(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(
                client,
                "/admin/requests",
                [
                    patch.object(admin, "list_rows_all", return_value=[]),
                    patch.object(admin, "_course_tracking_groups", return_value=([], None)),
                    patch.object(admin, "_theme_preference", return_value=None),
                    patch.object(admin, "_pending_admin_request_count", return_value=0),
                ],
            )
            with patch.object(admin, "set_course_tracking_refresh_minutes") as set_refresh, \
                    patch.object(admin, "update_course_tracking_refresh_interval", return_value=True) as update_refresh, \
                    patch.object(admin, "_log_admin_action") as log_action:
                missing_token = client.post("/admin/course-tracking/refresh-interval", json={"minutes": 10})
                response = client.post(
                    "/admin/course-tracking/refresh-interval",
                    json={"minutes": 10},
                    headers={"X-CSRFToken": token},
                )
                invalid = client.post(
                    "/admin/course-tracking/refresh-interval",
                    json={"minutes": 15},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(missing_token.status_code, 400)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["refresh_interval_minutes"], 10)
        self.assertTrue(response.get_json()["scheduler_updated"])
        self.assertEqual(invalid.status_code, 400)
        set_refresh.assert_called_once_with(10)
        update_refresh.assert_called_once_with(10)
        log_action.assert_called_once()
        self.assertEqual(log_action.call_args.args[0], "course_tracking_refresh_interval")
        self.assertEqual(log_action.call_args.kwargs["metadata"]["refresh_interval_minutes"], 10)

    def test_spring_course_tracking_toggle_requires_csrf_and_logs(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(
                client,
                "/admin/requests",
                [
                    patch.object(admin, "list_rows_all", return_value=[]),
                    patch.object(admin, "_course_tracking_groups", return_value=([], None)),
                    patch.object(admin, "_theme_preference", return_value=None),
                    patch.object(admin, "_pending_admin_request_count", return_value=0),
                    patch.object(admin, "spring_course_tracking_open", return_value=False),
                ],
            )

            missing_token = client.post("/admin/course-tracking/spring-toggle", json={"enabled": True})
            self.assertEqual(missing_token.status_code, 400)

            with patch.object(admin, "set_spring_course_tracking_open") as set_open, \
                    patch.object(admin, "_log_admin_action") as log_action:
                response = client.post(
                    "/admin/course-tracking/spring-toggle",
                    json={"enabled": True},
                    headers={"X-CSRFToken": token},
                )

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["enabled"])
        set_open.assert_called_once_with(True)
        self.assertEqual(log_action.call_args.args[0], "spring_course_tracking_toggle")
        self.assertTrue(log_action.call_args.kwargs["metadata"]["enabled"])

    def test_chem_150_diagnostic_is_non_mutating(self):
        with self.app.test_client() as client:
            self._login(client)
            token = self._get_csrf_token(
                client,
                "/admin/requests",
                [
                    patch.object(admin, "list_rows_all", return_value=[]),
                    patch.object(admin, "_course_tracking_groups", return_value=([], None)),
                    patch.object(admin, "_theme_preference", return_value=None),
                    patch.object(admin, "_pending_admin_request_count", return_value=0),
                ],
            )
            with patch("services.course_tracking.check_course_seat_tracks", return_value=0) as check_tracks, \
                    patch("services.course_tracking.get_last_course_tracking_poll", return_value={"poll_source": "manual_admin_test", "track_count": 1}) as last_poll, \
                    patch.object(admin, "create_row_safe") as create_row, \
                    patch.object(admin, "update_row_safe") as update_row, \
                    patch.object(admin, "_log_admin_action"):
                response = client.post("/admin/course-tracking/test-chem-150", data={"csrf_token": token})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["poll"]["track_count"], 1)
        check_tracks.assert_called_once_with(
            term="Fall_2026",
            subject="CHEM",
            catalog="150",
            poll_source="manual_admin_test",
        )
        last_poll.assert_called_once()
        create_row.assert_not_called()
        update_row.assert_not_called()


if __name__ == "__main__":
    unittest.main()
