import logging
import os
from datetime import datetime, timedelta, timezone

from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from dotenv import load_dotenv
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()
logger = logging.getLogger(__name__)

if os.environ.get("APSTUDY_ALLOW_INSECURE_OAUTH") == "1" or os.environ.get("FLASK_DEBUG") == "1":
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PRODUCTION_DATABASE_PATH = "/var/www/nest.apstudy.org/instance/nest.sqlite3"


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
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-fallback-key")
    app.config["APPWRITE_DATABASE_ID"] = os.environ.get("APPWRITE_DATABASE_ID", "")
    app.config["DATABASE_PATH"] = os.environ.get(
        "DATABASE_PATH",
        PRODUCTION_DATABASE_PATH
        if os.environ.get("FLASK_ENV") == "production"
        else os.path.join(app.instance_path, "nest.sqlite3"),
    )
    app.config["CALENDAR_SQLITE_PATH"] = app.config["DATABASE_PATH"]
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

    # Initialize extensions
    from extensions import csrf, login_manager
    csrf.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"
    from services.database import close_db, init_db
    init_db(app)
    app.teardown_appcontext(close_db)

    @login_manager.unauthorized_handler
    def handle_unauthorized():
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
            return {"sidebar_default": "expanded", "avatar_src": avatar_url_for_size}

        try:
            from appwrite.query import Query
            from appwrite_client import COLLECTIONS
            from appwrite_helpers import list_rows_safe

            response = list_rows_safe(
                COLLECTIONS["user_settings"],
                [Query.equal("user_id", [str(current_user.id)]), Query.limit(1)],
            )
            rows = response.get("rows", [])
            raw_sidebar_default = rows[0].get("sidebar_default") if rows else ""
        except Exception:
            raw_sidebar_default = ""

        sidebar_default = str(raw_sidebar_default or "").strip().lower()
        if sidebar_default not in {"expanded", "collapsed"}:
            sidebar_default = "expanded"
        return {"sidebar_default": sidebar_default, "avatar_src": avatar_url_for_size}

    # Register all blueprints
    from blueprints import register_blueprints
    register_blueprints(app)

    @app.route("/apple-touch-icon.png")
    def apple_touch_icon():
        return app.send_static_file("apple-touch-icon.png")

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

    from services.discord_audit import init_discord_audit
    init_discord_audit(app)
    from services.scheduler import init_scheduler
    init_scheduler(app)

    return app

if __name__ == "__main__":
    app = create_app()
    app.run("localhost", 5000, debug=True)
