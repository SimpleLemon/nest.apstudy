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

    def _onboarding_user(self, **overrides):
        data = {
            "id": "user-1",
            "onboarding_step": 4,
            "onboarding_complete": False,
            "education_level": "Undergraduate",
            "class_year": "2028",
            "emory_student": False,
            "emory_email": None,
            "school": None,
            "school_key": None,
            "school_source": None,
            "scorecard_id": None,
        }
        data.update(overrides)
        return SimpleNamespace(**data)

    def test_settings_defaults_and_payload_include_task_sound_preference(self):
        self.assertTrue(settings_bp._settings_defaults("user-1")["task_sound_enabled"])
        self.assertTrue(settings_bp._settings_defaults("user-1")["chat_sound_enabled"])
        self.assertTrue(settings_bp._settings_payload(None)["task_sound_enabled"])
        self.assertTrue(settings_bp._settings_payload(None)["chat_sound_enabled"])
        self.assertFalse(settings_bp._settings_payload({"task_sound_enabled": False})["task_sound_enabled"])
        self.assertFalse(settings_bp._settings_payload({"chat_sound_enabled": False})["chat_sound_enabled"])

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

    def test_interface_preferences_persist_chat_sound_preference(self):
        existing = {"$id": "settings-1", "user_id": "user-1"}
        updated = {**existing, "chat_sound_enabled": False}

        with self.app.test_request_context(
            "/settings/api/interface-preferences",
            method="POST",
            json={"chat_sound_enabled": False},
        ):
            with patch.object(settings_bp, "current_user", self.user), \
                    patch.object(settings_bp, "_load_user_settings", return_value=existing), \
                    patch.object(settings_bp, "update_row_safe", return_value=updated) as update_row:
                response = settings_bp.update_interface_preferences.__wrapped__()

        payload = response.get_json()
        self.assertFalse(payload["chat_sound_enabled"])
        self.assertFalse(update_row.call_args.args[2]["chat_sound_enabled"])

    def test_interface_preferences_accept_nest_theme_variants(self):
        for interface_theme, legacy_theme in (
            ("nest-light", "light"),
            ("nest-dark", "dark"),
        ):
            with self.subTest(interface_theme=interface_theme):
                existing = {"$id": "settings-1", "user_id": "user-1"}
                updated = {
                    **existing,
                    "interface_theme": interface_theme,
                    "theme": legacy_theme,
                }

                with self.app.test_request_context(
                    "/settings/api/interface-preferences",
                    method="POST",
                    json={"interface_theme": interface_theme},
                ):
                    with patch.object(settings_bp, "current_user", self.user), \
                            patch.object(settings_bp, "_load_user_settings", return_value=existing), \
                            patch.object(settings_bp, "update_row_safe", return_value=updated) as update_row:
                        response = settings_bp.update_interface_preferences.__wrapped__()

                payload = response.get_json()
                updates = update_row.call_args.args[2]
                self.assertEqual(payload["interface_theme"], interface_theme)
                self.assertEqual(payload["theme"], legacy_theme)
                self.assertEqual(updates["interface_theme"], interface_theme)
                self.assertEqual(updates["theme"], legacy_theme)

    def test_onboarding_step_four_advances_without_completion_event(self):
        user = self._onboarding_user(onboarding_step=4)

        with self.app.test_request_context("/onboarding", method="POST", json={"step": 4}):
            with patch.object(settings_bp, "current_user", user), \
                    patch.object(settings_bp, "update_row_safe", return_value={}) as update_row, \
                    patch.object(settings_bp, "emit_user_event") as emit_user_event:
                response = settings_bp.save_onboarding.__wrapped__()

        payload = response.get_json()
        self.assertEqual(payload["next_step"], 5)
        self.assertFalse(user.onboarding_complete)
        self.assertEqual(user.onboarding_step, 5)
        self.assertEqual(update_row.call_args.args[2], {"onboarding_step": 5})
        emit_user_event.assert_not_called()

    def test_onboarding_step_five_completes_and_emits_once(self):
        user = self._onboarding_user(onboarding_step=5, school="Emory University")

        with self.app.test_request_context("/onboarding", method="POST", json={"step": 5}):
            with patch.object(settings_bp, "current_user", user), \
                    patch.object(settings_bp, "update_row_safe", return_value={}) as update_row, \
                    patch.object(settings_bp, "emit_user_event") as emit_user_event, \
                    patch.object(settings_bp, "url_for", return_value="/"):
                response = settings_bp.save_onboarding.__wrapped__()

        payload = response.get_json()
        self.assertEqual(payload["redirect_url"], "/")
        self.assertTrue(user.onboarding_complete)
        self.assertEqual(user.onboarding_step, 5)
        self.assertEqual(
            update_row.call_args.args[2],
            {"onboarding_complete": True, "onboarding_step": 5},
        )
        emit_user_event.assert_called_once()
        self.assertEqual(emit_user_event.call_args.args[0], "Onboarding Complete")

    def test_onboarding_step_two_defaults_emory_school(self):
        user = self._onboarding_user(onboarding_step=2)

        with self.app.test_request_context(
            "/onboarding",
            method="POST",
            json={
                "step": 2,
                "education_level": "Undergraduate",
                "class_year": "2028",
                "emory_student": True,
                "emory_email": "student@emory.edu",
            },
        ):
            with patch.object(settings_bp, "current_user", user), \
                    patch.object(settings_bp, "update_row_safe", return_value={}) as update_row, \
                    patch.object(settings_bp, "sync_chat_presence_labels_for_user"):
                response = settings_bp.save_onboarding.__wrapped__()

        payload = response.get_json()
        updates = update_row.call_args.args[2]
        self.assertEqual(payload["next_step"], 3)
        self.assertEqual(updates["school"], "Emory University")
        self.assertTrue(updates["emory_student"])
        self.assertEqual(updates["emory_email"], "student@emory.edu")

    def test_onboarding_step_two_saves_non_emory_school(self):
        user = self._onboarding_user(onboarding_step=2)

        with self.app.test_request_context(
            "/onboarding",
            method="POST",
            json={
                "step": 2,
                "education_level": "Undergraduate",
                "class_year": "2028",
                "emory_student": False,
                "school": "Georgia State University",
            },
        ):
            with patch.object(settings_bp, "current_user", user), \
                    patch.object(settings_bp, "update_row_safe", return_value={}) as update_row, \
                    patch.object(settings_bp, "sync_chat_presence_labels_for_user"):
                response = settings_bp.save_onboarding.__wrapped__()

        payload = response.get_json()
        updates = update_row.call_args.args[2]
        self.assertEqual(payload["next_step"], 4)
        self.assertEqual(updates["school"], "Georgia State University")
        self.assertFalse(updates["emory_student"])
        self.assertIsNone(updates["emory_email"])


if __name__ == "__main__":
    unittest.main()
