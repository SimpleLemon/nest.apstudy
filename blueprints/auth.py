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
from datetime import datetime

# Must be set before OAuth flow objects are created during local HTTP testing.
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")

import requests as http_requests
import google_auth_oauthlib.flow
from flask import (
    Blueprint, redirect, url_for, session, render_template, request, jsonify
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
    list_rows_safe,
    update_row_safe,
)
from models import User, user_from_doc

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger(__name__)

CLIENT_SECRETS_FILE = "client_secret.json"
SCOPES = [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
]


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
        return redirect(url_for("dashboard.dashboard"))
    return redirect(url_for("auth.login"))


@auth_bp.route("/login")
def login():
    """Render the sign-in page."""
    if current_user.is_authenticated:
        return redirect(url_for("dashboard.dashboard"))
    return render_template("login.html")


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
        if picture_url:
            updates["picture_url"] = picture_url
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

    return redirect(url_for("dashboard.dashboard"))


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
