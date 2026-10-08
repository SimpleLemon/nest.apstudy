"""Scan upload bytes through local ClamAV INSTREAM without temporary files."""

import ipaddress
import math
import os
import socket
import struct
import time

from services.storage_backend import storage_setting
from services.storage_errors import StorageUnavailable, StorageValidationError


MAX_SCAN_BYTES = 50 * 1024 * 1024
_CHUNK_BYTES = 64 * 1024
_MAX_REPLY_BYTES = 4096


def _configuration():
    try:
        raw_timeout = storage_setting("NEST_CLAMAV_TIMEOUT")
        timeout = float(30 if raw_timeout is None or raw_timeout == "" else raw_timeout)
        if not math.isfinite(timeout) or not 0 < timeout <= 300:
            raise ValueError()
        unix_path = storage_setting("NEST_CLAMAV_SOCKET")
        if unix_path:
            unix_path = os.fspath(unix_path)
            if not os.path.isabs(unix_path) or "\x00" in unix_path:
                raise ValueError()
            return socket.AF_UNIX, unix_path, timeout
        host = str(storage_setting("NEST_CLAMAV_HOST", "127.0.0.1") or "127.0.0.1").strip()
        if host == "localhost":
            host = "127.0.0.1"
        address = ipaddress.ip_address(host)
        if not address.is_loopback:
            raise ValueError()
        raw_port = storage_setting("NEST_CLAMAV_PORT")
        if isinstance(raw_port, bool) or isinstance(raw_port, float):
            raise ValueError()
        port = int(3310 if raw_port is None or raw_port == "" else raw_port)
        if not 1 <= port <= 65535:
            raise ValueError()
        family = socket.AF_INET6 if address.version == 6 else socket.AF_INET
        return family, (str(address), port), timeout
    except (TypeError, ValueError):
        raise StorageUnavailable("Local upload scanner is not configured correctly.") from None


def _set_remaining_timeout(connection, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError()
    connection.settimeout(remaining)


def _receive_reply(connection, deadline):
    response = bytearray()
    while len(response) <= _MAX_REPLY_BYTES:
        _set_remaining_timeout(connection, deadline)
        part = connection.recv(min(1024, _MAX_REPLY_BYTES + 1 - len(response)))
        if not part:
            raise StorageUnavailable("Local upload scanner returned an incomplete result.")
        response.extend(part)
        if b"\x00" in response:
            record = bytes(response).split(b"\x00", 1)[0]
            try:
                return record.decode("utf-8", errors="strict")
            except UnicodeError:
                break
    raise StorageUnavailable("Local upload scanner returned an invalid result.")


def scan_upload(data):
    """Accept only an explicit clean result; unavailable or invalid fails closed."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise StorageValidationError("Upload content must be bytes.")
    view = memoryview(data)
    if view.nbytes > MAX_SCAN_BYTES:
        raise StorageValidationError("Upload exceeds the 50 MiB storage limit.")
    if not view.c_contiguous:
        view = memoryview(bytes(view))
    view = view.cast("B")
    family, address, timeout = _configuration()
    deadline = time.monotonic() + timeout
    connection = None
    try:
        connection = socket.socket(family, socket.SOCK_STREAM)
        _set_remaining_timeout(connection, deadline)
        connection.connect(address)
        connection.sendall(b"zINSTREAM\x00")
        for start in range(0, view.nbytes, _CHUNK_BYTES):
            chunk = view[start : start + _CHUNK_BYTES]
            _set_remaining_timeout(connection, deadline)
            connection.sendall(struct.pack("!I", len(chunk)))
            connection.sendall(chunk)
        _set_remaining_timeout(connection, deadline)
        connection.sendall(struct.pack("!I", 0))
        reply = _receive_reply(connection, deadline)
    except OSError:
        raise StorageUnavailable("Local upload scanner is unavailable.") from None
    finally:
        if connection is not None:
            connection.close()
    if reply == "stream: OK":
        return
    if reply.startswith("stream: ") and reply.endswith(" FOUND"):
        raise StorageValidationError("Upload was rejected by the antivirus scanner.")
    raise StorageUnavailable("Local upload scanner could not verify this upload.")
