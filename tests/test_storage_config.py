import os
import unittest
from unittest.mock import patch

from flask import Flask

from config import ENVIRONMENT_CONFIG_EXTENSION_KEY, load_environment_config
from services import storage_backend
from services.storage_errors import StorageMutationPaused


class UploadStorageConfigTests(unittest.TestCase):
    def test_chat_uploads_default_enabled_with_no_appwrite_bucket(self):
        with patch.dict(os.environ, {}, clear=True):
            snapshot = load_environment_config()
            self.assertTrue(snapshot.chat_attachments_enabled)
            self.assertFalse(snapshot.appwrite_chat_attachments_enabled)
            self.assertTrue(storage_backend.chat_attachments_enabled())
            self.assertEqual(storage_backend.write_backend(), "appwrite")

    def test_storage_settings_remain_snapshot_scoped_and_can_pause(self):
        with patch.dict(os.environ, {
            "NEST_STORAGE_BACKEND": "sqlite", "NEST_STORAGE_MUTATIONS_PAUSED": "1",
            "NEST_CHAT_ATTACHMENTS_ENABLED": "0", "NEST_UPLOAD_KEYRING_PATH": "/test/private-keys.json",
        }, clear=True):
            snapshot = load_environment_config()
        app = Flask(__name__)
        app.extensions[ENVIRONMENT_CONFIG_EXTENSION_KEY] = snapshot
        with patch.dict(os.environ, {}, clear=True), app.app_context():
            self.assertEqual(storage_backend.write_backend(), "sqlite")
            self.assertFalse(storage_backend.chat_attachments_enabled())
            with self.assertRaises(StorageMutationPaused):
                storage_backend.require_mutations_enabled()
            app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = False
            storage_backend.require_mutations_enabled()

    def test_scheduler_pause_skips_storage_cleanup(self):
        from services.scheduler import _cleanup_note_media
        app = Flask(__name__)
        app.config["NEST_STORAGE_MUTATIONS_PAUSED"] = True
        with patch("services.note_media.cleanup_abandoned_media") as note_cleanup, patch(
            "services.chat_attachments.cleanup_abandoned_attachments"
        ) as chat_cleanup:
            _cleanup_note_media(app)
        note_cleanup.assert_not_called()
        chat_cleanup.assert_not_called()
