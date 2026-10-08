"""The internal notes API always requires the sidecar's secret header."""

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.notes_api as notes_api


class NotesInternalAuthTests(unittest.TestCase):
    DOCUMENT_URL = "/api/internal/notes/note-1/collaboration-document"
    HEADER = "X-Nest-Collaboration-Secret"

    def setUp(self):
        self.app = Flask(__name__)
        self.app.config["TESTING"] = True
        self.app.register_blueprint(notes_api.notes_api_bp)
        self.client = self.app.test_client()
        self.configured = SimpleNamespace(
            notes_collaboration_internal_secret="internal-secret",
            notes_collaboration_secret="general-secret",
            flask_env="development",
        )
        environment = patch.object(notes_api, "runtime_environment_config", return_value=self.configured)
        environment.start()
        self.addCleanup(environment.stop)
        document = patch.object(
            notes_api.notes_collaboration, "get_collaboration_document",
            return_value={"ydoc_blob": b"document", "durable_revision": 2, "schema_version": 1},
        )
        self.document = document.start()
        self.addCleanup(document.stop)

    def test_valid_internal_header_reads_document(self):
        response = self.client.get(self.DOCUMENT_URL, headers={self.HEADER: "internal-secret"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, b"document")
        self.assertEqual(response.headers["X-Nest-Durable-Revision"], "2")
        self.document.assert_called_once_with("note-1")

    def test_bad_or_missing_header_keeps_forbidden_contract(self):
        for headers in ({}, {self.HEADER: "wrong"}, {self.HEADER: "general-secret"}, {self.HEADER: ""}):
            with self.subTest(headers=headers):
                response = self.client.get(self.DOCUMENT_URL, headers=headers)
                self.assertEqual(response.status_code, 403)
        self.document.assert_not_called()

    def test_query_secret_does_not_authorize(self):
        for headers in ({}, {self.HEADER: "wrong"}):
            with self.subTest(headers=headers):
                response = self.client.get(
                    self.DOCUMENT_URL, query_string={"secret": "internal-secret"}, headers=headers,
                )
                self.assertEqual(response.status_code, 403)
        self.document.assert_not_called()

    def test_general_secret_header_is_supported_when_internal_secret_is_absent(self):
        self.configured.notes_collaboration_internal_secret = ""
        response = self.client.get(self.DOCUMENT_URL, headers={self.HEADER: "general-secret"})
        self.assertEqual(response.status_code, 200)

    def test_missing_configured_secret_fails_closed_in_every_environment_and_address(self):
        self.configured.notes_collaboration_internal_secret = ""
        self.configured.notes_collaboration_secret = ""
        for environment in ("production", "development", "testing", "", None):
            self.configured.flask_env = environment
            for address in ("127.0.0.1", "::1", "localhost", "203.0.113.1", None):
                with self.subTest(environment=environment, address=address):
                    response = self.client.get(
                        self.DOCUMENT_URL, headers={self.HEADER: "anything"},
                        query_string={"secret": "anything"}, environ_overrides={"REMOTE_ADDR": address},
                    )
                    self.assertEqual(response.status_code, 403)
        self.document.assert_not_called()

    def test_non_ascii_header_is_rejected_without_server_error(self):
        response = self.client.get(self.DOCUMENT_URL, headers={self.HEADER: "invalid-\N{SNOWMAN}"})
        self.assertEqual(response.status_code, 403)
        self.document.assert_not_called()

    def test_every_internal_route_rejects_missing_credentials(self):
        routes = (
            ("GET", self.DOCUMENT_URL),
            ("PUT", self.DOCUMENT_URL),
            ("POST", self.DOCUMENT_URL),
            ("POST", "/api/internal/notes/access-invalidation"),
            ("POST", "/api/internal/notes/collaboration-access"),
            ("GET", "/api/internal/notes/collaboration-health"),
            ("POST", "/api/internal/notes/collaboration-token/verify"),
        )
        for method, url in routes:
            with self.subTest(method=method, url=url):
                response = self.client.open(url, method=method)
                self.assertEqual(response.status_code, 403)

    def test_current_access_uses_authenticated_identity_without_ticket(self):
        payload = {"ok": True, "note_id": "note-1", "user_id": "user-1", "can_write": True}
        with patch.object(notes_api.notes_access, "collaboration_access", return_value=payload) as resolve:
            response = self.client.post(
                "/api/internal/notes/collaboration-access", headers={self.HEADER: "internal-secret"},
                json={"note_id": "note-1", "user_id": "user-1"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), payload)
        resolve.assert_called_once_with("note-1", "user-1")

    def test_current_access_revocation_and_outage_fail_closed(self):
        for result, error, expected in ((None, None, 403), (None, OSError("database unavailable"), 503)):
            with self.subTest(status=expected), patch.object(
                notes_api.notes_access, "collaboration_access", return_value=result, side_effect=error,
            ):
                response = self.client.post(
                    "/api/internal/notes/collaboration-access", headers={self.HEADER: "internal-secret"},
                    json={"note_id": "note-1", "user_id": "user-1"},
                )
                self.assertEqual(response.status_code, expected)

    def test_current_access_rejects_untrusted_identity_shapes(self):
        for identity in ({}, {"note_id": "note-1", "user_id": ["owner"]}, {"note_id": "note-1", "user_id": 12}):
            with self.subTest(identity=identity), patch.object(notes_api.notes_access, "collaboration_access") as resolve:
                response = self.client.post(
                    "/api/internal/notes/collaboration-access", headers={self.HEADER: "internal-secret"}, json=identity,
                )
                self.assertEqual(response.status_code, 400)
                resolve.assert_not_called()


if __name__ == "__main__":
    unittest.main()
