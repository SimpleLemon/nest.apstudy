import html
import json
import unittest
from unittest.mock import patch

import blueprints.chat_api as chat_api
from services import chat_discord_formatting as formatting


class TestChatDiscordFormatting(unittest.TestCase):
    def test_discord_previews_and_images_keep_media_limits_and_fields(self):
        message = {
            "embeds": [
                {"url": f"https://example.test/{index}", "title": f"Embed {index}"}
                for index in range(3)
            ],
            "attachments": [
                {"filename": "mime.png", "content_type": "image/png", "url": "https://cdn/mime"},
                {"filename": "extension.webp", "url": "https://cdn/extension"},
                {"filename": "missing.jpg", "url": ""},
                {"filename": "four.jpeg", "url": "https://cdn/four"},
                {"filename": "five.gif", "url": "https://cdn/five"},
                {"filename": "six.png", "url": "https://cdn/six"},
            ],
        }

        previews = formatting.discord_previews(message)
        images = formatting.discord_images(message)

        self.assertEqual(len(previews), 2)
        self.assertEqual([image["filename"] for image in images], [
            "mime.png",
            "extension.webp",
            "four.jpeg",
            "five.gif",
        ])
        self.assertEqual(images[0]["kind"], "discord_image")
        self.assertEqual(images[0]["content_type"], "image/png")

    def test_discord_attachment_detection_accepts_mime_and_known_extensions(self):
        self.assertTrue(formatting.discord_attachment_is_image({"content_type": "image/png; charset=binary"}))
        self.assertTrue(formatting.discord_attachment_is_image({"filename": "PHOTO.JPG"}))
        self.assertFalse(formatting.discord_attachment_is_image({"filename": "notes.txt", "content_type": "text/plain"}))

    def test_discord_media_json_compacts_and_drops_trailing_items_to_fit(self):
        serialized = formatting.discord_media_json(
            [{"url": "https://example.test", "title": "abcdef", "empty": "", "missing": None}, "skip"],
            [{"kind": "discord_image", "url": "https://cdn.example/image.png"}],
            bounded_string_fn=lambda value, limit: str(value)[:limit],
            text_limit=60,
        )

        self.assertEqual(json.loads(serialized), [{"url": "https://example.test", "title": "abcdef"}])

    def test_discord_ids_and_avatar_identity_are_deterministic(self):
        channel = {"discord_channel_id": "discord-channel"}

        row_id = formatting.discord_message_row_id(channel, "discord-message")
        self.assertEqual(row_id, "discord_c717b7b49a52eb197e5ea545")
        self.assertEqual(row_id, formatting.discord_message_row_id(channel, "discord-message"))
        self.assertNotEqual(row_id, formatting.discord_message_row_id(channel, "other-message"))
        self.assertEqual(
            formatting.discord_message_external_id(channel, "discord-message"),
            "discord:discord-channel:discord-message",
        )
        self.assertIsNone(formatting.discord_message_row_id({}, "discord-message"))
        self.assertIsNone(formatting.discord_message_external_id(channel, ""))

        self.assertEqual(
            formatting.discord_avatar({"id": "user-1", "avatar": "a_hash"}, default_avatar="default"),
            "https://cdn.discordapp.com/avatars/user-1/a_hash.gif?size=128",
        )
        self.assertEqual(
            formatting.discord_avatar({"id": "user-1", "avatar": "hash"}, default_avatar="default"),
            "https://cdn.discordapp.com/avatars/user-1/hash.png?size=128",
        )
        self.assertEqual(formatting.discord_avatar({}, default_avatar="default"), "default")

    def test_discord_row_identity_digest_explicitly_uses_nonsecurity_mode(self):
        sha1 = formatting.hashlib.sha1
        with patch.object(formatting.hashlib, "sha1", wraps=sha1) as digest:
            result = formatting.discord_message_row_id(
                {"discord_channel_id": "discord-channel"}, "discord-message",
            )

        self.assertEqual(result, "discord_c717b7b49a52eb197e5ea545")
        digest.assert_called_once_with(b"discord-channel:discord-message", usedforsecurity=False)

    def test_discord_rendering_escapes_fallback_identity_and_custom_emoji(self):
        markdown_calls = []

        def render_markdown(value):
            markdown_calls.append(value)
            return html.escape(value)

        rendered = formatting.render_discord_content(
            "<@123> <@&456> <:party:123456789012345678>",
            {"mentions": []},
            render_markdown_fn=render_markdown,
            fetch_user_fn=lambda user_id: {"global_name": "User <One>"},
            fetch_roles_fn=lambda: [{"id": "456", "name": "Role & Name"}],
        )

        self.assertEqual(markdown_calls, ["<@123> <@&456> <:party:123456789012345678>"])
        self.assertIn('<span class="chat-mention">@User &lt;One&gt;</span>', rendered)
        self.assertIn('<span class="chat-mention chat-mention-role">@Role &amp; Name</span>', rendered)
        self.assertIn('class="chat-custom-emoji"', rendered)
        self.assertIn("123456789012345678.png?size=48&amp;quality=lossless", rendered)

    def test_discord_message_payload_preserves_full_and_partial_shapes(self):
        callbacks = {
            "default_avatar": "avatar-url",
            "format_datetime_fn": lambda value: f"formatted:{value}",
            "now_fn": lambda: "now",
            "render_discord_content_fn": lambda content, message: f"rendered:{content}",
            "media_json_fn": lambda previews, images: "media-json",
            "bounded_chat_message_value_fn": lambda key, value: value,
        }
        channel = {"$id": "channel-row", "discord_channel_id": "discord-channel"}
        message = {
            "id": "discord-message",
            "author": {"id": "author-1", "username": "user"},
            "content": "hello",
            "embeds": [],
            "attachments": [],
            "webhook_id": "webhook-1",
            "timestamp": "timestamp",
        }

        payload = formatting.discord_message_payload(channel, message, **callbacks)

        self.assertEqual(payload, {
            "channel_id": "channel-row",
            "source": "discord",
            "external_id": "discord:discord-channel:discord-message",
            "discord_message_id": "discord-message",
            "updated_at": "formatted:now",
            "author_name": "user",
            "author_username": "user",
            "author_avatar_url": "avatar-url",
            "content": "hello",
            "rendered_html": "rendered:hello",
            "link_preview_json": "media-json",
            "discord_webhook_id": "webhook-1",
            "created_at": "formatted:timestamp",
        })

        partial = formatting.discord_message_payload(
            channel,
            {"id": "discord-message", "edited_timestamp": "edited"},
            partial=True,
            **callbacks,
        )
        self.assertEqual(partial, {
            "channel_id": "channel-row",
            "source": "discord",
            "external_id": "discord:discord-channel:discord-message",
            "discord_message_id": "discord-message",
            "updated_at": "formatted:now",
        })

    def test_blueprint_render_adapter_keeps_discord_fetchers_patchable(self):
        with patch.object(chat_api, "render_markdown", return_value="&lt;@123&gt; &lt;@&456&gt;"), \
                patch.object(chat_api, "fetch_discord_user", return_value={"global_name": "Fetched User"}) as fetch_user, \
                patch.object(chat_api, "fetch_guild_roles", return_value=[{"id": "456", "name": "Beta Tester"}]) as fetch_roles:
            rendered = chat_api._render_discord_content("source", {"mentions": []})

        self.assertIn('<span class="chat-mention">@Fetched User</span>', rendered)
        self.assertIn('<span class="chat-mention chat-mention-role">@Beta Tester</span>', rendered)
        fetch_user.assert_called_once_with("123")
        fetch_roles.assert_called_once_with()

    def test_blueprint_payload_adapter_binds_only_runtime_policy(self):
        channel = {"$id": "channel-row", "discord_channel_id": "discord-channel"}
        message = {
            "id": "discord-message",
            "author": {},
            "content": "hello",
            "timestamp": "timestamp",
            "embeds": [{"url": "https://example.test", "title": "Preview"}],
            "attachments": [{"filename": "image.png", "url": "https://cdn.example/image.png"}],
        }
        with patch.object(chat_api, "_render_discord_content", return_value="patched-rendered") as render_content, \
                patch.object(chat_api, "_now", return_value="now"), \
                patch.object(chat_api, "format_datetime", return_value="formatted"), \
                patch.object(chat_api, "_bounded_chat_message_value", side_effect=lambda key, value: value):
            payload = chat_api._discord_message_payload(channel, message)

        self.assertEqual(payload["channel_id"], "channel-row")
        self.assertEqual(payload["external_id"], "discord:discord-channel:discord-message")
        self.assertEqual(payload["rendered_html"], "patched-rendered")
        self.assertEqual(payload["author_avatar_url"], chat_api.DEFAULT_AVATAR)
        media = json.loads(payload["link_preview_json"])
        self.assertEqual(media[0]["title"], "Preview")
        self.assertEqual(media[1]["kind"], "discord_image")
        render_content.assert_called_once_with("hello", message)

    def test_blueprint_pure_helpers_are_the_service_entry_points(self):
        for name in (
            "discord_previews", "discord_images", "discord_attachment_is_image",
            "discord_message_row_id", "discord_message_external_id",
            "discord_mention_name", "discord_user_mentions", "mention_span", "emoji_img",
        ):
            with self.subTest(name=name):
                self.assertIs(getattr(chat_api, f"_{name}"), getattr(formatting, name))
