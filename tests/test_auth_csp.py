import unittest

from blueprints.auth import LOGIN_CSP


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


if __name__ == "__main__":
    unittest.main()
