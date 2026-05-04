import os
from flask import Flask, redirect, url_for
from dotenv import load_dotenv

load_dotenv()

# Flask CLI imports this module without executing __main__, so set this here
# for local HTTP OAuth callbacks in development environments.
os.environ.setdefault("OAUTHLIB_INSECURE_TRANSPORT", "1")


BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def create_app():
    app = Flask(__name__)
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-fallback-key")
    app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
    app.config["FILE_SHARE_UPLOAD_DIR"] = os.path.join(app.root_path, "uploads", "file_share")
    os.makedirs(app.config["FILE_SHARE_UPLOAD_DIR"], exist_ok=True)

    # Initialize extensions
    from extensions import login_manager
    login_manager.init_app(app)
    login_manager.login_view = "auth.login"

    @login_manager.unauthorized_handler
    def handle_unauthorized():
        return redirect(url_for("auth.login"))

    # Register all blueprints
    from blueprints import register_blueprints
    register_blueprints(app)

    @app.cli.command("cleanup-files")
    def cleanup_files_command():
        from services.file_cleanup import cleanup_expired_files

        cleanup_expired_files()

    from services.scheduler import init_scheduler
    init_scheduler(app)

    return app

if __name__ == "__main__":
    app = create_app()
    app.run("localhost", 5000, debug=True)