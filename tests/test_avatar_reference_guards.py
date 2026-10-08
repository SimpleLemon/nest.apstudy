"""Retirement guards retain atomic chat fencing without image-storage imports."""

import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from services import avatar_references, database
from services.storage_errors import StorageUnavailable, StorageValidationError


class AvatarReferenceGuardTests(unittest.TestCase):
    def test_guard_requires_writer_and_recognizes_legacy_crop_variants(self):
        with sqlite3.connect(":memory:") as conn:
            conn.execute("CREATE TABLE storage_legacy_deletions(namespace TEXT, object_id TEXT)")
            with self.assertRaises(StorageValidationError):
                avatar_references.reject_retiring_avatar_references(conn, {"picture_url": "/api/avatars/old"})
            conn.execute("INSERT INTO storage_legacy_deletions VALUES ('avatars', 'old')")
            url = "https://legacy.example/v1/storage/buckets/profile/files/old/preview?project=project&width=64"
            with patch.object(avatar_references, "legacy_identity", return_value=("https://legacy.example/v1", "project", "profile")):
                with self.assertRaises(StorageUnavailable):
                    avatar_references.reject_retiring_avatar_references(conn, {"author_avatar_url": url})
                avatar_references.reject_retiring_avatar_references(conn, {"picture_url": url.replace("project=project", "project=other")})

    def test_both_chat_insert_paths_replace_stale_retiring_avatar_under_writer(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "nest.sqlite3"
            database.init_db(path=path)
            database.create_row("users", "owner", {
                "google_id": "owner", "email": "owner@example.test", "picture_url": "/api/avatars/fresh",
                "created_at": "2026-10-01T00:00:00Z",
            }, path=path)
            with database.db_connection(path) as conn:
                conn.execute("INSERT INTO storage_legacy_deletions(namespace, bucket_id, object_id, created_at) VALUES ('avatars', 'profile', 'old', '2026-10-01')")
            for insert, row_id in ((database.create_row, "created"), (database.insert_row_ignore, "ignored")):
                insert("chat_messages", row_id, {
                    "user_id": "owner", "author_avatar_url": "/api/avatars/old", "content": "message",
                    "created_at": "2026-10-01T00:00:00Z",
                }, path=path)
                self.assertEqual(database.get_row("chat_messages", row_id, path=path)["author_avatar_url"], "/api/avatars/fresh")

            with database.db_connection(path) as conn:
                conn.execute("UPDATE users SET picture_url = '/api/avatars/old' WHERE id = 'owner'")
            row = database.create_row("chat_messages", "retired-current", {
                "user_id": "owner", "author_avatar_url": "/api/avatars/old", "content": "message",
                "created_at": "2026-10-01T00:00:00Z",
            }, path=path)
            self.assertEqual(row["author_avatar_url"], "")

    def test_generic_chat_guard_does_not_load_feature_storage_implementations(self):
        script = '''
import sqlite3
import sys
from services import database
with sqlite3.connect(":memory:") as conn:
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE users(id TEXT, picture_url TEXT)")
    conn.execute("CREATE TABLE storage_legacy_deletions(namespace TEXT, object_id TEXT)")
    database._prepare_chat_author_references(conn, "chat_messages", {"author_avatar_url": "/api/avatars/current"})
    assert conn.in_transaction
assert "services.avatar_storage" not in sys.modules
assert "services.avatar_ownership" not in sys.modules
assert "services.note_store" not in sys.modules
'''
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
