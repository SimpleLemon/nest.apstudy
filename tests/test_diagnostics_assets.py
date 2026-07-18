import unittest

from flask import Flask, render_template


class DiagnosticsAssetsTemplateTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__, template_folder="../templates", static_folder="../static")

    def render(self, enabled):
        with self.app.test_request_context("/"):
            return render_template(
                "_diagnostics_assets.html",
                frontend_console_diagnostics_enabled=enabled,
            )

    def test_diagnostics_script_is_absent_by_default(self):
        self.assertNotIn("console-discord.js", self.render(False))

    def test_enabled_diagnostics_script_is_async(self):
        markup = self.render(True)
        self.assertIn("console-discord.js", markup)
        self.assertIn(" async", markup)
        self.assertNotIn("document.write", markup)


if __name__ == "__main__":
    unittest.main()
