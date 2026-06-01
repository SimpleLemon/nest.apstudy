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

import fcntl
import os
import json
import logging
import socket
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
)
from services.staleness import is_stale

logger = logging.getLogger(__name__)

# Module-level scheduler instance. Initialized once via init_scheduler().
_scheduler = None
_scheduler_lock_file = None
_scheduler_lock_acquired = False
_scheduler_lock_path = None


def _configured_scheduler_lock_path():
    return os.environ.get("SCHEDULER_LOCK_PATH") or "/tmp/nest_apstudy_scheduler.lock"


def _release_scheduler_lock():
    global _scheduler_lock_file, _scheduler_lock_acquired, _scheduler_lock_path

    if _scheduler_lock_file is None:
        _scheduler_lock_acquired = False
        _scheduler_lock_path = None
        return
    try:
        fcntl.flock(_scheduler_lock_file.fileno(), fcntl.LOCK_UN)
    except OSError:
        logger.exception("Failed to release scheduler lock")
    try:
        _scheduler_lock_file.close()
    except OSError:
        logger.exception("Failed to close scheduler lock file")
    _scheduler_lock_file = None
    _scheduler_lock_acquired = False
    _scheduler_lock_path = None


def _acquire_scheduler_lock():
    global _scheduler_lock_file, _scheduler_lock_acquired, _scheduler_lock_path

    if _scheduler_lock_acquired:
        return True

    lock_path = _configured_scheduler_lock_path()
    os.makedirs(os.path.dirname(lock_path) or ".", exist_ok=True)
    lock_file = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_file.close()
        _scheduler_lock_file = None
        _scheduler_lock_acquired = False
        _scheduler_lock_path = lock_path
        return False
    except OSError:
        lock_file.close()
        _scheduler_lock_file = None
        _scheduler_lock_acquired = False
        _scheduler_lock_path = lock_path
        logger.exception("Failed to acquire scheduler lock: %s", lock_path)
        return False

    lock_file.seek(0)
    lock_file.truncate()
    lock_file.write(f"pid={os.getpid()} host={socket.gethostname()}\n")
    lock_file.flush()
    _scheduler_lock_file = lock_file
    _scheduler_lock_acquired = True
    _scheduler_lock_path = lock_path
    return True


def _emit_scheduler_event(title, metadata=None, color="gray"):
    try:
        from services.discord_audit import emit_server_log_event

        return emit_server_log_event(
            title,
            actor="System",
            target="Background scheduler",
            metadata=metadata or {},
            color=color,
        )
    except Exception:
        logger.exception("Failed to emit scheduler diagnostic event")
        return False


def scheduler_status():
    jobs = []
    if _scheduler is not None:
        try:
            jobs = [
                {
                    "id": getattr(job, "id", ""),
                    "name": getattr(job, "name", ""),
                    "next_run_time": (
                        format_datetime(getattr(job, "next_run_time", None))
                        if getattr(job, "next_run_time", None)
                        else None
                    ),
                }
                for job in _scheduler.get_jobs()
            ]
        except Exception:
            logger.exception("Failed to read scheduler jobs")
    return {
        "scheduler_enabled": os.environ.get("SCHEDULER_ENABLED") == "1",
        "scheduler_initialized": _scheduler is not None,
        "scheduler_running": bool(_scheduler and _scheduler.running),
        "scheduler_lock_acquired": bool(_scheduler_lock_acquired),
        "scheduler_lock_path": _scheduler_lock_path or _configured_scheduler_lock_path(),
        "scheduler_process_id": os.getpid(),
        "scheduler_hostname": socket.gethostname(),
        "jobs": jobs,
    }


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
            _emit_scheduler_event(
                "Course Seat Tracking Scheduler Failed",
                metadata={"job_id": "check_course_seat_tracks"},
                color="red",
            )


def _sync_discord_chat(app):
    """Poll Discord-backed chat channels and notify /chat clients via chat events."""
    with app.app_context():
        try:
            from blueprints.chat_api import sync_discord_channels

            created_count = sync_discord_channels(emit_events=True)
            if created_count:
                logger.info("Discord chat sync: %s new message(s).", created_count)
        except Exception:
            logger.exception("Discord chat sync failed")


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
        _emit_scheduler_event(
            "Scheduler Disabled",
            metadata={"scheduler_enabled": False, "SCHEDULER_ENABLED": os.environ.get("SCHEDULER_ENABLED", "")},
            color="yellow",
        )
        return

    if _scheduler is not None:
        logger.warning("Scheduler already initialized. Skipping.")
        return

    if not _acquire_scheduler_lock():
        logger.warning(
            "Scheduler lock is held by another process. Skipping scheduler startup: %s",
            _scheduler_lock_path,
        )
        return

    default_interval = int(
        os.environ.get("FEED_REFRESH_INTERVAL_MINUTES", "15")
    )

    try:
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
            trigger=IntervalTrigger(minutes=5),
            id="check_course_seat_tracks",
            name="Check tracked Emory course seats every 5 min",
            replace_existing=True,
            max_instances=1,
        )

        discord_sync_seconds = int(os.environ.get("DISCORD_CHAT_SYNC_SECONDS", "5"))
        if os.environ.get("DISCORD_CHAT_SYNC_ENABLED", "1") != "0" and discord_sync_seconds > 0:
            _scheduler.add_job(
                func=lambda: _sync_discord_chat(app),
                trigger=IntervalTrigger(seconds=discord_sync_seconds),
                id="sync_discord_chat",
                name=f"Sync Discord chat every {discord_sync_seconds} sec",
                replace_existing=True,
                max_instances=1,
                coalesce=True,
            )

        _scheduler.start()
    except Exception:
        _scheduler = None
        _release_scheduler_lock()
        raise
    logger.info(
        f"Scheduler started. Feed refresh interval: {default_interval} min."
    )
    _emit_scheduler_event(
        "Scheduler Started",
        metadata={
            "scheduler_enabled": True,
            "scheduler_lock_acquired": True,
            "scheduler_lock_path": _scheduler_lock_path,
            "scheduler_process_id": os.getpid(),
            "scheduler_hostname": socket.gethostname(),
            "feed_refresh_interval_minutes": default_interval,
            "job_ids": ", ".join(job["id"] for job in scheduler_status()["jobs"]),
        },
        color="green",
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
    _release_scheduler_lock()
