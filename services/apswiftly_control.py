import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone

import requests

from services.environment_config import apswiftly_settings

logger = logging.getLogger(__name__)

EXECUTABLE_FALLBACKS = {
    "sudo": ("/usr/bin/sudo", "/bin/sudo"),
    "systemctl": ("/usr/bin/systemctl", "/bin/systemctl"),
}


class APSwiftlyControlError(Exception):
    def __init__(self, message, *, status_code=500):
        super().__init__(message)
        self.status_code = status_code


def _resolve_executable(name):
    found = shutil.which(name)
    if found:
        return found
    for candidate in EXECUTABLE_FALLBACKS.get(name, ()):
        if os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise FileNotFoundError(f"Required command not found: {name}")


def _control_headers(settings=None):
    if settings is None:
        settings = apswiftly_settings()
    headers = {"Accept": "application/json"}
    if settings.control_token:
        headers["Authorization"] = f"Bearer {settings.control_token}"
    return headers


def _checked_at():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def format_service_state_display(state):
    normalized = (state or "unknown").strip().lower()
    if normalized == "unknown":
        return "Unknown"
    return normalized.capitalize()


def format_checked_at_display(value, *, now=None):
    if not value:
        return "—"

    if isinstance(value, datetime):
        checked_at = value
    elif isinstance(value, str):
        text = value[:-1] + "+00:00" if value.endswith("Z") else value
        try:
            checked_at = datetime.fromisoformat(text)
        except ValueError:
            return value
    else:
        return str(value)

    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    else:
        checked_at = checked_at.astimezone(timezone.utc)

    reference = now or datetime.now(timezone.utc)
    total_seconds = max(0, int((reference - checked_at).total_seconds()))

    if total_seconds > 5 * 86400:
        return f"{checked_at.strftime('%B')} {checked_at.day}, {checked_at.strftime('%Y')}"

    hours = total_seconds / 3600
    if hours < 48:
        if hours < 1:
            minutes = max(1, total_seconds // 60)
            suffix = "minute" if minutes == 1 else "minutes"
            return f"{minutes} {suffix} ago"
        hour_count = max(1, int(hours))
        suffix = "hour" if hour_count == 1 else "hours"
        return f"{hour_count} {suffix} ago"

    day_count = max(1, total_seconds // 86400)
    suffix = "day" if day_count == 1 else "days"
    return f"{day_count} {suffix} ago"


def _service_state():
    settings = apswiftly_settings()
    try:
        result = subprocess.run(
            [_resolve_executable("systemctl"), "is-active", settings.service_name],
            check=False,
            capture_output=True,
            text=True,
            timeout=settings.timeout_seconds,
        )
        state = (result.stdout or result.stderr or "").strip().lower()
        if state in {"active", "inactive", "failed", "activating", "deactivating"}:
            return state
        return "unknown"
    except Exception:
        logger.exception("Failed to read APSwiftly service state")
        return "unknown"


def _api_status():
    settings = apswiftly_settings()
    if not settings.control_token:
        return False, None
    try:
        response = requests.get(
            f"{settings.control_url}/api/control/status",
            headers=_control_headers(settings),
            timeout=settings.timeout_seconds,
        )
        if response.ok:
            payload = response.json() if response.content else {}
            return True, payload if isinstance(payload, dict) else {}
        return False, None
    except Exception:
        logger.debug("APSwiftly control API unreachable", exc_info=True)
        return False, None


def apswiftly_status():
    settings = apswiftly_settings()
    service_state = _service_state()
    api_reachable, api_payload = _api_status()
    checked_at = _checked_at()
    return {
        "service_name": settings.service_name,
        "service_state": service_state,
        "service_state_display": format_service_state_display(service_state),
        "service_active": service_state == "active",
        "api_reachable": api_reachable,
        "api_payload": api_payload,
        "control_url": settings.control_url,
        "checked_at": checked_at,
        "checked_at_display": format_checked_at_display(checked_at),
    }


def _post_control(path):
    settings = apswiftly_settings()
    if not settings.control_token:
        raise APSwiftlyControlError(
            "APSwiftly control token is not configured.",
            status_code=503,
        )
    try:
        response = requests.post(
            f"{settings.control_url}{path}",
            headers=_control_headers(settings),
            json={},
            timeout=settings.timeout_seconds,
        )
    except requests.RequestException as exc:
        raise APSwiftlyControlError(
            "APSwiftly control API is unreachable.",
            status_code=503,
        ) from exc

    payload = {}
    if response.content:
        try:
            payload = response.json()
        except ValueError:
            payload = {"message": response.text.strip()}

    if not response.ok:
        message = ""
        if isinstance(payload, dict):
            message = payload.get("message") or payload.get("error") or ""
        raise APSwiftlyControlError(
            message or "APSwiftly control API request failed.",
            status_code=503,
        )

    if isinstance(payload, dict):
        return payload
    return {"message": "OK"}


def apswiftly_reload():
    return _post_control("/api/control/reload")


def apswiftly_refresh_slash():
    return _post_control("/api/control/refresh-slash")


def apswiftly_shutdown():
    return _post_control("/api/control/shutdown")


def apswiftly_service_restart():
    settings = apswiftly_settings()
    command = [
        _resolve_executable("sudo"),
        _resolve_executable("systemctl"),
        "restart",
        settings.service_name,
    ]
    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=settings.timeout_seconds,
        )
    except subprocess.CalledProcessError as exc:
        message = (exc.stderr or exc.stdout or str(exc)).strip()
        raise APSwiftlyControlError(message or "Service restart failed.", status_code=500) from exc
    except subprocess.TimeoutExpired as exc:
        raise APSwiftlyControlError("Service restart timed out.", status_code=500) from exc
    except FileNotFoundError as exc:
        raise APSwiftlyControlError(str(exc), status_code=500) from exc

    return {
        "message": f"Systemd service restart initiated for {settings.service_name}.",
        "service": settings.service_name,
    }
