import io
import os
import unittest
from unittest.mock import MagicMock, patch
from urllib3.exceptions import ProtocolError

from services.storage_errors import StorageIntegrityError, StorageNotFound, StorageUnavailable
from services.storage_legacy_transport import read_legacy_file


class LegacyDownloadBoundsTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {
            "APPWRITE_ENDPOINT": "https://storage.example.test/v1",
            "APPWRITE_PROJECT_ID": "project", "APPWRITE_API_KEY": "test-only-key",
            "NEST_STORAGE_READ_LEGACY": "1",
        })
        env.start()
        self.addCleanup(env.stop)

    def response(self, data=b"bounded", *, status=200, headers=None):
        result = MagicMock()
        result.__enter__.return_value = result
        result.status_code = status
        result.headers = headers or {}
        result.raw = io.BytesIO(data)
        return result

    def test_streams_raw_bytes_without_redirects_and_closes_response(self):
        response = self.response(headers={"Content-Length": "7"})
        with patch("services.storage_legacy_transport.requests.get", return_value=response) as get:
            self.assertEqual(read_legacy_file("private bucket", "id/x", max_bytes=8, expected_bytes=7), b"bounded")
        self.assertFalse(get.call_args.kwargs["allow_redirects"])
        self.assertTrue(get.call_args.kwargs["stream"])
        self.assertIn("private%20bucket/files/id%2Fx/download", get.call_args.args[0])
        response.__exit__.assert_called_once()

    def test_no_header_and_forged_header_cannot_exceed_bound(self):
        for headers in ({}, {"Content-Length": "2"}):
            response = self.response(b"x" * 100, headers=headers)
            with self.subTest(headers=headers), patch("services.storage_legacy_transport.requests.get", return_value=response):
                with self.assertRaises(StorageIntegrityError):
                    read_legacy_file("bucket", "id", max_bytes=8)
                self.assertEqual(response.raw.tell(), 9)

    def test_transport_headers_and_metadata_mismatch_fail_closed(self):
        for headers in ({"Content-Length": "999"}, {"Content-Length": "invalid"},
                        {"Content-Encoding": "gzip"}, {"Content-Length": "6"}):
            response = self.response(headers=headers)
            with self.subTest(headers=headers), patch("services.storage_legacy_transport.requests.get", return_value=response):
                with self.assertRaises(StorageIntegrityError):
                    read_legacy_file("bucket", "id", max_bytes=8, expected_bytes=7)
                self.assertEqual(response.raw.tell(), 0)
        with patch("services.storage_legacy_transport.requests.get", return_value=self.response(b"short")):
            with self.assertRaises(StorageIntegrityError):
                read_legacy_file("bucket", "id", max_bytes=8, expected_bytes=7)

    def test_redirects_and_missing_files_do_not_read_response_bodies(self):
        for status, expected in ((302, StorageUnavailable), (404, StorageNotFound)):
            response = self.response(status=status)
            with self.subTest(status=status), patch("services.storage_legacy_transport.requests.get", return_value=response):
                with self.assertRaises(expected):
                    read_legacy_file("bucket", "id", max_bytes=8)
                self.assertEqual(response.raw.tell(), 0)

    def test_disabled_fallback_and_oversized_metadata_never_use_transport(self):
        with patch("services.storage_legacy_transport.requests.get") as get:
            with self.assertRaises(StorageIntegrityError):
                read_legacy_file("bucket", "id", max_bytes=8, expected_bytes=9)
            with patch.dict(os.environ, {"NEST_STORAGE_READ_LEGACY": "0"}):
                with self.assertRaises(StorageUnavailable):
                    read_legacy_file("bucket", "id", max_bytes=8)
        get.assert_not_called()

    def test_raw_transport_failure_and_malformed_endpoint_are_unavailable(self):
        response = self.response()
        response.raw = MagicMock()
        response.raw.read.side_effect = ProtocolError("connection lost")
        with patch("services.storage_legacy_transport.requests.get", return_value=response):
            with self.assertRaises(StorageUnavailable):
                read_legacy_file("bucket", "id", max_bytes=8)
        response.__exit__.assert_called_once()
        with patch.dict(os.environ, {"APPWRITE_ENDPOINT": "http://["}), \
                patch("services.storage_legacy_transport.requests.get") as get:
            with self.assertRaises(StorageUnavailable):
                read_legacy_file("bucket", "id", max_bytes=8)
        get.assert_not_called()

    def test_declared_length_is_verified_when_feature_length_is_unknown(self):
        with patch("services.storage_legacy_transport.requests.get", return_value=self.response(headers={"Content-Length": "8"})):
            with self.assertRaises(StorageIntegrityError):
                read_legacy_file("bucket", "id", max_bytes=8)
