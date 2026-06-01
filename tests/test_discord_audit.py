import hashlib
import hmac
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.notes_api as notes_api
import blueprints.admin as admin
import blueprints.auth as auth
import blueprints.courses as courses
import blueprints.webhooks as webhooks
from services import discord_audit
from services.discord_audit import (
    DiscordAuditEvent,
    DiscordAuditService,
    TokenBucket,
    _QueuedAuditEvent,
)


class ResponseStub:
    def __init__(self, status_code, payload=None, headers=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.headers = headers or {}

    def json(self):
        return self._payload


class DiscordAuditServiceTestCase(unittest.TestCase):
    def test_embed_schema_and_color_mapping(self):
        event = DiscordAuditEvent(
            channel="admin",
            title="Admin Viewed Profile",
            actor="admin-1 (admin)",
            target="user-1 (student)",
            metadata={"action_type": "view", "ip": "127.0.0.1"},
            color="gray",
            event_id="event-1",
            event_timestamp="2026-05-25T00:00:00Z",
        )

        embed = event.embed()

        self.assertEqual(embed["title"], "Admin Viewed Profile")
        self.assertEqual(embed["color"], discord_audit.COLOR_VALUES["gray"])
        self.assertEqual([field["name"] for field in embed["fields"]], ["Actor", "Target", "Metadata"])
        self.assertTrue(all(field["inline"] is True for field in embed["fields"]))
        self.assertIn("2026-05-25T00:00:00Z", embed["footer"]["text"])
        self.assertNotIn("event-1", embed["footer"]["text"])

    def test_server_log_embed_fields_are_inline(self):
        event = DiscordAuditEvent(
            channel="server_logs",
            title="Scheduler Started",
            actor="System",
            target="Background scheduler",
            metadata={"job_ids": "refresh_all_feeds, check_course_seat_tracks"},
            color="green",
        )

        embed = event.embed()

        self.assertTrue(embed["fields"])
        self.assertTrue(all(field["inline"] is True for field in embed["fields"]))

    def test_chat_delete_channel_defaults_to_requested_channel(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(discord_audit._env_channel_id("chat_deletes"), "1508949346639675543")

    def test_course_track_checked_embed_is_course_first(self):
        event = DiscordAuditEvent(
            channel="course_tracks",
            title="Automated Course Track Checked",
            actor="System",
            target="JPN 101",
            metadata={
                "course_name": "Elementary Japanese I",
                "term": "Fall_2026",
                "crn": "12345",
                "section_number": "1",
                "enrollment_type": "Open",
                "seats_open": 4,
                "user_count": 3,
                "request_source": "automated",
            },
            color="gray",
            event_timestamp="2026-05-25T00:00:00Z",
        )

        embed = event.embed()

        self.assertEqual(embed["title"], "JPN 101: Elementary Japanese I")
        self.assertEqual(embed["description"], "Sec # 1 | 3 Tracking")
        self.assertEqual([field["name"] for field in embed["fields"]], ["Enrollment", "Seats Open"])
        self.assertTrue(all(field["inline"] is True for field in embed["fields"]))
        self.assertEqual([field["value"] for field in embed["fields"]], ["Open", "4"])
        self.assertEqual(embed["timestamp"], "2026-05-25T00:00:00Z")
        self.assertEqual(embed["footer"]["text"], "2026-05-25T00:00:00Z")
        self.assertNotIn("12345", embed["footer"]["text"])
        self.assertNotIn("automated", embed["footer"]["text"])
        self.assertNotIn("Fall_2026", embed["footer"]["text"])

    def test_course_track_checked_embed_keeps_zero_open_seats(self):
        event = DiscordAuditEvent(
            channel="course_tracks",
            title="Automated Course Track Checked",
            actor="System",
            target="JPN 101",
            metadata={
                "course_name": "Elementary Japanese I",
                "term": "Fall_2026",
                "enrollment_type": "Closed",
                "seats_open": 0,
                "user_count": 1,
            },
            color="gray",
        )

        embed = event.embed()

        self.assertEqual(embed["fields"][1]["name"], "Seats Open")
        self.assertEqual(embed["fields"][1]["value"], "0")

    def test_course_track_request_embed_uses_timestamp_footer(self):
        event = DiscordAuditEvent(
            channel="course_tracks",
            title="Course Track Requested",
            actor="user-1 (student)",
            target="JPN 101",
            metadata={"term": "Spring_2026", "request_source": "manual"},
            color="green",
            event_timestamp="2026-05-25T00:00:00Z",
        )

        embed = event.embed()

        self.assertEqual(embed["footer"]["text"], "2026-05-25T00:00:00Z")
        self.assertNotIn("Spring_2026", embed["footer"]["text"])
        self.assertNotIn("{", embed["footer"]["text"])

    def test_server_logs_channel_defaults_to_requested_channel(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(discord_audit._env_channel_id("server_logs"), "1509603923433099356")

    def test_chat_delete_channel_env_override(self):
        with patch.dict(os.environ, {"DISCORD_AUDIT_CHAT_DELETES_CHANNEL_ID": "override-channel"}):
            self.assertEqual(discord_audit._env_channel_id("chat_deletes"), "override-channel")

    def test_server_log_channel_env_override(self):
        with patch.dict(os.environ, {"DISCORD_AUDIT_SERVER_LOGS_CHANNEL_ID": "override-channel"}):
            self.assertEqual(discord_audit._env_channel_id("server_logs"), "override-channel")

    def test_emit_server_log_event_targets_server_logs_channel(self):
        with patch.object(discord_audit, "emit_audit_event", return_value=True) as emit_event:
            sent = discord_audit.emit_server_log_event(
                "OAuth Login Error",
                metadata={"error_code": "AUTH-OAUTH-START-SCOPE"},
                color="red",
            )

        self.assertTrue(sent)
        event = emit_event.call_args.args[0]
        self.assertEqual(event.channel, "server_logs")
        self.assertEqual(event.title, "OAuth Login Error")
        self.assertEqual(event.metadata["error_code"], "AUTH-OAUTH-START-SCOPE")
        self.assertEqual(event.color, "red")

    def test_unhandled_request_exception_emits_sanitized_server_log(self):
        app = Flask(__name__)
        with app.test_request_context(
            "/broken?token=secret-token",
            headers={"User-Agent": "Unit Test"},
        ):
            with patch.object(discord_audit, "emit_server_log_event") as emit_event:
                discord_audit._emit_unhandled_request_exception(
                    app,
                    RuntimeError("boom token=super-secret"),
                )

        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Unhandled Server Error")
        metadata = emit_event.call_args.kwargs["metadata"]
        self.assertEqual(metadata["exception_class"], "RuntimeError")
        self.assertEqual(metadata["path"], "/broken")
        self.assertNotIn("super-secret", metadata["message"])
        self.assertIn("token=[redacted]", metadata["message"])

    def test_token_bucket_caps_four_messages_per_five_seconds(self):
        bucket = TokenBucket(capacity=4, refill_amount=4, refill_seconds=5)
        bucket.updated_at = 0.0
        bucket.tokens = 4.0

        self.assertTrue(bucket.consume(0.0))
        self.assertTrue(bucket.consume(0.0))
        self.assertTrue(bucket.consume(0.0))
        self.assertTrue(bucket.consume(0.0))
        self.assertFalse(bucket.consume(0.0))
        self.assertAlmostEqual(bucket.seconds_until_available(0.0), 1.25)
        self.assertTrue(bucket.consume(5.0))

    def test_429_retry_respects_retry_after(self):
        calls = []

        def request_func(method, url, **kwargs):
            calls.append((method, url, kwargs))
            if method == "POST":
                return ResponseStub(429, headers={"Retry-After": "7"})
            return ResponseStub(200, payload=[])

        service = DiscordAuditService(token_getter=lambda: "token", request_func=request_func)
        queued = _QueuedAuditEvent(event=DiscordAuditEvent(channel="admin", title="A", actor="B", target="C"))
        before = discord_audit.time.monotonic()
        service._send_queued(queued)

        self.assertEqual(len(service.queue), 1)
        self.assertEqual(service.queue[0].attempt, 1)
        self.assertGreaterEqual(service.queue[0].next_attempt - before, 6.9)
        self.assertEqual(calls[0][0], "POST")

    def test_5xx_retry_uses_exponential_backoff_with_jitter(self):
        def request_func(method, url, **kwargs):
            if method == "POST":
                return ResponseStub(500)
            return ResponseStub(200, payload=[])

        service = DiscordAuditService(token_getter=lambda: "token", request_func=request_func)
        queued = _QueuedAuditEvent(event=DiscordAuditEvent(channel="admin", title="A", actor="B", target="C"))
        with patch("services.discord_audit.random.uniform", return_value=1.0):
            before = discord_audit.time.monotonic()
            service._send_queued(queued)

        self.assertEqual(len(service.queue), 1)
        self.assertEqual(service.queue[0].attempt, 1)
        self.assertGreaterEqual(service.queue[0].next_attempt - before, 5.9)

    def test_retry_discards_duplicate_event_found_in_history(self):
        event = DiscordAuditEvent(channel="admin", title="A", actor="B", target="C", event_id="duplicate-id")

        def request_func(method, url, **kwargs):
            if method == "POST":
                return ResponseStub(500)
            return ResponseStub(200, payload=[{"embeds": [{"fields": [{"name": "Event ID", "value": "duplicate-id"}]}]}])

        service = DiscordAuditService(token_getter=lambda: "token", request_func=request_func)
        service._send_queued(_QueuedAuditEvent(event=event))

        self.assertEqual(len(service.queue), 0)

    def test_max_retry_attempts_persist_to_fallback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fallback_path = os.path.join(temp_dir, "discord_audit_fallback.jsonl")

            def request_func(method, url, **kwargs):
                if method == "POST":
                    return ResponseStub(500)
                return ResponseStub(200, payload=[])

            service = DiscordAuditService(
                fallback_path=fallback_path,
                token_getter=lambda: "token",
                request_func=request_func,
            )
            service._send_queued(
                _QueuedAuditEvent(
                    event=DiscordAuditEvent(channel="admin", title="A", actor="B", target="C"),
                    attempt=14,
                )
            )

            self.assertEqual(len(service.queue), 0)
            with open(fallback_path, "r", encoding="utf-8") as handle:
                lines = handle.readlines()
            self.assertEqual(len(lines), 1)

    def test_queue_overflow_persists_oldest_event(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fallback_path = os.path.join(temp_dir, "discord_audit_fallback.jsonl")
            service = DiscordAuditService(
                fallback_path=fallback_path,
                token_getter=lambda: "token",
                max_queue_events=2,
            )

            service.emit(DiscordAuditEvent(channel="admin", title="1", actor="A", target="T", event_id="one"))
            service.emit(DiscordAuditEvent(channel="admin", title="2", actor="A", target="T", event_id="two"))
            service.emit(DiscordAuditEvent(channel="admin", title="3", actor="A", target="T", event_id="three"))

            self.assertEqual([item.event.event_id for item in service.queue], ["two", "three"])
            with open(fallback_path, "r", encoding="utf-8") as handle:
                self.assertIn("one", handle.read())

    def test_replay_fallback_loads_events_and_clears_file(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fallback_path = os.path.join(temp_dir, "discord_audit_fallback.jsonl")
            with open(fallback_path, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"event": DiscordAuditEvent(channel="admin", title="A", actor="B", target="C").to_dict()}))
                handle.write("\n")

            service = DiscordAuditService(fallback_path=fallback_path, token_getter=lambda: "token")
            replayed = service.replay_fallback()

            self.assertEqual(replayed, 1)
            self.assertEqual(len(service.queue), 1)
            with open(fallback_path, "r", encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "")

    def test_invalid_response_window_pauses_sends(self):
        service = DiscordAuditService(token_getter=lambda: "token")
        for _ in range(discord_audit.INVALID_PAUSE_THRESHOLD + 1):
            service._record_invalid_response()

        self.assertTrue(service.pause_warning_pending)
        self.assertGreater(service.pause_until, discord_audit.time.monotonic())

    def test_discord_audit_status_reports_queue_fallback_and_thread_state(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            fallback_path = os.path.join(temp_dir, "discord_audit_fallback.jsonl")
            with open(fallback_path, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"event": {"title": "Stored"}}))
                handle.write("\n")

            service = DiscordAuditService(fallback_path=fallback_path, token_getter=lambda: "token")
            service.queue.append(_QueuedAuditEvent(
                event=DiscordAuditEvent(channel="admin", title="Queued", actor="A", target="T")
            ))

            with patch.object(discord_audit, "_service", service), \
                    patch.dict(os.environ, {"DISCORD_BOT_TOKEN": "token"}, clear=False):
                status = discord_audit.discord_audit_status()

        self.assertTrue(status["audit_enabled"])
        self.assertTrue(status["bot_token_present"])
        self.assertTrue(status["course_tracks_channel_present"])
        self.assertTrue(status["server_logs_channel_present"])
        self.assertTrue(status["service_initialized"])
        self.assertFalse(status["sender_thread_alive"])
        self.assertEqual(status["queue_length"], 1)
        self.assertEqual(status["fallback_line_count"], 1)
        self.assertNotIn("token-secret", json.dumps(status).lower())


class GitHubWebhookTestCase(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.register_blueprint(webhooks.webhooks_bp)

    def _signature(self, body, secret):
        digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        return f"sha256={digest}"

    def test_github_webhook_requires_secret_by_default(self):
        with patch.dict(os.environ, {"FLASK_DEBUG": "0"}, clear=True), \
                patch.object(webhooks, "emit_server_log_event") as emit_event:
            response = self.app.test_client().post(
                "/webhooks/github",
                data=b"{}",
                headers={"X-GitHub-Event": "push"},
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 503)
        emit_event.assert_not_called()

    def test_github_webhook_rejects_bad_signature(self):
        with patch.dict(os.environ, {"GITHUB_WEBHOOK_SECRET": "secret"}, clear=True), \
                patch.object(webhooks, "emit_server_log_event") as emit_event:
            response = self.app.test_client().post(
                "/webhooks/github",
                data=b"{}",
                headers={"X-GitHub-Event": "push", "X-Hub-Signature-256": "sha256=bad"},
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 401)
        emit_event.assert_not_called()

    def test_github_push_emits_one_server_log_event_per_commit(self):
        payload = {
            "ref": "refs/heads/main",
            "compare": "https://github.com/apstudy/nest/compare/a...b",
            "repository": {"full_name": "apstudy/nest"},
            "pusher": {"name": "Derek"},
            "commits": [
                {
                    "id": "abcdef1234567890",
                    "message": "Update website auth errors\n\nDetails",
                    "url": "https://github.com/apstudy/nest/commit/abcdef1",
                    "author": {"name": "Derek Chen", "email": "derek@example.com"},
                },
                {
                    "id": "1234567890abcdef",
                    "message": "Notify server logs",
                    "url": "https://github.com/apstudy/nest/commit/1234567",
                    "author": {"name": "Derek Chen"},
                },
            ],
        }
        body = json.dumps(payload).encode("utf-8")

        with patch.dict(os.environ, {"GITHUB_WEBHOOK_SECRET": "secret"}, clear=True), \
                patch.object(webhooks, "emit_server_log_event", return_value=True) as emit_event:
            response = self.app.test_client().post(
                "/webhooks/github",
                data=body,
                headers={
                    "X-GitHub-Event": "push",
                    "X-Hub-Signature-256": self._signature(body, "secret"),
                },
                content_type="application/json",
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["commits"], 2)
        self.assertEqual(emit_event.call_count, 2)
        first_call = emit_event.call_args_list[0]
        self.assertEqual(first_call.args[0], "GitHub Commit Pushed")
        self.assertEqual(first_call.kwargs["actor"], "Derek")
        self.assertEqual(first_call.kwargs["target"], "apstudy/nest@main")
        self.assertEqual(first_call.kwargs["metadata"]["commit"], "abcdef1")
        self.assertEqual(first_call.kwargs["metadata"]["message"], "Update website auth errors")

    def test_github_webhook_ignores_non_push_events(self):
        with patch.dict(os.environ, {"GITHUB_WEBHOOK_ALLOW_UNSIGNED": "1"}, clear=True), \
                patch.object(webhooks, "emit_server_log_event") as emit_event:
            response = self.app.test_client().post(
                "/webhooks/github",
                json={"action": "opened"},
                headers={"X-GitHub-Event": "pull_request"},
            )

        self.assertEqual(response.status_code, 202)
        emit_event.assert_not_called()


class DiscordAuditRouteInstrumentationTestCase(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.register_blueprint(notes_api.notes_api_bp)
        self.user = SimpleNamespace(id="user-1", username="student", name="Student")

    def _unwrap(self, func):
        while hasattr(func, "__wrapped__"):
            func = func.__wrapped__
        return func

    def test_new_user_creation_emits_creation_event(self):
        user_doc = {
            "$id": "user-1",
            "email": "student@example.com",
            "name": "Student",
            "username": "student",
            "onboarding_complete": False,
        }
        settings_doc = {"$id": "user-1", "user_id": "user-1"}
        create_results = [user_doc, settings_doc]

        with self.app.test_request_context(
            "/auth/session",
            method="POST",
            json={"jwt": "jwt-token", "provider": "appwrite"},
        ):
            with patch.object(auth, "_account_from_jwt", return_value={"$id": "user-1", "email": "student@example.com", "name": "Student"}), \
                    patch.object(auth, "get_row_safe", return_value=None), \
                    patch.object(auth, "_find_user_by_email", return_value=None), \
                    patch.object(auth, "_fetch_provider_profile", return_value={}), \
                    patch.object(auth, "create_row_safe", side_effect=lambda *args, **kwargs: create_results.pop(0)), \
                    patch.object(auth, "sync_chat_presence_labels_for_user"), \
                    patch.object(auth, "login_user"), \
                    patch.object(auth, "url_for", side_effect=lambda endpoint, **kwargs: f"/{endpoint}"), \
                    patch.object(auth, "emit_user_event") as emit_event:
                response = auth.appwrite_session()

        self.assertEqual(response.get_json()["status"], "ok")
        self.assertEqual(len(emit_event.call_args_list), 2)
        self.assertEqual(emit_event.call_args_list[0].args[0], "New User Created")
        self.assertEqual(emit_event.call_args_list[1].args[0], "User Login")

    def test_admin_detail_view_emits_admin_event(self):
        admin_user = SimpleNamespace(id="admin-1", username="admin", name="Admin", is_authenticated=True)
        user_doc = {"$id": "user-1", "username": "student", "name": "Student"}

        with self.app.test_request_context("/admin/user-1?section=overview"):
            with patch.object(admin, "current_user", admin_user), \
                    patch.object(admin, "get_row_safe", return_value=user_doc), \
                    patch.object(admin, "_fetch_account", return_value={}), \
                    patch.object(admin, "_safe_count_rows", return_value=0), \
                    patch.object(admin, "_chat_count_summary", return_value={}), \
                    patch.object(admin, "_load_section", return_value={}), \
                    patch.object(admin, "_pending_admin_request_count", return_value=0), \
                    patch.object(admin, "_theme_preference", return_value=None), \
                    patch.object(admin, "url_for", side_effect=lambda endpoint, **kwargs: f"/{endpoint}"), \
                    patch.object(admin, "render_template", return_value="ok"), \
                    patch.object(admin, "emit_admin_event") as emit_event:
                response = self._unwrap(admin.admin_detail)("user-1")

        self.assertEqual(response, "ok")
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Admin Viewed Profile")

    def test_course_track_upsert_emits_course_track_event(self):
        section = {
            "id": "Fall_2026-CS-170-1234-1",
            "term": "Fall_2026",
            "subject": "CS",
            "catalog_number": "170",
            "crn": "1234",
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "section_number": "1",
            "instructor": "Ada Lovelace",
            "enrollment_status": "Closed",
            "seats_available": 0,
        }
        track = {
            "$id": "track-1",
            "user_id": "user-1",
            "section_id": section["id"],
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "enabled": True,
        }
        user = SimpleNamespace(id="user-1", username="student", name="Student", emory_student=True)

        with self.app.test_request_context("/api/courses/tracks", method="POST", json={"section_id": section["id"], "enabled": True}):
            with patch.object(courses, "current_user", user), \
                    patch.object(courses, "_require_emory_student", return_value=None), \
                    patch.object(courses, "_get_section_by_id", return_value=section), \
                    patch.object(courses, "_merge_live_section", return_value=(section, None, "2026-05-25T00:00:00Z")), \
                    patch.object(courses, "is_section_trackable", return_value=True), \
                    patch.object(courses, "_track_for_section", return_value=None), \
                    patch.object(courses, "create_row_safe", return_value=track), \
                    patch.object(courses, "emit_course_track_event") as emit_event:
                response = self._unwrap(courses.upsert_track)()

        payload = response.get_json()
        self.assertEqual(payload["status"], "ok")
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "Course Track Requested")

    def test_spring_course_track_upsert_requires_admin_open_gate(self):
        section = {
            "id": "Spring_2026-CS-170-1234-1",
            "term": "Spring_2026",
            "subject": "CS",
            "catalog_number": "170",
            "crn": "1234",
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "section_number": "1",
            "enrollment_status": "Closed",
            "seats_available": 0,
        }
        user = SimpleNamespace(id="user-1", username="student", name="Student", emory_student=True)

        with self.app.test_request_context("/api/courses/tracks", method="POST", json={"section_id": section["id"], "enabled": True}):
            with patch.object(courses, "current_user", user), \
                    patch.object(courses, "_require_emory_student", return_value=None), \
                    patch.object(courses, "_get_section_by_id", return_value=section), \
                    patch.object(courses, "spring_course_tracking_open", return_value=False), \
                    patch.object(courses, "_merge_live_section") as merge_live:
                response, status = self._unwrap(courses.upsert_track)()

        self.assertEqual(status, 403)
        self.assertIn("Spring course tracking", response.get_json()["error"])
        merge_live.assert_not_called()

    def test_spring_course_track_upsert_works_when_admin_gate_open(self):
        section = {
            "id": "Spring_2026-CS-170-1234-1",
            "term": "Spring_2026",
            "subject": "CS",
            "catalog_number": "170",
            "crn": "1234",
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "section_number": "1",
            "enrollment_status": "Closed",
            "seats_available": 0,
        }
        track = {"$id": "track-1", "user_id": "user-1", "section_id": section["id"], "enabled": True}
        user = SimpleNamespace(id="user-1", username="student", name="Student", emory_student=True)

        with self.app.test_request_context("/api/courses/tracks", method="POST", json={"section_id": section["id"], "enabled": True}):
            with patch.object(courses, "current_user", user), \
                    patch.object(courses, "_require_emory_student", return_value=None), \
                    patch.object(courses, "_get_section_by_id", return_value=section), \
                    patch.object(courses, "spring_course_tracking_open", return_value=True), \
                    patch.object(courses, "_merge_live_section", return_value=(section, None, "2026-05-25T00:00:00Z")), \
                    patch.object(courses, "is_section_trackable", return_value=True), \
                    patch.object(courses, "_track_for_section", return_value=None), \
                    patch.object(courses, "create_row_safe", return_value=track), \
                    patch.object(courses, "emit_course_track_event"):
                response = self._unwrap(courses.upsert_track)()

        self.assertEqual(response.get_json()["status"], "ok")

    def test_spring_course_track_disable_works_while_gate_closed(self):
        section = {
            "id": "Spring_2026-CS-170-1234-1",
            "term": "Spring_2026",
            "subject": "CS",
            "catalog_number": "170",
            "crn": "1234",
            "course_code": "CS 170",
            "course_title": "Intro CS",
            "section_number": "1",
            "enrollment_status": "Closed",
            "seats_available": 0,
        }
        existing = {"$id": "track-1", "enabled": True}
        updated = {"$id": "track-1", "user_id": "user-1", "section_id": section["id"], "enabled": False}
        user = SimpleNamespace(id="user-1", username="student", name="Student", emory_student=True)

        with self.app.test_request_context("/api/courses/tracks", method="POST", json={"section_id": section["id"], "enabled": False}):
            with patch.object(courses, "current_user", user), \
                    patch.object(courses, "_require_emory_student", return_value=None), \
                    patch.object(courses, "_get_section_by_id", return_value=section), \
                    patch.object(courses, "spring_course_tracking_open", return_value=False), \
                    patch.object(courses, "_track_for_section", return_value=existing), \
                    patch.object(courses, "update_row_safe", return_value=updated), \
                    patch.object(courses, "emit_course_track_event"):
                response = self._unwrap(courses.upsert_track)()

        self.assertEqual(response.get_json()["track"]["enabled"], False)

    def test_note_creation_emits_creation_event(self):
        created_note = {
            "$id": "note-1",
            "user_id": "user-1",
            "title": "Lab Notes",
            "content": "",
            "order": 1000,
            "created_at": "2026-05-25T00:00:00Z",
            "updated_at": "2026-05-25T00:00:00Z",
        }
        with self.app.test_request_context("/api/notes", method="POST", json={"title": "Lab Notes", "content": ""}):
            with patch.object(notes_api, "current_user", self.user), \
                    patch.object(notes_api, "list_rows_all", return_value=[]), \
                    patch.object(notes_api, "create_row_safe", return_value=created_note), \
                    patch.object(notes_api, "emit_creation_event") as emit_event:
                response, status = notes_api.create_note.__wrapped__()

        self.assertEqual(status, 201)
        self.assertEqual(response.get_json()["id"], "note-1")
        emit_event.assert_called_once()
        self.assertEqual(emit_event.call_args.args[0], "New Note Created")


if __name__ == "__main__":
    unittest.main()
