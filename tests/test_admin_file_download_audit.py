"""Actor attribution for privileged file downloads, without remote transport."""

import unittest
from unittest.mock import patch

from flask import Flask, Response
from flask_login import LoginManager, UserMixin

from blueprints import admin
from services import file_share_store


class AdminFileDownloadAuditTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SECRET_KEY="test", TESTING=True)
        self.app.register_blueprint(admin.admin_bp)
        self.app.add_url_rule("/", endpoint="dashboard.dashboard", view_func=lambda: "home")
        login = LoginManager(self.app)

        @login.user_loader
        def user_loader(user_id):
            user = UserMixin()
            user.id, user.name, user.email = user_id, "Administrator", "admin@example.test"
            return user

        self.enterContext(patch.dict("os.environ", {"ADMIN_USER_IDS": "administrator"}))
        self.row = {"$id": "file", "user_id": "owner", "original_filename": "private.txt"}
        self.client = self.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"], session["_fresh"] = "administrator", True

    def test_successful_download_records_actor_target_and_file(self):
        for status in (200, 206):
            with self.subTest(status=status), patch.object(admin, "get_row_safe", return_value=self.row), \
                    patch.object(file_share_store, "_send_shared_file", return_value=Response("bytes", status=status)), \
                    patch.object(admin, "emit_admin_event") as event, \
                    self.assertLogs(admin.admin_actions_logger, level="INFO") as logs:
                response = self.client.get("/admin/users/owner/files/file/download")
            self.assertEqual(response.status_code, status)
            self.assertIn("admin_id=administrator action=download_shared_file target=user:owner file:file", logs.output[0])
            event.assert_called_once()
            self.assertEqual(event.call_args.args[0], "Admin Downloaded Shared File")
            values = event.call_args.kwargs
            self.assertIn("administrator", str(values["actor"]))
            self.assertIn("owner", str(values["target"]))
            self.assertEqual(values["metadata"]["resource_id"], "file")
            self.assertEqual(values["metadata"]["target_user_id"], "owner")

    def test_denied_or_unsuccessful_responses_do_not_record_successful_access(self):
        for user_id, row, status, expected in (
            ("administrator", None, 200, 404),
            ("administrator", {**self.row, "user_id": "someone-else"}, 200, 404),
            ("administrator", self.row, 503, 503),
            ("outsider", self.row, 200, 302),
        ):
            with self.subTest(user_id=user_id, status=status, row=row):
                with self.client.session_transaction() as session:
                    session["_user_id"] = user_id
                with patch.object(admin, "get_row_safe", return_value=row), \
                        patch.object(file_share_store, "_send_shared_file", return_value=Response(status=status)) as send, \
                        patch.object(admin, "emit_admin_event") as event:
                    response = self.client.get("/admin/users/owner/files/file/download")
                self.assertEqual(response.status_code, expected)
                event.assert_not_called()
                if expected in {302, 403, 404}:
                    send.assert_not_called()
