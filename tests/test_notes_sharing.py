import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Blueprint, Flask

import blueprints.dashboard as dashboard
import blueprints.notes_api as notes_api
from services import note_store


class NotesSharingStoreTests(unittest.TestCase):
    def setUp(self):
        handle, self.path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)
        self.addCleanup(lambda: os.path.exists(self.path) and os.remove(self.path))
        self.env = patch.dict(os.environ, {"DATABASE_PATH": self.path})
        self.env.start()
        self.addCleanup(self.env.stop)
        with sqlite3.connect(self.path) as conn:
            conn.executescript(
                """
                CREATE TABLE users (
                    id TEXT PRIMARY KEY, name TEXT, username TEXT, email TEXT,
                    picture_url TEXT, created_at TEXT
                );
                CREATE TABLE note_folders (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
                    "order" INTEGER, created_at TEXT NOT NULL, updated_at TEXT
                );
                CREATE TABLE notes (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, folder_id TEXT,
                    title TEXT, content TEXT, preview_text TEXT, page_setup_json TEXT,
                    "order" INTEGER, created_at TEXT NOT NULL, updated_at TEXT
                );
                """
            )
            root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            for filename in ("003_notes_sharing.sql", "004_notes_collaboration.sql"):
                with open(os.path.join(root, "migrations", filename), encoding="utf-8") as migration:
                    conn.executescript(migration.read())
            conn.executemany(
                "INSERT INTO users (id, name, username, email, picture_url, created_at) VALUES (?, ?, ?, ?, '', ?)",
                [
                    ("owner", "Owner Name", "owner", "owner@example.test", "2026-01-01T00:00:00Z"),
                    ("viewer", "Viewer Name", "viewer", "viewer@example.test", "2026-01-01T00:00:00Z"),
                    ("other", "Other User", "other", "other@example.test", "2026-01-01T00:00:00Z"),
                ],
            )
            conn.execute(
                "INSERT INTO note_folders (id, user_id, name, \"order\", created_at) VALUES ('folder-1', 'owner', 'Shared Folder', 1, '2026-01-01T00:00:00Z')"
            )
            conn.executemany(
                """
                INSERT INTO notes (id, user_id, folder_id, title, content, preview_text, "order", created_at, updated_at)
                VALUES (?, 'owner', ?, ?, '[]', ?, 1, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
                """,
                [
                    ("folder-note", "folder-1", "Folder Note", "Inside folder"),
                    ("standalone-note", None, "Standalone Note", "Outside folder"),
                ],
            )

    def test_public_named_and_folder_access_is_dynamic(self):
        folder_note = note_store.get_note("folder-note")
        self.assertFalse(note_store.resolve_note_access(folder_note)["can_view"])

        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=True, user_ids=["viewer"], granted_by_user_id="owner"
        )
        self.assertEqual(note_store.resolve_note_access(folder_note)["source"], "folder_public")
        self.assertEqual(note_store.resolve_note_access(folder_note, "viewer")["source"], "folder_user")
        self.assertTrue(note_store.resolve_note_access(folder_note, "owner")["can_edit"])

        with sqlite3.connect(self.path) as conn:
            conn.execute("UPDATE notes SET folder_id = NULL WHERE id = 'folder-note'")
        moved = note_store.get_note("folder-note")
        self.assertFalse(note_store.resolve_note_access(moved, "viewer")["can_view"])

        note_store.replace_resource_grants(
            "note", "folder-note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        self.assertEqual(note_store.resolve_note_access(moved, "viewer")["source"], "note_user")

    def test_grants_are_unique_replaceable_and_removed_with_resource(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=True,
            user_ids=["viewer", "viewer"], granted_by_user_id="owner",
        )
        state = note_store.sharing_state("note", "standalone-note")
        self.assertTrue(state["public"])
        self.assertEqual([user["id"] for user in state["users"]], ["viewer"])

        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            user_ids=["other"], granted_by_user_id="owner",
        )
        state = note_store.sharing_state("note", "standalone-note")
        self.assertFalse(state["public"])
        self.assertEqual([user["id"] for user in state["users"]], ["other"])
        note_store.delete_note("standalone-note")
        self.assertEqual(note_store.resource_grants("note", "standalone-note"), [])

    def test_migration_enforces_one_grant_per_resource_principal(self):
        grant = (
            "grant-1", "owner", "note", "standalone-note", "user", "viewer",
            "viewer", "owner", "2026-01-01T00:00:00Z",
        )
        with sqlite3.connect(self.path) as conn:
            conn.execute(
                """
                INSERT INTO note_access_grants (
                    id, owner_user_id, resource_type, resource_id, principal_type,
                    principal_id, access_level, granted_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                grant,
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    INSERT INTO note_access_grants (
                        id, owner_user_id, resource_type, resource_id, principal_type,
                        principal_id, access_level, granted_by_user_id, created_at
                    ) VALUES ('grant-2', 'owner', 'note', 'standalone-note',
                              'user', 'viewer', 'viewer', 'owner',
                              '2026-01-01T00:00:00Z')
                    """
                )

    def test_shared_with_me_groups_folder_notes_and_deduplicates_direct_grants(self):
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        note_store.replace_resource_grants(
            "note", "folder-note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        payload = note_store.list_shared_for_user("viewer")
        self.assertEqual([folder["id"] for folder in payload["folders"]], ["folder-1"])
        self.assertEqual([note["id"] for note in payload["folders"][0]["notes"]], ["folder-note"])
        self.assertEqual([note["id"] for note in payload["notes"]], ["standalone-note"])

    def test_user_search_uses_public_profile_fields_only(self):
        results = note_store.search_share_users("@view", "owner")
        self.assertEqual([user["id"] for user in results], ["viewer"])
        self.assertNotIn("email", results[0])

    def test_public_note_api_returns_owner_and_read_only_capabilities(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=True, user_ids=[], granted_by_user_id="owner"
        )
        app = Flask(__name__)
        app.secret_key = "test"
        with app.test_request_context("/api/notes/standalone-note"):
            anonymous = SimpleNamespace(is_authenticated=False)
            with patch.object(notes_api, "current_user", anonymous), patch.object(
                notes_api, "_load_global_notes_page_setup", return_value={}
            ):
                response = notes_api.get_note("standalone-note")
        payload = response.get_json()
        self.assertEqual(payload["access"]["role"], "viewer")
        self.assertFalse(payload["access"]["can_edit"])
        self.assertEqual(payload["owner"]["id"], "owner")
        self.assertEqual(payload["owner"]["profile_url"], "/u/owner")
        self.assertNotIn("email", payload["owner"])

    def test_private_note_api_requires_login_then_hides_from_other_users(self):
        app = Flask(__name__)
        app.secret_key = "test"
        with app.test_request_context("/api/notes/standalone-note"):
            with patch.object(notes_api, "current_user", SimpleNamespace(is_authenticated=False)):
                response, status = notes_api.get_note("standalone-note")
        self.assertEqual(status, 401)
        self.assertTrue(response.get_json()["login_required"])

        with app.test_request_context("/api/notes/standalone-note"):
            outsider = SimpleNamespace(id="other", is_authenticated=True)
            with patch.object(notes_api, "current_user", outsider):
                response, status = notes_api.get_note("standalone-note")
        self.assertEqual(status, 404)
        self.assertEqual(response.get_json()["error"], "Not found.")

    def test_owner_can_replace_public_and_named_sharing_together(self):
        app = Flask(__name__)
        app.secret_key = "test"
        owner = SimpleNamespace(id="owner", is_authenticated=True)
        with app.test_request_context(
            "/api/notes/standalone-note/sharing",
            method="PATCH",
            json={"public": True, "user_ids": ["viewer"]},
        ):
            with patch.object(notes_api, "current_user", owner), patch.object(
                notes_api, "_sharing_url", return_value="https://example.test/notes/standalone-note"
            ):
                response = notes_api.note_sharing.__wrapped__("standalone-note")
        payload = response.get_json()
        self.assertTrue(payload["public"])
        self.assertEqual([user["id"] for user in payload["users"]], ["viewer"])

    def test_sharing_update_rejects_non_boolean_public_state(self):
        app = Flask(__name__)
        app.secret_key = "test"
        owner = SimpleNamespace(id="owner", is_authenticated=True)
        with app.test_request_context(
            "/api/notes/standalone-note/sharing",
            method="PATCH",
            json={"public": "yes", "user_ids": []},
        ), patch.object(notes_api, "current_user", owner):
            response, status = notes_api._replace_sharing(
                "note", "standalone-note", "owner"
            )
        self.assertEqual(status, 400)
        self.assertEqual(response.get_json()["error"], "public must be a boolean.")


class NotesSharingPageTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        auth = Blueprint("auth", __name__)
        auth.add_url_rule("/", "index", lambda: "")
        auth.add_url_rule("/login", "login", lambda: "")
        self.app.register_blueprint(auth)
        self.app.register_blueprint(dashboard.dashboard_bp)
        self.note = {
            "$id": "note-1",
            "id": "note-1",
            "user_id": "owner",
            "folder_id": None,
            "title": "Shared Note",
        }
        self.owner = {"id": "owner", "name": "Owner Name", "username": "owner", "picture_url": ""}

    def test_logged_out_restricted_note_renders_login_gate(self):
        anonymous = SimpleNamespace(is_authenticated=False)
        denied = note_store._access_payload()
        with self.app.test_request_context("/notes/note-1"), patch.object(
            dashboard, "current_user", anonymous
        ), patch.object(dashboard.note_store, "get_note", return_value=self.note), patch.object(
            dashboard.note_store, "resolve_note_access", return_value=denied
        ), patch.object(dashboard.note_store, "get_safe_user", return_value=self.owner), patch.object(
            dashboard, "render_template", return_value="login gate"
        ) as render:
            body, status = dashboard.note_document("note-1")
        self.assertEqual((body, status), ("login gate", 401))
        self.assertEqual(render.call_args.kwargs["page_state"], "login_required")
        self.assertIsNone(render.call_args.kwargs["owner"])
        self.assertIn("next=/notes/note-1", render.call_args.kwargs["login_url"])

    def test_public_note_page_is_ready_without_authentication(self):
        anonymous = SimpleNamespace(is_authenticated=False)
        access = note_store._access_payload(role="viewer", source="note_public", source_id="note-1")
        with self.app.test_request_context("/notes/note-1"), patch.object(
            dashboard, "current_user", anonymous
        ), patch.object(dashboard.note_store, "get_note", return_value=self.note), patch.object(
            dashboard.note_store, "resolve_note_access", return_value=access
        ), patch.object(dashboard.note_store, "get_safe_user", return_value=self.owner), patch.object(
            dashboard, "render_template", return_value="public note"
        ) as render:
            response = dashboard.note_document("note-1")
        self.assertEqual(response, "public note")
        self.assertEqual(render.call_args.kwargs["page_state"], "ready")
        self.assertFalse(render.call_args.kwargs["viewer_authenticated"])
        self.assertFalse(render.call_args.kwargs["access"]["can_edit"])

    def test_legacy_editor_url_redirects_to_canonical_note(self):
        with self.app.test_request_context("/notes/editor/note-1?from=dashboard"):
            response = dashboard.legacy_notes_editor("note-1")
        self.assertEqual(response.status_code, 308)
        self.assertEqual(response.location, "/notes/note-1?from=dashboard")

    def test_anonymous_shared_folder_back_link_does_not_point_to_itself(self):
        anonymous = SimpleNamespace(is_authenticated=False)
        folder = {
            "$id": "folder-1",
            "id": "folder-1",
            "user_id": "owner",
            "name": "Shared Folder",
        }
        access = note_store._access_payload(
            role="viewer", source="folder_public", source_id="folder-1"
        )
        with self.app.test_request_context("/notes/folders/folder-1"), patch.object(
            dashboard, "current_user", anonymous
        ), patch.object(dashboard.note_store, "get_folder", return_value=folder), patch.object(
            dashboard.note_store, "resolve_folder_access", return_value=access
        ), patch.object(dashboard.note_store, "get_safe_user", return_value=self.owner), patch.object(
            dashboard.note_store, "list_notes_in_folder", return_value=[]
        ), patch.object(dashboard, "render_template", return_value="shared folder") as render:
            response = dashboard.shared_note_folder("folder-1")
        self.assertEqual(response, "shared folder")
        self.assertEqual(render.call_args.kwargs["back_url"], "/")
        self.assertEqual(render.call_args.kwargs["back_label"], "Nest.APStudy")

    def test_unauthorized_folder_page_does_not_expose_folder_metadata(self):
        outsider = SimpleNamespace(
            id="outsider", is_authenticated=True, onboarding_complete=True
        )
        folder = {
            "$id": "folder-1",
            "id": "folder-1",
            "user_id": "owner",
            "name": "Private Folder Name",
        }
        denied = note_store._access_payload()
        with self.app.test_request_context("/notes/folders/folder-1"), patch.object(
            dashboard, "current_user", outsider
        ), patch.object(
            dashboard, "_user_payload", return_value={"id": "outsider"}
        ), patch.object(
            dashboard, "_load_user_settings", return_value=None
        ), patch.object(dashboard.note_store, "get_folder", return_value=folder), patch.object(
            dashboard.note_store, "resolve_folder_access", return_value=denied
        ), patch.object(dashboard, "render_template", return_value="unavailable") as render:
            body, status = dashboard.shared_note_folder("folder-1")
        self.assertEqual((body, status), ("unavailable", 404))
        self.assertIsNone(render.call_args.kwargs["folder"])
        self.assertIsNone(render.call_args.kwargs["owner"])


if __name__ == "__main__":
    unittest.main()
