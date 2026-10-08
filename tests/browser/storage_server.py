"""Disposable loopback fixture for real SQLite-backed upload pages.

Run ``.venv/bin/python tests/browser/storage_server.py`` and open
``http://127.0.0.1:8038/__test__/storage/auth?next=/__test__/storage/overview``.
All rows and key material live in a temporary directory. Only Appwrite Storage
is made unavailable; Appwrite authentication clients retain their real APIs.
"""

from __future__ import annotations

import base64
import gzip
import io
import json
import os
import sys
import tempfile
from contextlib import ExitStack, contextmanager
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from flask import abort, jsonify, redirect, render_template_string, request
from flask_login import login_user, logout_user
from PIL import Image, ImageDraw


REPO_ROOT = str(Path(__file__).resolve().parents[2])
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

OWNER_ID = "storage-owner"
PEER_ID = "storage-peer"
OUTSIDER_ID = "storage-outsider"
NOTE_ID = "storage-browser-note"
CHANNEL_ID = "uni_emory-university"
THREAD_ID = "storage-browser-thread"
AUTH_ROUTE = "/__test__/storage/auth"
OVERVIEW_ROUTE = "/__test__/storage/overview"
TEST_SECRET = "nest-storage-disposable-test-secret"
ALLOWED_NEXT = {
    OVERVIEW_ROUTE, "/dashboard", "/settings", "/settings/", "/files", "/notes",
    f"/notes/{NOTE_ID}", "/chat", f"/chat?channel={CHANNEL_ID}",
}


def png_bytes(*, color="#286b78", size=(320, 200), image_format="PNG"):
    image = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(image)
    draw.ellipse((24, 24, size[0] - 24, size[1] - 24), fill="#f2d58c")
    draw.rectangle((size[0] // 3, size[1] // 3, size[0] * 2 // 3, size[1] * 2 // 3), fill="#31524a")
    output = io.BytesIO()
    image.save(output, format=image_format)
    return output.getvalue()


def gif_bytes():
    frames = [Image.open(io.BytesIO(png_bytes(color=color))) for color in ("#286b78", "#96506b")]
    output = io.BytesIO()
    frames[0].save(output, format="GIF", save_all=True, append_images=frames[1:], duration=200, loop=0)
    return output.getvalue()


def pdf_bytes():
    image = Image.open(io.BytesIO(png_bytes(size=(480, 320))))
    output = io.BytesIO()
    image.save(output, format="PDF", resolution=72.0, title="Synthetic storage preview")
    return output.getvalue()


def authenticated_client(app, user_id=OWNER_ID):
    client = app.test_client()
    with client.session_transaction() as session:
        session["_user_id"] = user_id
        session["_fresh"] = True
    # The full app explicitly protects authenticated mutations. Use its real
    # signed cookie token, as the browser does, instead of disabling CSRF.
    require_response(client.get(OVERVIEW_ROUTE), 200)
    client.environ_base["HTTP_X_CSRFTOKEN"] = client.get_cookie("csrf_token").value
    return client


def require_response(response, status):
    if response.status_code != status:
        raise AssertionError(f"Expected HTTP {status}; received {response.status_code}: {response.get_data(as_text=True)[:600]}")
    return response.get_json()


def upload_shared_file(client, data=b"Synthetic shared file\n", *, filename="storage-fixture.txt", visibility="public", mime_type="text/plain", **form):
    payload = require_response(client.post("/api/files/upload", data={
        "file": (io.BytesIO(data), filename, mime_type), "filename": filename,
        "visibility": visibility, "expiryDays": "7", **form,
    }), 201)
    return payload["files"][0]


def upload_note_image(client, *, data=None, note_id=NOTE_ID):
    return require_response(client.post(f"/api/notes/{note_id}/media", data={
        "file": (io.BytesIO(data if data is not None else png_bytes()), "note-image.png", "image/png"),
    }), 201)


def upload_chat_attachment(client, data, filename, *, mime_type="application/octet-stream", **form):
    return require_response(client.post("/api/chat/attachments", data={
        "file": (io.BytesIO(data), filename, mime_type),
        "scope_type": "channel", "scope_id": CHANNEL_ID, **form,
    }), 201)["attachment"]


def _seed_rows():
    from services import database
    from services.time_utils import utcnow_iso

    now = utcnow_iso()
    for user_id in (OWNER_ID, PEER_ID, OUTSIDER_ID):
        database.create_row("users", user_id, {
            "google_id": user_id, "email": f"{user_id}@example.test", "name": user_id.replace("-", " ").title(),
            "username": user_id, "tier": "grade_aa", "onboarding_complete": True,
            "onboarding_step": 5, "created_at": now, "provider": "test",
            "school": "Other School" if user_id == OUTSIDER_ID else "Emory University",
            "school_key": "other-school" if user_id == OUTSIDER_ID else "emory-university",
        })
        database.create_row("user_settings", user_id, {
            "user_id": user_id, "interface_theme": "obsidian-dark", "theme": "dark",
            "sidebar_default": "expanded", "created_at": now, "updated_at": now,
        })
    database.create_row("notes", NOTE_ID, {
        "user_id": OWNER_ID, "title": "SQLite image fixture", "content": "[]",
        "preview_text": "Synthetic image served through note permissions", "order": 1000,
        "created_at": now, "updated_at": now,
    })
    database.create_row("chat_channels", CHANNEL_ID, {
        "kind": "university", "name": "emory-university", "label": "Emory University",
        "section": "university", "school_key": "emory-university", "school_name": "Emory University",
        "approved": True, "read_only": False, "created_at": now, "updated_at": now,
    })
    database.create_row("chat_dm_threads", THREAD_ID, {
        "participant_a": OWNER_ID, "participant_b": PEER_ID,
        "participant_key": f"{OWNER_ID}:{PEER_ID}", "created_at": now, "updated_at": now,
    })


def _seed_uploads(app):
    client = authenticated_client(app)
    avatar = require_response(client.post("/settings/api/avatar-upload", data={
        "avatar": (io.BytesIO(png_bytes(size=(160, 160))), "avatar.png", "image/png"),
    }), 200)
    shared = upload_shared_file(client)
    # Seed requests use Flask's in-process default localhost host. Browser
    # fixtures stay relative so they retain the live loopback server's port.
    shared["shareUrl"] = urlsplit(shared["shareUrl"]).path
    private = upload_shared_file(client, visibility="private", filename="private-storage-fixture.txt")
    media = upload_note_image(client)
    document = [{"id": "storage-image-paragraph", "type": "paragraph", "content": [
        {"type": "text", "text": "This private image is stored in encrypted SQLite. ", "styles": {}},
        {"type": "inlineImage", "props": {"url": media["url"], "mediaId": media["id"],
            "clientId": "storage-browser-image", "alt": "Synthetic SQLite image", "width": 320,
            "layout": "break", "alignment": "left", "status": "ready", "error": ""}},
    ]}]
    require_response(client.patch(f"/api/notes/{NOTE_ID}", json={"content": json.dumps(document)}), 200)
    attachments = [
        upload_chat_attachment(client, png_bytes(), "chat-image.png"),
        upload_chat_attachment(client, gif_bytes(), "chat-animation.gif"),
        upload_chat_attachment(client, pdf_bytes(), "chat-document.pdf"),
        upload_chat_attachment(client, gzip.compress(b"SQLite restores this compressed chat document.\n" * 200), "chat-text.txt",
                               content_encoding="gzip", original_size_bytes=str(len(b"SQLite restores this compressed chat document.\n" * 200))),
    ]
    message = require_response(client.post(f"/api/chat/channels/{CHANNEL_ID}/messages", json={
        "content": "SQLite image, animated GIF, PDF preview, and compressed text fixtures.",
        "attachment_ids": [item["id"] for item in attachments],
    }), 201)["message"]
    return {"avatar": avatar, "shared_file": shared, "private_file": private, "note_media": media,
            "note_url": f"/notes/{NOTE_ID}", "chat_url": f"/chat?channel={CHANNEL_ID}",
            "attachments": attachments, "message_id": message["id"]}


def _register_routes(app):
    if not app.testing:
        raise RuntimeError("Storage fixture routes require an explicitly testing app.")

    @app.get(AUTH_ROUTE)
    def storage_auth():
        from models import user_from_doc
        from services import database

        user_id = request.args.get("user", OWNER_ID)
        next_url = request.args.get("next", OVERVIEW_ROUTE)
        if user_id not in {OWNER_ID, PEER_ID, OUTSIDER_ID} or next_url not in ALLOWED_NEXT:
            abort(400)
        login_user(user_from_doc(database.get_row("users", user_id)), remember=False)
        return redirect(next_url)

    @app.get("/__test__/storage/logout")
    def storage_logout():
        logout_user()
        return redirect(OVERVIEW_ROUTE)

    @app.get("/__test__/storage/fixtures")
    def storage_fixtures():
        return jsonify(app.extensions["storage_test_fixture"]["fixtures"])

    @app.get(OVERVIEW_ROUTE)
    def storage_overview():
        fixtures = app.extensions["storage_test_fixture"]["fixtures"]
        return render_template_string("""<!doctype html><html><head><meta charset="utf-8"><title>SQLite storage fixtures</title>
        <style>body{font:16px system-ui;background:#f4f3ec;color:#18372e;margin:40px;max-width:1000px}a{color:#286b78}img{max-width:320px;max-height:220px}section{margin:24px 0;padding:20px;background:white;border-radius:12px}nav{display:flex;gap:24px}figure{display:inline-grid;gap:8px;margin:12px}</style></head><body>
        <h1>SQLite storage fixtures</h1><p>Disposable synthetic uploads, encrypted local storage, mocked clean scanner, unavailable Appwrite Storage.</p>
        <nav><a href="/settings/">Avatar settings</a><a href="/files">Shared files</a><a href="{{ f.note_url }}">Note editor</a><a href="{{ f.chat_url }}">Chat previews</a></nav>
        {% if f %}<section><h2>Public avatar</h2><img src="{{ f.avatar.picture_url }}" alt="Synthetic public avatar"></section>
        <section><h2>Shared link</h2><a href="{{ f.shared_file.shareUrl }}">Open the existing public share page</a></section>
        <section><h2>Private note image</h2><img src="{{ f.note_media.url }}" alt="Synthetic private note image"></section>
        <section><h2>Private chat previews</h2>{% for a in f.attachments %}<figure>{% if a.preview_url %}<img src="{{ a.preview_url }}" alt="{{ a.filename }} preview">{% endif %}<figcaption><a href="{{ a.download_url }}">{{ a.filename }}</a></figcaption></figure>{% endfor %}</section>{% endif %}
        <p><a href="{{ auth }}">Authenticate as fixture owner</a> · <a href="/__test__/storage/logout">Log out to verify private media denial</a></p></body></html>""",
            f=fixtures, auth=AUTH_ROUTE)


@contextmanager
def storage_test_app(*, seed_uploads=False, port=8038):
    """Own disposable state and test patches for the application's full lifetime."""
    from appwrite.services.storage import Storage

    with ExitStack() as stack:
        temp_dir = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="nest-storage-integration-")))
        (temp_dir / "keys").mkdir(mode=0o700)
        (temp_dir / "database").mkdir(mode=0o700)
        keyring_path = temp_dir / "keys" / "upload-keyring.json"
        descriptor = os.open(keyring_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump({"active_key_id": "test-key", "keys": {"test-key": base64.b64encode(b"\x11" * 32).decode("ascii")}}, handle)
        environment = {
            **{name: os.environ[name] for name in ("HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL") if name in os.environ},
            "DATABASE_PATH": str(temp_dir / "database" / "nest.sqlite3"), "NEST_INSTANCE_DIR": str(temp_dir),
            "FLASK_SECRET_KEY": TEST_SECRET, "FLASK_ENV": "testing", "APSTUDY_ALLOW_INSECURE_HTTP": "1",
            "SCHEDULER_ENABLED": "0", "DISCORD_AUDIT_ENABLED": "0", "DISCORD_CONSOLE_LOG_ENABLED": "0",
            "DISCORD_SERVER_CONSOLE_LOG_ENABLED": "0", "DISCORD_GATEWAY_ENABLED": "0", "DISCORD_CHAT_SYNC_ENABLED": "0",
            "DISCORD_BOT_TOKEN": "", "DISCORD_CHAT_CHANNEL_ID": "", "DISCORD_ANNOUNCEMENTS_CHANNEL_ID": "",
            "NEST_STORAGE_BACKEND": "sqlite", "NEST_STORAGE_READ_LEGACY": "0", "NEST_STORAGE_MUTATIONS_PAUSED": "0",
            "NEST_CHAT_ATTACHMENTS_ENABLED": "true", "NEST_UPLOAD_KEYRING_PATH": str(keyring_path),
            "APP_BASE_URL": f"http://127.0.0.1:{port}", "CALENDAR_ICS_SUBSCRIPTIONS_ENABLED": "0",
            "APPWRITE_ENDPOINT": "https://appwrite.synthetic.invalid/v1", "APPWRITE_PROJECT_ID": "synthetic-storage",
            "APPWRITE_API_KEY": "", "APPWRITE_DATABASE_ID": "synthetic-storage",
            "CALENDAR_ICS_SUBSCRIPTIONS_OWNER_ALLOWLIST": "", "CALENDAR_ICS_UID_SECRET": "",
        }
        # Snapshot synthetic settings before any application modules import.
        # Patch only Storage operations; OAuth Account/Users APIs retain their
        # actual SDK implementations and can be mocked independently by tests.
        stack.enter_context(patch.dict(os.environ, environment, clear=True))
        stack.enter_context(patch("dotenv.load_dotenv", return_value=False))
        storage_methods = [name for name, value in vars(Storage).items() if not name.startswith("_") and callable(value)]
        storage_mocks = {name: stack.enter_context(patch.object(Storage, name, side_effect=AssertionError("Appwrite Storage transport is unavailable in SQLite mode"))) for name in storage_methods}
        stack.enter_context(patch("services.storage_objects.scan_upload"))
        stack.enter_context(patch("services.chat_attachments.scan_upload"))
        stack.enter_context(patch("services.discord_audit.init_discord_audit"))
        stack.enter_context(patch("services.discord_audit.emit_audit_event", return_value=False))
        stack.enter_context(patch("services.scheduler.init_scheduler"))
        from app import create_app
        from extensions import login_manager
        from models import load_user

        for name in ("_user_callback", "unauthorized_callback", "login_view"):
            stack.enter_context(patch.object(login_manager, name, getattr(login_manager, name)))
        app = create_app()
        login_manager._user_callback = load_user
        app.config.update(TESTING=True, SESSION_COOKIE_SECURE=False,
                          REMEMBER_COOKIE_SECURE=False, FILE_SHARE_UPLOAD_DIR=str(temp_dir / "legacy-files"))
        app.extensions["storage_test_fixture"] = {"temporary_directory": str(temp_dir), "storage_mocks": storage_mocks, "fixtures": {}}
        with app.app_context():
            _seed_rows()
        _register_routes(app)
        if seed_uploads:
            app.extensions["storage_test_fixture"]["fixtures"] = _seed_uploads(app)
        yield app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8038"))
    with storage_test_app(seed_uploads=True, port=port) as app:
        print(f"Storage fixtures: http://127.0.0.1:{port}{AUTH_ROUTE}?next={OVERVIEW_ROUTE}", flush=True)
        app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
