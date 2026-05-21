import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.settings as settings_bp


class TestSettingsPreferences(unittest.TestCase):
    def setUp(self):
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(root, "templates"),
            static_folder=os.path.join(root, "static"),
        )
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        self.user = SimpleNamespace(id="user-1")

    def test_settings_defaults_and_payload_include_task_sound_preference(self):
        self.assertTrue(settings_bp._settings_defaults("user-1")["task_sound_enabled"])
        self.assertTrue(settings_bp._settings_payload(None)["task_sound_enabled"])
        self.assertFalse(settings_bp._settings_payload({"task_sound_enabled": False})["task_sound_enabled"])

    def test_interface_preferences_persist_task_sound_preference(self):
        existing = {"$id": "settings-1", "user_id": "user-1"}
        updated = {**existing, "task_sound_enabled": False}

        with self.app.test_request_context(
            "/settings/api/interface-preferences",
            method="POST",
            json={"task_sound_enabled": False},
        ):
            with patch.object(settings_bp, "current_user", self.user), \
                    patch.object(settings_bp, "_load_user_settings", return_value=existing), \
                    patch.object(settings_bp, "update_row_safe", return_value=updated) as update_row:
                response = settings_bp.update_interface_preferences.__wrapped__()

        payload = response.get_json()
        self.assertFalse(payload["task_sound_enabled"])
        self.assertFalse(update_row.call_args.args[2]["task_sound_enabled"])


if __name__ == "__main__":
    unittest.main()
