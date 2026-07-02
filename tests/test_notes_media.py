import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image
from flask import Flask
from werkzeug.datastructures import FileStorage

import blueprints.notes_api as notes_api
from services import note_media


def image_bytes(image_format="PNG", size=(32, 24)):
    output = io.BytesIO()
    Image.new("RGB", size, "red").save(output, format=image_format)
    return output.getvalue()


class NoteMediaServiceTests(unittest.TestCase):
    def test_image_inspection_accepts_supported_content_and_ignores_claimed_mime(self):
        details = note_media.inspect_image(image_bytes("PNG", (40, 30)))
        self.assertEqual(details["mime_type"], "image/png")
        self.assertEqual((details["width"], details["height"]), (40, 30))

        with self.assertRaisesRegex(ValueError, "valid supported image"):
            note_media.inspect_image(b"<svg><script>alert(1)</script></svg>")

    def test_create_media_rolls_back_storage_when_metadata_fails(self):
        storage = Mock()
        upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="note.png", content_type="image/png")
        with patch.object(note_media, "storage_service", return_value=storage), patch.object(
            note_media, "create_row_safe", side_effect=RuntimeError("database down")
        ):
            with self.assertRaisesRegex(RuntimeError, "database down"):
                note_media.create_media("note-1", "user-1", upload)
        storage.create_file.assert_called_once()
        storage.delete_file.assert_called_once()

    def test_referenced_media_ids_walks_lists_tables_and_children(self):
        content = json.dumps([
            {
                "type": "bulletListItem",
                "content": [{"type": "text", "text": "Item"}, {"type": "inlineImage", "props": {"mediaId": "one"}}],
                "children": [{"type": "paragraph", "content": [{"type": "inlineImage", "props": {"mediaId": "two"}}]}],
            },
            {"type": "table", "content": {"rows": [{"cells": [[{"type": "inlineImage", "props": {"mediaId": "three"}}]]}]}},
        ])
        self.assertEqual(note_media.referenced_media_ids(content), {"one", "two", "three"})

    def test_sync_activates_references_and_deletes_removed_active_media(self):
        rows = [
            {"id": "keep", "note_id": "note-1", "status": "pending"},
            {"id": "remove", "note_id": "note-1", "status": "active", "storage_file_id": "stored"},
            {"id": "pending", "note_id": "note-1", "status": "pending"},
        ]
        content = json.dumps([{"type": "paragraph", "content": [{"type": "inlineImage", "props": {"mediaId": "keep"}}]}])
        with patch.object(note_media, "list_rows_all", return_value=rows), patch.object(
            note_media, "update_row_safe"
        ) as update, patch.object(note_media, "delete_media") as delete:
            note_media.sync_note_media("note-1", content)
        update.assert_called_once()
        self.assertEqual(update.call_args.args[:2], (note_media.NOTE_MEDIA_TABLE_ID, "keep"))
        delete.assert_called_once_with(rows[1])


class NoteMediaApiTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.register_blueprint(notes_api.notes_api_bp)
        self.note = {"id": "note-1", "user_id": "owner", "folder_id": None}
        self.media = {
            "id": "media-1", "note_id": "note-1", "storage_file_id": "stored-1",
            "original_filename": "image.png", "mime_type": "image/png",
        }

    def test_public_media_uses_note_access_and_safe_response_headers(self):
        access = {"can_view": True, "can_edit": False}
        with self.app.test_request_context("/api/notes/note-1/media/media-1"), patch.object(
            notes_api.note_store, "get_note", return_value=self.note
        ), patch.object(notes_api.note_store, "resolve_note_access", return_value=access), patch.object(
            notes_api.note_media, "get_media", return_value=self.media
        ), patch.object(notes_api.note_media, "media_bytes", return_value=image_bytes()), patch.object(
            notes_api, "current_user", SimpleNamespace(is_authenticated=False)
        ):
            response = notes_api.get_note_media("note-1", "media-1")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(response.headers["Cache-Control"], "private, no-cache")

    def test_media_is_hidden_when_note_is_not_viewable(self):
        with self.app.test_request_context("/api/notes/note-1/media/media-1"), patch.object(
            notes_api.note_store, "get_note", return_value=self.note
        ), patch.object(notes_api.note_store, "resolve_note_access", return_value={"can_view": False}), patch.object(
            notes_api.note_media, "get_media", return_value=self.media
        ), patch.object(notes_api, "current_user", SimpleNamespace(is_authenticated=True, id="other")):
            response, status = notes_api.get_note_media("note-1", "media-1")
        self.assertEqual(status, 404)
        self.assertEqual(response.get_json()["error"], "Not found.")


if __name__ == "__main__":
    unittest.main()
