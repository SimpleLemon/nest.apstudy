import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from appwrite.exception import AppwriteException

from services import course_tracking


class CourseTrackingTests(unittest.TestCase):
    def _track(self, row_id, user_id, section_id="Fall_2026-CS-170-1234-1"):
        return {
            "$id": row_id,
            "user_id": user_id,
            "section_id": section_id,
            "term": "Fall_2026",
            "subject": "CS",
            "catalog": "170",
            "crn": "1234",
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "enabled": True,
            "last_status": "Closed",
            "last_seats_available": 0,
        }

    def _open_section(self):
        return {
            "id": "Fall_2026-CS-170-1234-1",
            "term": "Fall_2026",
            "subject": "CS",
            "catalog_number": "170",
            "crn": "1234",
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "section_number": "1",
            "instructor": "Ada Lovelace",
            "enrollment_status": "Open",
            "seats_available": 2,
        }

    def test_scheduler_course_tracking_interval_is_five_minutes(self):
        root = os.path.dirname(os.path.dirname(__file__))
        with open(os.path.join(root, "services", "scheduler.py"), encoding="utf-8") as handle:
            source = handle.read()

        self.assertIn("trigger=IntervalTrigger(minutes=5)", source)
        self.assertIn('name="Check tracked Emory course seats every 5 min"', source)
        self.assertNotIn("Check tracked Emory course seats every 10 min", source)

    def test_no_enabled_tracks_skips_atlas_ping(self):
        with patch.dict(course_tracking.COLLECTIONS, {"course_seat_tracks": "tracks"}, clear=False), \
                patch.object(course_tracking, "list_rows_all", return_value=[]), \
                patch.object(course_tracking, "fetch_live_section_status") as fetch_status, \
                patch.object(course_tracking, "emit_course_track_event") as emit_event:
            notified = course_tracking.check_course_seat_tracks()

        self.assertEqual(notified, 0)
        fetch_status.assert_not_called()
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Automated Course Track Poll Skipped")
        metadata = emit_event.call_args.kwargs["metadata"]
        self.assertEqual(metadata["reason"], "no_enabled_tracks")
        self.assertEqual(metadata["track_count"], 0)

    def test_missing_collection_mapping_emits_skipped_poll_log(self):
        with patch.dict(course_tracking.COLLECTIONS, {"course_seat_tracks": ""}, clear=False), \
                patch.object(course_tracking, "list_rows_all") as list_rows, \
                patch.object(course_tracking, "emit_course_track_event") as emit_event:
            notified = course_tracking.check_course_seat_tracks()

        self.assertEqual(notified, 0)
        list_rows.assert_not_called()
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Automated Course Track Poll Skipped")
        self.assertEqual(emit_event.call_args.kwargs["metadata"]["reason"], "collection_mapping_missing")

    def test_list_tracks_failure_emits_failed_poll_log(self):
        with patch.dict(course_tracking.COLLECTIONS, {"course_seat_tracks": "tracks"}, clear=False), \
                patch.object(course_tracking, "list_rows_all", side_effect=AppwriteException("Appwrite unavailable")), \
                patch.object(course_tracking, "fetch_live_section_status") as fetch_status, \
                patch.object(course_tracking, "emit_course_track_event") as emit_event:
            notified = course_tracking.check_course_seat_tracks()

        self.assertEqual(notified, 0)
        fetch_status.assert_not_called()
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Automated Course Track Poll Failed")
        self.assertIn("Appwrite unavailable", emit_event.call_args.kwargs["metadata"]["error"])

    def test_duplicate_tracks_share_one_atlas_ping_and_one_check_log(self):
        tracks = [self._track("track-1", "user-1"), self._track("track-2", "user-2")]
        section = self._open_section()

        with patch.dict(course_tracking.COLLECTIONS, {"course_seat_tracks": "tracks"}, clear=False), \
                patch.object(course_tracking, "list_rows_all", return_value=tracks), \
                patch.object(course_tracking, "fetch_live_section_status", return_value={"section": section}) as fetch_status, \
                patch.object(course_tracking, "_send_open_email") as send_email, \
                patch.object(course_tracking, "update_row_safe", side_effect=lambda table, row_id, data: {"$id": row_id, **data}) as update_row, \
                patch.object(course_tracking, "emit_course_track_event") as emit_event, \
                patch.object(course_tracking, "_now_utc", return_value=datetime(2026, 5, 29, tzinfo=timezone.utc)):
            notified = course_tracking.check_course_seat_tracks()

        self.assertEqual(notified, 2)
        fetch_status.assert_called_once_with("Fall_2026", "CS", "170", crn="1234")
        self.assertEqual(send_email.call_count, 2)
        self.assertEqual(update_row.call_count, 2)
        self.assertEqual({call.args[1] for call in update_row.call_args_list}, {"track-1", "track-2"})

        checked_events = [
            call for call in emit_event.call_args_list
            if call.args[0] == "Automated Course Track Checked"
        ]
        self.assertEqual(len(checked_events), 1)
        metadata = checked_events[0].kwargs["metadata"]
        self.assertEqual(metadata["track_count"], 2)
        self.assertEqual(metadata["user_count"], 2)
        self.assertEqual(metadata["request_source"], "automated")

        completed_events = [
            call for call in emit_event.call_args_list
            if call.args[0] == "Automated Course Track Poll Completed"
        ]
        self.assertEqual(len(completed_events), 1)
        summary = completed_events[0].kwargs["metadata"]
        self.assertEqual(summary["track_count"], 2)
        self.assertEqual(summary["section_group_count"], 1)
        self.assertEqual(summary["atlas_checks_attempted"], 1)
        self.assertEqual(summary["atlas_checks_succeeded"], 1)
        self.assertEqual(summary["atlas_checks_failed"], 0)
        self.assertEqual(summary["row_updates"], 2)
        self.assertEqual(summary["email_notifications"], 2)

    def test_duplicate_track_failure_logs_once_and_updates_each_row(self):
        tracks = [self._track("track-1", "user-1"), self._track("track-2", "user-2")]

        with patch.dict(course_tracking.COLLECTIONS, {"course_seat_tracks": "tracks"}, clear=False), \
                patch.object(course_tracking, "list_rows_all", return_value=tracks), \
                patch.object(course_tracking, "fetch_live_section_status", return_value={"error": "Atlas unavailable"}) as fetch_status, \
                patch.object(course_tracking, "update_row_safe", side_effect=lambda table, row_id, data: {"$id": row_id, **data}) as update_row, \
                patch.object(course_tracking, "emit_course_track_event") as emit_event, \
                patch.object(course_tracking, "_now_utc", return_value=datetime(2026, 5, 29, tzinfo=timezone.utc)):
            notified = course_tracking.check_course_seat_tracks()

        self.assertEqual(notified, 0)
        fetch_status.assert_called_once_with("Fall_2026", "CS", "170", crn="1234")
        self.assertEqual(update_row.call_count, 2)

        failed_events = [
            call for call in emit_event.call_args_list
            if call.args[0] == "Automated Course Track Check Failed"
        ]
        self.assertEqual(len(failed_events), 1)
        metadata = failed_events[0].kwargs["metadata"]
        self.assertEqual(metadata["track_count"], 2)
        self.assertEqual(metadata["user_count"], 2)
        self.assertEqual(metadata["error"], "Atlas unavailable")

        completed_events = [
            call for call in emit_event.call_args_list
            if call.args[0] == "Automated Course Track Poll Completed"
        ]
        self.assertEqual(len(completed_events), 1)
        summary = completed_events[0].kwargs["metadata"]
        self.assertEqual(summary["track_count"], 2)
        self.assertEqual(summary["section_group_count"], 1)
        self.assertEqual(summary["atlas_checks_attempted"], 1)
        self.assertEqual(summary["atlas_checks_succeeded"], 0)
        self.assertEqual(summary["atlas_checks_failed"], 1)
        self.assertEqual(summary["row_updates"], 2)
        self.assertEqual(summary["email_notifications"], 0)

    def test_live_check_exception_logs_failure_and_completed_poll(self):
        tracks = [self._track("track-1", "user-1")]

        with patch.dict(course_tracking.COLLECTIONS, {"course_seat_tracks": "tracks"}, clear=False), \
                patch.object(course_tracking, "list_rows_all", return_value=tracks), \
                patch.object(course_tracking, "fetch_live_section_status", side_effect=RuntimeError("Atlas exploded token=secret")), \
                patch.object(course_tracking, "update_row_safe", side_effect=lambda table, row_id, data: {"$id": row_id, **data}), \
                patch.object(course_tracking, "emit_course_track_event") as emit_event, \
                patch.object(course_tracking, "_now_utc", return_value=datetime(2026, 5, 29, tzinfo=timezone.utc)):
            notified = course_tracking.check_course_seat_tracks()

        self.assertEqual(notified, 0)
        failed_events = [
            call for call in emit_event.call_args_list
            if call.args[0] == "Automated Course Track Check Failed"
        ]
        self.assertEqual(len(failed_events), 1)
        self.assertIn("token=[redacted]", failed_events[0].kwargs["metadata"]["error"])

        completed_events = [
            call for call in emit_event.call_args_list
            if call.args[0] == "Automated Course Track Poll Completed"
        ]
        self.assertEqual(len(completed_events), 1)
        self.assertEqual(completed_events[0].kwargs["metadata"]["atlas_checks_failed"], 1)


if __name__ == "__main__":
    unittest.main()
