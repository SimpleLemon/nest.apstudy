import socket
import struct
import unittest
from unittest.mock import Mock, patch

from flask import Flask

from services import storage_scanner
from services.storage_errors import StorageUnavailable, StorageValidationError


class StorageScannerTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(NEST_CLAMAV_SOCKET="/run/clamav/clamd.ctl", NEST_CLAMAV_TIMEOUT=5)
        self.context = self.app.app_context()
        self.context.push()
        self.addCleanup(self.context.pop)
        self.connection = Mock()
        self.connection.recv.return_value = b"stream: OK\x00"
        self.socket_factory = patch.object(storage_scanner.socket, "socket", return_value=self.connection).start()
        self.addCleanup(patch.stopall)

    def test_local_unix_instream_framing_and_explicit_clean_result(self):
        storage_scanner.scan_upload(b"sample")
        self.socket_factory.assert_called_once_with(socket.AF_UNIX, socket.SOCK_STREAM)
        self.connection.connect.assert_called_once_with("/run/clamav/clamd.ctl")
        messages = [bytes(call.args[0]) for call in self.connection.sendall.call_args_list]
        self.assertEqual(messages, [b"zINSTREAM\x00", struct.pack("!I", 6), b"sample", struct.pack("!I", 0)])
        self.connection.close.assert_called_once()

    def test_large_payload_is_chunked_and_reply_can_arrive_in_parts(self):
        data = b"x" * (storage_scanner._CHUNK_BYTES + 3)
        self.connection.recv.side_effect = [b"stream: ", b"OK", b"\x00"]
        storage_scanner.scan_upload(data)
        messages = [bytes(call.args[0]) for call in self.connection.sendall.call_args_list]
        self.assertEqual(messages[1], struct.pack("!I", storage_scanner._CHUNK_BYTES))
        self.assertEqual(messages[3], struct.pack("!I", 3))
        self.assertEqual(messages[2] + messages[4], data)
        self.assertEqual(messages[-1], struct.pack("!I", 0))

    def test_empty_payload_still_receives_a_verdict(self):
        storage_scanner.scan_upload(b"")
        self.assertEqual([call.args[0] for call in self.connection.sendall.call_args_list], [b"zINSTREAM\x00", b"\x00" * 4])
        self.connection.recv.assert_called_once()

    def test_malware_rejected_without_exposing_scanner_signature(self):
        self.connection.recv.return_value = b"stream: Win.Test.EICAR FOUND\x00"
        with self.assertRaises(StorageValidationError) as caught:
            storage_scanner.scan_upload(b"malware")
        self.assertNotIn("EICAR", str(caught.exception))
        self.connection.close.assert_called_once()

    def test_scanner_errors_unrecognized_or_incomplete_replies_fail_closed(self):
        for reply in (b"INSTREAM size limit exceeded. ERROR\x00", b"stream: scan failed ERROR\x00",
                      b"other: OK\x00", b"stream: OK", b"", b"\xff\x00"):
            self.connection.recv.side_effect = [reply, b""]
            with self.subTest(reply=reply), self.assertRaises(StorageUnavailable):
                storage_scanner.scan_upload(b"upload")
        self.assertEqual(self.connection.close.call_count, 6)

    def test_oversized_reply_fails_closed(self):
        self.connection.recv.side_effect = lambda size: b"x" * size
        with self.assertRaises(StorageUnavailable):
            storage_scanner.scan_upload(b"upload")

    def test_connection_refusal_timeout_and_broken_stream_fail_closed(self):
        for operation, error in (("connect", ConnectionRefusedError()), ("sendall", BrokenPipeError()), ("recv", socket.timeout())):
            self.connection.reset_mock(side_effect=True)
            self.connection.recv.return_value = b"stream: OK\x00"
            getattr(self.connection, operation).side_effect = error
            with self.subTest(operation=operation), self.assertRaises(StorageUnavailable):
                storage_scanner.scan_upload(b"upload")
            self.connection.close.assert_called_once()

    def test_tcp_configuration_accepts_only_numeric_loopback_or_localhost(self):
        self.app.config["NEST_CLAMAV_SOCKET"] = ""
        for host, expected_family, expected_host in (("127.0.0.1", socket.AF_INET, "127.0.0.1"),
                                                     ("localhost", socket.AF_INET, "127.0.0.1"),
                                                     ("::1", socket.AF_INET6, "::1")):
            self.socket_factory.reset_mock()
            self.app.config["NEST_CLAMAV_HOST"] = host
            self.app.config["NEST_CLAMAV_PORT"] = 3311
            storage_scanner.scan_upload(b"upload")
            self.socket_factory.assert_called_once_with(expected_family, socket.SOCK_STREAM)
            self.assertEqual(self.connection.connect.call_args.args, ((expected_host, 3311),))

    def test_remote_scanner_or_invalid_configuration_sends_no_content(self):
        self.app.config["NEST_CLAMAV_SOCKET"] = ""
        for host in ("8.8.8.8", "192.168.1.1", "scanner.example.com", "::ffff:8.8.8.8"):
            self.app.config["NEST_CLAMAV_HOST"] = host
            with self.subTest(host=host), self.assertRaises(StorageUnavailable):
                storage_scanner.scan_upload(b"private user content")
        self.socket_factory.assert_not_called()
        self.connection.sendall.assert_not_called()

    def test_nonpositive_or_unbounded_timeout_and_port_are_rejected(self):
        self.app.config["NEST_CLAMAV_SOCKET"] = ""
        for setting, value in (("NEST_CLAMAV_TIMEOUT", -1), ("NEST_CLAMAV_TIMEOUT", 0),
                               ("NEST_CLAMAV_TIMEOUT", float("inf")), ("NEST_CLAMAV_TIMEOUT", 301),
                               ("NEST_CLAMAV_PORT", -1), ("NEST_CLAMAV_PORT", 0), ("NEST_CLAMAV_PORT", 70000)):
            self.app.config.update(NEST_CLAMAV_HOST="127.0.0.1", NEST_CLAMAV_TIMEOUT=5, NEST_CLAMAV_PORT=3310)
            self.app.config[setting] = value
            with self.subTest(setting=setting, value=value), self.assertRaises(StorageUnavailable):
                storage_scanner.scan_upload(b"upload")
        self.socket_factory.assert_not_called()

    def test_invalid_upload_type_and_oversize_are_rejected_without_connection(self):
        with self.assertRaises(StorageValidationError):
            storage_scanner.scan_upload("not bytes")
        with patch.object(storage_scanner, "MAX_SCAN_BYTES", 3):
            with self.assertRaises(StorageValidationError):
                storage_scanner.scan_upload(b"1234")
        self.socket_factory.assert_not_called()

    def test_timeout_bounds_the_whole_scan(self):
        with patch.object(storage_scanner.time, "monotonic", side_effect=[1, 2, 7]):
            with self.assertRaises(StorageUnavailable):
                storage_scanner.scan_upload(b"upload")
        self.connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
