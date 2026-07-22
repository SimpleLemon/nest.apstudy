import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from services import focus_mode, notifications
from services.database import db_connection, init_db


class FocusModeTests(unittest.TestCase):
    def setUp(self):
        self.path = tempfile.mktemp(suffix=".sqlite3")
        self.app = Flask(__name__)
        self.app.config["DATABASE_PATH"] = self.path
        init_db(self.app, self.path)
        self.context = self.app.app_context()
        self.context.push()
        self.metadata_patch = patch.object(
            focus_mode,
            "_playlist_metadata",
            side_effect=lambda url: {
                "title": "Deep Focus" if url.endswith("abc123") else "Reading Flow",
                "creator": "Nest listener" if url.endswith("abc123") else "Study Club",
                "thumbnail_url": f"https://i.scdn.co/image/{url.rsplit('/', 1)[-1]}",
            },
        )
        self.metadata_patch.start()

    def tearDown(self):
        self.metadata_patch.stop()
        self.context.pop()
        Path(self.path).unlink(missing_ok=True)

    def test_routine_session_pause_resume_and_phase_history(self):
        routine = focus_mode.save_routine("u1", {
            "name": "Reading",
            "focus_minutes": 25,
            "break_minutes": 5,
            "long_break_minutes": 15,
            "cycles": 4,
            "spotify_url": "https://open.spotify.com/playlist/abc123?si=test",
        })
        self.assertEqual(routine["spotify_url"], "https://open.spotify.com/playlist/abc123")
        self.assertIn("/embed/playlist/abc123", routine["spotify_embed_url"])

        session = focus_mode.start_session("u1", {
            "routine_id": routine["id"],
            "name": "Reading",
            "focus_minutes": 25,
            "break_minutes": 5,
            "long_break_minutes": 15,
            "cycles": 4,
            "spotify_url": routine["spotify_url"],
            "auto_start_next": False,
        })
        self.assertEqual(session["state"], "running")
        self.assertEqual(session["cycle_number"], 1)
        self.assertTrue(focus_mode.is_focus_mode_active("u1"))

        paused = focus_mode.update_session("u1", session["id"], "pause")
        self.assertEqual(paused["state"], "paused")
        self.assertGreater(paused["remaining_seconds"], 0)
        resumed = focus_mode.update_session("u1", session["id"], "resume")
        self.assertEqual(resumed["state"], "running")

        break_phase = focus_mode.update_session("u1", session["id"], "complete_phase")
        self.assertEqual(break_phase["phase"], "break")
        self.assertEqual(break_phase["state"], "paused")
        history = focus_mode.list_history("u1")
        self.assertEqual(history[0]["phase"], "focus")
        self.assertEqual(history[0]["duration_seconds"], 1500)

    def test_single_cycle_completion_releases_focus_status(self):
        session = focus_mode.start_session("u1", {
            "name": "Quick review",
            "focus_minutes": 10,
            "break_minutes": 0,
            "long_break_minutes": 0,
            "cycles": 1,
            "spotify_url": "",
            "auto_start_next": False,
        })
        completed = focus_mode.update_session("u1", session["id"], "complete_phase")
        self.assertEqual(completed["state"], "completed")
        self.assertFalse(focus_mode.is_focus_mode_active("u1"))
        self.assertIsNone(focus_mode.get_active_session("u1"))
        self.assertEqual(len(focus_mode.list_history("u1")), 1)

    def test_due_session_recovers_from_server_timestamps(self):
        session = focus_mode.start_session("u1", {
            "name": "Recovery",
            "focus_minutes": 10,
            "break_minutes": 0,
            "long_break_minutes": 0,
            "cycles": 1,
            "spotify_url": "",
        })
        expired = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat().replace("+00:00", "Z")
        with db_connection() as conn:
            conn.execute("UPDATE focus_sessions SET phase_ends_at=? WHERE id=?", [expired, session["id"]])
        self.assertIsNone(focus_mode.get_active_session("u1"))
        stored = focus_mode.get_session("u1", session["id"])
        self.assertEqual(stored["state"], "completed")

    def test_validation_rejects_invalid_spotify_and_breakless_cycles(self):
        with self.assertRaisesRegex(ValueError, "Spotify playlist"):
            focus_mode.normalize_spotify_url("https://example.com/playlist/abc")
        with self.assertRaisesRegex(ValueError, "Choose a break time"):
            focus_mode.start_session("u1", {
                "name": "Invalid",
                "focus_minutes": 25,
                "break_minutes": 0,
                "long_break_minutes": 0,
                "cycles": 2,
            })

    def test_active_session_playlist_updates_persist_and_validate(self):
        session = focus_mode.start_session("u1", {
            "name": "Study",
            "focus_minutes": 25,
            "break_minutes": 5,
            "long_break_minutes": 5,
            "cycles": 1,
        })
        updated = focus_mode.update_session(
            "u1",
            session["id"],
            "set_playlist",
            {"spotify_url": "https://open.spotify.com/playlist/abc123?si=demo"},
        )
        self.assertEqual(updated["spotify_url"], "https://open.spotify.com/playlist/abc123")
        self.assertIn("/embed/playlist/abc123", updated["spotify_embed_url"])
        self.assertEqual(
            focus_mode.snapshot("u1")["active_session"]["spotify_url"],
            "https://open.spotify.com/playlist/abc123",
        )

        removed = focus_mode.update_session(
            "u1", session["id"], "set_playlist", {"spotify_url": ""}
        )
        self.assertIsNone(removed["spotify_url"])
        with self.assertRaisesRegex(ValueError, "Spotify playlist"):
            focus_mode.update_session(
                "u1", session["id"], "set_playlist", {"spotify_url": "https://example.com/list"}
            )

    def test_multiple_playlists_persist_and_active_selection_switches(self):
        first = "https://open.spotify.com/playlist/abc123"
        second = "https://open.spotify.com/playlist/xyz789"
        routine = focus_mode.save_routine("u1", {
            "name": "Playlist set",
            "focus_minutes": 25,
            "break_minutes": 0,
            "long_break_minutes": 0,
            "cycles": 1,
            "spotify_url": first,
            "spotify_playlists": [first, second, first],
        })
        self.assertEqual([item["spotify_url"] for item in routine["playlists"]], [first, second])
        self.assertEqual(routine["playlists"][0]["title"], "Deep Focus")
        self.assertEqual(routine["playlists"][1]["creator"], "Study Club")

        session = focus_mode.start_session("u1", {
            "routine_id": routine["id"],
            "name": routine["name"],
            "focus_minutes": 25,
            "break_minutes": 0,
            "long_break_minutes": 0,
            "cycles": 1,
            "spotify_url": first,
        })
        self.assertEqual(len(session["playlists"]), 2)
        switched = focus_mode.update_session(
            "u1", session["id"], "set_playlist", {"spotify_url": second}
        )
        self.assertEqual(switched["spotify_url"], second)
        self.assertTrue(next(item for item in switched["playlists"] if item["spotify_url"] == second)["active"])

        removed = focus_mode.update_session(
            "u1", session["id"], "remove_playlist", {"spotify_url": second}
        )
        self.assertEqual(removed["spotify_url"], first)
        self.assertEqual(len(removed["playlists"]), 1)

    def test_player_preferences_are_account_synced_and_bounded(self):
        defaults = focus_mode.player_preferences("u1")
        self.assertEqual(defaults["layout"], "beside")
        saved = focus_mode.save_player_preferences("u1", {
            "layout": "floating",
            "floating_size": "expanded",
            "floating_x": 1.5,
            "floating_y": -0.25,
        })
        self.assertEqual(saved, {
            "layout": "floating",
            "floating_size": "expanded",
            "floating_x": 1.0,
            "floating_y": 0.0,
        })
        self.assertEqual(focus_mode.snapshot("u1")["player_preferences"], saved)
        with self.assertRaisesRegex(ValueError, "placement"):
            focus_mode.save_player_preferences("u1", {"layout": "diagonal"})

    def test_focus_suppresses_nonurgent_delivery_but_preserves_urgent_categories(self):
        notifications.upsert_subscription(
            "u1",
            {"endpoint": "https://push.example/focus", "keys": {"p256dh": "key", "auth": "auth"}},
            "Laptop",
        )
        focus_mode.start_session("u1", {
            "name": "Study",
            "focus_minutes": 25,
            "break_minutes": 5,
            "long_break_minutes": 5,
            "cycles": 1,
        })
        with patch.object(notifications, "_send", return_value=201) as send:
            muted = notifications.deliver("u1", "n1", "chat_dm", "Message", "Hello", "/chat")
            urgent = notifications.deliver("u1", "n2", "chat_mention", "Mention", "Needed", "/chat")
        self.assertEqual(muted, {"accepted": 0, "failed": 0})
        self.assertEqual(urgent, {"accepted": 1, "failed": 0})
        send.assert_called_once()


if __name__ == "__main__":
    unittest.main()
