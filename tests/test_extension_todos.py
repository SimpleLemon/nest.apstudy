import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import patch

import app as app_module
from extensions import login_manager
from services.extension_todos import prune_idempotency_receipts
from services.scheduler import _cleanup_note_media
from services.task_calendar import TASK_CALENDAR_ID, task_calendar_events_for_user


class ExtensionTodoTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.db_path = os.path.join(self.temp_dir.name, "todos.sqlite3")
        self.env = patch.dict(
            os.environ,
            {
                "DATABASE_PATH": self.db_path,
                "FLASK_SECRET_KEY": "extension-todo-test-key",
                "FLASK_ENV": "testing",
                "APSTUDY_ALLOW_INSECURE_HTTP": "1",
                "SCHEDULER_ENABLED": "0",
            },
            clear=False,
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        with patch("services.discord_audit.init_discord_audit"), patch("services.scheduler.init_scheduler"):
            self.app = app_module.create_app()
        self.app.config.update(TESTING=True)
        self.users = {
            "user-1": SimpleNamespace(id="user-1", is_authenticated=True, name="One", username="one"),
            "user-2": SimpleNamespace(id="user-2", is_authenticated=True, name="Two", username="two"),
        }
        previous_loader = login_manager._user_callback
        self.addCleanup(setattr, login_manager, "_user_callback", previous_loader)
        login_manager._user_callback = lambda user_id: self.users.get(user_id)

    def client(self, user_id=None):
        client = self.app.test_client()
        if user_id:
            with client.session_transaction() as session:
                session["_user_id"] = user_id
                session["_fresh"] = True
        return client

    def csrf(self, client):
        response = client.get("/api/extension/csrf")
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.headers["X-CSRFToken"]

    def post_todo(self, client, payload, key):
        return client.post(
            "/api/extension/todos",
            json=payload,
            headers={"X-CSRFToken": self.csrf(client), "Idempotency-Key": key},
        )

    def patch_completion(self, client, task_id, completed):
        return client.patch(
            f"/api/extension/todos/{task_id}/completion",
            json={"completed": completed},
            headers={"X-CSRFToken": self.csrf(client)},
        )

    def db_value(self, sql, params=()):
        with sqlite3.connect(self.db_path) as connection:
            return connection.execute(sql, params).fetchone()[0]

    def test_authentication_is_required_for_read_and_mutations(self):
        client = self.client()
        for response in (
            client.get("/api/extension/todos"),
            client.post("/api/extension/todos", json={"title": "No session"}),
            client.patch("/api/extension/todos/missing/completion", json={"completed": True}),
        ):
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.get_json()["error"]["code"], "authentication_required")
            self.assertEqual(response.headers["Cache-Control"], "no-store")

    def test_source_list_lifecycle_rename_delete_and_recreate(self):
        client = self.client("user-1")
        before = client.get("/api/extension/todos")
        self.assertEqual(before.status_code, 200)
        self.assertIsNone(before.get_json()["list"])
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_lists WHERE user_id = 'user-1'"), 0)

        created = self.post_todo(client, {"title": "First", "priority": "low"}, "lifecycle-1")
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        created_payload = created.get_json()
        source_list = created_payload["list"]
        self.assertEqual(source_list["source_key"], "apstudycanvas")
        self.assertEqual(source_list["name"], "APStudyCanvas To-Do")

        renamed = client.patch(
            f"/api/task-lists/{source_list['id']}",
            json={"name": "Canvas imports"},
            headers={"X-CSRFToken": self.csrf(client)},
        )
        self.assertEqual(renamed.status_code, 200, renamed.get_data(as_text=True))
        self.assertEqual(renamed.get_json()["list"]["source_key"], "apstudycanvas")
        self.assertEqual(client.get("/api/extension/todos").get_json()["list"]["name"], "Canvas imports")

        deleted = client.delete(
            f"/api/task-lists/{source_list['id']}",
            json={"confirm": True},
            headers={"X-CSRFToken": self.csrf(client)},
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))
        after_delete = client.get("/api/extension/todos")
        self.assertIsNone(after_delete.get_json()["list"])
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_lists WHERE user_id = 'user-1'"), 0)

        recreated = self.post_todo(client, {"title": "Recreated"}, "lifecycle-2")
        self.assertEqual(recreated.status_code, 201)
        self.assertNotEqual(recreated.get_json()["list"]["id"], source_list["id"])
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_lists WHERE user_id = 'user-1'"), 1)

    def test_cross_user_isolation_and_completion_ownership(self):
        owner = self.client("user-1")
        other = self.client("user-2")
        created = self.post_todo(owner, {"title": "Private todo"}, "isolation-1")
        task_id = created.get_json()["todo"]["id"]

        other_read = other.get("/api/extension/todos")
        self.assertEqual(other_read.status_code, 200)
        self.assertEqual(other_read.get_json()["todos"], [])
        self.assertIsNone(other_read.get_json()["list"])
        rejected = self.patch_completion(other, task_id, True)
        self.assertEqual(rejected.status_code, 404)
        self.assertEqual(rejected.get_json()["error"]["code"], "todo_not_found")

        completed = self.patch_completion(owner, task_id, True)
        self.assertEqual(completed.status_code, 200, completed.get_data(as_text=True))
        self.assertTrue(completed.get_json()["todo"]["completed"])
        self.assertIsNotNone(completed.get_json()["todo"]["completed_at"])

    def test_get_pagination_inclusive_dates_completion_and_explicit_undated(self):
        client = self.client("user-1")
        first = self.post_todo(
            client,
            {"title": "Due on start", "due": "2026-09-10", "timezone": "America/New_York"},
            "filters-1",
        ).get_json()["todo"]
        second = self.post_todo(
            client,
            {"title": "Due on end", "due": "2026-09-11", "timezone": "America/New_York"},
            "filters-2",
        ).get_json()["todo"]
        undated = self.post_todo(client, {"title": "No due date"}, "filters-3").get_json()["todo"]
        self.assertEqual(client.get("/api/extension/todos?limit=2").get_json()["pagination"], {
            "limit": 2,
            "offset": 0,
            "total": 3,
            "has_more": True,
            "next_offset": 2,
        })
        page_two = client.get("/api/extension/todos?limit=2&offset=2").get_json()
        self.assertEqual([todo["id"] for todo in page_two["todos"]], [undated["id"]])

        inclusive = client.get("/api/extension/todos?start=2026-09-10&end=2026-09-10").get_json()
        self.assertEqual([todo["id"] for todo in inclusive["todos"]], [first["id"]])
        completed = self.patch_completion(client, second["id"], True)
        self.assertEqual(completed.status_code, 200)
        incomplete = client.get("/api/extension/todos?completed=false").get_json()["todos"]
        self.assertEqual({todo["id"] for todo in incomplete}, {first["id"], undated["id"]})
        only_completed = client.get("/api/extension/todos?completed=true").get_json()["todos"]
        self.assertEqual([todo["id"] for todo in only_completed], [second["id"]])
        only_undated = client.get("/api/extension/todos?undated=only").get_json()["todos"]
        self.assertEqual([todo["id"] for todo in only_undated], [undated["id"]])
        with_date_default = client.get("/api/extension/todos?start=2026-09-10&end=2026-09-11").get_json()["todos"]
        self.assertEqual({todo["id"] for todo in with_date_default}, {first["id"], second["id"]})
        with_undated = client.get(
            "/api/extension/todos?start=2026-09-10&end=2026-09-11&include_undated=true"
        ).get_json()["todos"]
        self.assertEqual({todo["id"] for todo in with_undated}, {first["id"], second["id"], undated["id"]})

    def test_get_is_read_only_and_does_not_create_source_list(self):
        client = self.client("user-1")
        for query in ("", "?start=2026-01-01&end=2026-01-02", "?completed=false"):
            response = client.get(f"/api/extension/todos{query}")
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.get_json()["list"])
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_lists WHERE source_key = 'apstudycanvas'"), 0)
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 0)

    def test_validation_rejects_invalid_title_metadata_due_and_points(self):
        client = self.client("user-1")
        cases = [
            ({"description": "missing title"}, "missing_field"),
            ({"title": "x" * 256}, "invalid_title"),
            ({"title": "x", "description": "x" * 1001}, "invalid_description"),
            ({"title": "x", "link": "http://canvas.example.edu/item"}, "invalid_link"),
            ({"title": "x", "timezone": "Mars/Olympus"}, "invalid_timezone"),
            ({"title": "x", "priority": "urgent"}, "invalid_priority"),
            ({"title": "x", "due": "not-a-date"}, "invalid_due"),
            ({"title": "x", "points_earned": -1}, "invalid_points_earned"),
            ({"title": "x", "points_possible": float("inf")}, "invalid_points_possible"),
        ]
        for index, (payload, code) in enumerate(cases):
            response = self.post_todo(client, payload, f"validation-{index}")
            self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
            self.assertEqual(response.get_json()["error"]["code"], code)
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_lists"), 0)
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 0)

    def test_idempotency_replay_is_exact_and_conflict_does_not_create(self):
        client = self.client("user-1")
        payload = {
            "title": "Retry me",
            "description": "stable payload",
            "due": "2026-09-20",
            "timezone": "America/New_York",
        }
        first = self.post_todo(client, payload, "same-key")
        replay = self.post_todo(client, payload, "same-key")
        self.assertEqual(first.status_code, 201)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(first.get_json()["todo"], replay.get_json()["todo"])
        self.assertEqual(first.get_json()["list"], replay.get_json()["list"])
        self.assertFalse(first.get_json()["idempotent"])
        self.assertTrue(replay.get_json()["idempotent"])
        conflict = self.post_todo(client, {**payload, "title": "changed"}, "same-key")
        self.assertEqual(conflict.status_code, 409)
        self.assertEqual(conflict.get_json()["error"]["code"], "idempotency_conflict")
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 1)
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_idempotency_receipts"), 1)

    def test_metadata_round_trip(self):
        client = self.client("user-1")
        payload = {
            "title": "Read chapter",
            "description": "Bring notes",
            "link": "https://canvas.example.edu/courses/42/assignments/7",
            "due": "2026-09-21T18:30:00-04:00",
            "timezone": "America/New_York",
            "priority": "high",
            "canvas_account_key": "opaque-account-key",
            "canvas_course_id": 42,
            "canvas_course_label": "BIOL 141",
            "type_label": "Assignment",
            "points_earned": 8,
            "points_possible": 10.5,
            "source_identity": {
                "source_key": "canvas:course-42",
                "item_key": "assignment:7",
                "event_ref": "canvas-event-7",
            },
        }
        response = self.post_todo(client, payload, "metadata-1")
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        todo = response.get_json()["todo"]
        for field in (
            "description", "link", "canvas_account_key", "canvas_course_id", "canvas_course_label",
            "type_label", "points_earned", "points_possible", "source_identity", "source_key",
            "source_item_key", "source_event_ref",
        ):
            derived = {
                "source_key": "canvas:course-42",
                "source_item_key": "assignment:7",
                "source_event_ref": "canvas-event-7",
            }
            if field in derived:
                expected = derived[field]
            elif field == "canvas_course_id":
                expected = str(payload[field])
            else:
                expected = payload[field]
            self.assertEqual(todo[field], expected, field)
        self.assertEqual(todo["due"], "2026-09-21T22:30:00Z")
        fetched = client.get("/api/extension/todos").get_json()["todos"][0]
        self.assertEqual(fetched, todo)

    def test_idempotency_header_and_body_key_conflict_is_rejected(self):
        client = self.client("user-1")
        response = client.post(
            "/api/extension/todos",
            json={"title": "Conflicting", "idempotency_key": "body-key"},
            headers={"X-CSRFToken": self.csrf(client), "Idempotency-Key": "header-key"},
        )
        self.assertEqual(response.status_code, 400, response.get_data(as_text=True))
        self.assertEqual(response.get_json()["error"]["code"], "idempotency_key_conflict")
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 0)
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_idempotency_receipts"), 0)

        matching = client.post(
            "/api/extension/todos",
            json={"title": "Matching", "idempotency_key": "shared-key"},
            headers={"X-CSRFToken": self.csrf(client), "Idempotency-Key": "shared-key"},
        )
        self.assertEqual(matching.status_code, 201, matching.get_data(as_text=True))
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 1)

    def test_type_enum_is_enforced_and_normalized(self):
        client = self.client("user-1")
        rejected = self.post_todo(client, {"title": "Essay", "type": "essay"}, "type-bad")
        self.assertEqual(rejected.status_code, 400, rejected.get_data(as_text=True))
        self.assertEqual(rejected.get_json()["error"]["code"], "invalid_type")
        rejected_number = self.post_todo(client, {"title": "Numeric", "type": 7}, "type-number")
        self.assertEqual(rejected_number.status_code, 400)
        self.assertEqual(rejected_number.get_json()["error"]["code"], "invalid_type")
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 0)

        normalized = self.post_todo(client, {"title": "Quiz", "type": "  QUIZ "}, "type-good")
        self.assertEqual(normalized.status_code, 201, normalized.get_data(as_text=True))
        self.assertEqual(normalized.get_json()["todo"]["type_label"], "quiz")

        labeled = self.post_todo(
            client,
            {"title": "Labeled", "type": "discussion", "type_label": "Discussion post"},
            "type-label",
        )
        self.assertEqual(labeled.status_code, 201, labeled.get_data(as_text=True))
        self.assertEqual(labeled.get_json()["todo"]["type_label"], "Discussion post")

    def test_completion_is_scoped_to_the_integration_list(self):
        client = self.client("user-1")
        created = self.post_todo(client, {"title": "Integration task"}, "scope-1")
        todo_id = created.get_json()["todo"]["id"]
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """INSERT INTO task_lists
                   (id, user_id, name, description, source_key, "order", collapsed, hidden,
                    sort_mode, created_at, updated_at)
                   VALUES ('manual-list', 'user-1', 'Manual', '', NULL, 1, 0, 0, 'default', ?, ?)""",
                ("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"),
            )
            connection.execute(
                """INSERT INTO tasks
                   (id, user_id, list_id, title, priority, deadline_at, deadline_time, timezone,
                    completed, completed_at, starred, created_at, updated_at)
                   VALUES ('manual-task', 'user-1', 'manual-list', 'Manual task', 'medium',
                           NULL, NULL, 'UTC', 0, NULL, 0, ?, ?)""",
                ("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"),
            )
            connection.commit()

        rejected = self.patch_completion(client, "manual-task", True)
        self.assertEqual(rejected.status_code, 404)
        self.assertEqual(rejected.get_json()["error"]["code"], "todo_not_found")
        self.assertEqual(self.db_value("SELECT completed FROM tasks WHERE id = 'manual-task'"), 0)

        allowed = self.patch_completion(client, todo_id, True)
        self.assertEqual(allowed.status_code, 200, allowed.get_data(as_text=True))
        self.assertTrue(allowed.get_json()["todo"]["completed"])

    def test_source_list_delete_requires_confirmation_then_recreates(self):
        client = self.client("user-1")
        created = self.post_todo(client, {"title": "Guarded"}, "guard-1")
        source_list = created.get_json()["list"]

        tasks_payload = client.get("/api/tasks").get_json()
        integration = next(item for item in tasks_payload["lists"] if item["id"] == source_list["id"])
        self.assertEqual(integration["source_key"], "apstudycanvas")

        unconfirmed = client.delete(
            f"/api/task-lists/{source_list['id']}",
            headers={"X-CSRFToken": self.csrf(client)},
        )
        self.assertEqual(unconfirmed.status_code, 409, unconfirmed.get_data(as_text=True))
        payload = unconfirmed.get_json()
        self.assertEqual(payload["code"], "integration_list_confirmation_required")
        self.assertEqual(payload["warning"]["list_name"], "APStudyCanvas To-Do")
        self.assertEqual(payload["warning"]["task_count"], 1)
        self.assertEqual(
            self.db_value("SELECT COUNT(*) FROM task_lists WHERE id = ?", (source_list["id"],)),
            1,
        )
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 1)

        confirmed = client.delete(
            f"/api/task-lists/{source_list['id']}",
            json={"confirm": True},
            headers={"X-CSRFToken": self.csrf(client)},
        )
        self.assertEqual(confirmed.status_code, 200, confirmed.get_data(as_text=True))
        self.assertEqual(
            self.db_value("SELECT COUNT(*) FROM task_lists WHERE id = ?", (source_list["id"],)),
            0,
        )
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM tasks"), 0)

        recreated = self.post_todo(client, {"title": "Back again"}, "guard-2")
        self.assertEqual(recreated.status_code, 201)
        self.assertNotEqual(recreated.get_json()["list"]["id"], source_list["id"])
        self.assertEqual(recreated.get_json()["list"]["source_key"], "apstudycanvas")

    def test_ordinary_lists_delete_without_confirmation(self):
        client = self.client("user-1")
        created = client.post(
            "/api/task-lists",
            json={"name": "Mine"},
            headers={"X-CSRFToken": self.csrf(client)},
        )
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        self.assertNotIn("source_key", created.get_json()["list"])
        list_id = created.get_json()["list"]["id"]
        deleted = client.delete(
            f"/api/task-lists/{list_id}",
            headers={"X-CSRFToken": self.csrf(client)},
        )
        self.assertEqual(deleted.status_code, 200, deleted.get_data(as_text=True))

    def test_idempotency_receipts_are_pruned_by_the_daily_cleanup_job(self):
        client = self.client("user-1")
        self.post_todo(client, {"title": "Old receipt"}, "prune-old")
        self.post_todo(client, {"title": "Fresh receipt"}, "prune-fresh")
        stale_timestamp = (
            datetime.now(timezone.utc) - timedelta(days=31)
        ).isoformat().replace("+00:00", "Z")
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                "UPDATE task_idempotency_receipts SET created_at = ? WHERE idempotency_key = ?",
                (stale_timestamp, "prune-old"),
            )
            connection.commit()
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_idempotency_receipts"), 2)

        _cleanup_note_media(self.app)

        self.assertEqual(
            self.db_value("SELECT COUNT(*) FROM task_idempotency_receipts WHERE idempotency_key = ?",
                          ("prune-old",)),
            0,
        )
        self.assertEqual(self.db_value("SELECT COUNT(*) FROM task_idempotency_receipts"), 1)
        self.assertEqual(
            self.db_value("SELECT idempotency_key FROM task_idempotency_receipts"),
            "prune-fresh",
        )
        self.assertEqual(prune_idempotency_receipts(), 0)

    def test_new_extension_tasks_and_existing_tasks_project_to_local_tasks_calendar(self):
        client = self.client("user-1")
        created = self.post_todo(
            client,
            {
                "title": "Extension calendar task",
                "due": "2026-09-22T12:00:00Z",
                "timezone": "UTC",
                "priority": "high",
            },
            "calendar-1",
        )
        self.assertEqual(created.status_code, 201)
        with sqlite3.connect(self.db_path) as connection:
            connection.execute(
                """INSERT INTO task_lists
                   (id, user_id, name, description, source_key, "order", collapsed, hidden,
                    sort_mode, created_at, updated_at)
                   VALUES ('legacy-list', 'user-1', 'Legacy', '', NULL, 1, 0, 0, 'default', ?, ?)""",
                ("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"),
            )
            connection.execute(
                """INSERT INTO tasks
                   (id, user_id, list_id, title, priority, deadline_at, deadline_time, timezone,
                    completed, completed_at, starred, created_at, updated_at)
                   VALUES ('legacy-task', 'user-1', 'legacy-list', 'Existing task', 'medium',
                           '2026-09-22T13:00:00Z', '13:00', 'UTC', 0, NULL, 0, ?, ?)""",
                ("2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"),
            )
            connection.commit()

        events = task_calendar_events_for_user("user-1")
        self.assertEqual({event["task_id"] for event in events}, {created.get_json()["todo"]["id"], "legacy-task"})
        extension_event = next(event for event in events if event["task_id"] == created.get_json()["todo"]["id"])
        self.assertEqual(extension_event["calendar_id"], TASK_CALENDAR_ID)
        self.assertEqual(extension_event["type"], "task")
        self.assertEqual(extension_event["priority"], "high")
        self.assertEqual(extension_event["reminder_minutes"], 10)


if __name__ == "__main__":
    unittest.main()
