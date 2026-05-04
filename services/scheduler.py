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
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

from appwrite.exception import AppwriteException
from appwrite_client import COLLECTIONS
from appwrite_helpers import list_documents_all, update_document_safe, format_datetime

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
            all_settings = list_documents_all(COLLECTIONS["user_settings"])
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

        for settings in settings_with_feeds:
            try:
                count = fetch_and_cache_feeds(
                    settings.get("user_id"),
                    _configured_feed_urls(settings),
                )
                update_document_safe(
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