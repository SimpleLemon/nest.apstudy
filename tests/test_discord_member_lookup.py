import unittest
from unittest.mock import Mock, patch

import requests

from services import discord_bridge
from services.discord_member_lookup import DiscordMemberLookup, RATE_LIMIT_MARGIN_SECONDS


def _response(status=200, *, headers=None, payload=None):
    response = Mock(status_code=status, text="Discord response")
    response.headers = requests.structures.CaseInsensitiveDict(headers or {})
    response.json.return_value = payload if payload is not None else {"roles": ["role"]}
    return response


class DiscordMemberLookupTests(unittest.TestCase):
    def setUp(self):
        self.now = 100.0
        self.sleeps = []
        self.client = DiscordMemberLookup(
            clock=lambda: self.now,
            sleep=self._sleep,
            wall_clock=lambda: 1000.0,
        )
        request_patch = patch("services.discord_member_lookup.requests.get")
        self.request = request_patch.start()
        self.addCleanup(request_patch.stop)

    def _sleep(self, delay):
        self.sleeps.append(delay)
        self.now += delay

    def _get(self, user="user-1", guild="guild-1"):
        return self.client.get(guild, user, headers={"Authorization": "Bot test-token"})

    def test_exhausted_quota_paces_the_next_user_in_same_guild(self):
        self.request.side_effect = [
            _response(headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.19"}),
            _response(),
        ]

        self._get()
        self.assertEqual(self.sleeps, [])
        self._get("user-2")

        self.assertAlmostEqual(self.sleeps[0], 0.19 + RATE_LIMIT_MARGIN_SECONDS)
        self.assertTrue(self.request.call_args_list[1].args[0].endswith("/members/user-2"))

    def test_available_quota_does_not_delay_requests(self):
        self.request.return_value = _response(
            headers={"X-RateLimit-Remaining": "1", "X-RateLimit-Reset-After": "10"}
        )
        self._get()
        self._get("user-2")
        self.assertEqual(self.sleeps, [])

    def test_local_cooldown_does_not_delay_another_guild(self):
        self.request.side_effect = [
            _response(headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "5"}),
            _response(),
        ]
        self._get()
        self._get(guild="guild-2")
        self.assertEqual(self.sleeps, [])

    def test_expired_cooldown_does_not_add_another_wait(self):
        self.request.return_value = _response(
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "0.1"}
        )
        self._get()
        self.now += 1
        self._get("user-2")
        self.assertEqual(self.sleeps, [])

    def test_absolute_reset_is_used_when_relative_reset_is_missing(self):
        self.request.return_value = _response(
            headers={"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1000.5"}
        )
        self._get()
        self._get("user-2")
        self.assertAlmostEqual(self.sleeps[0], 0.5 + RATE_LIMIT_MARGIN_SECONDS)

    def test_429_retries_same_member_using_retry_header(self):
        success = _response()
        self.request.side_effect = [
            _response(429, headers={"retry-after": "0.19"}, payload={}), success,
        ]

        self.assertIs(self._get(), success)
        self.assertAlmostEqual(self.sleeps[0], 0.19 + RATE_LIMIT_MARGIN_SECONDS)
        self.assertEqual(self.request.call_args_list[0], self.request.call_args_list[1])

    def test_429_uses_json_cooldown_when_header_is_missing(self):
        self.request.side_effect = [_response(429, payload={"retry_after": 0.1}), _response()]
        self._get()
        self.assertAlmostEqual(self.sleeps[0], 0.1 + RATE_LIMIT_MARGIN_SECONDS)

    def test_429_waits_for_longest_reported_cooldown(self):
        self.request.side_effect = [
            _response(429, headers={"Retry-After": "0.1", "X-RateLimit-Reset-After": "0.4"},
                      payload={"retry_after": 0.2}),
            _response(),
        ]
        self._get()
        self.assertAlmostEqual(self.sleeps[0], 0.4 + RATE_LIMIT_MARGIN_SECONDS)

    def test_retries_are_bounded_and_last_cooldown_applies_to_next_user(self):
        limited = _response(429, payload={"retry_after": 0.1})
        self.request.side_effect = [limited, limited, limited, _response()]

        self.assertIs(self._get(), limited)
        self.assertEqual(self.request.call_count, 3)
        self.assertEqual(len(self.sleeps), 2)
        self._get("user-2")
        self.assertEqual(len(self.sleeps), 3)
        self.assertAlmostEqual(self.sleeps[-1], 0.1 + RATE_LIMIT_MARGIN_SECONDS)

    def test_global_cooldown_applies_to_other_guild_after_retry_exhaustion(self):
        for headers, payload in [
            ({}, {"global": True, "retry_after": 0.2}),
            ({"X-RateLimit-Global": "true", "Retry-After": "0.2"}, {}),
            ({"X-RateLimit-Scope": "global", "Retry-After": "0.2"}, {}),
        ]:
            with self.subTest(headers=headers, payload=payload):
                self.client = DiscordMemberLookup(clock=lambda: self.now, sleep=self._sleep)
                self.sleeps.clear()
                limited = _response(429, headers=headers, payload=payload)
                self.request.side_effect = [limited, limited, limited, _response()]
                self._get()
                self._get(guild="guild-2")
                self.assertEqual(len(self.sleeps), 3)
                self.assertAlmostEqual(self.sleeps[-1], 0.2 + RATE_LIMIT_MARGIN_SECONDS)

    def test_malformed_or_missing_headers_do_not_break_successful_lookup(self):
        for headers in [{}, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "nan"},
                        {"X-RateLimit-Remaining": "invalid", "X-RateLimit-Reset": "inf"}]:
            with self.subTest(headers=headers):
                self.request.return_value = _response(headers=headers)
                self._get()
                self._get("user-2")
                self.assertEqual(self.sleeps, [])

    def test_invalid_429_delays_have_a_safe_fallback(self):
        for payload in [{}, ["bad payload"], {"retry_after": -1}, {"retry_after": "nan"}]:
            with self.subTest(payload=payload):
                self.sleeps.clear()
                self.request.side_effect = [
                    _response(429, headers={"Retry-After": "inf"}, payload=payload), _response(),
                ]
                self._get()
                self.assertAlmostEqual(self.sleeps[-1], 1 + RATE_LIMIT_MARGIN_SECONDS)

    def test_invalid_429_json_still_honors_retry_header(self):
        limited = _response(429, headers={"Retry-After": "0.1"})
        limited.json.side_effect = ValueError("Invalid JSON")
        self.request.side_effect = [limited, _response()]
        self._get()
        self.assertAlmostEqual(self.sleeps[0], 0.1 + RATE_LIMIT_MARGIN_SECONDS)

    def test_non_rate_limit_errors_are_not_retried(self):
        for status in [404, 403, 500]:
            with self.subTest(status=status):
                failure = _response(status)
                self.request.reset_mock()
                self.request.return_value = failure
                self.assertIs(self._get(), failure)
                self.request.assert_called_once()

    def test_transport_failure_releases_lock_for_next_lookup(self):
        self.request.side_effect = [requests.RequestException("offline"), _response()]
        with self.assertRaises(requests.RequestException):
            self._get()
        self.assertEqual(self._get().status_code, 200)

    def test_role_check_recovers_from_429_without_warning_or_skipping_member(self):
        self.request.side_effect = [_response(429, payload={"retry_after": 0.19}), _response()]
        with patch.object(discord_bridge, "_member_lookup", self.client), \
                patch.object(discord_bridge, "_bot_token", return_value="test-token"), \
                patch.object(discord_bridge.logger, "warning") as warning:
            self.assertTrue(discord_bridge.member_has_role("user-1", guild_id="guild-1", role_id="role"))
        warning.assert_not_called()

    def test_role_check_warns_once_when_retries_are_exhausted(self):
        self.request.return_value = _response(429, payload={"retry_after": 0.1})
        with patch.object(discord_bridge, "_member_lookup", self.client), \
                patch.object(discord_bridge, "_bot_token", return_value="test-token"), \
                patch.object(discord_bridge.logger, "warning") as warning:
            self.assertIsNone(discord_bridge.member_has_role("user-1", guild_id="guild-1", role_id="role"))
        self.assertEqual(self.request.call_count, 3)
        warning.assert_called_once()


if __name__ == "__main__":
    unittest.main()
