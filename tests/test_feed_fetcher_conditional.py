import unittest
from unittest.mock import Mock, patch

from services import feed_fetcher
from services.feed_fetcher import fetch_and_parse_ical


class TestFeedFetcherConditional(unittest.TestCase):
    @patch("services.feed_fetcher.icalendar.Calendar.from_ical")
    @patch("services.feed_fetcher.require_public_http_url", side_effect=lambda url: url)
    @patch("services.feed_fetcher.http_requests.get")
    def test_304_skips_parse(self, mock_get, _public_url, mock_from_ical):
        response = Mock()
        response.status_code = 304
        response.headers = {}
        response.content = b""
        response.text = ""
        mock_get.return_value = response

        result = fetch_and_parse_ical("https://example.com/feed", etag="abc")

        self.assertEqual(result["status_code"], 304)
        self.assertEqual(result["etag"], "abc")
        mock_from_ical.assert_not_called()

    def test_batch_failure_does_not_apply_partial_results_or_log_feed_secret(self):
        good = {
            "status_code": 200,
            "events": [],
            "feed_url": "https://good.example/feed.ics",
            "etag": None,
            "last_modified": None,
            "calendar_name": None,
        }

        def fetch(url, **_kwargs):
            if "bad.example" in url:
                raise ValueError("request failed token=calendar-secret")
            return good

        with patch.object(feed_fetcher, "list_calendar_rows_all", return_value=[]), \
                patch.object(feed_fetcher, "_load_feed_metadata", return_value={}), \
                patch.object(feed_fetcher, "fetch_and_parse_ical", side_effect=fetch), \
                patch.object(feed_fetcher, "_upsert_feed_metadata") as upsert_metadata, \
                patch.object(feed_fetcher, "_apply_feed_diffs") as apply_diffs, \
                self.assertLogs(feed_fetcher.logger, level="ERROR") as captured:
            with self.assertRaises(ValueError):
                feed_fetcher.fetch_and_cache_feeds(
                    "user-1",
                    [
                        "https://good.example/feed.ics",
                        "https://bad.example/feed.ics?token=calendar-secret",
                    ],
                )

        upsert_metadata.assert_not_called()
        apply_diffs.assert_not_called()
        self.assertNotIn("calendar-secret", "\n".join(captured.output))


if __name__ == "__main__":
    unittest.main()
