"""
services/scheduler.py

Background task scheduler using APScheduler.
Handles periodic Canvas iCal feed refresh for all users.

Must be initialized within a Flask application context because
the scheduled jobs access the database via Appwrite.

Warning: When running under Gunicorn with multiple workers, each worker
spawns its own scheduler. Use the SCHEDULER_ENABLED environment variable
or Gunicorn's --preload flag with a worker check to ensure only one
instance runs scheduled jobs [8].
"""

import os
import json
import logging
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_client import COLLECTIONS
from appwrite_helpers import (
    first_row,
    format_datetime,
    list_rows_all,
    parse_datetime,
    update_row_safe,
)
from services.staleness import is_stale

logger = logging.getLogger(__name__)

# Module-level scheduler instance. Initialized once via init_scheduler().
_scheduler = None


def _configured_feed_urls(settings):
    """Return all configured calendar URLs from user settings."""
    urls = []
    canvas_url = settings.get("canvas_ical_url")
    if canvas_url:
        urls.append(canvas_url.strip())

    other_urls = settings.get("other_ical_urls_json")
    if other_urls:
        try:
            extras = json.loads(other_urls)
            if isinstance(extras, list):
                for item in extras:
                    if isinstance(item, str) and item.strip():
                        urls.append(item.strip())
        except json.JSONDecodeError:
            pass

    return urls


def _refresh_all_feeds(app):
    """
    Iterate through all users with configured calendar feed URLs
    and refresh their cached calendar events.

    Runs inside a Flask application context so that database access works.
    """
    with app.app_context():
        from services.feed_fetcher import fetch_and_cache_feeds
        try:
            all_settings = list_rows_all(COLLECTIONS["user_settings"])
        except AppwriteException:
            logger.exception("Failed to list user settings")
            return

        settings_with_feeds = [
            settings for settings in all_settings if _configured_feed_urls(settings)
        ]

        if not settings_with_feeds:
            logger.info("Feed refresh: no users with configured feeds.")
            return

        logger.info(
            f"Feed refresh: processing {len(settings_with_feeds)} user(s)."
        )

        now = datetime.now(timezone.utc)
        for settings in settings_with_feeds:
            refresh_minutes = settings.get("feed_refresh_minutes")
            try:
                refresh_minutes = int(refresh_minutes) if refresh_minutes is not None else None
            except (TypeError, ValueError):
                refresh_minutes = None

            if refresh_minutes is None:
                refresh_minutes = int(os.environ.get("FEED_REFRESH_INTERVAL_MINUTES", "15"))

            last_fetched = None
            feed_table = COLLECTIONS.get("calendar_feeds")
            if feed_table:
                latest_feed = first_row(
                    feed_table,
                    [
                        Query.equal("user_id", [settings.get("user_id")]),
                        Query.order_desc("last_fetched"),
                    ],
                )
                if latest_feed and latest_feed.get("last_fetched"):
                    last_fetched = parse_datetime(latest_feed.get("last_fetched"))

            if not last_fetched:
                latest_event = first_row(
                    COLLECTIONS["calendar_cache"],
                    [
                        Query.equal("user_id", [settings.get("user_id")]),
                        Query.order_desc("fetched_at"),
                    ],
                )
                if latest_event and latest_event.get("fetched_at"):
                    last_fetched = parse_datetime(latest_event.get("fetched_at"))

            # Refresh only when the user's interval has elapsed.
            if not is_stale(last_fetched, refresh_minutes, now=now):
                continue
            try:
                count = fetch_and_cache_feeds(
                    settings.get("user_id"),
                    _configured_feed_urls(settings),
                )
                update_row_safe(
                    COLLECTIONS["user_settings"],
                    settings.get("$id"),
                    {"updated_at": format_datetime(datetime.utcnow())},
                )
                logger.info(
                    "  User %s: %s events cached.",
                    settings.get("user_id"),
                    count,
                )
            except AppwriteException as exc:
                logger.error(
                    "  User %s: feed refresh failed: %s",
                    settings.get("user_id"),
                    exc,
                )
            except Exception as e:
                logger.error(
                    "  User %s: feed refresh failed: %s",
                    settings.get("user_id"),
                    e,
                )


def _check_course_seat_tracks(app):
    """Run course seat tracking checks inside the Flask app context."""
    with app.app_context():
        try:
            from services.course_tracking import check_course_seat_tracks

            notified_count = check_course_seat_tracks()
            logger.info("Course seat tracking: %s notification(s) sent.", notified_count)
        except Exception:
            logger.exception("Course seat tracking failed")


def init_scheduler(app):
    """
    Initialize and start the background scheduler.

    Call this once from the application factory (app.py) after all
    extensions and blueprints are registered.

    The scheduler only starts if the SCHEDULER_ENABLED environment
    variable is set to "1". This prevents duplicate job execution
    when running multiple Gunicorn workers.

    Args:
        app: The Flask application instance.
    """
    global _scheduler

    if os.environ.get("SCHEDULER_ENABLED") != "1":
        logger.info(
            "Scheduler disabled (SCHEDULER_ENABLED != '1'). "
            "Feed refresh will only run on manual trigger."
        )
        return

    if _scheduler is not None:
        logger.warning("Scheduler already initialized. Skipping.")
        return

    default_interval = int(
        os.environ.get("FEED_REFRESH_INTERVAL_MINUTES", "15")
    )

    _scheduler = BackgroundScheduler(daemon=True)

    _scheduler.add_job(
        func=lambda: _refresh_all_feeds(app),
        trigger=IntervalTrigger(minutes=default_interval),
        id="refresh_all_feeds",
        name=f"Refresh Canvas feeds every {default_interval} min",
        replace_existing=True,
        max_instances=1,  # Prevent overlapping runs if a refresh takes longer than the interval
    )

    _scheduler.add_job(
        func=lambda: _check_course_seat_tracks(app),
        trigger=IntervalTrigger(minutes=10),
        id="check_course_seat_tracks",
        name="Check tracked Emory course seats every 10 min",
        replace_existing=True,
        max_instances=1,
    )

    _scheduler.start()
    logger.info(
        f"Scheduler started. Feed refresh interval: {default_interval} min."
    )


def shutdown_scheduler():
    """
    Gracefully shut down the scheduler.
    Call from a Flask teardown handler or signal handler.
    """
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler shut down.")
        _scheduler = None
