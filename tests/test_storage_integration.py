"""Full-application HTTP coverage with Appwrite Storage unavailable."""

import copy
import gzip
import io
import stat
import unittest
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

from flask import Flask, session
from PIL import Image

from tests.browser.storage_server import (
    AUTH_ROUTE, CHANNEL_ID, NOTE_ID, OUTSIDER_ID, OVERVIEW_ROUTE, OWNER_ID,
    PEER_ID, THREAD_ID, _register_routes, authenticated_client, gif_bytes, pdf_bytes,
    png_bytes, require_response, storage_test_app, upload_chat_attachment,
    upload_note_image, upload_shared_file,
)


def local_url(url):
    parsed = urlsplit(url)
    return parsed.path + (f"?{parsed.query}" if parsed.query else "")


class StorageIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.pdf_payload = pdf_bytes()
        with patch("tests.browser.storage_server.pdf_bytes", return_value=self.pdf_payload):
            self.app = self.enterContext(storage_test_app(seed_uploads=True))
        self.state = self.app.extensions["storage_test_fixture"]
        self.fixtures = self.state["fixtures"]
        self.owner = authenticated_client(self.app)
        self.peer = authenticated_client(self.app, PEER_ID)
        self.outsider = authenticated_client(self.app, OUTSIDER_ID)
        self.anonymous = self.app.test_client()

    def tearDown(self):
        for method, transport in self.state["storage_mocks"].items():
            with self.subTest(storage_method=method):
                transport.assert_not_called()

    def row(self, table, row_id):
        from services import database
        return database.get_row(table, row_id, path=self.app.config["DATABASE_PATH"])

    def update(self, table, row_id, values):
        from services import database
        return database.update_row(table, row_id, values, path=self.app.config["DATABASE_PATH"])

    def counts(self):
        from services import database
        with database.db_connection(self.app.config["DATABASE_PATH"]) as conn:
            return tuple(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                         for table in ("storage_objects", "storage_avatar_ownership", "shared_files", "note_media", "chat_attachments"))

    def avatar_ownership(self, file_id):
        from services import database
        with database.db_connection(self.app.config["DATABASE_PATH"]) as conn:
            row = conn.execute("SELECT * FROM storage_avatar_ownership WHERE object_id = ?", (file_id,)).fetchone()
            return dict(row) if row is not None else None

    def storage_usage(self, user_id):
        from services import entitlements
        with self.app.app_context():
            return entitlements.entitlements_for_user(user_id)["usage"]["storage_bytes"]

    def assert_seekable(self, client, url, data, *, disposition="attachment", public=False):
        response = client.get(url)
        self.assertEqual(response.status_code, 200, response.get_json(silent=True))
        self.assertEqual(response.data, data)
        self.assertIn(disposition, response.headers["Content-Disposition"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("public" if public else "private", response.headers["Cache-Control"])
        ranged = client.get(url, headers={"Range": "bytes=2-7"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.data, data[2:8])
        self.assertEqual(ranged.headers["Content-Range"], f"bytes 2-7/{len(data)}")
        conditional = client.get(url, headers={"If-None-Match": response.headers["ETag"]})
        self.assertEqual(conditional.status_code, 304)
        self.assertFalse(conditional.data)
        self.assertEqual(client.head(url).headers["Content-Length"], str(len(data)))
        self.assertEqual(client.get(url, headers={"Range": f"bytes={len(data) + 1}-"}).status_code, 416)
        return response

    def test_seeded_real_pages_use_encrypted_disposable_objects(self):
        from appwrite.services.account import Account
        from appwrite.services.users import Users
        from services import database

        for url in ("/settings", "/files", "/notes", self.fixtures["note_url"], self.fixtures["chat_url"], OVERVIEW_ROUTE):
            with self.subTest(page=url):
                response = self.owner.get(url, follow_redirects=True)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.mimetype, "text/html")
        self.assertFalse(isinstance(Users.get, Mock))
        self.assertFalse(isinstance(Account.create_o_auth2_token, Mock))
        shared_url = self.fixtures["shared_file"]["shareUrl"]
        self.assertTrue(shared_url.startswith("/files/share/"))
        overview = self.owner.get(OVERVIEW_ROUTE).get_data(as_text=True)
        self.assertIn(f'href="{shared_url}"', overview)
        self.assertNotIn("http://localhost", overview)
        self.assertEqual(self.anonymous.get(shared_url).status_code, 200)
        keyring = Path(self.app.config["NEST_UPLOAD_KEYRING_PATH"])
        self.assertEqual(stat.S_IMODE(keyring.stat().st_mode), 0o600)
        self.assertNotEqual(keyring.parent, Path(self.app.config["DATABASE_PATH"]).parent)
        with database.db_connection(self.app.config["DATABASE_PATH"]) as conn:
            namespaces = {row[0] for row in conn.execute("SELECT DISTINCT namespace FROM storage_objects")}
            self.assertEqual(namespaces, {"avatars", "shared_files", "note_media", "chat_attachments"})
            for row in conn.execute("SELECT byte_length, payload FROM storage_objects"):
                self.assertEqual(len(row["payload"]), row["byte_length"] + 16)
                self.assertNotIn(b"Synthetic shared file", row["payload"])
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_avatar_replacement_preserves_shared_profile_and_chat_history(self):
        previous = self.row("users", OWNER_ID)
        original = png_bytes(size=(160, 160))
        owner_usage = self.storage_usage(OWNER_ID)
        peer_usage = self.storage_usage(PEER_ID)
        ownership = {
            "object_id": previous["avatar_file_id"], "user_id": OWNER_ID,
            "size_bytes": len(original), "storage_backend": "sqlite",
        }
        self.assertEqual(self.avatar_ownership(previous["avatar_file_id"]), ownership)
        avatar_fields = {key: previous[key] for key in (
            "picture_url", "avatar_file_id", "avatar_storage_backend", "avatar_source", "avatar_file_size_bytes",
        )}
        self.update("users", PEER_ID, avatar_fields)
        self.update("chat_messages", self.fixtures["message_id"], {"author_avatar_url": previous["picture_url"]})
        self.assertEqual(self.storage_usage(OWNER_ID), owner_usage)
        self.assertEqual(self.storage_usage(PEER_ID), peer_usage)
        replacement = png_bytes(color="#96506b", size=(160, 160))
        uploaded = require_response(self.owner.post("/settings/api/avatar-upload", data={
            "avatar": (io.BytesIO(replacement), "replacement.png", "image/png"),
        }), 200)
        self.assertNotEqual(uploaded["picture_url"], previous["picture_url"])
        self.assert_seekable(self.anonymous, uploaded["picture_url"], replacement, disposition="inline", public=True)
        self.assert_seekable(self.anonymous, previous["picture_url"], original, disposition="inline", public=True)
        current = self.row("users", OWNER_ID)
        self.assertEqual(self.avatar_ownership(current["avatar_file_id"]), {
            "object_id": current["avatar_file_id"], "user_id": OWNER_ID,
            "size_bytes": len(replacement), "storage_backend": "sqlite",
        })
        self.assertEqual(self.avatar_ownership(previous["avatar_file_id"]), ownership)
        self.assertEqual(self.storage_usage(OWNER_ID), owner_usage + len(replacement))
        self.assertEqual(self.storage_usage(PEER_ID), peer_usage)
        self.assertEqual(self.row("users", PEER_ID)["picture_url"], previous["picture_url"])
        messages = require_response(self.peer.get(f"/api/chat/channels/{CHANNEL_ID}/messages"), 200)
        message = next(item for item in messages["messages"] if item["id"] == self.fixtures["message_id"])
        self.assertEqual(message["author_avatar_url"], previous["picture_url"])

    def test_provider_login_copies_synthetic_avatar_with_storage_transport_disabled(self):
        from blueprints import auth
        from services import avatar_storage

        image = png_bytes(color="#96506b", size=(160, 160))
        with self.app.test_request_context("/auth/session", method="POST"), ExitStack() as stack:
            stack.enter_context(patch.object(auth, "_provider_access_token_from_identities", return_value={}))
            stack.enter_context(patch.object(auth, "_fetch_provider_profile", return_value={"avatar_url": "https://provider.synthetic.invalid/avatar"}))
            download = stack.enter_context(patch.object(avatar_storage, "_download_provider_avatar", return_value=(image, "image/png")))
            stack.enter_context(patch.object(auth, "sync_chat_presence_labels_for_user"))
            result = auth._complete_appwrite_login({"$id": PEER_ID, "email": f"{PEER_ID}@example.test"},
                provider="google", provider_access_token="synthetic-token")
            self.assertEqual(session["_user_id"], PEER_ID)
            self.assertEqual(result["user_doc"]["avatar_storage_backend"], "sqlite")
            download.assert_called_once()
        stored = self.row("users", PEER_ID)
        self.assertEqual(stored["avatar_source"], "provider")
        self.assertEqual(self.avatar_ownership(stored["avatar_file_id"]), {
            "object_id": stored["avatar_file_id"], "user_id": PEER_ID,
            "size_bytes": len(image), "storage_backend": "sqlite",
        })
        self.assertEqual(self.storage_usage(PEER_ID), len(image))
        self.assert_seekable(self.anonymous, stored["picture_url"], image, disposition="inline", public=True)

    def test_shared_file_public_private_expiry_and_folder_zip_contracts(self):
        public = self.fixtures["shared_file"]
        private = self.fixtures["private_file"]
        public_url = local_url(public["shareUrl"]) + "?download=1"
        private_url = f"/api/files/my/{private['id']}/download"
        self.assert_seekable(self.anonymous, public_url, b"Synthetic shared file\n")
        self.assert_seekable(self.owner, private_url, b"Synthetic shared file\n")
        self.assertEqual(self.anonymous.get(private_url).status_code, 401)
        self.assertEqual(self.peer.get(private_url).status_code, 404)
        folder = require_response(self.owner.post("/api/files/folders", json={"name": "SQLite folder"}), 201)
        first = upload_shared_file(self.owner, b"first child\n", filename="first.txt", visibility="private", folderId=folder["id"])
        second = upload_shared_file(self.owner, b"second child\n", filename="second.txt", visibility="private", folderId=folder["id"])
        shared_folder = require_response(self.owner.post(f"/api/files/folders/{folder['id']}/visibility", json={"visibility": "public"}), 200)
        share_url = local_url(shared_folder["shareUrl"])
        self.assertEqual(self.anonymous.get(share_url).status_code, 200)
        self.assertEqual(self.anonymous.get(f"{share_url}/download/{first['id']}").data, b"first child\n")
        for client, url in ((self.owner, f"/api/files/folders/{folder['id']}/download.zip"), (self.anonymous, share_url + "?download=zip")):
            with client.get(url) as response:
                self.assertEqual(response.status_code, 200)
                with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
                    self.assertEqual({archive.read(name) for name in archive.namelist()}, {b"first child\n", b"second child\n"})
        self.update("shared_files", public["id"], {"expires_at": "2000-01-01T00:00:00Z"})
        self.assertIn(b"File not found or expired", self.anonymous.get(public_url).data)
        self.update("shared_files", second["id"], {"expires_at": "2000-01-01T00:00:00Z"})
        self.assertEqual(self.anonymous.get(f"{share_url}/download/{second['id']}").status_code, 404)

    def test_note_image_permissions_are_rechecked_before_conditional_responses(self):
        from services import note_store

        url = self.fixtures["note_media"]["url"]
        original = png_bytes()
        response = self.assert_seekable(self.owner, url, original, disposition="inline")
        headers = {"If-None-Match": response.headers["ETag"]}
        self.assertEqual(self.anonymous.get(url, headers=headers).status_code, 401)
        self.assertEqual(self.peer.get(url, headers=headers).status_code, 404)
        with self.app.app_context():
            note_store.replace_resource_grants("note", NOTE_ID, OWNER_ID, public=False,
                user_ids=[PEER_ID], granted_by_user_id=OWNER_ID)
        self.assert_seekable(self.peer, url, original, disposition="inline")
        with self.app.app_context():
            note_store.replace_resource_grants("note", NOTE_ID, OWNER_ID, public=True,
                granted_by_user_id=OWNER_ID)
        self.assert_seekable(self.anonymous, url, original, disposition="inline")
        with self.app.app_context():
            note_store.replace_resource_grants("note", NOTE_ID, OWNER_ID, public=False,
                granted_by_user_id=OWNER_ID)
        self.assertEqual(self.peer.get(url, headers=headers).status_code, 404)
        self.assertEqual(self.anonymous.get(url, headers=headers).status_code, 401)

    def test_chat_gif_pdf_and_gzip_are_private_seekable_and_scope_bound(self):
        fixtures = self.fixtures["attachments"]
        originals = (None, gif_bytes(), self.pdf_payload, b"SQLite restores this compressed chat document.\n" * 200)
        for attachment, original in zip(fixtures, originals):
            url = attachment["download_url"]
            response = self.peer.get(url)
            self.assertEqual(response.status_code, 200)
            if original is not None:
                self.assertEqual(response.data, original)
            self.assert_seekable(self.peer, url, response.data)
            self.assertIn("sandbox", response.headers["Content-Security-Policy"])
            self.assertIn("Cookie", response.headers["Vary"])
            headers = {"If-None-Match": response.headers["ETag"]}
            self.assertEqual(self.anonymous.get(url, headers=headers).status_code, 401)
            self.assertEqual(self.outsider.get(url, headers=headers).status_code, 404)
            if attachment["preview_url"]:
                preview = self.peer.get(attachment["preview_url"])
                self.assertEqual(preview.status_code, 200)
                self.assertTrue(preview.mimetype.startswith("image/"))
                self.assert_seekable(self.peer, attachment["preview_url"], preview.data, disposition="inline")
        with Image.open(io.BytesIO(self.owner.get(fixtures[1]["download_url"]).data)) as image:
            self.assertEqual(image.n_frames, 2)
        self.assertEqual(self.row("chat_attachments", fixtures[3]["id"])["compression_encoding"], "gzip")
        pending = upload_chat_attachment(self.owner, gzip.compress(b"pending text\n" * 20), "pending.txt",
                                        content_encoding="gzip", original_size_bytes="260")
        self.assertEqual(self.owner.get(pending["download_url"]).status_code, 200)
        self.assertEqual(self.peer.get(pending["download_url"]).status_code, 404)
        self.assertEqual(self.owner.delete(f"/api/chat/attachments/{pending['id']}").status_code, 200)
        self.assertEqual(self.owner.get(pending["download_url"]).status_code, 404)
        direct = upload_chat_attachment(self.owner, b"Private direct message text\n", "direct.txt",
                                        scope_type="thread", scope_id=THREAD_ID)
        self.assertEqual(self.peer.get(direct["download_url"]).status_code, 404)
        require_response(self.owner.post(f"/api/chat/dm/threads/{THREAD_ID}/messages", json={
            "content": "Synthetic direct message attachment", "attachment_ids": [direct["id"]],
        }), 201)
        self.assert_seekable(self.peer, direct["download_url"], b"Private direct message text\n")
        self.assertEqual(self.outsider.get(direct["download_url"]).status_code, 404)

    def test_cross_feature_quota_rechecks_stored_tier_inside_writer(self):
        from services import entitlements, storage_objects

        with self.app.app_context():
            usage = entitlements.entitlements_for_user(OWNER_ID)["usage"]["storage_bytes"]
            definitions = copy.deepcopy(entitlements.DEFAULT_TIER_DEFINITIONS)
            definitions["free"]["storage_bytes"] = usage + 4
            entitlements.save_tier_definitions(definitions)

        def downgrade_after_preparation(_data):
            self.update("users", OWNER_ID, {"tier": "free"})

        before = self.counts()
        with patch.object(storage_objects, "scan_upload", side_effect=downgrade_after_preparation):
            response = self.owner.post(f"/api/notes/{NOTE_ID}/media", data={
                "file": (io.BytesIO(png_bytes()), "over-quota.png", "image/png"),
            })
        self.assertEqual(response.status_code, 403, response.get_json())
        self.assertEqual(response.json["code"], "tier_limit")
        self.assertEqual(response.json["current"], usage)
        self.assertEqual(self.counts(), before)
        payload = require_response(self.owner.post("/api/files/upload", data={
            "file": (io.BytesIO(b"four"), "four.txt", "text/plain"), "visibility": "private",
        }), 201)
        response = self.owner.post("/api/chat/attachments", data={
            "file": (io.BytesIO(b"five!"), "five.txt", "text/plain"),
            "scope_type": "channel", "scope_id": CHANNEL_ID,
        })
        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.json["code"], "tier_limit")
        self.assertEqual(response.json["current"], usage + 4)
        self.assertEqual(len(payload["files"]), 1)

    def test_account_tombstone_blocks_every_feature_and_provider_login(self):
        from blueprints import auth
        from services import avatar_storage, database
        from services.storage_errors import StorageUnavailable

        with database.db_connection(self.app.config["DATABASE_PATH"]) as conn:
            conn.execute("INSERT INTO storage_account_deletions (user_id, deleted_at) VALUES (?, ?)",
                         (OWNER_ID, "2026-10-01T00:00:00Z"))
        before = self.counts()
        responses = (
            self.owner.post("/settings/api/avatar-upload", data={"avatar": (io.BytesIO(png_bytes()), "avatar.png", "image/png")}),
            self.owner.post(f"/api/notes/{NOTE_ID}/media", data={"file": (io.BytesIO(png_bytes()), "image.png", "image/png")}),
            self.owner.post("/api/files/upload", data={"file": (io.BytesIO(b"text"), "text.txt", "text/plain")}),
            self.owner.post("/api/chat/attachments", data={"file": (io.BytesIO(b"text"), "text.txt", "text/plain"),
                "scope_type": "channel", "scope_id": CHANNEL_ID}),
        )
        for response in responses:
            self.assertEqual(response.status_code, 503, response.get_json())
            payload = response.get_json()
            self.assertEqual(payload.get("code") or payload["errors"][0]["code"], "storage_unavailable")
        with self.app.test_request_context("/auth/session", method="POST"), \
                patch.object(auth, "_provider_access_token_from_identities", return_value={}), \
                patch.object(auth, "_fetch_provider_profile", return_value={}), \
                patch.object(avatar_storage, "_download_provider_avatar"):
            with self.assertRaises(StorageUnavailable):
                auth._complete_appwrite_login({"$id": OWNER_ID, "email": f"{OWNER_ID}@example.test"}, provider="google")
        self.assertEqual(self.counts(), before)

    def test_storage_error_handlers_protect_note_media_and_app_routes(self):
        from app import create_app
        from services import note_media
        from services.storage_errors import StorageIntegrityError, StorageUnavailable

        with patch.object(note_media, "media_bytes", side_effect=StorageIntegrityError("Synthetic integrity failure.")):
            response = self.owner.get(self.fixtures["note_media"]["url"])
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json["code"], "storage_integrity")
        self.assertEqual(self.owner.get(AUTH_ROUTE + "?next=https://example.test").status_code, 400)
        self.assertEqual(self.owner.get(AUTH_ROUTE + "?user=production-account").status_code, 400)
        with self.assertRaisesRegex(RuntimeError, "explicitly testing"):
            _register_routes(Flask("non-testing"))
        ordinary_app = create_app()
        self.assertFalse(ordinary_app.testing)
        self.assertFalse(any(rule.rule.startswith("/__test__/storage") for rule in ordinary_app.url_map.iter_rules()))

        @ordinary_app.get("/api/storage-fault-fixture")
        def storage_fault_fixture():
            raise StorageUnavailable("Synthetic storage outage.")

        response = ordinary_app.test_client().get("/api/storage-fault-fixture")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["code"], "storage_unavailable")


if __name__ == "__main__":
    unittest.main()
