import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from PIL import Image
from flask import Flask
from werkzeug.datastructures import FileStorage

from appwrite.exception import AppwriteException
from appwrite.permission import Permission
from appwrite.role import Role

import blueprints.notes_api as notes_api
from services import database, note_media


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

    def test_create_media_passes_read_permissions_to_storage(self):
        storage = Mock()
        upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="note.png", content_type="image/png")
        with patch.object(note_media, "storage_service", return_value=storage), patch.object(
            note_media, "create_row_safe", return_value={"id": "media-1"}
        ):
            note_media.create_media("note-1", "user-1", upload)
        storage.create_file.assert_called_once()
        self.assertEqual(
            storage.create_file.call_args.kwargs.get("permissions"),
            [Permission.read(Role.any())],
        )

    def test_create_media_persists_metadata_in_sqlite(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        db_path = Path(temp_dir.name) / "nest-test.sqlite3"
        app = Flask(__name__)
        app.config["DATABASE_PATH"] = str(db_path)
        with app.app_context():
            database.init_db(app=app)
            with database.db_connection(db_path) as conn:
                conn.execute(
                    "INSERT INTO users (id, google_id, email, name, username, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("user-1", "google-1", "user@example.com", "User", "user", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT INTO notes (id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)",
                    ("note-1", "user-1", "Note", "[]", "2026-01-01T00:00:00Z"),
                )
            storage = Mock()
            upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="note.png", content_type="image/png")
            with patch.object(note_media, "storage_service", return_value=storage):
                media = note_media.create_media("note-1", "user-1", upload)
            with database.db_connection(db_path) as conn:
                count = conn.execute(
                    "SELECT COUNT(*) FROM note_media WHERE id = ? AND note_id = ?",
                    (media["id"], "note-1"),
                ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_create_media_storage_failure_does_not_insert_row(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        db_path = Path(temp_dir.name) / "nest-test.sqlite3"
        app = Flask(__name__)
        app.config["DATABASE_PATH"] = str(db_path)
        with app.app_context():
            database.init_db(app=app)
            with database.db_connection(db_path) as conn:
                conn.execute(
                    "INSERT INTO users (id, google_id, email, name, username, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    ("user-1", "google-1", "user@example.com", "User", "user", "2026-01-01T00:00:00Z"),
                )
                conn.execute(
                    "INSERT INTO notes (id, user_id, title, content, created_at) VALUES (?, ?, ?, ?, ?)",
                    ("note-1", "user-1", "Note", "[]", "2026-01-01T00:00:00Z"),
                )
            storage = Mock()
            storage.create_file.side_effect = AppwriteException("bucket not found", 404)
            upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="note.png", content_type="image/png")
            with patch.object(note_media, "storage_service", return_value=storage):
                with self.assertRaises(AppwriteException):
                    note_media.create_media("note-1", "user-1", upload)
            with database.db_connection(db_path) as conn:
                count = conn.execute("SELECT COUNT(*) FROM note_media").fetchone()[0]
        self.assertEqual(count, 0)

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

    def test_upload_media_returns_500_when_storage_fails(self):
        upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="note.png", content_type="image/png")
        with self.app.test_request_context(
            "/api/notes/note-1/media",
            method="POST",
            data={"file": upload},
            content_type="multipart/form-data",
        ), patch.object(notes_api, "_note_owner_or_404", return_value=self.note), patch.object(
            notes_api.note_store, "resolve_note_access", return_value={"can_edit": True}
        ), patch.object(
            notes_api.note_media, "create_media", side_effect=AppwriteException("Bucket with the requested ID could not be found.", 404)
        ), patch.object(notes_api, "current_user", SimpleNamespace(is_authenticated=True, id="owner")):
            response = notes_api.upload_note_media.__wrapped__("note-1")
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.get_json()["error"], "File storage is not configured. Contact support.")

    def test_upload_media_returns_400_for_disallowed_extension(self):
        upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="note.png", content_type="image/png")
        with self.app.test_request_context(
            "/api/notes/note-1/media",
            method="POST",
            data={"file": upload},
            content_type="multipart/form-data",
        ), patch.object(notes_api, "_note_owner_or_404", return_value=self.note), patch.object(
            notes_api.note_store, "resolve_note_access", return_value={"can_edit": True}
        ), patch.object(
            notes_api.note_media, "create_media", side_effect=AppwriteException("File extension not allowed", 400)
        ), patch.object(notes_api, "current_user", SimpleNamespace(is_authenticated=True, id="owner")):
            response = notes_api.upload_note_media.__wrapped__("note-1")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.get_json()["error"], "This image type is not allowed.")

    def test_upload_media_accepts_clipboard_file_without_filename(self):
        upload = FileStorage(stream=io.BytesIO(image_bytes()), filename="", content_type="image/png")
        created = {
            "id": "media-1",
            "original_filename": "clipboard-image.png",
            "mime_type": "image/png",
            "file_size_bytes": 123,
            "width": 32,
            "height": 24,
        }
        with self.app.test_request_context(
            "/api/notes/note-1/media",
            method="POST",
            data={"file": upload},
            content_type="multipart/form-data",
        ), patch.object(notes_api, "_note_owner_or_404", return_value=self.note), patch.object(
            notes_api.note_store, "resolve_note_access", return_value={"can_edit": True}
        ), patch.object(notes_api.note_media, "create_media", return_value=created) as create_media, patch.object(
            notes_api, "current_user", SimpleNamespace(is_authenticated=True, id="owner")
        ):
            response = notes_api.upload_note_media.__wrapped__("note-1")
        self.assertEqual(response.status_code, 201)
        self.assertEqual(create_media.call_args.args[2].filename, "clipboard-image.png")


if __name__ == "__main__":
    unittest.main()
