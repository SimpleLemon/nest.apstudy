import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

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
        )
        self.jobs.append(job)
        return job

    def get_jobs(self):
        return list(self.jobs)

    def start(self):
        self.running = True

    def shutdown(self, wait=False):
        self.running = False


class SchedulerDiagnosticsTests(unittest.TestCase):
    def tearDown(self):
        scheduler._scheduler = None

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
        with patch.dict(os.environ, {"SCHEDULER_ENABLED": "1"}, clear=False), \
                patch.object(scheduler, "BackgroundScheduler", FakeScheduler), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler.init_scheduler(app)

        status = scheduler.scheduler_status()
        self.assertTrue(status["scheduler_running"])
        self.assertIn("check_course_seat_tracks", {job["id"] for job in status["jobs"]})
        self.assertEqual(emit_event.call_args.args[0], "Scheduler Started")
        self.assertIn("check_course_seat_tracks", emit_event.call_args.kwargs["metadata"]["job_ids"])

    def test_course_tracking_wrapper_emits_server_log_on_exception(self):
        app = Flask(__name__)
        with patch("services.course_tracking.check_course_seat_tracks", side_effect=RuntimeError("boom")), \
                patch("services.discord_audit.emit_server_log_event", return_value=True) as emit_event:
            scheduler._check_course_seat_tracks(app)

        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Course Seat Tracking Scheduler Failed")
        self.assertEqual(emit_event.call_args.kwargs["metadata"]["job_id"], "check_course_seat_tracks")


if __name__ == "__main__":
    unittest.main()
