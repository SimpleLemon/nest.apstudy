"""Reverse callbacks use the sidecar listener and preserve best-effort delivery."""

from dataclasses import replace
from email.message import Message
from io import BytesIO
import json
import os
import unittest
import urllib.error
import urllib.response
from unittest.mock import patch

from flask import Flask

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services.environment_config import notes_collaboration_callback_base_url
from services import notes_collaboration


class NotesCollaborationCallbackTests(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, {}, clear=True):
            self.defaults = load_environment_config()
        self.app = Flask(__name__)

    def _configure(self, **overrides):
        self.app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = replace(
            self.defaults,
            notes_collaboration_internal_secret=overrides.pop("notes_collaboration_internal_secret", "internal-secret"),
            notes_collaboration_secret=overrides.pop("notes_collaboration_secret", "fallback-secret"),
            **overrides,
        )

    def test_defaults_and_empty_values_match_node_listener_defaults(self):
        for values in ({}, {"NOTES_COLLABORATION_HOST": "", "NOTES_COLLABORATION_PORT": ""}):
            with self.subTest(values=values), patch.dict(os.environ, values, clear=True):
                configured = load_environment_config()
                self.assertEqual(configured.notes_collaboration_host, "127.0.0.1")
                self.assertEqual(configured.notes_collaboration_port_raw, "1234")
                self.assertEqual(notes_collaboration_callback_base_url(configured), "http://127.0.0.1:1234")

    def test_listener_addresses_map_to_valid_callback_urls(self):
        for host, expected in (
            ("127.0.0.1", "127.0.0.1"),
            ("collaboration.internal", "collaboration.internal"),
            ("0.0.0.0", "127.0.0.1"),
            ("::", "[::1]"),
            ("0:0:0:0:0:0:0:0", "[::1]"),
            ("::1", "[::1]"),
            ("2001:db8::20", "[2001:db8::20]"),
            ("fe80::1%lo0", "[fe80::1%25lo0]"),
        ):
            with self.subTest(host=host):
                configured = replace(self.defaults, notes_collaboration_host=host, notes_collaboration_port_raw="5678")
                self.assertEqual(notes_collaboration_callback_base_url(configured), f"http://{expected}:5678")

    def test_callbacks_use_snapshot_address_secret_payload_and_timeouts(self):
        with patch.dict(os.environ, {
            "NOTES_COLLABORATION_HOST": "::",
            "NOTES_COLLABORATION_PORT": "5678",
            "NOTES_COLLABORATION_INTERNAL_SECRET": "snapshot-secret",
        }, clear=True):
            configured = load_environment_config()
        self.app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = configured
        with patch.dict(os.environ, {
            "NOTES_COLLABORATION_HOST": "ignored.example",
            "NOTES_COLLABORATION_PORT": "9999",
            "NOTES_COLLABORATION_INTERNAL_SECRET": "ignored-secret",
        }, clear=True), self.app.app_context(), patch.object(notes_collaboration.urllib.request.OpenerDirector, "open") as send:
            notes_collaboration._broadcast_review_event(42, "review.comment.created", 99)
            notes_collaboration._reload_collaboration_document(42, "replacement-1")

        self.assertEqual(send.call_count, 2)
        event_call, reload_call = send.call_args_list
        event_request = event_call.args[0]
        reload_request = reload_call.args[0]
        self.assertEqual(event_request.full_url, "http://[::1]:5678/events")
        self.assertEqual(reload_request.full_url, "http://[::1]:5678/reload")
        self.assertEqual(event_call.kwargs["timeout"], 0.75)
        self.assertEqual(reload_call.kwargs["timeout"], 10)
        for request in (event_request, reload_request):
            self.assertEqual(request.get_method(), "POST")
            self.assertEqual(request.get_header("Content-type"), "application/json")
            self.assertEqual(request.get_header("X-nest-collaboration-secret"), "snapshot-secret")
            self.assertNotIn("secret", request.full_url)
        event = json.loads(event_request.data)
        self.assertEqual(event["note_id"], "42")
        self.assertEqual(event["event"]["type"], "review.comment.created")
        self.assertEqual(event["event"]["resource_id"], "99")
        self.assertTrue(event["event"]["id"])
        self.assertEqual(json.loads(reload_request.data), {"note_id": "42", "replacement_id": "replacement-1"})

    def test_callbacks_fall_back_to_general_secret_and_skip_without_secret(self):
        for internal, general, expected in (("", "shared", "shared"), (None, None, None)):
            with self.subTest(internal=internal, general=general):
                self._configure(notes_collaboration_internal_secret=internal, notes_collaboration_secret=general)
                with self.app.app_context(), patch.object(notes_collaboration.urllib.request.OpenerDirector, "open") as send:
                    notes_collaboration._broadcast_review_event("n", "event", "r")
                    notes_collaboration._reload_collaboration_document("n", "replacement-1")
                if expected:
                    self.assertEqual(send.call_count, 2)
                    for call in send.call_args_list:
                        self.assertEqual(call.args[0].get_header("X-nest-collaboration-secret"), expected)
                else:
                    send.assert_not_called()

    def test_bad_listener_config_skips_callbacks_instead_of_breaking_note_mutations(self):
        for host, port in (("https://example.com/path", "1234"), ("127.0.0.1", "bad"),
                           ("127.0.0.1", "0"), ("127.0.0.1", "65536"), ("bad host", "1234")):
            with self.subTest(host=host, port=port):
                self._configure(notes_collaboration_host=host, notes_collaboration_port_raw=port)
                with self.app.app_context(), patch.object(notes_collaboration.urllib.request.OpenerDirector, "open") as send:
                    notes_collaboration._broadcast_review_event("n", "event", "r")
                    notes_collaboration._reload_collaboration_document("n", "replacement-1")
                send.assert_not_called()

    def test_network_and_http_failure_remain_best_effort(self):
        self._configure()
        http_error = urllib.error.HTTPError("http://127.0.0.1:1234/events", 403, "Forbidden", {}, None)
        self.addCleanup(http_error.close)
        for error in (OSError("refused"), urllib.error.URLError("unreachable"),
                      http_error):
            with self.subTest(error=type(error).__name__), self.app.app_context(), patch.object(
                notes_collaboration.urllib.request.OpenerDirector, "open", side_effect=error,
            ) as send:
                notes_collaboration._broadcast_review_event("n", "event", "r")
                notes_collaboration._reload_collaboration_document("n", "replacement-1")
                self.assertEqual(send.call_count, 2)

    def test_access_invalidation_uses_header_auth_and_expands_folder_notes(self):
        self._configure()
        with self.app.app_context(), patch.object(notes_collaboration.urllib.request.OpenerDirector, "open") as send, patch.object(
            notes_collaboration.note_store, "list_notes_in_folder", return_value=[{"$id": "note-a"}, {"$id": "note-b"}],
        ):
            self.assertTrue(notes_collaboration.invalidate_access("folder", "folder-1"))
        request = send.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:1234/access-invalidation")
        self.assertEqual(request.get_header("X-nest-collaboration-secret"), "internal-secret")
        self.assertEqual(json.loads(request.data), {"note_ids": ["note-a", "note-b"]})
        self.assertEqual(send.call_args.kwargs["timeout"], 1.5)

    def test_access_invalidation_reports_callback_failure_for_periodic_retry_fallback(self):
        self._configure()
        with self.app.app_context(), patch.object(notes_collaboration.urllib.request.OpenerDirector, "open", side_effect=OSError("refused")):
            self.assertFalse(notes_collaboration.invalidate_access("note", "note-a"))

    def test_redirects_do_not_forward_the_internal_secret(self):
        self._configure()
        for status in (301, 302, 303, 307, 308):
            for destination in ("http://other.internal/events", "http://127.0.0.1:1234/moved"):
                requests = []

                def respond(request):
                    requests.append(request)
                    headers = Message()
                    if len(requests) == 1:
                        headers["Location"] = destination
                    response = urllib.response.addinfourl(
                        BytesIO(b""), headers, request.full_url,
                        status if len(requests) == 1 else 200,
                    )
                    response.msg = "Found" if len(requests) == 1 else "OK"
                    return response

                with self.subTest(status=status, destination=destination), self.app.app_context(), patch.object(
                    notes_collaboration.urllib.request.HTTPHandler, "http_open", side_effect=respond,
                ):
                    self.assertFalse(notes_collaboration.invalidate_access("note", "note-a"))
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0].get_header("X-nest-collaboration-secret"), "internal-secret")


if __name__ == "__main__":
    unittest.main()
