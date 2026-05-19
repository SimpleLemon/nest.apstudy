"""
blueprints/auth.py

OAuth 2.0 authentication flow.
Handles login, callback, session creation, and logout.

Migrated from the monolithic app.py implementation [2].
Requires: client_secret.json in project root,
          GOOGLE_CLIENT_ID and FLASK_SECRET_KEY in .env.
"""

import os
import secrets
import logging
import re
from datetime import datetime

# Must be set before OAuth flow objects are created during local HTTP testing.
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

import requests as http_requests
import google_auth_oauthlib.flow
from flask import (
    Blueprint, Response, abort, redirect, url_for, session, render_template, request, jsonify, make_response
)
from flask_login import login_user, logout_user, current_user

from appwrite.client import Client
from appwrite.exception import AppwriteException
from appwrite.query import Query
from appwrite.services.users import Users
from appwrite_helpers import (
    create_row_safe,
    format_datetime,
    get_row_safe,
    first_row,
    list_rows_safe,
    update_row_safe,
)
from models import User, user_from_doc

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger(__name__)

LOGIN_CSP = "; ".join([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https://resources.apstudy.org data:",
    "connect-src 'self' https://nyc.cloud.appwrite.io",
    "form-action 'self'",
])

PUBLIC_PROFILE_CSP = "; ".join([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' https: data:",
    "connect-src 'self' https://nyc.cloud.appwrite.io",
    "form-action 'self'",
])

CLIENT_SECRETS_FILE = "client_secret.json"
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]
USERNAME_MIN_LENGTH = 3
USERNAME_MAX_LENGTH = 20
USERNAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


def _set_oauth_session(provider, user_id, email, name=None, picture_url=None):
    session["oauth_provider"] = provider
    session["oauth_user_id"] = user_id
    session["oauth_email"] = email
    if name:
        session["oauth_name"] = name
    if picture_url:
        session["oauth_picture_url"] = picture_url


def _account_to_dict(value):
    if isinstance(value, dict):
        return value

    if hasattr(value, "to_dict"):
        return value.to_dict()
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, mode="json")
    return {}


def _discord_avatar_url(profile):
    user_id = profile.get("id")
    avatar_hash = profile.get("avatar")
    if not user_id or not avatar_hash:
        return None
    extension = "gif" if avatar_hash.startswith("a_") else "png"
    return f"https://cdn.discordapp.com/avatars/{user_id}/{avatar_hash}.{extension}?size=256"


def _format_member_since(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.strftime("%b %d, %Y")
    text = value[:-1] + "+00:00" if isinstance(value, str) and value.endswith("Z") else value
    try:
        return datetime.fromisoformat(text).strftime("%b %d, %Y")
    except (TypeError, ValueError):
        return str(value)


def _normalize_banner_color(value):
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


def _normalize_username(value):
    if not value:
        return ""
    normalized = str(value).strip().lower()
    if not USERNAME_PATTERN.fullmatch(normalized):
        return ""
    if len(normalized) < USERNAME_MIN_LENGTH or len(normalized) > USERNAME_MAX_LENGTH:
        return ""
    return normalized


def _profile_handle(name, user_id, username=None):
    if username:
        return f"@{username}"
    base = "".join(
        char.lower() if char.isalnum() else "-"
        for char in (name or "")
    ).strip("-")
    base = "-".join(part for part in base.split("-") if part)
    return f"@{base or user_id or 'apstudy-user'}"


def _is_emory_school(value):
    normalized = str(value or "").strip().lower()
    return normalized in {"emory", "emory university"}


def _is_early_member(value):
    if not value:
        return False
    parsed = value
    if isinstance(value, str) and value.endswith("Z"):
        parsed = value[:-1] + "+00:00"
    try:
        created_at = parsed if isinstance(parsed, datetime) else datetime.fromisoformat(parsed)
    except (TypeError, ValueError):
        return False
    if created_at.tzinfo is not None:
        created_at = created_at.replace(tzinfo=None)
    return created_at < datetime(2026, 8, 20)


def _public_profile_payload(user_doc):
    user_id = user_doc.get("$id") or user_doc.get("id")
    name = user_doc.get("name") or "APStudy User"
    username = user_doc.get("username")
    return {
        "id": user_id,
        "name": name,
        "username": username,
        "handle": _profile_handle(name, user_id, username),
        "picture_url": user_doc.get("picture_url"),
        "banner_color": _normalize_banner_color(user_doc.get("banner_color")),
        "school": user_doc.get("school"),
        "major": user_doc.get("major"),
        "graduation_year": user_doc.get("graduation_year"),
        "education_level": user_doc.get("education_level"),
        "class_year": user_doc.get("class_year"),
        "member_since": _format_member_since(user_doc.get("created_at")),
        "is_emory_school": _is_emory_school(user_doc.get("school")),
        "is_early_member": _is_early_member(user_doc.get("created_at")),
    }


def _fetch_provider_profile(provider, access_token):
    if not provider or not access_token:
        return {}

    provider_key = provider.lower()
    try:
        if provider_key == "github":
            response = http_requests.get(
                "https://api.github.com/user",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/vnd.github+json",
                },
                timeout=8,
            )
            if response.status_code == 200:
                data = response.json()
                return {
                    "name": data.get("name") or data.get("login"),
                    "avatar_url": data.get("avatar_url"),
                }
            logger.warning("GitHub profile fetch failed: %s", response.status_code)
            return {}

        if provider_key == "discord":
            response = http_requests.get(
                "https://discord.com/api/users/@me",
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=8,
            )
            if response.status_code == 200:
                data = response.json()
                return {
                    "name": data.get("global_name") or data.get("username"),
                    "avatar_url": _discord_avatar_url(data),
                }
            logger.warning("Discord profile fetch failed: %s", response.status_code)
            return {}
    except Exception:
        logger.exception("Failed to fetch provider profile: %s", provider)

    return {}



def _find_user_by_email(email):
    if not email:
        return None
    from appwrite_client import COLLECTIONS
    response = list_rows_safe(
        COLLECTIONS["users"],
        [Query.equal("email", [email]), Query.limit(1)],
    )
    rows = response.get("rows", [])
    return rows[0] if rows else None


@auth_bp.route("/")
def index():
    """Root redirect: dashboard if authenticated, login if not."""
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.calendar"))
    return redirect(url_for("auth.login"))


@auth_bp.route("/login")
def login():
    """Render the sign-in page."""
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.calendar"))
    response = make_response(render_template("login.html"))
    response.headers["Content-Security-Policy"] = LOGIN_CSP
    return response


@auth_bp.route("/user/<user_id>")
def public_user_profile(user_id):
    """Render a public profile card for a user."""
    from appwrite_client import COLLECTIONS

    try:
        user_doc = get_row_safe(COLLECTIONS["users"], user_id, allow_missing=True)
    except AppwriteException:
        logger.exception("Failed to load public user profile")
        abort(404)
    if not user_doc:
        abort(404)
    return _render_public_profile(user_doc)


@auth_bp.route("/u/<username>")
def public_user_profile_by_username(username):
    """Render a public profile card for a username."""
    normalized = _normalize_username(username)
    if not normalized:
        abort(404)

    from appwrite_client import COLLECTIONS
    try:
        user_doc = first_row(
            COLLECTIONS["users"],
            [Query.equal("username", [normalized])],
        )
    except AppwriteException:
        logger.exception("Failed to load public user profile by username")
        abort(404)
    if not user_doc:
        abort(404)

    return _render_public_profile(user_doc)


def _render_public_profile(user_doc):
    viewer = None
    theme_preference = "system-match"
    if current_user.is_authenticated:
        viewer = {
            "email": current_user.email,
            "picture": current_user.picture_url,
        }
        try:
            from appwrite_client import COLLECTIONS
            settings_response = list_rows_safe(
                COLLECTIONS["user_settings"],
                [Query.equal("user_id", [str(current_user.id)]), Query.limit(1)],
            )
            rows = settings_response.get("rows", [])
            if rows:
                theme_preference = rows[0].get("interface_theme") or theme_preference
        except AppwriteException:
            logger.exception("Failed to load viewer theme for public profile")

    response = make_response(render_template(
        "user_profile.html",
        profile=_public_profile_payload(user_doc),
        viewer=viewer,
        theme_preference=theme_preference,
    ))
    response.headers["Content-Security-Policy"] = PUBLIC_PROFILE_CSP
    return response


@auth_bp.route("/user/profile-banner/<color>.svg")
def profile_banner_svg(color):
    """Serve a CSP-safe solid banner image for public profile cards."""
    normalized_color = _normalize_banner_color(color)
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 360" '
        'role="img" aria-hidden="true">'
        f'<rect width="1200" height="360" fill="{normalized_color}"/>'
        '</svg>'
    )
    return Response(svg, mimetype="image/svg+xml")


@auth_bp.route("/auth/session", methods=["POST"])
def appwrite_session():
    payload = request.get_json(silent=True) or {}
    user_id = payload.get("user_id")
    email = payload.get("email")
    provider = payload.get("provider") or "appwrite"
    provider_access_token = payload.get("provider_access_token") or payload.get("providerAccessToken")

    if not user_id:
        return jsonify({"error": "Missing user_id."}), 400

    # Verify user exists in Appwrite via server-side Users service using API key
    try:
        from appwrite_client import client as appwrite_client, COLLECTIONS
        users_service = Users(appwrite_client)
        remote_user = users_service.get(user_id)
    except Exception:
        logger.exception("Failed to verify Appwrite user via server SDK")
        return jsonify({"error": "Invalid Appwrite user."}), 401

    remote_user = _account_to_dict(remote_user)
    remote_email = remote_user.get("email") or ""
    if email and remote_email and email.lower() != remote_email.lower():
        # Email mismatch -- fail the exchange
        logger.warning("Email mismatch during Appwrite session exchange: %s vs %s", email, remote_email)
        return jsonify({"error": "Email mismatch."}), 401

    if not email:
        email = remote_email

    appwrite_user_id = user_id
    user_doc = get_row_safe(COLLECTIONS["users"], appwrite_user_id, allow_missing=True)
    if not user_doc and email:
        user_doc = _find_user_by_email(email)

    # Normalize profile fields from Appwrite's user object
    provider_profile = _fetch_provider_profile(provider, provider_access_token)
    provider_name = provider_profile.get("name")
    provider_avatar_url = provider_profile.get("avatar_url")

    name = provider_name or remote_user.get("name") or remote_user.get("displayName")
    picture_url = (
        provider_avatar_url
        or remote_user.get("photoUrl")
        or remote_user.get("avatar")
        or remote_user.get("picture_url")
    )

    if not user_doc:
        created_at = format_datetime(datetime.utcnow())
        row_data = {
            "google_id": appwrite_user_id,
            "email": email,
            "name": name or remote_user.get("name"),
            "picture_url": picture_url,
            "banner_color": "#fecae1",
            "avatar_source": "provider" if picture_url else None,
            "school": None,
            "major": None,
            "graduation_year": None,
            "onboarding_complete": False,
            "onboarding_step": 1,
            "created_at": created_at,
            "last_login": created_at,
        }
        if provider and provider != "appwrite":
            row_data["provider"] = provider
        try:
            user_doc = create_row_safe(
                COLLECTIONS["users"],
                row_id=appwrite_user_id,
                data=row_data,
            )
        except AppwriteException:
            logger.exception("Failed to create user row from Appwrite auth")
            return jsonify({"error": "Unable to create user."}), 500

        try:
            create_row_safe(
                COLLECTIONS["user_settings"],
                row_id=appwrite_user_id,
                data={
                    "user_id": appwrite_user_id,
                    "ics_secret_token": secrets.token_urlsafe(32),
                    "feed_refresh_minutes": 15,
                    "preferred_calendar_view": "week",
                    "interface_theme": "obsidian-dark",
                    "theme": "dark",
                    "sidebar_default": "expanded",
                    "email_notifications": True,
                    "product_updates": True,
                    "language": "en",
                    "timezone": "",
                    "created_at": created_at,
                },
            )
        except AppwriteException:
            logger.exception("Failed to create user settings from Appwrite auth")
            return jsonify({"error": "Unable to create user settings."}), 500
    else:
        updates = {"last_login": format_datetime(datetime.utcnow())}
        if name:
            updates["name"] = name
        existing_avatar_source = user_doc.get("avatar_source")
        if picture_url and (not user_doc.get("picture_url") or existing_avatar_source == "provider"):
            updates["picture_url"] = picture_url
            updates["avatar_source"] = "provider"
        if email:
            updates["email"] = email
        if provider and provider != "appwrite":
            updates["provider"] = provider

        row_id = user_doc.get("$id") or user_doc.get("id")
        if not row_id:
            return jsonify({"error": "User lookup failed."}), 500
        try:
            user_doc = update_row_safe(
                COLLECTIONS["users"],
                row_id,
                updates,
            )
        except AppwriteException:
            logger.exception("Failed to update user row from Appwrite auth")
            return jsonify({"error": "Unable to update user."}), 500

    login_user(user_from_doc(user_doc))
    session["user_id"] = user_doc.get("$id") or user_doc.get("id")
    session["email"] = email or remote_email
    _set_oauth_session(provider, appwrite_user_id, email, name=name, picture_url=picture_url)
    redirect_to = url_for("settings.onboarding")
    if user_doc.get("onboarding_complete"):
        redirect_to = url_for("dashboard.dashboard")

    return jsonify({"status": "ok", "user_id": session["user_id"], "redirect": redirect_to})


@auth_bp.route("/authorize")
def authorize():
    """Initiate OAuth 2.0 flow by redirecting to Google's consent screen."""
    flow = google_auth_oauthlib.flow.Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE, scopes=SCOPES
    )
    flow.redirect_uri = url_for("auth.oauth2callback", _external=True)

    authorization_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="select_account",
    )

    session["oauth_state"] = state
    return redirect(authorization_url)


@auth_bp.route("/oauth2callback")
def oauth2callback():
    """Handle Google's redirect after user consent."""
    state = session.get("oauth_state")
    if not state:
        return redirect(url_for("auth.login"))

    flow = google_auth_oauthlib.flow.Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE, scopes=SCOPES, state=state
    )
    flow.redirect_uri = url_for("auth.oauth2callback", _external=True)

    # Exchange authorization code for tokens
    flow.fetch_token(authorization_response=request.url)
    credentials = flow.credentials

    # Store credentials in session for potential token revocation later
    session["credentials"] = {
        "token": credentials.token,
        "refresh_token": credentials.refresh_token,
        "token_uri": credentials.token_uri,
        "client_id": credentials.client_id,
        "client_secret": credentials.client_secret,
        "scopes": list(credentials.scopes or []),
    }

    # Fetch user profile from Google
    userinfo_response = http_requests.get(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        headers={"Authorization": f"Bearer {credentials.token}"},
    )

    if userinfo_response.status_code != 200:
        session.clear()
        return redirect(url_for("auth.login"))

    user_info = userinfo_response.json()

    email = user_info.get("email", "")

    google_id = str(user_info["id"])
    _set_oauth_session(
        "google",
        google_id,
        email,
        name=user_info.get("name"),
        picture_url=user_info.get("picture"),
    )
    user_doc = None

    try:
        user_doc = get_row_safe(COLLECTIONS["users"], google_id)
    except AppwriteException as exc:
        if exc.code != 404:
            logger.exception("Failed to fetch user row")
            return redirect(url_for("auth.login"))

    if not user_doc:
        created_at = format_datetime(datetime.utcnow())
        try:
            user_doc = create_row_safe(
                COLLECTIONS["users"],
                row_id=google_id,
                data={
                    "google_id": google_id,
                    "email": email,
                    "name": user_info.get("name"),
                    "picture_url": user_info.get("picture"),
                    "school": None,
                    "major": None,
                    "graduation_year": None,
                    "onboarding_complete": False,
                    "onboarding_step": 1,
                    "created_at": created_at,
                    "last_login": created_at,
                },
            )
        except AppwriteException:
            return redirect(url_for("auth.login"))

        # Create default settings with a unique .ics subscription token
        try:
            create_row_safe(
                COLLECTIONS["user_settings"],
                row_id=google_id,
                data={
                    "user_id": google_id,
                    "ics_secret_token": secrets.token_urlsafe(32),
                    "feed_refresh_minutes": 15,
                    "preferred_calendar_view": "week",
                    "interface_theme": "obsidian-dark",
                    "theme": "dark",
                    "sidebar_default": "expanded",
                    "email_notifications": True,
                    "product_updates": True,
                    "language": "en",
                    "timezone": "",
                    "created_at": created_at,
                },
            )
        except AppwriteException:
            return redirect(url_for("auth.login"))
    else:
        try:
            user_doc = update_row_safe(
                COLLECTIONS["users"],
                google_id,
                {
                    "last_login": format_datetime(datetime.utcnow()),
                    "name": user_info.get("name", user_doc.get("name")),
                    "picture_url": user_info.get("picture", user_doc.get("picture_url")),
                    "email": email or user_doc.get("email"),
                },
            )
        except AppwriteException:
            return redirect(url_for("auth.login"))

    login_user(user_from_doc(user_doc))
    session["user_id"] = user_doc.get("$id") or user_doc.get("id")
    session.pop("oauth_state", None)

    # Redirect users who have not completed onboarding yet.
    if not user_doc.get("onboarding_complete"):
        return redirect(url_for("settings.onboarding"))

    return redirect(url_for("dashboard.calendar"))


@auth_bp.route("/logout")
def logout():
    """Clear session and revoke Google token if possible."""
    credentials_data = session.get("credentials")
    user_id = session.get("oauth_user_id") or session.get("user_id")
    if user_id:
        try:
            from appwrite_client import client as appwrite_client
            users_service = Users(appwrite_client)
            users_service.delete_sessions(str(user_id))
        except Exception:
            logger.exception("Failed to revoke Appwrite sessions for user")
    logout_user()
    session.clear()

    if credentials_data and credentials_data.get("token"):
        http_requests.post(
            "https://oauth2.googleapis.com/revoke",
            params={"token": credentials_data["token"]},
            headers={"content-type": "application/x-www-form-urlencoded"},
        )
    return redirect(url_for("auth.login"))
