import unittest
from unittest.mock import MagicMock, patch

import blueprints.notes_api as notes_api
from services import note_store
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

        from app import create_app

        app = create_app()
        with app.test_request_context("/api/notes"):
            with patch.object(notes_api, "current_user", self.user):
                response = notes_api.list_notes.__wrapped__()

        payload = response.get_json()
        self.assertEqual(len(payload["notes"]), 1)
        note = payload["notes"][0]
        self.assertEqual(note["preview_text"], "Secret body")
        self.assertNotIn("content", note)

    @patch.object(note_store, "update_row_safe")
    def test_note_store_update_adds_preview_text(self, update_row_safe):
        update_row_safe.return_value = {"$id": "note-1"}
        content = '[{"type":"paragraph","content":[{"text":"Saved text"}]}]'
        note_store.update_note("note-1", {"content": content})
        updates = update_row_safe.call_args.args[2]
        self.assertEqual(updates["preview_text"], "Saved text")


if __name__ == "__main__":
    unittest.main()
