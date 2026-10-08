import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from flask import Flask
from flask_login import UserMixin

from blueprints import chat_api
from extensions import login_manager
from services import chat_message_delivery, database
from tests.support.harness import reset_flask_login_manager


class _User(UserMixin):
    id = "viewer"


class ChatMessagePaginationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db_path = str(Path(directory.name) / "chat.sqlite3")
        database.init_db(path=self.db_path)
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.config.update(DATABASE_PATH=self.db_path, SERVER_NAME="example.test", TESTING=True)
        for name in ("_user_callback", "unauthorized_callback", "login_view"):
            self.addCleanup(setattr, login_manager, name, getattr(login_manager, name))
        self.addCleanup(reset_flask_login_manager)
        login_manager.login_view = None
        login_manager.unauthorized_callback = None
        login_manager.init_app(self.app)
        login_manager.user_loader(lambda _id: _User())
        self.app.register_blueprint(chat_api.chat_api_bp)
        database.create_row("chat_channels", "general", {"name": "General", "kind": "appwrite", "created_at": "2026-01-01T00:00:00Z"}, path=self.db_path)
        for name, kwargs in {
            "_can_access_channel": {"return_value": True},
            "_channel_payload": {"return_value": {"id": "general"}},
            "_room_message_metadata": {"return_value": {}},
            "_thread_for_user": {"return_value": {"$id": "general", "participant_a": "viewer", "participant_b": "other"}},
            "_public_user": {"return_value": None},
            "_thread_payload": {"return_value": {}},
            "_blocked_user_ids": {"return_value": set()},
            "_serialize_messages": {"side_effect": lambda rows: [{"id": row["$id"], "created_at": row["created_at"]} for row in rows]},
        }.items():
            patcher = patch.object(chat_api, name, **kwargs)
            self.addCleanup(patcher.stop)
            patcher.start()
        self.client = self.app.test_client()
        with self.client.session_transaction() as session:
            session["_user_id"] = "viewer"
            session["_fresh"] = True
        self.timestamp = "2026-01-01T00:00:00Z"

    def seed(self, message_id, created_at=None, **fields):
        database.create_row("chat_messages", message_id, {
            "channel_id": "general", "thread_id": "general", "user_id": "viewer",
            "created_at": created_at or self.timestamp, **fields,
        }, path=self.db_path)

    def page(self, route, **cursor):
        response = self.client.get(route, query_string=cursor)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_trimmed_timestamp_boundary_is_recovered_by_both_actual_routes(self):
        self.seed("outside", channel_id="other", thread_id="other")
        self.seed("cut-2")
        self.seed("cut-1")
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        for index in range(49):
            self.seed(f"new-{index:02}", (start + timedelta(minutes=index + 1)).isoformat().replace("+00:00", "Z"))
        for route in ("/api/chat/channels/general/messages", "/api/chat/dm/threads/general/messages"):
            with self.subTest(route=route):
                initial = self.page(route)
                self.assertEqual(len(initial["messages"]), 50)
                self.assertEqual(initial["messages"][0]["id"], "cut-2")
                self.assertTrue(initial["has_more"])
                history = self.page(route, before=self.timestamp, before_message_id="cut-2")
                self.assertEqual([row["id"] for row in history["messages"]], ["cut-1"])
                self.assertFalse(history["has_more"])
                # Older clients keep the strict timestamp-only behavior.
                self.assertEqual(self.page(route, before=self.timestamp)["messages"], [])

    def test_more_than_two_pages_of_ties_have_stable_order_and_no_missing_ids(self):
        for index in reversed(range(121)):
            self.seed(f"message-{index:03}")
        route = "/api/chat/channels/general/messages"
        pages = [self.page(route)]
        while pages[-1]["has_more"]:
            oldest = pages[-1]["messages"][0]
            pages.append(self.page(route, before=oldest["created_at"], before_message_id=oldest["id"]))
        self.assertEqual([len(page["messages"]) for page in pages], [50, 50, 21])
        ids = [row["id"] for page in reversed(pages) for row in page["messages"]]
        self.assertEqual(ids, [f"message-{index:03}" for index in range(121)])

    def test_service_backward_page_fills_across_ties_earlier_rows_and_filtered_rows(self):
        earlier = "2025-12-31T23:59:00Z"
        for index in range(60):
            self.seed(f"earlier-{index:03}", earlier)
        for index in range(70):
            self.seed(f"tie-{index:03}", deleted_at=self.timestamp if index >= 20 else None)
        self.seed("tie-080", user_id="blocked")
        self.seed("tie-090")
        with self.app.app_context(), patch.object(chat_api, "_current_user_id", return_value="viewer"), \
                patch.object(chat_api, "_blocked_user_ids", return_value={"blocked"}):
            rows, has_more = chat_message_delivery.list_room_messages(
                "thread", "general", self.timestamp, None, None,
                before_message_id="tie-090", list_messages_fn=chat_api._list_messages,
                page_size=chat_api.MESSAGE_PAGE_SIZE,
            )
        self.assertTrue(has_more)
        self.assertEqual([row["$id"] for row in rows],
                         [f"earlier-{index:03}" for index in range(30, 60)] + [f"tie-{index:03}" for index in range(20)])

    def test_forward_id_cursor_queries_ties_without_widening_or_repeating_the_anchor(self):
        for index in reversed(range(121)):
            self.seed(f"message-{index:03}")
        route = "/api/chat/channels/general/messages"
        payload = self.page(route, after=self.timestamp, after_message_id="message-050")
        self.assertFalse(payload["has_more"])
        self.assertEqual([row["id"] for row in payload["messages"]], [f"message-{index:03}" for index in range(51, 101)])
        missing_anchor = self.page(route, after=self.timestamp, after_message_id="message-050-missing")
        self.assertEqual([row["id"] for row in missing_anchor["messages"]], [f"message-{index:03}" for index in range(51, 101)])

    def test_id_only_backward_cursor_and_ordinary_timestamp_before_remain_available(self):
        self.seed("a", "2025-12-31T23:58:00Z")
        self.seed("b", "2025-12-31T23:59:00Z")
        self.seed("c")
        route = "/api/chat/channels/general/messages"
        self.assertEqual([row["id"] for row in self.page(route, before=self.timestamp)["messages"]], ["a", "b"])
        self.assertEqual([row["id"] for row in self.page(route, before_message_id="c")["messages"]], ["a", "b"])
        self.assertEqual(self.page(route, before_message_id="missing")["messages"], [])


if __name__ == "__main__":
    unittest.main()
