import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from flask import Flask

import blueprints.notes_api as notes_api
from services import database, note_store
from tests.support.harness import reset_flask_login_manager


class NotesListApiTests(unittest.TestCase):
    def setUp(self):
        self.user = MagicMock()
        self.user.id = "user-1"

    def tearDown(self):
        reset_flask_login_manager()

    @patch.object(notes_api.note_store, "list_folders_for_user", return_value=[])
    @patch.object(notes_api.note_store, "list_notes_for_user")
    def test_list_notes_omits_content(self, list_notes, list_folders):
        list_notes.return_value = [
            {
                "$id": "note-1",
                "user_id": "user-1",
                "folder_id": None,
                "title": "My Note",
                "content": '[{"type":"paragraph","content":[{"text":"Secret body"}]}]',
                "preview_text": "Secret body",
                "order": 1000,
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-02T00:00:00Z",
            }
        ]

        app = Flask(__name__)
        with app.test_request_context("/api/notes"):
            with patch.object(notes_api, "current_user", self.user), patch.object(
                notes_api.note_store, "shared_resource_ids", return_value=set()
            ):
                response = notes_api.list_notes.__wrapped__()

        payload = response.get_json()
        self.assertEqual(len(payload["notes"]), 1)
        note = payload["notes"][0]
        self.assertEqual(note["preview_text"], "Secret body")
        self.assertNotIn("content", note)

    def test_note_store_update_adds_preview_text(self):
        content = '[{"type":"paragraph","content":[{"text":"Saved text"}]}]'
        with tempfile.TemporaryDirectory() as directory:
            app = Flask(__name__)
            app.config.update(
                DATABASE_PATH=str(Path(directory) / "notes.sqlite3"),
                NEST_STORAGE_BACKEND="sqlite", NEST_STORAGE_MUTATIONS_PAUSED=False,
            )
            with app.app_context():
                database.init_db(app=app)
                with database.db_connection() as conn:
                    conn.execute(
                        "INSERT INTO users (id, google_id, email, created_at) "
                        "VALUES ('user-1', 'google-1', 'user@example.test', '2026-01-01T00:00:00Z')",
                    )
                    conn.execute(
                        "INSERT INTO notes (id, user_id, title, content, created_at) "
                        "VALUES ('note-1', 'user-1', 'Note', '[]', '2026-01-01T00:00:00Z')",
                    )
                updated = note_store.update_note("note-1", {"content": content})
                self.assertEqual(updated["preview_text"], "Saved text")
                self.assertEqual(note_store.get_note("note-1")["preview_text"], "Saved text")


if __name__ == "__main__":
    unittest.main()
