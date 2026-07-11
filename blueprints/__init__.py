"""
blueprints/__init__.py

Central registration point for all Flask blueprints.
Called once from the application factory in app.py.
"""

from blueprints.auth import auth_bp
from blueprints.dashboard import dashboard_bp
from blueprints.atlas_api import atlas_bp
from blueprints.calendar_api import calendar_bp
from blueprints.calendar_sources_api import calendar_sources_bp
from blueprints.courses import courses_bp
from blueprints.file_share import file_share_bp
from blueprints.notes_api import notes_api_bp
from blueprints.tasks_api import tasks_api_bp
from blueprints.chat_api import chat_api_bp
from blueprints.settings import settings_bp
from blueprints.admin import admin_bp
from blueprints.webhooks import webhooks_bp
from blueprints.legal import legal_bp
from blueprints.debug_api import debug_api_bp
from blueprints.notifications_api import notifications_bp


def register_blueprints(app):
    """Register all blueprints on the Flask application instance."""
    app.register_blueprint(auth_bp)
    app.register_blueprint(dashboard_bp)
    app.register_blueprint(atlas_bp, url_prefix="/api/atlas")
    app.register_blueprint(calendar_bp, url_prefix="/api/calendar")
    app.register_blueprint(calendar_sources_bp, url_prefix="/api/calendar")
    app.register_blueprint(courses_bp, url_prefix="/api/courses")
    app.register_blueprint(file_share_bp)
    app.register_blueprint(notes_api_bp)
    app.register_blueprint(tasks_api_bp)
    app.register_blueprint(chat_api_bp)
    app.register_blueprint(settings_bp, url_prefix="/settings")
    app.register_blueprint(admin_bp)
    app.register_blueprint(webhooks_bp)
    app.register_blueprint(legal_bp)
    app.register_blueprint(debug_api_bp)
    app.register_blueprint(notifications_bp)
