import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing, redirect_stdout
from pathlib import Path
from unittest.mock import patch

from scripts import cleanup_legacy_storage


class LegacyStorageDrainCliTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "nest.sqlite3"
        with closing(sqlite3.connect(self.path)) as conn:
            conn.execute("CREATE TABLE storage_legacy_deletions(namespace TEXT,object_id TEXT,account_user_id TEXT)")
            conn.executemany("INSERT INTO storage_legacy_deletions VALUES (?,'queued','owner')",
                             [(namespace,) for namespace in cleanup_legacy_storage.NAMESPACES])
            conn.commit()
        environment = patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "false"})
        environment.start()
        self.addCleanup(environment.stop)

    def cleaners(self, *, fail=None):
        calls = []

        def cleaner(namespace):
            def apply(**scope):
                calls.append((namespace, scope))
                if namespace == fail:
                    raise RuntimeError("private remote response never print me")
                with closing(sqlite3.connect(self.path)) as conn:
                    conn.execute("DELETE FROM storage_legacy_deletions WHERE namespace=?", (namespace,))
                    conn.commit()
                # Final queue counts must come from the database, rather than
                # an optimistic stale value returned by a remote operation.
                return {"completed": 1, "pending": 999}
            return apply

        return {namespace: cleaner(namespace) for namespace in cleanup_legacy_storage.NAMESPACES}, calls

    def test_drains_all_four_scoped_exports_and_checks_settled_counts(self):
        functions, calls = self.cleaners()
        result = cleanup_legacy_storage.run_cleanup(self.path, account_user_id="owner", object_ids=["queued"],
                                                   cleanup_functions=functions)
        self.assertEqual([namespace for namespace, _ in calls], list(cleanup_legacy_storage.NAMESPACES))
        self.assertTrue(all(scope == {"account_user_id": "owner", "object_ids": ["queued"]} for _, scope in calls))
        self.assertEqual(result["pending"], 0)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(sum(row["completed"] for row in result["namespaces"].values()), 4)

    def test_failures_preserve_pending_work_and_do_not_print_remote_response(self):
        functions, calls = self.cleaners(fail="note_media")
        result = cleanup_legacy_storage.run_cleanup(self.path, cleanup_functions=functions)
        self.assertEqual(result["pending"], 1)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(len(calls), 4)
        self.assertNotIn("private", json.dumps(result))
        with patch.object(cleanup_legacy_storage, "run_cleanup", return_value=result), \
                redirect_stdout(io.StringIO()) as output:
            code = cleanup_legacy_storage.main(["--database-path", str(self.path), "--env-file", str(self.path.parent / "absent.env")])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue()), result)

    def test_pause_blocks_drain_but_read_only_status_remains_available(self):
        functions, calls = self.cleaners()
        with patch.dict(os.environ, {"NEST_STORAGE_MUTATIONS_PAUSED": "true"}):
            blocked = cleanup_legacy_storage.run_cleanup(self.path, cleanup_functions=functions)
            status = cleanup_legacy_storage.run_cleanup(self.path, status_only=True, cleanup_functions=functions)
        self.assertTrue(blocked["paused"])
        self.assertEqual(blocked["failed"], 1)
        self.assertEqual(status["stage"], "status")
        self.assertEqual(status["pending"], 4)
        self.assertEqual(status["failed"], 0)
        self.assertEqual(calls, [])

    def test_status_scope_is_read_only_and_missing_database_is_never_created(self):
        original = self.path.read_bytes()
        result = cleanup_legacy_storage.run_cleanup(self.path, status_only=True, account_user_id="other")
        self.assertEqual(result["pending"], 0)
        self.assertEqual(self.path.read_bytes(), original)
        absent = self.path.parent / "absent.sqlite3"
        with self.assertRaises(sqlite3.Error):
            cleanup_legacy_storage.run_cleanup(absent, status_only=True)
        self.assertFalse(absent.exists())


if __name__ == "__main__":
    unittest.main()
