import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import app as app_module


class BrandAssetResponseTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        database_path = os.path.join(self.temp_dir.name, "brand-assets.sqlite3")
        self.environment = patch.dict(os.environ, {
            "DATABASE_PATH": database_path,
            "FLASK_SECRET_KEY": "brand-assets-test-key",
            "FLASK_ENV": "testing",
            "APSTUDY_ALLOW_INSECURE_HTTP": "1",
            "SCHEDULER_ENABLED": "0",
        }, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        schema_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), "migrations", "001_initial_schema.sql")
        with sqlite3.connect(database_path) as connection, open(schema_path, encoding="utf-8") as schema:
            connection.executescript(schema.read())
        with patch("services.scheduler.init_scheduler"), patch("services.discord_audit.init_discord_audit"):
            self.app = app_module.create_app()
        self.app.config.update(TESTING=True)
        self.client = self.app.test_client()

    def test_versioned_favicon_is_small_png_with_immutable_cache(self):
        response = self.client.get("/static/images/brand/nest-logo-v1-32.png")
        self.addCleanup(response.close)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertLess(len(response.data), 10_000)
        self.assertIn("public", response.headers["Cache-Control"])
        self.assertIn("max-age=31536000", response.headers["Cache-Control"])
        self.assertIn("immutable", response.headers["Cache-Control"])
        self.assertNotIn("no-cache", response.headers["Cache-Control"])

    def test_apple_touch_icon_uses_local_180px_asset_with_cache(self):
        response = self.client.get("/apple-touch-icon.png")
        self.addCleanup(response.close)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "image/png")
        self.assertIn("max-age=86400", response.headers["Cache-Control"])
        self.assertEqual(response.data[16:24], (180).to_bytes(4, "big") * 2)


if __name__ == "__main__":
    unittest.main()
