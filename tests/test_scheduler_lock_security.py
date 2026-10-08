"""File-system safety and contention behavior for the shared scheduler lock."""

import fcntl
import os
from pathlib import Path
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from services import scheduler


class SchedulerLockSecurityTests(unittest.TestCase):
    def setUp(self):
        scheduler._release_scheduler_lock()
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(scheduler._release_scheduler_lock)
        self.path = Path(self.directory.name) / "scheduler.lock"
        self.configured = SimpleNamespace(scheduler_lock_path=str(self.path))

    def test_new_lock_is_private_and_keeps_the_configured_path(self):
        self.assertTrue(scheduler._acquire_scheduler_lock(self.configured))
        self.assertEqual(scheduler._scheduler_lock_path, str(self.path))
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertIn(f"pid={os.getpid()}", self.path.read_text())

    def test_symlink_cannot_modify_its_target(self):
        target = Path(self.directory.name) / "important.txt"
        target.write_text("preserve this file")
        self.path.symlink_to(target)
        with self.assertLogs(scheduler.logger, level="ERROR") as logs:
            self.assertFalse(scheduler._acquire_scheduler_lock(self.configured))
        self.assertIn("Failed to acquire scheduler lock", logs.output[0])
        self.assertEqual(target.read_text(), "preserve this file")
        self.assertFalse(scheduler._scheduler_lock_acquired)

    def test_symlink_is_rejected_without_platform_no_follow_flag(self):
        target = Path(self.directory.name) / "important.txt"
        target.write_text("preserve this file")
        self.path.symlink_to(target)
        with patch.object(os, "O_NOFOLLOW", 0, create=True), self.assertLogs(scheduler.logger, level="ERROR"):
            self.assertFalse(scheduler._acquire_scheduler_lock(self.configured))
        self.assertEqual(target.read_text(), "preserve this file")

    def test_hard_link_cannot_modify_its_target(self):
        target = Path(self.directory.name) / "important.txt"
        target.write_text("preserve this file")
        os.link(target, self.path)
        with self.assertLogs(scheduler.logger, level="ERROR"):
            self.assertFalse(scheduler._acquire_scheduler_lock(self.configured))
        self.assertEqual(target.read_text(), "preserve this file")

    def test_nonregular_lock_is_rejected_without_hanging(self):
        os.mkfifo(self.path)
        with self.assertLogs(scheduler.logger, level="ERROR"):
            self.assertFalse(scheduler._acquire_scheduler_lock(self.configured))

    def test_lock_owned_by_another_user_is_rejected_before_writing(self):
        self.path.write_text("other lock owner")
        with patch.object(os, "geteuid", return_value=os.geteuid() + 1), \
                self.assertLogs(scheduler.logger, level="ERROR"):
            self.assertFalse(scheduler._acquire_scheduler_lock(self.configured))
        self.assertEqual(self.path.read_text(), "other lock owner")

    def test_contending_owner_does_not_truncate_and_can_retry_after_release(self):
        self.path.write_text("existing lock owner")
        with self.path.open("r+") as holder:
            fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertFalse(scheduler._acquire_scheduler_lock(self.configured))
            self.assertEqual(self.path.read_text(), "existing lock owner")
            self.assertFalse(scheduler._scheduler_lock_acquired)
            fcntl.flock(holder.fileno(), fcntl.LOCK_UN)
            self.assertTrue(scheduler._acquire_scheduler_lock(self.configured))
        scheduler._release_scheduler_lock()
        with self.path.open("r+") as next_owner:
            fcntl.flock(next_owner.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == "__main__":
    unittest.main()
