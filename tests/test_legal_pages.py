import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

from blueprints.auth import auth_bp
import blueprints.legal as legal
from extensions import login_manager


class LegalPagesTestCase(unittest.TestCase):
    def setUp(self):
        project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        self.app = Flask(
            __name__,
            template_folder=os.path.join(project_root, "templates"),
            static_folder=os.path.join(project_root, "static"),
        )
        self.app.secret_key = "test"
        self.app.jinja_env.filters["avatar_url"] = lambda value, size=32: value or ""
        login_manager.init_app(self.app)
        self.app.register_blueprint(auth_bp)
        self.app.register_blueprint(legal.legal_bp)

    def test_privacy_policy_renders_logged_out(self):
        response = self.app.test_client().get("/privacy-policy")
        body = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertIn("<title>Privacy Policy - APStudy Nest</title>", body)
        self.assertIn("Last Updated: June 2025", body)
        self.assertIn('href="/privacy-policy"', body)
        self.assertIn('href="/terms-of-service"', body)
        self.assertIn('href="mailto:derek.chen@emory.edu"', body)
        self.assertIn("legal-public-nav", body)
        self.assertIn("Google Analytics", body)
        self.assertNotIn('class="thesidebar"', body)

    def test_terms_of_service_renders_logged_out(self):
        response = self.app.test_client().get("/terms-of-service")
        body = response.get_data(as_text=True)

        self.assertEqual(response.status_code, 200)
        self.assertIn("<title>Terms of Service - APStudy Nest</title>", body)
        self.assertIn("Last Updated: June 2025", body)
        self.assertIn("Academic Data Disclaimer", body)
        self.assertIn("Limitation of Liability", body)
        self.assertIn('href="/privacy-policy"', body)
        self.assertIn('href="/terms-of-service"', body)
        self.assertNotIn('class="thesidebar"', body)

    def test_authenticated_legal_page_uses_app_chrome_placeholders(self):
        user = SimpleNamespace(
            id="user-1",
            email="student@example.test",
            picture_url="https://example.test/avatar.png",
            emory_student=True,
            is_authenticated=True,
        )

        with patch.object(legal, "current_user", user), \
                patch.object(legal, "list_rows_safe", return_value={"rows": [{"interface_theme": "nest-light"}]}):
            response = self.app.test_client().get("/privacy-policy")

        body = response.get_data(as_text=True)
        self.assertEqual(response.status_code, 200)
        self.assertIn('global class="thenav"', body)
        self.assertIn('global class="thesidebar"', body)
        self.assertIn('data-user-email="student@example.test"', body)
        self.assertIn('data-user-emory-student="True"', body)
        self.assertNotIn("legal-public-nav", body)
        self.assertIn('window.APSTUDY_THEME_PREFERENCE = "nest-light";', body)

    def test_global_footer_points_to_legal_pages(self):
        footer_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "static",
            "js",
            "global.js",
        )
        with open(footer_path, encoding="utf-8") as footer_file:
            footer_source = footer_file.read()

        self.assertIn('href="mailto:derek.chen@emory.edu"', footer_source)
        self.assertIn('href="/privacy-policy"', footer_source)
        self.assertIn('href="/terms-of-service"', footer_source)
        self.assertNotIn(">Archive<", footer_source)

    def test_legal_css_keeps_responsive_readability_rules(self):
        css_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "static",
            "css",
            "legal.css",
        )
        with open(css_path, encoding="utf-8") as css_file:
            css_source = css_file.read()

        self.assertIn("overflow-x: hidden", css_source)
        self.assertIn(".legal-table-wrap", css_source)
        self.assertIn("overflow-x: auto", css_source)
        self.assertIn("@media (max-width: 980px)", css_source)
        self.assertIn("@media (max-width: 640px)", css_source)
        self.assertIn("grid-template-columns: 1fr", css_source)
        self.assertIn("min-height: 48px", css_source)


if __name__ == "__main__":
    unittest.main()
