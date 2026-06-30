import unittest
from unittest.mock import Mock, patch

from services import daily_quote, discord_bridge


class ExternalWorkflowResilienceTests(unittest.TestCase):
    def test_malformed_quote_response_never_writes_cache(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.side_effect = ValueError("malformed JSON token=quote-secret")

        with patch.object(daily_quote.http_requests, "get", return_value=response), \
                patch.object(daily_quote, "create_row_safe") as create_row, \
                patch.object(daily_quote, "update_row_safe") as update_row:
            with self.assertRaises(ValueError):
                daily_quote.fetch_and_store_daily_quote("2026-06-03")

        create_row.assert_not_called()
        update_row.assert_not_called()

    def test_malformed_discord_member_payload_is_unknown_not_exception(self):
        response = Mock(status_code=200)
        response.json.return_value = ["not", "a", "member"]

        with patch.object(discord_bridge, "_bot_token", return_value="token"), \
                patch.object(discord_bridge.requests, "get", return_value=response):
            self.assertIsNone(discord_bridge.member_has_role("user-1"))

    def test_role_failure_log_redacts_response_secret(self):
        response = Mock(status_code=500, text="failure token=discord-secret")

        with patch.object(discord_bridge, "_bot_token", return_value="token"), \
                patch.object(discord_bridge.requests, "put", return_value=response), \
                self.assertLogs(discord_bridge.logger, level="WARNING") as captured:
            self.assertFalse(discord_bridge.add_guild_member_role("user-1"))

        output = "\n".join(captured.output)
        self.assertNotIn("discord-secret", output)
        self.assertIn("token=[redacted]", output)


if __name__ == "__main__":
    unittest.main()
