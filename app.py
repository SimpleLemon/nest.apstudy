import os
from flask import Flask, jsonify, redirect, render_template, request, url_for
from dotenv import load_dotenv
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

if os.environ.get("APSTUDY_ALLOW_INSECURE_OAUTH") == "1" or os.environ.get("FLASK_DEBUG") == "1":
    os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


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

    # Initialize extensions
    from extensions import csrf, login_manager
    csrf.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"

    @login_manager.unauthorized_handler
    def handle_unauthorized():
        return redirect(url_for("auth.login"))

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
