import json
import unittest
from unittest.mock import Mock, patch

from appwrite.exception import AppwriteException
from appwrite.query import Query

import appwrite_helpers
from services import calendar_store, database


class PaginationContractTests(unittest.TestCase):
    def adapters(self):
        return (
            (database.list_rows_all, database, "list_rows", "users"),
            (appwrite_helpers.list_rows_all, appwrite_helpers, "list_rows_safe", "users"),
            (appwrite_helpers.list_appwrite_rows_all, appwrite_helpers, "list_appwrite_rows_safe", "users"),
            (calendar_store.list_calendar_rows_all, database, "list_rows", "user_events"),
        )

    def test_invalid_limits_are_rejected_before_the_first_fetch(self):
        for adapter, module, fetch_name, table in self.adapters():
            for limit in (0, -1, None, "2", 2.0, True, False):
                with self.subTest(adapter=adapter.__name__, limit=limit), patch.object(
                    module, fetch_name
                ) as fetch:
                    with self.assertRaisesRegex(ValueError, "positive integer"):
                        adapter(table, limit=limit)
                    fetch.assert_not_called()

    def test_valid_pagination_keeps_filters_and_advances_offsets(self):
        filters = [Query.order_asc("$id")]
        pages = [{"rows": [{"id": "a"}, {"id": "b"}]}, {"rows": [{"id": "c"}]}]
        for adapter, module, fetch_name, table in self.adapters():
            with self.subTest(adapter=adapter.__name__), patch.object(
                module, fetch_name, side_effect=pages
            ) as fetch:
                rows = adapter(table, filters, 2)
                self.assertEqual([row["id"] for row in rows], ["a", "b", "c"])
                self.assertEqual(fetch.call_count, 2)
                for offset, call in zip((0, 2), fetch.call_args_list):
                    self.assertEqual(call.args[0], table)
                    self.assertEqual(call.args[1][0], filters[0])
                    queries = [json.loads(query) for query in call.args[1][1:]]
                    self.assertEqual(queries, [
                        {"method": "limit", "values": [2]},
                        {"method": "offset", "values": [offset]},
                    ])
                self.assertEqual(filters, [Query.order_asc("$id")])

    def test_required_local_rows_contract_is_not_silently_treated_as_empty(self):
        with patch.object(database, "list_rows", return_value={"total": 0}):
            with self.assertRaises(KeyError):
                database.list_rows_all("users")
            with self.assertRaises(KeyError):
                database.first_row("users")

    def test_default_page_size_stays_one_hundred(self):
        for adapter, module, fetch_name, table in self.adapters():
            with self.subTest(adapter=adapter.__name__), patch.object(
                module, fetch_name, return_value={"rows": []}
            ) as fetch:
                self.assertEqual(adapter(table), [])
                query = json.loads(fetch.call_args.args[1][0])
                self.assertEqual(query, {"method": "limit", "values": [100]})
                fetch.assert_called_once()


class ExplicitAppwriteRepositoryTests(unittest.TestCase):
    def test_missing_rows_are_optional_only_when_requested(self):
        sdk = Mock()
        repository = appwrite_helpers.AppwriteRepository(sdk, "remote-db")
        sdk.get_row.side_effect = AppwriteException("Row not found", 404)
        self.assertIsNone(repository.get_row("legacy-table", "missing", allow_missing=True))
        with self.assertRaises(AppwriteException) as raised:
            repository.get_row("legacy-table", "missing")
        self.assertEqual(raised.exception.code, 404)

        sdk.get_row.side_effect = AppwriteException("Service unavailable", 503)
        with self.assertRaises(AppwriteException) as raised:
            repository.get_row("legacy-table", "missing", allow_missing=True)
        self.assertEqual(raised.exception.code, 503)

    def test_sdk_model_and_dictionary_rows_keep_the_existing_conversion(self):
        class SdkRow:
            def to_dict(self):
                return {"$id": "remote-a", "data": {"title": "Legacy row"}}

        class SdkRowList:
            rows = [SdkRow()]

            def model_dump(self, **_kwargs):
                return {"rows": self.rows, "total": 1}

        sdk = Mock()
        sdk.list_rows.return_value = SdkRowList()
        repository = appwrite_helpers.AppwriteRepository(sdk, "remote-db")
        queries = [Query.limit(1)]
        result = repository.list_rows("legacy-table", queries)
        self.assertEqual(result, {
            "rows": [{"$id": "remote-a", "title": "Legacy row"}], "total": 1,
        })
        sdk.list_rows.assert_called_once_with(
            database_id="remote-db", table_id="legacy-table", queries=queries,
        )
        sdk.get_row.return_value = {"$id": "remote-b", "title": "Dictionary row"}
        self.assertEqual(repository.get_row("legacy-table", "remote-b"), sdk.get_row.return_value)


if __name__ == "__main__":
    unittest.main()
