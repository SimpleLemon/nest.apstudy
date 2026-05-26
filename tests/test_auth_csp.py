import unittest

from flask import Flask

from blueprints.auth import LOGIN_CSP, auth_bp
from extensions import login_manager


def _csp_directives(policy):
    directives = {}
    for part in policy.split(";"):
        tokens = part.strip().split()
        if tokens:
            directives[tokens[0]] = tokens[1:]
    return directives


class LoginCspTestCase(unittest.TestCase):
    def test_login_csp_allows_cloudflare_web_analytics(self):
        directives = _csp_directives(LOGIN_CSP)

        self.assertIn("https://static.cloudflareinsights.com", directives["script-src"])
        self.assertIn("https://cloudflareinsights.com", directives["connect-src"])
        self.assertIn("https://static.cloudflareinsights.com", directives["connect-src"])

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
