"""Provider fallback and login completion through the service interfaces."""

import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

from flask import Flask, session

from services import auth_session, oauth_providers, user_profile


class AuthServiceContractTests(unittest.TestCase):
    def test_discord_link_uses_linked_token_and_prefers_session_uid(self):
        fetch = Mock(return_value={"id": "profile-id", "username": "linked-name"})
        linked = Mock(return_value={"id": "linked-id", "access_token": "linked-token"})
        identity = oauth_providers.resolve_discord_link_identity(
            provider_uid="session-id", appwrite_user_ids=["remote-user"],
            fetch_profile=fetch, appwrite_identity=linked,
        )
        fetch.assert_called_once_with("discord", "linked-token")
        # No initial provider token means the only fetch uses the linked token.
        self.assertEqual(identity["id"], "session-id")
        self.assertEqual(identity["username"], "linked-name")
        self.assertTrue(identity["has_appwrite_identity"])

    def test_discord_link_retries_failed_profile_with_linked_identity(self):
        fetch = Mock(side_effect=[{}, {"id": "profile-id", "username": "linked-name"}])
        identity = oauth_providers.resolve_discord_link_identity(
            provider_access_token="session-token", appwrite_user_ids=["remote-user"],
            fetch_profile=fetch,
            appwrite_identity=lambda *_ids: {"id": "linked-id", "access_token": "linked-token"},
        )
        self.assertEqual(fetch.call_count, 2)
        fetch.assert_called_with("discord", "session-token")
        self.assertEqual(identity["id"], "profile-id")
        self.assertEqual(identity["username"], "linked-name")

    def test_discord_avatar_hash_is_resolved_before_remote_profile_urls(self):
        remote = {"id": "discord-user", "avatar": "a_hash", "picture_url": "https://old.example/avatar"}
        self.assertEqual(
            oauth_providers.provider_avatar_url({"avatar_url": "https://profile.example/avatar"}, remote, "discord"),
            "https://cdn.discordapp.com/avatars/discord-user/a_hash.gif?size=256",
        )
        self.assertEqual(remote["avatar"], "a_hash")

    def test_profile_owner_retains_public_fields_and_avatar_refresh_policy(self):
        profile = user_profile.public_profile_payload({"$id": "user-1", "name": "Chosen Name", "username": "chosen", "banner_color": "ABCDEF", "created_at": "2026-08-19T10:00:00Z"})
        self.assertEqual(profile["handle"], "@chosen")
        self.assertEqual(profile["banner_color"], "#abcdef")
        self.assertTrue(profile["is_early_member"])
        self.assertFalse(user_profile.avatar_can_use_provider({"avatar_source": "upload", "picture_url": "https://nest.example/avatar"}))

    def test_login_uses_injected_clock_and_committed_profile_before_session(self):
        app = Flask(__name__)
        app.secret_key = "fixture"
        fixed = datetime(2026, 10, 3, 12, 34, 56)
        existing = {"$id": "local-user", "name": "Chosen Name", "email": "old@example.test"}
        effects = []

        def persist(user_id, data, **_kwargs):
            effects.append("persist")
            self.assertNotIn("name", data)
            self.assertEqual(data["last_login"], "2026-10-03T12:34:56Z")
            return {**existing, **data}

        profiles = auth_session.LoginProfiles(
            get_row=lambda *_args, **_kwargs: existing,
            find_by_email=Mock(), prepare_avatar=Mock(), persist=persist,
            can_refresh_avatar=lambda _row: False,
        )
        providers = auth_session.LoginProviders(
            identity_token=Mock(return_value={"provider": "github", "provider_access_token": "linked-token"}),
            fetch_profile=Mock(return_value={"name": "Provider Name"}),
            avatar_url=Mock(return_value=None), log_avatar=Mock(), discord_identity=Mock(),
        )
        completion = auth_session.LoginCompletion(
            login=lambda *_args, **_kwargs: effects.append("login") or True,
            set_oauth=Mock(), sync_presence=Mock(), emit_event=Mock(),
            redirect=lambda _row: "/dashboard", session_duration=timedelta(days=14),
            invite_cookie="nest_invite",
        )
        with app.test_request_context("/auth/session"), patch.object(auth_session.notes_collaboration, "claim_pending_invitations"):
            result = auth_session._complete_appwrite_login(
                {"$id": "remote-user", "email": "fresh@example.test"},
                profiles=profiles, providers=providers, completion=completion,
                now_fn=lambda: fixed,
            )
            self.assertEqual(session["user_id"], "local-user")
            self.assertEqual(result["user_doc"]["name"], "Chosen Name")
        providers.fetch_profile.assert_called_once_with("github", "linked-token")
        self.assertEqual(effects, ["persist", "login"])


if __name__ == "__main__":
    unittest.main()
