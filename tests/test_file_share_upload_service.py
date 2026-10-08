"""Upload processing returns domain data outside an HTTP request."""

import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from werkzeug.datastructures import FileStorage, MultiDict

from services import file_share_uploads as uploads
from services.entitlements import EntitlementError


class FileShareUploadServiceTests(unittest.TestCase):
    def setUp(self):
        self.user = SimpleNamespace(id="owner", name="Owner", email="owner@example.test")
        self.enterContext(patch.object(uploads, "require_mutations_enabled"))
        self.enterContext(patch.object(uploads, "write_backend", return_value="sqlite"))
        self.entitlements = {"limits": {"max_upload_files": 5, "max_file_size_bytes": 20}}
        self.enterContext(patch.object(uploads, "request_entitlements", return_value=self.entitlements))

    def run_upload(self, files, form=None):
        return uploads.upload_files(self.user, files, form or MultiDict(), share_base_url="https://nest.example/prefix/files/share/")

    def test_public_upload_returns_plain_payload_with_request_supplied_base_url(self):
        row = {"id": "file", "original_filename": "notes.txt", "is_public": True,
               "share_code": "PUBLIC", "file_size_bytes": 5, "mime_type": "text/plain"}
        file = FileStorage(stream=io.BytesIO(b"notes"), filename="notes.txt")
        with patch.object(uploads, "_save_sqlite_file", return_value=row), \
                patch.object(uploads, "check_storage"), patch.object(uploads, "emit_creation_event") as audit:
            payload, status = self.run_upload([file], MultiDict({"visibility": "public", "expiryDays": "1"}))
        self.assertEqual(status, 201)
        self.assertIsInstance(payload, dict)
        self.assertEqual(payload["files"][0]["shareUrl"], "https://nest.example/prefix/files/share/PUBLIC")
        audit.assert_called_once()

    def test_empty_batch_and_unavailable_entitlements_return_error_payloads(self):
        self.assertEqual(self.run_upload([]), ({"error": "At least one file is required."}, 400))
        file = FileStorage(stream=io.BytesIO(b"notes"), filename="notes.txt")
        with patch.object(uploads, "request_entitlements", side_effect=EntitlementError("private detail")):
            payload, status = self.run_upload([file])
        self.assertEqual(status, 503)
        self.assertEqual(payload["code"], "tier_check_unavailable")
        self.assertNotIn("private detail", payload["error"])
