"""Feature rows participate in the caller's existing SQLite transaction."""

import sqlite3
import unittest
from types import MappingProxyType

from services import storage_rows
from services.storage_errors import StorageNotFound, StorageValidationError


class StorageRowContractTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.addCleanup(self.conn.close)
        self.conn.execute(
            "CREATE TABLE user_events (id TEXT PRIMARY KEY, title TEXT, is_all_day INTEGER)"
        )

    def test_missing_rows_are_optional_only_when_requested(self):
        self.assertIsNone(storage_rows.get_row(
            self.conn, "user_events", "missing", allow_missing=True,
        ))
        with self.assertRaises(StorageNotFound):
            storage_rows.get_row(self.conn, "user_events", "missing")

    def test_mutations_require_an_active_transaction(self):
        for mutate, arguments in (
            (storage_rows.insert_row, ("new", {"title": "Study"})),
            (storage_rows.update_row, ("missing", {"title": "Study"})),
            (storage_rows.delete_row, ("missing",)),
        ):
            with self.subTest(operation=mutate.__name__):
                with self.assertRaises(StorageValidationError):
                    mutate(self.conn, "user_events", *arguments)
        self.assertFalse(self.conn.in_transaction)

    def test_row_mutations_preserve_values_and_the_callers_rollback(self):
        self.conn.execute("BEGIN IMMEDIATE")
        inserted = storage_rows.insert_row(self.conn, "user_events", 123, MappingProxyType({
            "title": "Study", "is_all_day": False, "$id": "ignored", "$permissions": [],
        }))
        self.assertEqual(inserted, {
            "id": "123", "$id": "123", "title": "Study", "is_all_day": False,
        })
        updated = storage_rows.update_row(self.conn, "user_events", 123, {"is_all_day": True})
        self.assertIs(updated["is_all_day"], True)
        self.assertEqual(storage_rows.update_row(self.conn, "user_events", 123, {}), updated)
        self.assertTrue(self.conn.in_transaction)
        self.conn.rollback()
        self.assertIsNone(storage_rows.get_row(self.conn, "user_events", 123, allow_missing=True))

    def test_delete_receipt_distinguishes_existing_and_missing_rows(self):
        self.conn.execute("BEGIN IMMEDIATE")
        storage_rows.insert_row(self.conn, "user_events", "event-1", {"title": "Study"})
        self.assertIs(storage_rows.delete_row(self.conn, "user_events", "event-1"), True)
        self.assertIs(storage_rows.delete_row(self.conn, "user_events", "event-1"), False)
        with self.assertRaises(StorageNotFound):
            storage_rows.update_row(self.conn, "user_events", "event-1", {})
        with self.assertRaises(StorageNotFound):
            storage_rows.update_row(self.conn, "user_events", "event-1", {"title": "Gone"})
        self.assertTrue(self.conn.in_transaction)


if __name__ == "__main__":
    unittest.main()
