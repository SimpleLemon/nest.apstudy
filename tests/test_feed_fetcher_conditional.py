import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import requests

from services import feed_fetcher
from services.feed_fetcher import fetch_and_parse_ical
from services.feed_diff import build_cache_payload


class TestFeedFetcherConditional(unittest.TestCase):
    def test_partial_body_transport_failures_are_safe_and_close_response(self):
        url = "https://example.com/calendar-secret?token=calendar-secret"
        cases = (
            (feed_fetcher.fetch_and_parse_ical, "Calendar feed request failed."),
            (feed_fetcher.probe_calendar_feed,
             "Unable to reach that calendar URL. Check the link and try again."),
        )
        for fetch, expected in cases:
            for error_class in (requests.exceptions.ConnectionError,
                                requests.exceptions.ChunkedEncodingError,
                                requests.exceptions.ContentDecodingError):
                with self.subTest(fetch=fetch.__name__, error=error_class.__name__):
                    response = requests.Response()
                    response.status_code = 200
                    response.encoding = "utf-8"

                    def chunks(chunk_size):
                        yield b"BEGIN:VCALENDAR\r\n"
                        raise error_class("calendar-secret interrupted stream")

                    response.iter_content = chunks
                    with patch.object(feed_fetcher, "_request_public_feed", return_value=(response, url)), \
                            patch.object(response, "close") as close, \
                            self.assertLogs(feed_fetcher.logger, level="ERROR") as logs:
                        with self.assertRaises(ValueError) as captured:
                            fetch(url)
                    self.assertEqual(str(captured.exception), expected)
                    self.assertIsNone(captured.exception.__cause__)
                    close.assert_called_once()
                    self.assertNotIn("calendar-secret", "\n".join(logs.output))
                    self.assertIn(error_class.__name__, "\n".join(logs.output))

    def test_batch_counts_creates_and_updates_but_not_deletes_or_304(self):
        url = "https://example.com/feed.ics"
        unchanged_url = "https://example.com/unchanged.ics"
        fetched_at = datetime(2026, 10, 3)

        def event(uid, title):
            return {"uid": uid, "title": title, "start": fetched_at}

        def row(row_id, uid, title, feed_url=url):
            return {
                "$id": row_id,
                **build_cache_payload(event(uid, title), "user-1", feed_url, fetched_at),
            }

        existing = [
            row("update-id", "update", "Old title"),
            row("unchanged-id", "unchanged", "Same title"),
            row("delete-id", "delete", "Removed event"),
            row("304-id", "retained", "Retained event", unchanged_url),
        ]

        def fetch(feed_url, **_kwargs):
            return {
                "feed_url": feed_url,
                "status_code": 304 if feed_url == unchanged_url else 200,
                "events": [] if feed_url == unchanged_url else [
                    event("create", "New event"),
                    event("update", "New title"),
                    event("unchanged", "Same title"),
                ],
            }

        with patch.object(feed_fetcher, "list_calendar_rows_all", return_value=existing), \
                patch.object(feed_fetcher, "_load_feed_metadata", return_value={}), \
                patch.object(feed_fetcher, "fetch_and_parse_ical", side_effect=fetch), \
                patch.object(feed_fetcher, "_upsert_feed_metadata") as metadata, \
                patch.object(feed_fetcher, "create_calendar_row") as create, \
                patch.object(feed_fetcher, "update_calendar_row") as update, \
                patch.object(feed_fetcher, "delete_calendar_row") as delete:
            count = feed_fetcher.fetch_and_cache_feeds("user-1", [url, url, unchanged_url])

        self.assertEqual(count, 2)
        self.assertIs(type(count), int)
        create.assert_called_once()
        update.assert_called_once()
        self.assertEqual(update.call_args.args[1], "update-id")
        delete.assert_called_once_with(feed_fetcher.COLLECTIONS["calendar_cache"], "delete-id")
        self.assertEqual(metadata.call_count, 2)

    def test_empty_or_quarantined_batches_return_zero_without_fetching(self):
        url = "https://example.com/feed.ics"
        metadata = {feed_fetcher.feed_url_hash(url): {"disabled_at": "2026-10-03"}}
        with patch.object(feed_fetcher, "_load_feed_metadata", return_value=metadata), \
                patch.object(feed_fetcher, "list_calendar_rows_all") as load_cache, \
                patch.object(feed_fetcher, "fetch_and_parse_ical") as fetch:
            for urls in (None, [], ["", None], [url]):
                with self.subTest(urls=urls):
                    self.assertEqual(feed_fetcher.fetch_and_cache_feeds("user-1", urls), 0)

        fetch.assert_not_called()
        load_cache.assert_not_called()

    def test_force_retries_quarantined_feed(self):
        url = "https://example.com/feed.ics"
        metadata = {feed_fetcher.feed_url_hash(url): {"disabled_at": "2026-10-03"}}
        with patch.object(feed_fetcher, "_load_feed_metadata", return_value=metadata), \
                patch.object(feed_fetcher, "list_calendar_rows_all", return_value=[]), \
                patch.object(feed_fetcher, "fetch_and_parse_ical", return_value={
                    "feed_url": url, "status_code": 200, "events": [],
                }) as fetch, \
                patch.object(feed_fetcher, "_upsert_feed_metadata"):
            self.assertEqual(feed_fetcher.fetch_and_cache_feeds("user-1", [url], force=True), 0)

        fetch.assert_called_once_with(url, etag=None, last_modified=None)

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
                patch.object(feed_fetcher, "_record_feed_failure") as record_failure, \
                patch.object(feed_fetcher, "_upsert_feed_metadata") as upsert_metadata, \
                patch.object(feed_fetcher, "_apply_feed_diffs") as apply_diffs, \
                self.assertLogs(feed_fetcher.logger, level="ERROR") as captured:
            with self.assertRaisesRegex(ValueError, "request failed"):
                feed_fetcher.fetch_and_cache_feeds(
                    "user-1",
                    [
                        "https://good.example/feed.ics",
                        "https://bad.example/feed.ics?token=calendar-secret",
                    ],
                )

        upsert_metadata.assert_not_called()
        apply_diffs.assert_not_called()
        record_failure.assert_called_once()
        self.assertEqual(record_failure.call_args.args[1],
                         "https://bad.example/feed.ics?token=calendar-secret")
        self.assertNotIn("calendar-secret", "\n".join(captured.output))


if __name__ == "__main__":
    unittest.main()
