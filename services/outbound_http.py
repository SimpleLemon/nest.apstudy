"""Security helpers for user-influenced outbound HTTP requests."""

import ipaddress
import socket
from urllib.parse import urlparse, urlunparse


def is_public_http_url(value, *, resolver=None):
    """Return whether an HTTP(S) URL resolves only to globally routable IPs."""
    try:
        resolver = resolver or socket.getaddrinfo
        parsed = urlparse(str(value or "").strip())
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return False
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
        addresses = resolver(parsed.hostname, port, type=socket.SOCK_STREAM)
    except (TypeError, ValueError, OSError):
        return False

    if not addresses:
        return False
    try:
        return all(ipaddress.ip_address(item[4][0]).is_global for item in addresses)
    except (ValueError, IndexError, TypeError):
        return False


def require_public_http_url(value):
    """Return a validated URL or raise a caller-safe error."""
    normalized = str(value or "").strip()
    if not is_public_http_url(normalized):
        raise ValueError("URL must resolve to a public HTTP or HTTPS host.")
    return normalized


def redacted_url(value):
    """Remove credentials, query values, and fragments from a URL for logging."""
    try:
        parsed = urlparse(str(value or "").strip())
        hostname = parsed.hostname or ""
        if not parsed.scheme or not hostname:
            return "[invalid-url]"
        host = f"[{hostname}]" if ":" in hostname else hostname
        if parsed.port:
            host = f"{host}:{parsed.port}"
        query = "[redacted]" if parsed.query else ""
        return urlunparse((parsed.scheme, host, parsed.path or "", "", query, ""))
    except (TypeError, ValueError):
        return "[invalid-url]"
