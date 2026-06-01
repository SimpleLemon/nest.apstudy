import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from flask import Flask

from services import scheduler


class FakeScheduler:
    def __init__(self, daemon=True):
        self.daemon = daemon
        self.running = False
        self.jobs = []

    def add_job(self, **kwargs):
        job = SimpleNamespace(
            id=kwargs.get("id"),
            name=kwargs.get("name"),
            next_run_time=None,
            kwargs=kwargs,
        )
        self.jobs.append(job)
        return job

    def get_jobs(self):
        return list(self.jobs)

    def get_job(self, job_id):
        for job in self.jobs:
            if job.id == job_id:
                return job
        return None

    def reschedule_job(self, job_id, trigger):
        job = self.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        job.kwargs["trigger"] = trigger
        return job

    def modify_job(self, job_id, **kwargs):
        job = self.get_job(job_id)
        if job is None:
            raise KeyError(job_id)
        for key, value in kwargs.items():
            setattr(job, key, value)
        return job

    def start(self):
        self.running = True

    def shutdown(self, wait=False):
        self.running = False


class SchedulerDiagnosticsTests(unittest.TestCase):
    def tearDown(self):
        scheduler.shutdown_scheduler()

    def test_scheduler_disabled_emits_diagnostic_without_starting(self):
        app = Flask(__name__)
        with patch.dict(os.environ, {"SCHEDULER_ENABLED": "0"}, clear=False), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler.init_scheduler(app)

        self.assertIsNone(scheduler._scheduler)
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Scheduler Disabled")
        self.assertFalse(emit_event.call_args.kwargs["metadata"]["scheduler_enabled"])

    def test_scheduler_enabled_registers_course_tracking_job_and_emits_started(self):
        app = Flask(__name__)
        with tempfile.TemporaryDirectory() as temp_dir, \
                patch.dict(os.environ, {
                    "SCHEDULER_ENABLED": "1",
                    "SCHEDULER_LOCK_PATH": os.path.join(temp_dir, "scheduler.lock"),
                }, clear=False), \
                patch.object(scheduler, "BackgroundScheduler", FakeScheduler), \
                patch.object(scheduler, "get_course_tracking_refresh_minutes", return_value=30), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler.init_scheduler(app)

        status = scheduler.scheduler_status()
        self.assertTrue(status["scheduler_running"])
        self.assertTrue(status["scheduler_lock_acquired"])
        self.assertEqual(
            {job["id"] for job in status["jobs"]},
            {"refresh_all_feeds", "check_course_seat_tracks", "sync_discord_chat"},
        )
        course_tracking_job = next(job for job in status["jobs"] if job["id"] == "check_course_seat_tracks")
        self.assertIn("30 min", course_tracking_job["name"])
        self.assertEqual(emit_event.call_args.args[0], "Scheduler Started")
        metadata = emit_event.call_args.kwargs["metadata"]
        self.assertTrue(metadata["scheduler_lock_acquired"])
        self.assertEqual(metadata["scheduler_process_id"], os.getpid())
        self.assertEqual(metadata["course_tracking_refresh_interval_minutes"], 30)
        self.assertIn("check_course_seat_tracks", metadata["job_ids"])

    def test_scheduler_lock_contention_skips_startup_and_started_log(self):
        app = Flask(__name__)
        scheduler_factory = Mock(side_effect=FakeScheduler)
        with patch.dict(os.environ, {"SCHEDULER_ENABLED": "1"}, clear=False), \
                patch.object(scheduler, "_acquire_scheduler_lock", return_value=False), \
                patch.object(scheduler, "BackgroundScheduler", scheduler_factory), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler.init_scheduler(app)

        self.assertIsNone(scheduler._scheduler)
        scheduler_factory.assert_not_called()
        emit_event.assert_not_called()
        self.assertFalse(scheduler.scheduler_status()["scheduler_lock_acquired"])

    def test_scheduler_double_init_starts_once(self):
        app = Flask(__name__)
        scheduler_factory = Mock(side_effect=FakeScheduler)
        with tempfile.TemporaryDirectory() as temp_dir, \
                patch.dict(os.environ, {
                    "SCHEDULER_ENABLED": "1",
                    "SCHEDULER_LOCK_PATH": os.path.join(temp_dir, "scheduler.lock"),
                }, clear=False), \
                patch.object(scheduler, "BackgroundScheduler", scheduler_factory), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler.init_scheduler(app)
            scheduler.init_scheduler(app)

        scheduler_factory.assert_called_once()
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Scheduler Started")

    def test_shutdown_releases_scheduler_lock(self):
        app = Flask(__name__)
        with tempfile.TemporaryDirectory() as temp_dir, \
                patch.dict(os.environ, {
                    "SCHEDULER_ENABLED": "1",
                    "SCHEDULER_LOCK_PATH": os.path.join(temp_dir, "scheduler.lock"),
                }, clear=False), \
                patch.object(scheduler, "BackgroundScheduler", FakeScheduler), \
                patch("services.discord_audit.emit_server_log_event", return_value=True):
            scheduler.init_scheduler(app)
            self.assertTrue(scheduler.scheduler_status()["scheduler_lock_acquired"])
            scheduler.shutdown_scheduler()

        status = scheduler.scheduler_status()
        self.assertFalse(status["scheduler_running"])
        self.assertFalse(status["scheduler_lock_acquired"])

    def test_course_tracking_wrapper_emits_server_log_on_exception(self):
        app = Flask(__name__)
        with patch("services.course_tracking.check_course_seat_tracks", side_effect=RuntimeError("boom")), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler._check_course_seat_tracks(app)

        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Course Seat Tracking Scheduler Failed")
        self.assertEqual(emit_event.call_args.kwargs["metadata"]["job_id"], "check_course_seat_tracks")

    def test_update_course_tracking_refresh_interval_reschedules_job(self):
        fake_scheduler = FakeScheduler()
        fake_scheduler.running = True
        fake_scheduler.add_job(
            id="check_course_seat_tracks",
            name="Check tracked Emory course seats every 5 min",
            trigger=None,
        )

        with patch.object(scheduler, "_scheduler", fake_scheduler):
            updated = scheduler.update_course_tracking_refresh_interval(30)

        self.assertTrue(updated)
        job = fake_scheduler.get_job("check_course_seat_tracks")
        self.assertEqual(job.name, "Check tracked Emory course seats every 30 min")
        self.assertIsNotNone(job.kwargs["trigger"])

    def test_feed_refresh_does_not_write_user_settings_heartbeat(self):
        app = Flask(__name__)
        settings = {
            "$id": "settings-1",
            "user_id": "user-1",
            "canvas_ical_url": "https://example.com/feed.ics",
            "feed_refresh_minutes": "5",
        }
        with patch.object(scheduler, "list_rows_all", return_value=[settings]), \
                patch.object(scheduler, "first_row", return_value=None), \
                patch.object(scheduler, "is_stale", return_value=True), \
                patch("services.feed_fetcher.fetch_and_cache_feeds", return_value=0) as fetch_feeds, \
                patch("services.scheduler.update_row_safe", create=True) as update_row:
            scheduler._refresh_all_feeds(app)

        fetch_feeds.assert_called_once_with("user-1", ["https://example.com/feed.ics"])
        update_row.assert_not_called()


if __name__ == "__main__":
    unittest.main()
