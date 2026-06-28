import unittest
from unittest.mock import patch

import blueprints.notes_api as notes_api
from tests.support.harness import reset_flask_login_manager


class NotesLinkPreviewTests(unittest.TestCase):
    def tearDown(self):
        reset_flask_login_manager()

    def test_rejects_invalid_url(self):
        payload, status = notes_api._link_preview_payload("javascript:alert(1)")

        self.assertIsNone(payload)
        self.assertEqual(status, 400)

    @patch.object(notes_api, "_is_public_host", return_value=False)
    def test_rejects_private_url(self, public_host):
        payload, status = notes_api._link_preview_payload("http://127.0.0.1:8000")

        self.assertIsNone(payload)
        self.assertEqual(status, 400)
        public_host.assert_called_once()

    @patch.object(notes_api, "_is_public_host", return_value=True)
    @patch.object(notes_api, "first_row", return_value={
        "url": "https://example.com/",
        "title": "Cached",
        "description": "Cached description",
        "image_url": "https://example.com/og.png",
        "site_name": "Example",
        "content_type": "text/html",
    })
    def test_uses_cached_preview(self, first_row, public_host):
        payload, status = notes_api._link_preview_payload("https://example.com")

        self.assertEqual(status, 200)
        self.assertTrue(payload["preview_found"])
        self.assertEqual(payload["title"], "Cached")
        first_row.assert_called_once()
        public_host.assert_called_once()

    @patch.object(notes_api, "_is_public_host", return_value=True)
    @patch.object(notes_api, "first_row", return_value=None)
    @patch.object(notes_api, "fetch_link_preview", return_value=None)
    def test_safe_url_without_metadata_returns_fallback(self, fetch_preview, first_row, public_host):
        payload, status = notes_api._link_preview_payload("https://example.com/path")

        self.assertEqual(status, 200)
        self.assertFalse(payload["preview_found"])
        self.assertEqual(payload["title"], "example.com")
        self.assertEqual(payload["url"], "https://example.com/path")
        fetch_preview.assert_called_once()

    @patch.object(notes_api, "_is_public_host", return_value=True)
    @patch.object(notes_api, "first_row", return_value=None)
    @patch.object(notes_api, "create_row_safe")
    @patch.object(notes_api, "fetch_link_preview", return_value={
        "url": "https://example.com/",
        "title": "Fetched",
        "description": "Fetched description",
        "image_url": "",
        "site_name": "Example",
        "content_type": "text/html",
    })
    def test_fetches_and_caches_preview(self, fetch_preview, create_row, first_row, public_host):
        payload, status = notes_api._link_preview_payload("https://example.com")

        self.assertEqual(status, 200)
        self.assertTrue(payload["preview_found"])
        self.assertEqual(payload["title"], "Fetched")
        create_row.assert_called_once()

    def test_route_requires_authentication(self):
        from app import create_app

        app = create_app()
        response = app.test_client().get("/api/notes/tools/link-preview?url=https://example.com")

        self.assertIn(response.status_code, {302, 401})


if __name__ == "__main__":
    unittest.main()
