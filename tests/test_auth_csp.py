import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.auth as auth
from blueprints.auth import LANDING_CSP, LOGIN_CSP, PUBLIC_PROFILE_CSP, auth_bp
from extensions import login_manager


def _csp_directives(policy):
    directives = {}
    for part in policy.split(";"):
        tokens = part.strip().split()
        if tokens:
            directives[tokens[0]] = tokens[1:]
    return directives


class LoginCspTestCase(unittest.TestCase):
    def test_landing_csp_allows_public_assets_and_analytics(self):
        directives = _csp_directives(LANDING_CSP)

        self.assertIn("'self'", directives["script-src"])
        self.assertIn("https://www.googletagmanager.com", directives["script-src"])
        self.assertIn("https://fonts.googleapis.com", directives["style-src"])
        self.assertIn("https://fonts.gstatic.com", directives["font-src"])
        self.assertIn("https://resources.apstudy.org", directives["img-src"])
        self.assertIn("https://www.google-analytics.com", directives["img-src"])
        self.assertIn("https://www.google-analytics.com", directives["connect-src"])
        self.assertIn("https://region1.google-analytics.com", directives["connect-src"])

    def test_login_csp_is_not_loosened_for_landing_analytics(self):
        directives = _csp_directives(LOGIN_CSP)

        self.assertNotIn("https://www.googletagmanager.com", directives["script-src"])
        self.assertNotIn("https://www.google-analytics.com", directives["connect-src"])

    def test_login_csp_blocks_cloudflare_web_analytics(self):
        directives = _csp_directives(LOGIN_CSP)

        self.assertNotIn("https://static.cloudflareinsights.com", directives["script-src"])
        self.assertNotIn("https://cloudflareinsights.com", directives["connect-src"])
        self.assertNotIn("https://static.cloudflareinsights.com", directives["connect-src"])

    def test_public_profile_csp_allows_consent_managed_analytics(self):
        directives = _csp_directives(PUBLIC_PROFILE_CSP)

        self.assertIn("https://www.googletagmanager.com", directives["script-src"])
        self.assertIn("https://www.google-analytics.com", directives["connect-src"])
        self.assertIn("https://region1.google-analytics.com", directives["connect-src"])

    def test_landing_route_renders_with_csp(self):
        app = Flask(__name__, template_folder="../templates", static_folder="../static")
        app.secret_key = "test"
        login_manager.init_app(app)
        app.register_blueprint(auth_bp)

        response = app.test_client().get("/")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Security-Policy"], LANDING_CSP)
        self.assertIn(b"Nest.APStudy", response.data)
        self.assertIn(b"Start free", response.data)
        self.assertNotIn(b"Open Nest", response.data)
        self.assertIn(b"/apple-touch-icon.png", response.data)
        self.assertIn(b"feature-panel--dashboard", response.data)
        self.assertIn(b"landing-app-demo-dashboard", response.data)
        self.assertIn(b"static/images/landing/nest-interface-hero.png", response.data)

    def test_landing_route_does_not_redirect_authenticated_users(self):
        app = Flask(__name__, template_folder="../templates", static_folder="../static")
        app.secret_key = "test"
        login_manager.init_app(app)
        app.register_blueprint(auth_bp)

        with patch.object(auth, "current_user", SimpleNamespace(is_authenticated=True)):
            response = app.test_client().get("/")

        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Location", response.headers)
        self.assertIn(b"Your semester", response.data)
        self.assertIn(b"Open Nest", response.data)
        self.assertNotIn(b"Log in", response.data)

    def test_login_route_renders_with_csp(self):
        app = Flask(__name__, template_folder="../templates", static_folder="../static")
        app.secret_key = "test"
        login_manager.init_app(app)
        app.register_blueprint(auth_bp)

        response = app.test_client().get("/login")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Content-Security-Policy"], LOGIN_CSP)
        self.assertIn(b"Sign in to Nest", response.data)


if __name__ == "__main__":
    unittest.main()
