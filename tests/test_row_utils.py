"""SDK rows and native row dictionaries keep their existing public shape."""

import unittest

import appwrite_helpers
from services.row_utils import row_to_dict


class LegacyRow:
    def to_dict(self):
        return {"$id": "row-1", "data": {"title": "Study", "done": False}}


class ModernRow:
    def model_dump(self, *, by_alias, mode):
        if not by_alias or mode != "json":
            raise ValueError("SDK metadata aliases and JSON values are required.")
        return {"$id": "row-2", "data": {"title": "Review", "done": True}}


class RowNormalizationTests(unittest.TestCase):
    def test_native_row_dictionaries_keep_identity_and_nested_data(self):
        row = {"$id": "row-1", "data": {"title": "Native"}}
        self.assertIs(row_to_dict(row), row)
        self.assertEqual(row["data"], {"title": "Native"})

    def test_sdk_rows_flatten_data_and_keep_metadata(self):
        self.assertEqual(row_to_dict(LegacyRow()), {"$id": "row-1", "title": "Study", "done": False})
        self.assertEqual(row_to_dict(ModernRow()), {"$id": "row-2", "title": "Review", "done": True})

    def test_unrecognized_rows_retain_the_previous_passthrough_contract(self):
        row = object()
        self.assertIs(row_to_dict(row), row)

    def test_repository_response_normalizes_each_sdk_row_and_keeps_total(self):
        response = appwrite_helpers._row_list_to_dict({
            "rows": [LegacyRow(), ModernRow()], "total": 10,
        })
        self.assertEqual(response, {
            "total": 10,
            "rows": [
                {"$id": "row-1", "title": "Study", "done": False},
                {"$id": "row-2", "title": "Review", "done": True},
            ],
        })
