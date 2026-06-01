import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

import blueprints.chat_api as chat_api
from avatar_images import APSTUDY_LOGO_URL
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

    def test_missing_public_user_avatar_uses_neutral_default(self):
        payload = chat_api._public_user({"$id": "user-2", "name": "No Avatar"})

        self.assertTrue(payload["picture_url"].startswith("data:image/svg+xml"))
        self.assertNotEqual(payload["picture_url"], APSTUDY_LOGO_URL)

    def test_missing_message_avatar_serializes_neutral_default(self):
        row = {
            "$id": "message-1",
            "user_id": "user-1",
            "source": "appwrite",
            "author_name": "No Avatar",
            "created_at": "2026-05-25T00:00:00Z",
        }
        with self.app.test_request_context("/api/chat/channels/nest_chat/messages"):
            with patch.object(chat_api, "current_user", self.user):
                payload = chat_api._serialize_message(row)

        self.assertTrue(payload["author_avatar_url"].startswith("data:image/svg+xml"))
        self.assertNotEqual(payload["author_avatar_url"], APSTUDY_LOGO_URL)

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
                    patch.object(chat_api, "emit_chat_event") as emit_event, \
                    patch.object(chat_api, "emit_audit_event") as emit_audit:
                response = chat_api.delete_message.__wrapped__("message-1")

        self.assertEqual(response.status_code if hasattr(response, "status_code") else 200, 200)
        update_row.assert_called_once()
        payload = update_row.call_args.args[2]
        self.assertEqual(payload["deleted_by"], "user-1")
        self.assertIn("deleted_at", payload)
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[:3], ("channel", "nest_chat", "message_deleted"))
        emit_audit.assert_called_once()
        audit_event = emit_audit.call_args.args[0]
        self.assertEqual(audit_event.channel, "chat_deletes")
        self.assertEqual(audit_event.metadata["message_id"], "message-1")

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
        self.assertLessEqual(len(label), 36)
        self.assertRegex(label, r"^[A-Za-z0-9]+$")
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
            "labels": ["student", "chat_uni_old", "bad-label!"],
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

    def test_discord_image_attachments_become_images_not_previews(self):
        message = {
            "attachments": [{
                "filename": "schedule.png",
                "url": "https://cdn.discordapp.com/attachments/channel/message/schedule.png",
                "proxy_url": "https://media.discordapp.net/attachments/channel/message/schedule.png",
                "content_type": "image/png",
                "width": 640,
                "height": 360,
            }],
        }
        previews = chat_api._discord_previews(message)
        images = chat_api._discord_images(message)

        self.assertEqual(previews, [])
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0]["kind"], "discord_image")
        self.assertEqual(images[0]["filename"], "schedule.png")
        self.assertEqual(images[0]["url"], "https://cdn.discordapp.com/attachments/channel/message/schedule.png")
        self.assertEqual(images[0]["proxy_url"], "https://media.discordapp.net/attachments/channel/message/schedule.png")

    def test_serialize_message_splits_discord_images_from_previews(self):
        row = {
            "$id": "message-1",
            "created_at": "2026-05-23T20:00:00Z",
            "link_preview_json": json.dumps([
                {"url": "https://example.test", "title": "Example"},
                {"kind": "discord_image", "url": "https://cdn.discordapp.com/image.png"},
            ]),
        }
        payload = chat_api._serialize_message(row)

        self.assertEqual(payload["previews"], [{"url": "https://example.test", "title": "Example"}])
        self.assertEqual(payload["images"], [{"kind": "discord_image", "url": "https://cdn.discordapp.com/image.png"}])

    def test_discord_mentions_render_as_inert_pills(self):
        message = {
            "content": "hi <@123> and <@&456>",
            "mentions": [{"id": "123", "global_name": "Derek Chen", "username": "derek"}],
        }
        with patch.object(chat_api, "fetch_guild_roles", return_value=[{"id": "456", "name": "Beta Tester"}]):
            rendered = chat_api._render_discord_content(message["content"], message)

        self.assertIn('<span class="chat-mention">@Derek Chen</span>', rendered)
        self.assertIn('<span class="chat-mention chat-mention-role">@Beta Tester</span>', rendered)
        self.assertNotIn("&lt;@123&gt;", rendered)
        self.assertNotIn("&lt;@&456&gt;", rendered)

    def test_discord_mentions_fetch_user_name_when_payload_missing(self):
        message = {"content": "hi <@123>", "mentions": []}
        with patch.object(chat_api, "fetch_discord_user", return_value={"id": "123", "global_name": "Fetched User"}):
            rendered = chat_api._render_discord_content(message["content"], message)

        self.assertIn('<span class="chat-mention">@Fetched User</span>', rendered)

    def test_discord_custom_emojis_render_as_lazy_cdn_images(self):
        message = {
            "content": "look <:bleak:1320062766026854541> <a:party:123456789012345678>",
            "mentions": [],
        }

        rendered = chat_api._render_discord_content(message["content"], message)

        self.assertIn('class="chat-custom-emoji"', rendered)
        self.assertIn("https://cdn.discordapp.com/emojis/1320062766026854541.png?size=48&amp;quality=lossless", rendered)
        self.assertIn("https://cdn.discordapp.com/emojis/123456789012345678.gif?size=48&amp;quality=lossless", rendered)
        self.assertIn('alt=":bleak:"', rendered)
        self.assertIn('loading="lazy"', rendered)
        self.assertNotIn("&lt;:bleak:1320062766026854541&gt;", rendered)

    def test_discord_upsert_emits_realtime_event_for_new_message(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        message = {
            "id": "discord-message-1",
            "content": "fresh from discord",
            "timestamp": "2026-05-26T22:00:00Z",
            "author": {"id": "author-1", "username": "UrbanPanda"},
        }

        with patch.object(chat_api, "first_row", return_value=None), \
                patch.object(chat_api, "create_row_safe", return_value={"$id": "row-1"}) as create_row, \
                patch.object(chat_api, "emit_chat_event") as emit_event:
            row, created = chat_api._upsert_discord_message(channel, message, emit_event=True)

        self.assertTrue(created)
        self.assertEqual(row["$id"], "row-1")
        create_row.assert_called_once()
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[:3], ("channel", "nest_chat", "message_created"))
        self.assertEqual(emit_event.call_args.kwargs["message_id"], "row-1")
        self.assertEqual(emit_event.call_args.kwargs["channel_id"], "nest_chat")

    def test_discord_upsert_does_not_emit_event_for_existing_message(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        message = {
            "id": "discord-message-1",
            "content": "edited discord payload",
            "timestamp": "2026-05-26T22:00:00Z",
            "author": {"id": "author-1", "username": "UrbanPanda"},
        }

        with patch.object(chat_api, "first_row", return_value={"$id": "existing-row"}), \
                patch.object(chat_api, "update_row_safe", return_value={"$id": "existing-row"}) as update_row, \
                patch.object(chat_api, "emit_chat_event") as emit_event:
            row, created = chat_api._upsert_discord_message(channel, message, emit_event=True)

        self.assertFalse(created)
        self.assertEqual(row["$id"], "existing-row")
        update_row.assert_called_once()
        emit_event.assert_not_called()

    def test_discord_upsert_skips_update_for_unchanged_existing_message(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        message = {
            "id": "discord-message-1",
            "content": "same discord payload",
            "timestamp": "2026-05-26T22:00:00Z",
            "author": {"id": "author-1", "username": "UrbanPanda"},
        }
        existing = {
            "$id": "existing-row",
            **chat_api._discord_message_payload(channel, message),
            "updated_at": "2026-05-26T22:01:00Z",
        }

        with patch.object(chat_api, "first_row", return_value=existing), \
                patch.object(chat_api, "update_row_safe") as update_row, \
                patch.object(chat_api, "emit_chat_event") as emit_event:
            row, created = chat_api._upsert_discord_message(channel, message, emit_event=True)

        self.assertFalse(created)
        self.assertEqual(row["$id"], "existing-row")
        update_row.assert_not_called()
        emit_event.assert_not_called()

    def test_discord_upsert_updates_only_changed_fields_for_existing_message(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        original = {
            "id": "discord-message-1",
            "content": "old discord payload",
            "timestamp": "2026-05-26T22:00:00Z",
            "author": {"id": "author-1", "username": "UrbanPanda"},
        }
        edited = {
            **original,
            "content": "edited discord payload",
        }
        existing = {
            "$id": "existing-row",
            **chat_api._discord_message_payload(channel, original),
            "updated_at": "2026-05-26T22:01:00Z",
        }

        with patch.object(chat_api, "first_row", return_value=existing), \
                patch.object(chat_api, "update_row_safe", return_value={"$id": "existing-row"}) as update_row:
            row, created = chat_api._upsert_discord_message(channel, edited)

        self.assertFalse(created)
        self.assertEqual(row["$id"], "existing-row")
        update_row.assert_called_once()
        payload = update_row.call_args.args[2]
        self.assertEqual(set(payload), {"content", "rendered_html", "updated_at"})
        self.assertEqual(payload["content"], "edited discord payload")

    def test_discord_message_payload_normalizes_schema_bounded_values(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        message = {
            "id": "discord-message-1",
            "content": "payload with media",
            "timestamp": "2026-05-26T22:00:00Z",
            "webhook_id": "w" * 100,
            "author": {
                "id": "author-1",
                "global_name": "D" * 200,
                "username": "u" * 100,
                "avatar": "avatarhash",
            },
            "embeds": [{
                "url": "https://example.test/" + ("x" * 3000),
                "title": "T" * 3000,
                "description": "D" * 3000,
                "provider": {"name": "Example"},
                "type": "link",
            }],
            "attachments": [{
                "filename": "schedule-" + ("x" * 3000) + ".png",
                "url": "https://cdn.discordapp.com/attachments/image.png",
                "content_type": "image/png",
                "width": 640,
                "height": 360,
            }],
        }

        payload = chat_api._discord_message_payload(channel, message)

        self.assertEqual(len(payload["author_name"]), 120)
        self.assertEqual(len(payload["author_username"]), 64)
        self.assertEqual(len(payload["discord_webhook_id"]), 32)
        self.assertLessEqual(len(payload["link_preview_json"]), chat_api.CHAT_MESSAGE_TEXT_LIMIT)
        media = json.loads(payload["link_preview_json"])
        self.assertEqual(media[1]["kind"], "discord_image")
        self.assertLessEqual(len(media[0]["title"]), 2048)

    def test_discord_upsert_returns_false_when_existing_update_fails(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        original = {
            "id": "discord-message-1",
            "content": "old discord payload",
            "timestamp": "2026-05-26T22:00:00Z",
            "author": {"id": "author-1", "username": "UrbanPanda"},
        }
        edited = {
            **original,
            "content": "edited discord payload",
        }
        existing = {
            "$id": "existing-row",
            **chat_api._discord_message_payload(channel, original),
        }

        with patch.object(chat_api, "first_row", return_value=existing), \
                patch.object(chat_api, "update_row_safe", side_effect=chat_api.AppwriteException("Server Error")), \
                patch.object(chat_api.logger, "exception") as log_exception:
            row, created = chat_api._upsert_discord_message(channel, edited)

        self.assertIsNone(row)
        self.assertFalse(created)
        log_exception.assert_called_once()

    def test_discord_ingest_endpoint_upserts_and_emits_for_bot_message(self):
        channel = {
            "$id": "nest_chat",
            "kind": "discord",
            "discord_channel_id": "discord-channel",
        }
        payload = {
            "message": {
                "id": "discord-message-2",
                "channel_id": "discord-channel",
                "content": "bot saw this first",
                "timestamp": "2026-05-26T22:01:00Z",
                "author": {"id": "author-1", "username": "UrbanPanda"},
            },
        }

        with self.app.test_request_context(
            "/api/chat/discord/messages",
            method="POST",
            json=payload,
            headers={"Authorization": "Bearer ingest-secret"},
        ):
            with patch.dict(os.environ, {"DISCORD_CHAT_INGEST_SECRET": "ingest-secret"}, clear=False), \
                    patch.object(chat_api, "first_row", side_effect=[channel, None]), \
                    patch.object(chat_api, "create_row_safe", return_value={"$id": "row-2"}) as create_row, \
                    patch.object(chat_api, "emit_chat_event") as emit_event:
                response = chat_api.discord_message_ingest()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["message_id"], "row-2")
        create_row.assert_called_once()
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[:3], ("channel", "nest_chat", "message_created"))

    def test_discord_ingest_endpoint_requires_shared_secret(self):
        with self.app.test_request_context(
            "/api/chat/discord/messages",
            method="POST",
            json={"message": {"id": "discord-message-2", "channel_id": "discord-channel"}},
        ):
            with patch.dict(os.environ, {"DISCORD_CHAT_INGEST_SECRET": "ingest-secret"}, clear=False):
                response, status = chat_api.discord_message_ingest()

        self.assertEqual(status, 403)
        self.assertIn("unavailable", response.get_json()["error"])


if __name__ == "__main__":
    unittest.main()
