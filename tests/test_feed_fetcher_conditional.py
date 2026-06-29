import unittest
from unittest.mock import Mock, patch

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


if __name__ == "__main__":
    unittest.main()
