import json
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

import blueprints.chat_api as chat_api
import services.chat_presence as chat_presence
from services.chat_formatting import render_markdown
from services.chat_presence import CHAT_UNIVERSITY_LABEL_PREFIX, university_presence_label
from services.universities import school_payload, search_universities
import services.discord_bridge as discord_bridge


class TestChatFeature(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.user = SimpleNamespace(
            id="user-1",
            name="Derek C",
            username="derek",
            picture_url="https://example.test/avatar.png",
            school="Emory University",
            school_key="emory-university",
            major="CS",
            graduation_year="2026",
            class_year="2026",
            education_level="Undergraduate",
        )

    def test_university_search_and_custom_school_payload(self):
        results = search_universities("Emory")
        self.assertTrue(any(row["name"] == "Emory University" for row in results))

        matched = school_payload("Emory University")
        self.assertEqual(matched["school_source"], "scorecard")
        self.assertEqual(matched["school_key"], "emory-university")

        custom = school_payload("A Very Real Custom University")
        self.assertEqual(custom["school_source"], "custom")
        self.assertEqual(custom["school_key"], "a-very-real-custom-university")

    def test_markdown_renderer_sanitizes_script_and_keeps_safe_formatting(self):
        rendered = render_markdown("**hello** <script>alert(1)</script> https://example.com")
        self.assertIn("<strong>hello</strong>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertNotIn("<script>", rendered)
        self.assertIn('rel="noopener noreferrer nofollow"', rendered)

    def test_delete_message_allows_owner_within_five_minutes(self):
        created_at = (datetime.now(timezone.utc) - timedelta(minutes=4)).isoformat()
        row = {
            "$id": "message-1",
            "user_id": "user-1",
            "source": "appwrite",
            "channel_id": "nest_chat",
            "created_at": created_at,
        }
        with self.app.test_request_context("/api/chat/messages/message-1", method="DELETE"):
            with patch.object(chat_api, "current_user", self.user), \
                    patch.object(chat_api, "get_row_safe", return_value=row), \
                    patch.object(chat_api, "update_row_safe") as update_row, \
                    patch.object(chat_api, "emit_chat_event") as emit_event:
                response = chat_api.delete_message.__wrapped__("message-1")

        self.assertEqual(response.status_code if hasattr(response, "status_code") else 200, 200)
        update_row.assert_called_once()
        payload = update_row.call_args.args[2]
        self.assertEqual(payload["deleted_by"], "user-1")
        self.assertIn("deleted_at", payload)
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[:3], ("channel", "nest_chat", "message_deleted"))

    def test_delete_message_rejects_after_five_minutes(self):
        created_at = (datetime.now(timezone.utc) - timedelta(minutes=6)).isoformat()
        row = {
            "$id": "message-1",
            "user_id": "user-1",
            "source": "appwrite",
            "created_at": created_at,
        }
        with self.app.test_request_context("/api/chat/messages/message-1", method="DELETE"):
            with patch.object(chat_api, "current_user", self.user), \
                    patch.object(chat_api, "get_row_safe", return_value=row), \
                    patch.object(chat_api, "update_row_safe") as update_row:
                response, status = chat_api.delete_message.__wrapped__("message-1")

        self.assertEqual(status, 403)
        self.assertIn("5 minutes", response.get_json()["error"])
        update_row.assert_not_called()

    def test_university_request_created_on_chat_bootstrap_helper(self):
        created = {"$id": "request-1", "status": "pending", "school_key": "emory-university"}
        with self.app.test_request_context("/api/chat/bootstrap"):
            with patch.object(chat_api, "current_user", self.user), \
                    patch.object(chat_api, "_find_university_channel", return_value=None), \
                    patch.object(chat_api, "first_row", return_value=None), \
                    patch.object(chat_api, "create_row_safe", return_value=created) as create_row:
                state = chat_api._ensure_university_request()

        self.assertEqual(state["status"], "pending")
        self.assertIsNotNone(state["channel"])
        self.assertEqual(state["channel"]["name"], "Emory University")
        self.assertTrue(state["channel"]["read_only"])
        self.assertFalse(state["channel"]["approved"])
        self.assertEqual(state["channel"]["university_status"], "pending")
        self.assertEqual(create_row.call_args.kwargs["data"]["label"], "[Uni Channel Approval]")

    def test_message_queries_support_after_delta_loading(self):
        queries = chat_api._message_queries(
            "channel",
            "nest_chat",
            after="2026-05-23T20:00:00Z",
        )
        methods = [json.loads(query)["method"] for query in queries]

        self.assertIn("greaterThan", methods)
        self.assertIn("orderAsc", methods)
        self.assertNotIn("orderDesc", methods)

    def test_chat_event_permissions_are_limited_to_dm_participants(self):
        with patch.object(chat_api, "create_row_safe", return_value={"$id": "event-1"}) as create_row:
            chat_api.emit_chat_event(
                "thread",
                "thread-1",
                "message_created",
                message_id="message-1",
                readable_user_ids=["user-b", "user-a", "user-a"],
            )

        create_row.assert_called_once()
        self.assertEqual(create_row.call_args.kwargs["data"]["message_id"], "message-1")
        self.assertEqual(
            create_row.call_args.kwargs["permissions"],
            ['read("user:user-a")', 'read("user:user-b")'],
        )

    def test_dm_thread_payload_includes_presence_permissions(self):
        thread = {
            "$id": "thread-1",
            "participant_a": "user-1",
            "participant_b": "user-2",
            "created_at": "2026-05-23T20:00:00Z",
        }
        other_user = {
            "$id": "user-2",
            "name": "Test Account",
            "username": "test",
            "school": "Emory University",
            "major": "Biology",
            "graduation_year": "2027",
            "education_level": "Undergraduate",
            "banner_color": "#aabbcc",
            "created_at": "2026-05-20T20:00:00Z",
        }
        with patch.object(chat_api, "current_user", self.user), \
                patch.object(chat_api, "_other_participant", return_value=other_user), \
                patch.object(chat_api, "_is_blocked_between", return_value=False):
            payload = chat_api._thread_payload(thread)

        self.assertEqual(payload["presence_status"], "offline")
        self.assertFalse(payload["other_user"]["online"])
        self.assertEqual(payload["presence_scope"], {
            "scope_type": "thread",
            "scope_id": "thread-1",
            "room_key": "thread:thread-1",
        })
        self.assertEqual(
            payload["presence_read_permissions"],
            ['read("user:user-1")', 'read("user:user-2")'],
        )
        self.assertTrue(payload["presence_profile_resolve_allowed"])
        self.assertEqual(payload["other_user"]["handle"], "@test")
        self.assertEqual(payload["other_user"]["banner_color"], "#aabbcc")
        self.assertEqual(payload["other_user"]["member_since"], "May 20, 2026")
        self.assertTrue(payload["other_user"]["is_emory_school"])
        self.assertTrue(payload["other_user"]["is_early_member"])
        self.assertEqual(payload["other_user"]["major"], "Biology")

    def test_channel_payload_includes_presence_permissions(self):
        discord_payload = chat_api._channel_payload({
            "$id": "nest_chat",
            "kind": "discord",
            "name": "chat",
            "label": "Chat",
            "approved": True,
        })
        self.assertEqual(discord_payload["presence_read_permissions"], ['read("users")'])
        self.assertEqual(discord_payload["presence_scope"]["room_key"], "channel:nest_chat")
        self.assertTrue(discord_payload["presence_profile_resolve_allowed"])

        label = university_presence_label("emory-university")
        self.assertTrue(label.startswith(CHAT_UNIVERSITY_LABEL_PREFIX))
        university_payload = chat_api._channel_payload({
            "$id": "uni_emory-university",
            "kind": "university",
            "name": "Emory University",
            "label": "Emory University",
            "school_key": "emory-university",
            "approved": True,
        })
        self.assertEqual(university_payload["presence_read_permissions"], [f'read("label:{label}")'])

    def test_current_appwrite_labels_accepts_dict_response(self):
        users_service = Mock()
        users_service.get.return_value = {"labels": ["student", "chat_uni_old"]}
        with patch.object(chat_presence, "Users", return_value=users_service):
            labels = chat_presence._current_appwrite_labels("user-1")

        self.assertEqual(labels, ["student", "chat_uni_old"])

    def test_current_appwrite_labels_accepts_model_dump_response(self):
        account = Mock()
        account.model_dump.return_value = {"labels": ["student"]}
        del account.to_dict
        users_service = Mock()
        users_service.get.return_value = account
        with patch.object(chat_presence, "Users", return_value=users_service):
            labels = chat_presence._current_appwrite_labels("user-1")

        self.assertEqual(labels, ["student"])
        account.model_dump.assert_called_once_with(by_alias=True, mode="json")

    def test_current_appwrite_labels_accepts_to_dict_response(self):
        account = Mock()
        account.to_dict.return_value = {"labels": ["mentor"]}
        users_service = Mock()
        users_service.get.return_value = account
        with patch.object(chat_presence, "Users", return_value=users_service):
            labels = chat_presence._current_appwrite_labels("user-1")

        self.assertEqual(labels, ["mentor"])

    def test_current_appwrite_labels_missing_labels_returns_empty_list(self):
        users_service = Mock()
        users_service.get.return_value = {}
        with patch.object(chat_presence, "Users", return_value=users_service):
            labels = chat_presence._current_appwrite_labels("user-1")

        self.assertEqual(labels, [])

    def test_sync_chat_presence_preserves_unrelated_labels(self):
        label = university_presence_label("emory-university")
        users_service = Mock()
        users_service.get.return_value = {
            "labels": ["student", f"{CHAT_UNIVERSITY_LABEL_PREFIX}obsolete"],
        }
        with patch.object(chat_presence, "Users", return_value=users_service), \
                patch.object(chat_presence, "_school_has_approved_channel", return_value=True):
            labels = chat_presence.sync_chat_presence_labels_for_user(
                "user-1",
                {"$id": "user-1", "school_key": "emory-university"},
            )

        self.assertEqual(labels, ["student", label])
        users_service.update_labels.assert_called_once_with("user-1", ["student", label])

    def test_discord_webhook_send_suppresses_mentions(self):
        response = Mock()
        response.status_code = 200
        response.json.return_value = {"id": "discord-message-1", "webhook_id": "webhook-1"}
        with patch.object(discord_bridge, "ensure_chat_webhook", return_value={"id": "webhook-1", "token": "token"}), \
                patch.object(discord_bridge.requests, "post", return_value=response) as post:
            result = discord_bridge.execute_chat_webhook("@everyone hello", "Derek", "https://example.test/a.png")

        self.assertEqual(result["id"], "discord-message-1")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["allowed_mentions"], {"parse": []})
        self.assertEqual(payload["username"], "Derek")


if __name__ == "__main__":
    unittest.main()
