import os
import tempfile
import unittest
from unittest.mock import patch

from services import database
from services.extension_consent import ConsentRecord, get_consent, put_consent
from services.extension_contract import canonical_canvas_source_key


class ConsentPersistenceTests(unittest.TestCase):
    def setUp(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.path = os.path.join(temp_dir.name, "consent.sqlite3")
        database.init_db(path=self.path)
        self.account_key = "1" * 64
        self.source_key = canonical_canvas_source_key(self.account_key)

    def grant(self):
        return put_consent(
            "user-1", self.source_key, self.account_key, action="grant",
            scopes=["full_history_upload", "ongoing_read", "shares_ics_inclusion"],
            path=self.path,
        )

    def test_absent_get_is_optional_and_put_returns_persisted_record(self):
        self.assertIsNone(get_consent("user-1", self.source_key, self.account_key, path=self.path))
        record = self.grant()
        self.assertIsInstance(record, ConsentRecord)
        self.assertTrue(all(type(flag) is bool for flag in record.scopes.values()))
        self.assertEqual(get_consent("user-1", self.source_key, self.account_key, path=self.path), record)
        self.assertEqual(self.grant(), record)
        with patch("services.calendar_events.revoke_canvas_consent_in_connection"):
            revoked = put_consent(
                "user-1", self.source_key, self.account_key, action="revoke", scopes=[], path=self.path,
            )
        self.assertIsInstance(revoked, ConsentRecord)
        self.assertEqual(revoked.state, "revoked")

    def test_missing_post_write_record_raises_and_rolls_back(self):
        with database.db_connection(self.path) as connection:
            connection.execute("CREATE TABLE discarded_consents (id TEXT)")
            connection.execute("""
                CREATE TRIGGER discard_consent AFTER INSERT ON calendar_integration_consents
                BEGIN
                    DELETE FROM calendar_integration_consents WHERE id = NEW.id;
                    INSERT INTO discarded_consents VALUES (NEW.id);
                END
            """)
        with self.assertRaisesRegex(RuntimeError, "Consent record was not persisted"):
            self.grant()
        with database.db_connection(self.path) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM discarded_consents").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
