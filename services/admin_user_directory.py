"""Admin user directory search, ordering, pagination, and projection."""
import logging
from collections.abc import Mapping, Sequence
from typing import Any

from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite_helpers import parse_datetime
from services.entitlements import normalize_tier, TIER_LABELS, TIER_BADGES
from services.row_utils import row_id as _row_id
from services.user_profile import normalize_banner_color as _normalize_banner_color

from services.admin_ports import ListAdminRows, ListAdminPage

logger = logging.getLogger(__name__)
Row = Mapping[str, Any]


def _format_admin_date(value):
    parsed = parse_datetime(value)
    return parsed.strftime("%B %-d, %Y") if parsed else str(value) if value else None


def _format_admin_datetime(value):
    parsed = parse_datetime(value)
    return parsed.strftime("%B %-d, %Y %-I:%M %p") if parsed else str(value) if value else None


def normalize_oauth_provider(user_doc: Row) -> str:
    provider = str((user_doc or {}).get("provider") or "").strip().lower()
    if provider in {"google", "discord", "github"}:
        return provider
    if (user_doc or {}).get("google_id"):
        return "google"
    return "other"


def user_summary(user_doc: Row) -> dict[str, Any]:
    tier = normalize_tier(user_doc.get("tier"))
    return {
        "id": _row_id(user_doc),
        "username": user_doc.get("username"),
        "name": user_doc.get("name"),
        "email": user_doc.get("email"),
        "created_at_raw": user_doc.get("created_at"),
        "created_at": _format_admin_date(user_doc.get("created_at")),
        "last_login_raw": user_doc.get("last_login"),
        "last_login": _format_admin_datetime(user_doc.get("last_login")),
        "onboarding_complete": bool(user_doc.get("onboarding_complete")),
        "onboarding_step": user_doc.get("onboarding_step") or 1,
        "discord_linked": bool(user_doc.get("discord_id")),
        "oauth_provider": normalize_oauth_provider(user_doc),
        "emory_student": bool(user_doc.get("emory_student")),
        "school": user_doc.get("school"),
        "major": user_doc.get("major"),
        "graduation_year": user_doc.get("graduation_year"),
        "education_level": user_doc.get("education_level"),
        "class_year": user_doc.get("class_year"),
        "picture_url": user_doc.get("picture_url"),
        "banner_color": _normalize_banner_color(user_doc.get("banner_color")),
        "tier": tier,
        "tier_label": TIER_LABELS[tier],
        "tier_badge": TIER_BADGES.get(tier),
    }


def search_users(users: Sequence[Row], query: str, field: str) -> list[Row]:
    """Return case-insensitive partial matches from the admin user directory."""
    needle = (query or "").strip().casefold()
    if not needle:
        return list(users)

    searchable_fields = {
        "name": ("name",),
        "email": ("email",),
        "username": ("username",),
        "id": ("$id", "id"),
    }
    keys = searchable_fields.get(field, ("name", "username", "email", "$id", "id"))
    return [
        user for user in users
        if any(needle in str(user.get(key) or "").casefold() for key in keys)
    ]


AUTH_USER_SORTS = {"identity", "tier", "profile", "activity", "created"}


def sort_auth_users(users: Sequence[Row], sort_key: str, sort_order: str) -> list[Row]:
    reverse = sort_order == "desc"

    def normalized(value):
        return str(value or "").strip().casefold()

    def sort_value(user):
        if sort_key == "identity":
            return (normalized(user.get("name") or user.get("username")), normalized(user.get("email")))
        if sort_key == "tier":
            tier = normalize_tier(user.get("tier"))
            return (normalized(TIER_LABELS[tier]), normalized(user.get("name") or user.get("username")))
        if sort_key == "profile":
            return (normalized(user.get("school")), normalized(user.get("major") or user.get("education_level")))
        if sort_key == "activity":
            return normalized(user.get("last_login"))
        return normalized(user.get("created_at"))

    return sorted(users, key=sort_value, reverse=reverse)


def load_user_directory(*, table_id: str, query: str, field: str, sort_key: str,
                        sort_order: str, page: int, per_page: int,
                        allowed_per_page: set[int], list_rows_safe: ListAdminPage,
                        list_rows_all: ListAdminRows) -> dict[str, Any]:
    error = None
    total_users = 0
    users = []
    total_pages = 1
    try:
        if not query and sort_key == "created" and sort_order == "desc":
            offset = (page - 1) * per_page
            response = list_rows_safe(
                table_id,
                [Query.order_desc("created_at"), Query.limit(per_page), Query.offset(offset)],
            )
            users = response.get("rows", [])
            total_users = int(response.get("total") or 0)
            total_pages = max(1, (total_users + per_page - 1) // per_page) if total_users else 1
            if page > total_pages:
                page = total_pages
                if total_users:
                    response = list_rows_safe(
                        table_id,
                        [Query.order_desc("created_at"), Query.limit(per_page), Query.offset((page - 1) * per_page)],
                    )
                    users = response.get("rows", [])
        else:
            all_users = list_rows_all(table_id, [Query.order_desc("created_at")])
            matched = search_users(all_users, query, field)
            matched = sort_auth_users(matched, sort_key, sort_order)
            total_users = len(matched)
            total_pages = max(1, (total_users + per_page - 1) // per_page) if total_users else 1
            if page > total_pages:
                page = total_pages
            start = (page - 1) * per_page
            users = matched[start:start + per_page]
    except AppwriteException:
        logger.exception("Failed to load admin user list")
        users = []
        total_users = 0
        total_pages = 1
        error = "Unable to load users right now."

    return {
        "users": [user_summary(user) for user in users],
        "q": query,
        "field": field,
        "sort": sort_key,
        "order": sort_order,
        "page": page,
        "per_page": per_page,
        "total_users": total_users,
        "total_pages": total_pages,
        "allowed_users_per_page": sorted(allowed_per_page),
        "error": error,
    }


