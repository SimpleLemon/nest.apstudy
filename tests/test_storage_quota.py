"""Concurrent metadata accounting must not oversubscribe the upload quota."""

import json
import tempfile
import threading
import unittest
from pathlib import Path

from services import database, entitlements


class StorageQuotaTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "quota.sqlite3"
        database.init_db(path=self.path)
        with database.db_connection(self.path) as conn:
            conn.execute(
                "INSERT INTO users(id,google_id,email,created_at,avatar_file_size_bytes) "
                "VALUES('owner','provider','owner@example.test','2026-10-01',20)"
            )
            conn.execute(
                "INSERT INTO chat_bridge_config(id,config_key,config_value,created_at) VALUES(?,?,?,?)",
                ("limits", "tier_entitlements", json.dumps({"free": {"storage_bytes": 100}}), "2026-10-01"),
            )

    def _insert_file(self, conn, identifier, size):
        conn.execute(
            "INSERT INTO shared_files(id,user_id,original_filename,stored_path,file_size_bytes,"
            "expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
            (identifier, "owner", "test.txt", "", size, "2099-01-01", "2026-10-01"),
        )

    def test_simultaneous_writers_recheck_after_lock_and_one_is_rejected(self):
        ready = threading.Barrier(2)
        results = []

        def upload(identifier):
            ready.wait(timeout=10)
            try:
                with database.db_connection(self.path) as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    entitlements.check_storage_transaction(conn, "owner", 60)
                    self._insert_file(conn, identifier, 60)
                results.append("saved")
            except entitlements.EntitlementLimitError:
                results.append("rejected")
            except Exception as exc:
                results.append(exc)

        threads = [threading.Thread(target=upload, args=(str(i),)) for i in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)
            self.assertFalse(thread.is_alive())
        self.assertCountEqual(results, ["saved", "rejected"])
        with database.db_connection(self.path) as conn:
            self.assertEqual(entitlements.storage_usage_transaction(conn, "owner"), 80)

    def test_current_tier_and_replacement_bytes_override_stale_request(self):
        stale = {"key": "developer", "limits": {"storage_bytes": None}, "usage": {"storage_bytes": 0}}
        with database.db_connection(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            fresh = entitlements.check_storage_transaction(
                conn, "owner", 95, replacing_bytes=20, entitlements=stale,
            )
            self.assertEqual(fresh["key"], "free")
            self.assertEqual(fresh["limits"]["storage_bytes"], 100)
            with self.assertRaises(entitlements.EntitlementLimitError):
                entitlements.check_storage_transaction(conn, "owner", 101, replacing_bytes=20)
            with self.assertRaises(entitlements.EntitlementError):
                entitlements.check_storage_transaction(conn, "owner", 0, replacing_bytes=21)

    def test_quota_queries_never_select_ciphertext(self):
        with database.db_connection(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            statements = []
            conn.set_trace_callback(statements.append)
            entitlements.check_storage_transaction(conn, "owner", 1)
        self.assertFalse(any("storage_objects" in sql for sql in statements))

    def test_retained_avatars_are_charged_once_to_original_owner(self):
        with database.db_connection(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.executemany(
                "INSERT INTO storage_avatar_ownership(object_id,user_id,size_bytes,storage_backend) VALUES(?,?,?,?)",
                [("old-avatar", "owner", 30, "sqlite"), ("current-avatar", "owner", 20, "appwrite")],
            )
            conn.execute("UPDATE users SET avatar_file_id='current-avatar' WHERE id='owner'")
            self.assertEqual(entitlements.storage_usage_transaction(conn, "owner"), 50)
            # Another profile using the public image does not change its payer.
            conn.execute(
                "INSERT INTO users(id,google_id,email,created_at,avatar_file_id,avatar_file_size_bytes) "
                "VALUES('peer','peer-provider','peer@example.test','2026-10-01','old-avatar',30)"
            )
            self.assertEqual(entitlements.storage_usage_transaction(conn, "peer"), 0)
            with self.assertRaises(entitlements.EntitlementLimitError):
                entitlements.check_storage_transaction(conn, "owner", 51)
            # Retaining attribution after profile deletion avoids transferring
            # an existing image's storage charge to a referencing account.
            conn.execute("DELETE FROM users WHERE id='owner'")
            self.assertEqual(entitlements.storage_usage_transaction(conn, "peer"), 0)

    def test_without_transaction_fails_closed_and_signup_uses_free_tier(self):
        with database.db_connection(self.path) as conn:
            with self.assertRaises(entitlements.EntitlementError):
                entitlements.check_storage_transaction(conn, "owner", 1)
            conn.execute("BEGIN IMMEDIATE")
            fresh = entitlements.check_storage_transaction(conn, "new-owner", 99, allow_new_user=True)
            self.assertEqual(fresh["key"], "free")
            self.assertEqual(fresh["usage"]["storage_bytes"], 0)

    def test_deleted_account_and_racing_signup_cannot_store_new_bytes(self):
        from services.storage_errors import StorageUnavailable
        with database.db_connection(self.path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            with self.assertRaises(StorageUnavailable):
                entitlements.check_storage_transaction(conn, "missing-owner", 1)
            conn.execute(
                "INSERT INTO storage_account_deletions(user_id,deleted_at) VALUES(?,?)",
                ("missing-owner", "2026-10-01"),
            )
            with self.assertRaises(StorageUnavailable):
                entitlements.check_storage_transaction(conn, "missing-owner", 1, allow_new_user=True)
