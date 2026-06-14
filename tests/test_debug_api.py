import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.debug_api as debug_api


class DebugApiTestCase(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config["LOGIN_DISABLED"] = True
        self.app.register_blueprint(debug_api.debug_api_bp)
        self.client = self.app.test_client()
        self.user = SimpleNamespace(
            id="user-1",
            username="student",
            name="Student",
            email="student@emory.edu",
            is_authenticated=True,
        )

    def test_report_browser_console_queues_batched_lines(self):
        payload = {
            "page": "/dashboard",
            "lines": ["[error] one", "[warn] two"],
        }
        with patch.object(debug_api, "current_user", self.user), \
                patch.object(debug_api, "queue_browser_console_lines", return_value=True) as queue_lines:
            response = self.client.post("/api/debug/console", json=payload)

        self.assertEqual(response.status_code, 202)
        queue_lines.assert_called_once()
        self.assertEqual(queue_lines.call_args.kwargs["page"], "/dashboard")
        self.assertEqual(queue_lines.call_args.kwargs["lines"], payload["lines"])

    def test_report_browser_console_ignores_empty_payload(self):
        with patch.object(debug_api, "current_user", self.user), \
                patch.object(debug_api, "queue_browser_console_lines") as queue_lines:
            response = self.client.post("/api/debug/console", json={"lines": []})

        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.get_json()["status"], "ignored")
        queue_lines.assert_not_called()


if __name__ == "__main__":
    unittest.main()
