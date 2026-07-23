"""Personal pages for Derek — Echo Show dashboard and related tools."""

from functools import wraps

from flask import Blueprint, abort, make_response, render_template
from flask_login import current_user, login_required

from blueprints.dashboard import _load_user_settings, _theme_from_settings, _user_payload

derek_bp = Blueprint("derek", __name__)

ALLOWED_EMAIL = "derekchenusa@gmail.com"


def derek_email_required(view):
    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        email = str(current_user.email or "").strip().lower()
        if email != ALLOWED_EMAIL:
            abort(403)
        return view(*args, **kwargs)

    return wrapped


@derek_bp.get("/derek/echo")
@derek_email_required
def echo_page():
    settings = _load_user_settings()
    response = make_response(render_template(
        "derek_echo.html",
        user=_user_payload(),
        theme_preference=_theme_from_settings(settings),
    ))
    response.headers["Cache-Control"] = "private, no-store, no-transform"
    return response
