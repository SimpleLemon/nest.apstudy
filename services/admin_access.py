import os


def admin_user_ids():
    raw = os.environ.get("ADMIN_USER_IDS") or os.environ.get("ADMIN_USER_ID") or ""
    return {item.strip() for item in raw.split(",") if item.strip()}


def user_can_access_admin(user_id):
    normalized = str(user_id or "").strip()
    return bool(normalized and normalized in admin_user_ids())
