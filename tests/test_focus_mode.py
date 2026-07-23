import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from flask import Flask

from services import focus_mode, notifications
from services.database import db_connection, init_db
from services.entitlements import EntitlementLimitError


def _unlimited_entitlements(*_args, **_kwargs):
    return {
        "limits": {"max_focus_playlists": None},
        "usage": {"focus_playlists": 0},
    }


def _limited_entitlements(limit, usage):
    return {
        "limits": {"max_focus_playlists": limit},
        "usage": {"focus_playlists": usage},
    }


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
        self.entitlements_patch = patch.object(
            focus_mode,
            "entitlements_for_user",
            side_effect=_unlimited_entitlements,
        )
        self.entitlements_patch.start()

    def tearDown(self):
        self.entitlements_patch.stop()
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
        with self.assertRaisesRegex(ValueError, "Spotify, YouTube"):
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
        with self.assertRaisesRegex(ValueError, "Spotify, YouTube"):
            focus_mode.update_session(
                "u1", session["id"], "set_playlist", {"spotify_url": "https://example.com/list"}
            )

    def test_youtube_and_youtube_music_playlists_normalize_and_embed_privately(self):
        youtube = "https://www.youtube.com/playlist?list=PL1234567890abc&feature=share"
        youtube_music = "https://music.youtube.com/playlist?list=PLabcdefghijk"
        self.assertEqual(
            focus_mode.normalize_playlist_url(youtube),
            "https://www.youtube.com/playlist?list=PL1234567890abc",
        )
        self.assertEqual(focus_mode.playlist_provider(youtube), "youtube")
        self.assertEqual(focus_mode.playlist_provider(youtube_music), "youtube_music")
        self.assertIn("youtube-nocookie.com/embed/videoseries", focus_mode.playlist_embed_url(youtube))

        routine = focus_mode.save_routine("u1", {
            "name": "Video study",
            "focus_minutes": 25,
            "cycles": 1,
            "spotify_url": youtube_music,
        })
        focus_mode.add_user_playlist("u1", youtube_music, entitlements=_unlimited_entitlements())
        focus_mode.add_user_playlist("u1", youtube, entitlements=_unlimited_entitlements())
        routine = focus_mode.list_routines("u1")[0]
        self.assertEqual(routine["playlist_provider"], "youtube_music")
        self.assertEqual([item["provider"] for item in routine["playlists"]], ["youtube_music", "youtube"])

    def test_multiple_playlists_persist_and_active_selection_switches(self):
        first = "https://open.spotify.com/playlist/abc123"
        second = "https://open.spotify.com/playlist/xyz789"
        focus_mode.add_user_playlist("u1", first, entitlements=_unlimited_entitlements())
        focus_mode.add_user_playlist("u1", second, entitlements=_unlimited_entitlements())
        focus_mode.set_active_playlist("u1", first)
        routine = focus_mode.save_routine("u1", {
            "name": "Playlist set",
            "focus_minutes": 25,
            "break_minutes": 0,
            "long_break_minutes": 0,
            "cycles": 1,
            "spotify_url": first,
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
        restored = focus_mode.update_session(
            "u1",
            session["id"],
            "restore_playlist",
            {"spotify_url": second, "active_spotify_url": second},
        )
        self.assertEqual(restored["spotify_url"], second)
        self.assertEqual(len(restored["playlists"]), 2)

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
            "panel_width": 0,
            "panel_height": 0,
        })
        self.assertEqual(focus_mode.snapshot("u1")["player_preferences"], saved)
        resized = focus_mode.save_player_preferences("u1", {
            "panel_width": 920,
            "panel_height": 680,
        })
        self.assertEqual(resized["panel_width"], 920)
        self.assertEqual(resized["panel_height"], 680)
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

    def test_user_playlist_crud_persists_in_snapshot(self):
        first = "https://open.spotify.com/playlist/abc123"
        second = "https://open.spotify.com/playlist/xyz789"
        playlists = focus_mode.add_user_playlist("u1", first, entitlements=_unlimited_entitlements())
        self.assertEqual(len(playlists), 1)
        self.assertTrue(playlists[0]["active"])

        focus_mode.add_user_playlist("u1", second, entitlements=_unlimited_entitlements())
        focus_mode.set_active_playlist("u1", second)
        source = focus_mode.user_playlist_source("u1")
        self.assertEqual(source["spotify_url"], second)
        self.assertEqual(len(source["playlists"]), 2)
        self.assertTrue(next(item for item in source["playlists"] if item["spotify_url"] == second)["active"])

        focus_mode.remove_user_playlist("u1", second)
        remaining = focus_mode.list_user_playlists("u1")
        self.assertEqual([item["spotify_url"] for item in remaining], [first])
        self.assertTrue(remaining[0]["active"])

        state = focus_mode.snapshot("u1", entitlements=_unlimited_entitlements())
        self.assertEqual(state["active_playlist_url"], first)
        self.assertEqual(len(state["playlists"]), 1)
        self.assertEqual(state["playlist_entitlements"], {"limit": None, "usage": 1})

    def test_user_playlist_tier_limit_enforced_on_add(self):
        first = "https://open.spotify.com/playlist/abc123"
        second = "https://open.spotify.com/playlist/xyz789"
        third = "https://open.spotify.com/playlist/def456"
        limited = _limited_entitlements(2, 0)
        focus_mode.add_user_playlist("u1", first, entitlements=limited)
        focus_mode.add_user_playlist("u1", second, entitlements=_limited_entitlements(2, 1))
        with self.assertRaises(EntitlementLimitError) as context:
            focus_mode.add_user_playlist("u1", third, entitlements=_limited_entitlements(2, 2))
        self.assertEqual(context.exception.resource, "focus_playlists")
        self.assertEqual(len(focus_mode.list_user_playlists("u1")), 2)

    def test_session_playlist_actions_sync_user_library(self):
        first = "https://open.spotify.com/playlist/abc123"
        second = "https://open.spotify.com/playlist/xyz789"
        session = focus_mode.start_session("u1", {
            "name": "Study",
            "focus_minutes": 25,
            "break_minutes": 0,
            "long_break_minutes": 0,
            "cycles": 1,
        })
        updated = focus_mode.update_session(
            "u1",
            session["id"],
            "set_playlist",
            {"spotify_url": first},
            entitlements=_unlimited_entitlements(),
        )
        self.assertEqual(updated["spotify_url"], first)
        self.assertEqual(len(focus_mode.list_user_playlists("u1")), 1)

        switched = focus_mode.update_session(
            "u1",
            session["id"],
            "set_playlist",
            {"spotify_url": second},
            entitlements=_unlimited_entitlements(),
        )
        self.assertEqual(switched["spotify_url"], second)
        self.assertEqual(len(focus_mode.list_user_playlists("u1")), 2)

        removed = focus_mode.update_session(
            "u1",
            session["id"],
            "remove_playlist",
            {"spotify_url": second},
            entitlements=_unlimited_entitlements(),
        )
        self.assertEqual(removed["spotify_url"], first)
        self.assertEqual(len(focus_mode.list_user_playlists("u1")), 1)

        restored = focus_mode.update_session(
            "u1",
            session["id"],
            "restore_playlist",
            {"spotify_url": second, "active_spotify_url": second},
            entitlements=_unlimited_entitlements(),
        )
        self.assertEqual(restored["spotify_url"], second)
        self.assertEqual(len(focus_mode.list_user_playlists("u1")), 2)
        self.assertEqual(focus_mode.snapshot("u1", entitlements=_unlimited_entitlements())["active_playlist_url"], second)


if __name__ == "__main__":
    unittest.main()
