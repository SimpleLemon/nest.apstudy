"""
services/staleness.py

Helpers for staleness checks.
"""
from datetime import datetime, timedelta, timezone


def is_stale(last_fetched, refresh_interval_minutes, now=None):
    """
    Return True if last_fetched is older than refresh_interval_minutes.
    """
    if not refresh_interval_minutes:
        return False
    if last_fetched is None:
        return True
    if now is None:
        now = datetime.now(timezone.utc)
    if last_fetched.tzinfo is None:
        last_fetched = last_fetched.replace(tzinfo=timezone.utc)
    else:
        last_fetched = last_fetched.astimezone(timezone.utc)
    return now - last_fetched > timedelta(minutes=refresh_interval_minutes)
