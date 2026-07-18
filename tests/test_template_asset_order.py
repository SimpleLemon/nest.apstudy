import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "templates"
BASE_STYLES = {
    "fonts.css",
    "global.css",
    "index.css",
    "layout.css",
    "tailwind.css",
    "themes.css",
}


def _full_templates():
    return [
        template
        for template in sorted(TEMPLATES.glob("*.html"))
        if "<!DOCTYPE html>" in template.read_text()
    ]


class TemplateAssetOrderTests(unittest.TestCase):
    def test_pages_do_not_load_the_unused_browser_appwrite_sdk(self):
        for template in _full_templates():
            with self.subTest(template=template.name):
                source = template.read_text()
                self.assertNotIn("appwrite@25.0.0", source)
                self.assertNotIn("js/core/appwrite.js", source)
                self.assertNotIn("_appwrite_meta.html", source)

    def test_theme_and_styles_follow_the_shared_cascade(self):
        for template in _full_templates():
            with self.subTest(template=template.name):
                source = template.read_text()
                head = source.split("</head>", 1)[0]
                theme_init = head.index("js/core/theme-init.js")
                themes = head.index("css/themes.css")
                global_styles = head.index("css/global.css")
                tailwind = head.index("css/tailwind.css")

                self.assertLess(theme_init, themes)
                self.assertLess(themes, global_styles)
                self.assertLess(global_styles, tailwind)

                feature_styles = re.findall(
                    r"filename=['\"](?:css|js/notes/dist)/([^'\"]+\.css)",
                    head,
                )
                for stylesheet in feature_styles:
                    if stylesheet in BASE_STYLES:
                        continue
                    self.assertLess(
                        tailwind,
                        head.index(stylesheet),
                        f"{stylesheet} must load after Tailwind",
                    )

    def test_remote_font_connections_are_warmed_before_use(self):
        for template in _full_templates():
            with self.subTest(template=template.name):
                head = template.read_text().split("</head>", 1)[0]
                if "https://fonts.googleapis.com/css" not in head:
                    continue
                preconnect = 'rel="preconnect" href="https://fonts.googleapis.com"'
                self.assertIn(preconnect, head)
                self.assertLess(head.index(preconnect), head.index("https://fonts.googleapis.com/css"))

    def test_head_scripts_do_not_block_rendering_dependencies(self):
        allowed_synchronous = {"theme-init.js", "landing-theme-init.js", "sidebar-init.js"}
        for template in _full_templates():
            with self.subTest(template=template.name):
                head = template.read_text().split("</head>", 1)[0]
                for script in re.findall(r"<script\b[^>]*\bsrc=[^>]+>", head):
                    if any(asset in script for asset in allowed_synchronous):
                        continue
                    self.assertTrue(
                        " defer" in script or 'type="module"' in script,
                        f"render-blocking script: {script}",
                    )

                if "appwrite@25.0.0" in head:
                    sdk = head.index("appwrite@25.0.0")
                    appwrite = head.index("js/core/appwrite.js")
                    self.assertLess(head.index("js/core/theme-init.js"), sdk)
                    self.assertLess(sdk, appwrite)

    def test_shared_shell_bootstraps_before_global_runtime(self):
        for template in _full_templates():
            source = template.read_text()
            if '<global class="thenav"' not in source:
                continue
            with self.subTest(template=template.name):
                head = source.split("</head>", 1)[0]
                self.assertLess(
                    head.index("js/core/global-chrome.js"),
                    head.index("js/core/global.js"),
                )


if __name__ == "__main__":
    unittest.main()
