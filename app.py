import logging
import os
import secrets
from datetime import datetime, timedelta, timezone

from flask import Flask, g, jsonify, redirect, render_template, request, session, url_for
from dotenv import load_dotenv
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()
logger = logging.getLogger(__name__)

if os.environ.get("APSTUDY_ALLOW_INSECURE_OAUTH") == "1" or os.environ.get("FLASK_DEBUG") == "1":
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _session_secret_key():
    configured = os.environ.get("FLASK_SECRET_KEY")
    if configured:
        return configured
    if (os.environ.get("FLASK_ENV") or "").strip().lower() == "production":
        raise RuntimeError("FLASK_SECRET_KEY must be configured in production.")
    logger.warning("FLASK_SECRET_KEY is not configured; using an ephemeral development key.")
    return secrets.token_hex(32)


def create_app():
    app = Flask(__name__)
    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=1,
        x_proto=1,
        x_host=1,
        x_port=1,
        x_prefix=1,
    )
    from avatar_images import avatar_url_for_size

    app.jinja_env.filters["avatar_url"] = avatar_url_for_size
    app.secret_key = _session_secret_key()
    app.config["APPWRITE_DATABASE_ID"] = os.environ.get("APPWRITE_DATABASE_ID", "")
    from services.database import database_path, nest_instance_dir

    resolved_database_path = database_path()
    app.config["DATABASE_PATH"] = resolved_database_path
    app.config["CALENDAR_SQLITE_PATH"] = resolved_database_path
    app.config["MAX_CONTENT_LENGTH"] = 5 * 50 * 1024 * 1024
    app.config["FILE_SHARE_UPLOAD_DIR"] = os.path.join(app.root_path, "uploads", "file_share")
    allow_insecure_http = (
        os.environ.get("APSTUDY_ALLOW_INSECURE_HTTP") == "1"
        or os.environ.get("FLASK_DEBUG") == "1"
    )
    app.config["SESSION_COOKIE_SECURE"] = not allow_insecure_http
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
    app.config["PREFERRED_URL_SCHEME"] = "http" if allow_insecure_http else "https"
    app.config["WTF_CSRF_CHECK_DEFAULT"] = False
    os.makedirs(app.config["FILE_SHARE_UPLOAD_DIR"], exist_ok=True)
    os.makedirs(app.instance_path, exist_ok=True)
    os.makedirs(nest_instance_dir(), exist_ok=True)

    # Initialize extensions
    from extensions import csrf, login_manager
    csrf.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"
    from flask_login import current_user
    from flask_wtf.csrf import generate_csrf
    from blueprints.auth import LOGIN_NEXT_SESSION_KEY, _is_safe_login_next_url
    from services.database import close_db, init_db
    init_db(app)
    app.teardown_appcontext(close_db)

    @app.before_request
    def protect_authenticated_mutations():
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
            return None
        if request.blueprint == "admin":
            return None
        if current_user.is_authenticated:
            csrf.protect()
        return None

    @app.after_request
    def provide_csrf_cookie(response):
        if request.method in {"GET", "HEAD"} and response.mimetype == "text/html":
            response.set_cookie(
                "csrf_token",
                generate_csrf(),
                secure=app.config["SESSION_COOKIE_SECURE"],
                httponly=False,
                samesite="Lax",
            )
        return response

    @login_manager.unauthorized_handler
    def handle_unauthorized():
        next_url = request.full_path
        if _is_safe_login_next_url(next_url):
            session[LOGIN_NEXT_SESSION_KEY] = next_url
            return redirect(url_for("auth.login", next=next_url))
        return redirect(url_for("auth.login"))

    @app.before_request
    def track_authenticated_site_open():
        from flask_login import current_user

        if not current_user.is_authenticated:
            return None
        if request.method not in {"GET", "HEAD"}:
            return None
        if request.endpoint == "static" or request.path.startswith("/api/"):
            return None
        if not request.accept_mimetypes.accept_html:
            return None

        now = datetime.now(timezone.utc)
        tracked_at = session.get("last_site_open_tracked_at")
        if tracked_at:
            try:
                previous = datetime.fromisoformat(str(tracked_at).replace("Z", "+00:00"))
                if previous.tzinfo is None:
                    previous = previous.replace(tzinfo=timezone.utc)
                if now - previous < timedelta(minutes=15):
                    return None
            except ValueError:
                pass

        try:
            from appwrite_client import COLLECTIONS
            from appwrite_helpers import format_datetime, update_row_safe

            timestamp = format_datetime(now)
            update_row_safe(COLLECTIONS["users"], str(current_user.id), {"last_login": timestamp})
            current_user.last_login = now
            session["last_site_open_tracked_at"] = timestamp
        except Exception:
            logger.exception("Failed to track authenticated site open")
        return None

    @app.context_processor
    def inject_shell_preferences():
        from flask_login import current_user

        if not current_user.is_authenticated:
            return {
                "sidebar_default": "expanded",
                "avatar_src": avatar_url_for_size,
                "can_access_admin": False,
                "appwrite_endpoint": os.environ.get("APPWRITE_ENDPOINT", "https://nyc.cloud.appwrite.io/v1"),
                "appwrite_project_id": os.environ.get("APPWRITE_PROJECT_ID", "69f77663000c16abdff2"),
            }

        try:
            from appwrite.query import Query
            from appwrite_client import COLLECTIONS
            from appwrite_helpers import first_row

            if hasattr(g, "_apstudy_user_settings"):
                settings = g._apstudy_user_settings
            else:
                settings = first_row(
                    COLLECTIONS["user_settings"],
                    [Query.equal("user_id", [str(current_user.id)])],
                )
                g._apstudy_user_settings = settings
            raw_sidebar_default = settings.get("sidebar_default") if settings else ""
        except Exception:
            raw_sidebar_default = ""

        sidebar_default = str(raw_sidebar_default or "").strip().lower()
        if sidebar_default not in {"expanded", "collapsed"}:
            sidebar_default = "expanded"
        user_id = str(getattr(current_user, "id", "") or "")
        from services.admin_access import user_can_access_admin

        return {
            "sidebar_default": sidebar_default,
            "avatar_src": avatar_url_for_size,
            "can_access_admin": user_can_access_admin(user_id),
            "appwrite_endpoint": os.environ.get("APPWRITE_ENDPOINT", "https://nyc.cloud.appwrite.io/v1"),
            "appwrite_project_id": os.environ.get("APPWRITE_PROJECT_ID", "69f77663000c16abdff2"),
        }

    # Register all blueprints
    from blueprints import register_blueprints
    register_blueprints(app)

    @app.route("/apple-touch-icon.png")
    def apple_touch_icon():
        return app.send_static_file("apple-touch-icon.png")

    @app.errorhandler(RequestEntityTooLarge)
    def handle_request_entity_too_large(_error):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Upload exceeds the maximum allowed size (50 MB per file)."}), 413
        return jsonify({"error": "Upload exceeds the maximum allowed size."}), 413

    @app.errorhandler(404)
    def page_not_found(error):
        if request.path.startswith("/api/"):
            return jsonify({"error": "not_found"}), 404

        from flask_login import current_user

        home_url = url_for("dashboard.dashboard") if current_user.is_authenticated else url_for("auth.login")
        return render_template("404.html", home_url=home_url), 404

    @app.cli.command("cleanup-files")
    def cleanup_files_command():
        from services.file_cleanup import cleanup_expired_files

        cleanup_expired_files()

    @app.cli.command("backup-db")
    def backup_db_command():
        from pathlib import Path

        from scripts.backup_nest_db import run_backup
        from services.database import nest_instance_dir

        instance_dir = Path(nest_instance_dir())
        backup_dir = Path(os.environ.get("NEST_BACKUP_DIR", "/var/backups/nest-db"))
        max_backups = int(os.environ.get("NEST_BACKUP_RETENTION", "7"))
        raise SystemExit(
            run_backup(
                instance_dir=instance_dir,
                backup_dir=backup_dir,
                max_backups=max_backups,
                notify_discord=True,
            )
        )

    from services.discord_audit import init_discord_audit
    init_discord_audit(app)
    from services.scheduler import init_scheduler
    init_scheduler(app)

    return app

if __name__ == "__main__":
    app = create_app()
    app.run("localhost", 5000, debug=True)
