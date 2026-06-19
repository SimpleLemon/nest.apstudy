"""Shared profile formatting helpers for auth and admin blueprints."""

from datetime import datetime

from appwrite_helpers import parse_datetime


def normalize_banner_color(value):
    if not isinstance(value, str):
        return "#fecae1"
    normalized = value.strip()
    if not normalized.startswith("#"):
        normalized = f"#{normalized}"
    if len(normalized) == 7:
        try:
            int(normalized[1:], 16)
            return normalized.lower()
        except ValueError:
            return "#fecae1"
    return "#fecae1"


def profile_handle(name, user_id, username=None):
    if username:
        return f"@{username}"
    base = "".join(
        char.lower() if char.isalnum() else "-"
        for char in (name or "")
    ).strip("-")
    base = "-".join(part for part in base.split("-") if part)
    return f"@{base or user_id or 'apstudy-user'}"


def is_emory_school(value):
    normalized = str(value or "").strip().lower()
    return normalized in {"emory", "emory university"}


def is_early_member(value):
    if not value:
        return False
    parsed = parse_datetime(value)
    if not parsed:
        if isinstance(value, str) and value.endswith("Z"):
            try:
                parsed = datetime.fromisoformat(value[:-1] + "+00:00")
            except (TypeError, ValueError):
                return False
        else:
            try:
                parsed = datetime.fromisoformat(value)
            except (TypeError, ValueError):
                return False
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed < datetime(2026, 8, 20)
