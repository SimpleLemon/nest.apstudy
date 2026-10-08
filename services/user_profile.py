"""Shared profile formatting helpers for auth and admin blueprints."""

import re
from datetime import datetime
from typing import Any, Mapping

from avatar_images import DEFAULT_AVATAR_URL
from appwrite_helpers import parse_datetime
from services.entitlements import TIER_BADGES, TIER_LABELS, normalize_tier


DEFAULT_BANNER_COLOR = "#fecae1"
USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 20
USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def normalize_banner_color(value: object) -> str:
    if not isinstance(value, str):
        return DEFAULT_BANNER_COLOR
    normalized = value.strip()
    if not normalized.startswith("#"):
        normalized = f"#{normalized}"
    if len(normalized) == 7:
        try:
            int(normalized[1:], 16)
            return normalized.lower()
        except ValueError:
            return DEFAULT_BANNER_COLOR
    return DEFAULT_BANNER_COLOR


def profile_handle(name: str | None, user_id: str | None, username: str | None = None) -> str:
    if username:
        return f"@{username}"
    base = "".join(
        char.lower() if char.isalnum() else "-"
        for char in (name or "")
    ).strip("-")
    base = "-".join(part for part in base.split("-") if part)
    return f"@{base or user_id or 'apstudy-user'}"


def is_emory_school(value: object) -> bool:
    normalized = str(value or "").strip().lower()
    return normalized in {"emory", "emory university"}


def is_emory_or_oxford_user(user):
    """Return whether a user qualifies for Emory-only product surfaces."""
    school = str(getattr(user, "school", "") or "").strip().lower()
    school_key = str(getattr(user, "school_key", "") or "").strip().lower()
    return bool(getattr(user, "emory_student", False)) or school in {
        "emory",
        "emory university",
        "emory university-oxford",
        "emory university oxford",
        "oxford college",
        "oxford college of emory university",
    } or school_key in {
        "emory",
        "emory-university",
        "emory-university-oxford",
        "oxford-college",
        "oxford-college-of-emory-university",
    }


def is_early_member(value: object) -> bool:
    if not value:
        return False
    parsed = parse_datetime(value)
    if parsed is None:
        return False
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed < datetime(2026, 8, 20)


def format_member_since(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.strftime("%b %d, %Y")
    text = value[:-1] + "+00:00" if isinstance(value, str) and value.endswith("Z") else value
    try:
        return datetime.fromisoformat(text).strftime("%b %d, %Y")
    except (TypeError, ValueError):
        return str(value)


def normalize_username(value: object) -> str:
    if not value:
        return ""
    normalized = str(value).strip().lower()
    if not USERNAME_PATTERN.fullmatch(normalized):
        return ""
    if len(normalized) < USERNAME_MIN_LENGTH or len(normalized) > USERNAME_MAX_LENGTH:
        return ""
    return normalized


def public_profile_payload(user_doc: Mapping[str, Any]) -> dict[str, Any]:
    user_id = user_doc.get("$id") or user_doc.get("id")
    name = user_doc.get("name") or "APStudy User"
    username = user_doc.get("username")
    tier = normalize_tier(user_doc.get("tier"))
    return {
        "id": user_id,
        "name": name,
        "username": username,
        "handle": profile_handle(name, user_id, username),
        "picture_url": user_doc.get("picture_url"),
        "banner_color": normalize_banner_color(user_doc.get("banner_color")),
        "school": user_doc.get("school"),
        "major": user_doc.get("major"),
        "graduation_year": user_doc.get("graduation_year"),
        "education_level": user_doc.get("education_level"),
        "class_year": user_doc.get("class_year"),
        "member_since": format_member_since(user_doc.get("created_at")),
        "is_emory_school": is_emory_school(user_doc.get("school")),
        "is_early_member": is_early_member(user_doc.get("created_at")),
        "tier": tier,
        "tier_label": TIER_LABELS[tier],
        "tier_badge": TIER_BADGES.get(tier),
    }


def clean_avatar_url(value: object) -> str | None:
    text = str(value or "").strip()
    if not text or text == DEFAULT_AVATAR_URL:
        return None
    return text


def avatar_can_use_provider(user_doc: Mapping[str, Any] | None) -> bool:
    if not user_doc:
        return True
    avatar_source = str(user_doc.get("avatar_source") or "").strip().lower()
    if avatar_source == "provider":
        return True
    return clean_avatar_url(user_doc.get("picture_url")) is None
