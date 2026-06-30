import unittest
from unittest.mock import patch

from appwrite.exception import AppwriteException

import services.daily_quote as daily_quote


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


class DailyQuoteServiceTests(unittest.TestCase):
    def test_daily_quotes_collection_is_configured(self):
        self.assertEqual(daily_quote._quote_table(), "daily_quotes")

    def test_fetch_and_store_daily_quote_normalizes_and_creates_row(self):
        response = FakeResponse([{"q": "Study the pattern.", "a": "Ada"}])

        with patch.object(daily_quote.http_requests, "get", return_value=response) as get_quote, \
                patch.object(daily_quote, "first_row", return_value=None), \
                patch.object(daily_quote, "create_row_safe", side_effect=lambda table, row_id=None, data=None, permissions=None: {"$id": row_id, **data}) as create_row:
            row = daily_quote.fetch_and_store_daily_quote("2026-06-03")

        get_quote.assert_called_once_with(daily_quote.ZENQUOTES_TODAY_URL, timeout=30)
        self.assertEqual(row["quote_date"], "2026-06-03")
        self.assertEqual(row["quote_text"], "Study the pattern.")
        self.assertEqual(row["author"], "Ada")
        self.assertEqual(row["source"], "zenquotes")
        self.assertIn('"q":"Study the pattern."', row["raw_payload"])
        self.assertEqual(create_row.call_args.args[0], "daily_quotes")

    def test_fetch_and_store_daily_quote_updates_existing_date_row(self):
        response = FakeResponse([{"q": "Keep going.", "a": ""}])
        existing = {"$id": "quote-1", "quote_date": "2026-06-03"}

        with patch.object(daily_quote.http_requests, "get", return_value=response), \
                patch.object(daily_quote, "first_row", return_value=existing), \
                patch.object(daily_quote, "update_row_safe", return_value={}) as update_row:
            daily_quote.fetch_and_store_daily_quote("2026-06-03")

        self.assertEqual(update_row.call_args.args[:2], ("daily_quotes", "quote-1"))
        self.assertEqual(update_row.call_args.args[2]["author"], "APStudy Nest")

    def test_daily_quote_payload_returns_fallback_when_row_missing_or_db_fails(self):
        with patch.object(daily_quote, "first_row", return_value=None):
            missing = daily_quote.get_daily_quote_payload("2026-06-03")
        self.assertTrue(missing["fallback"])
        self.assertEqual(missing["date"], "2026-06-03")

        with patch.object(daily_quote, "first_row", side_effect=AppwriteException("boom")):
            failed = daily_quote.get_daily_quote_payload("2026-06-03")
        self.assertTrue(failed["fallback"])
        self.assertEqual(failed["text"], daily_quote.FALLBACK_QUOTE["text"])

    def test_daily_quote_payload_serializes_stored_row(self):
        row = {
            "quote_date": "2026-06-03",
            "quote_text": "Stored quote.",
            "author": "Stored Author",
            "source": "zenquotes",
            "fetched_at": "2026-06-03T00:15:02Z",
        }
        with patch.object(daily_quote, "first_row", return_value=row):
            payload = daily_quote.get_daily_quote_payload("2026-06-03")

        self.assertFalse(payload["fallback"])
        self.assertEqual(payload["text"], "Stored quote.")
        self.assertEqual(payload["author"], "Stored Author")


if __name__ == "__main__":
    unittest.main()
