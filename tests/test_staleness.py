import unittest
from datetime import datetime, timedelta, timezone

from services.staleness import is_stale


class TestStaleness(unittest.TestCase):
    def test_missing_last_fetched_is_stale(self):
        now = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)
        self.assertTrue(is_stale(None, 15, now=now))

    def test_recent_not_stale(self):
        now = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)
        last = now - timedelta(minutes=10)
        self.assertFalse(is_stale(last, 15, now=now))

    def test_old_is_stale(self):
        now = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)
        last = now - timedelta(minutes=20)
        self.assertTrue(is_stale(last, 15, now=now))

    def test_zero_interval_not_stale(self):
        now = datetime(2026, 5, 12, 12, 0, 0, tzinfo=timezone.utc)
        self.assertFalse(is_stale(now, 0, now=now))


if __name__ == "__main__":
    unittest.main()
