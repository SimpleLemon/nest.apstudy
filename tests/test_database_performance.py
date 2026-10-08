import tempfile
import os
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from services import database


def _database_path():
    descriptor, path = tempfile.mkstemp(suffix=".sqlite3")
    os.close(descriptor)
    database.init_db(path=path)
    with database.db_connection(path) as conn:
        conn.execute(
            "INSERT INTO users (id, google_id, email, name, created_at) VALUES (?,?,?,?,?)",
            ["u1", "g1", "u1@example.com", "User One", "2026-08-01T00:00:00Z"],
        )
    return path


class DatabasePerformanceTests(unittest.TestCase):
    def test_list_rows_count_is_optional_and_first_row_uses_one_data_select(self):
        path = _database_path()
        statements = []
        original_connection = database.db_connection

        @contextmanager
        def tracked_connection(selected_path=None):
            with original_connection(selected_path) as conn:
                conn.set_trace_callback(statements.append)
                yield conn

        try:
            without_total = database.list_rows("users", path=path, include_total=False)
            self.assertNotIn("total", without_total)

            statements.clear()
            with patch.object(database, "db_connection", tracked_connection):
                row = database.first_row("users", path=path)
            user_selects = [
                statement for statement in statements
                if statement.lstrip().upper().startswith("SELECT * FROM \"USERS\"")
            ]
            self.assertEqual(row["$id"], "u1")
            self.assertEqual(len(user_selects), 1)
            self.assertTrue(not any("COUNT(*) AS total" in statement for statement in statements))

            with_total = database.list_rows("users", path=path, include_total=True)
            self.assertEqual(with_total["total"], 1)
            self.assertEqual(database.count_rows("users", path=path), 1)
        finally:
            Path(path).unlink(missing_ok=True)
