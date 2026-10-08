"""Dashboard save contracts independent of Flask request state."""

import json
import unittest
from datetime import datetime, timezone
from unittest.mock import Mock, patch

from appwrite.exception import AppwriteException

from services import dashboard_layout


class DashboardLayoutSaveTests(unittest.TestCase):
    def setUp(self):
        self.list_rows = Mock(return_value=[{"$id": "list-1"}, {"id": "list-2"}])
        self.ensure_settings = Mock(return_value={"id": "settings-1"})
        self.update_row = Mock(side_effect=lambda _collection, _id, data: data)
        self.now = datetime(2026, 10, 3, tzinfo=timezone.utc)

    def save(self, payload):
        return dashboard_layout.save_dashboard_layout(
            "user-1",
            payload,
            list_rows_all_fn=self.list_rows,
            ensure_user_settings_fn=self.ensure_settings,
            update_row_fn=self.update_row,
            now_fn=lambda: self.now,
        )

    def save_tiles(self, tiles, **layout_fields):
        return self.save({"dashboard_layout": {"version": 4, "tiles": tiles, **layout_fields}})

    def assert_rejected(self, result, message, status=400):
        self.assertEqual(result, ({"error": message}, status))
        self.ensure_settings.assert_not_called()
        self.update_row.assert_not_called()

    def test_invalid_tile_fields_preserve_exact_errors_without_writes(self):
        cases = [
            ({"type": "unknown"}, "Unknown dashboard tile: unknown."),
            ({"type": "calendar", "instance_id": "!"}, "Invalid dashboard tile instance: !."),
            ({"type": "courses", "size": "tall"}, "Invalid size 'tall' for dashboard tile: courses."),
            ({"type": "notes", "title": 1}, "Dashboard tile titles must be text."),
            ({"type": "notes", "title": "x" * 61}, "Dashboard tile titles must be 60 characters or fewer."),
            ({"type": "notes", "item_limit": None}, "Dashboard tile item_limit must be 3, 5, or 8."),
            ({"type": "notes", "density": "spacious"}, "Dashboard tile density must be compact or comfortable."),
            ({"type": "calendar", "view": "agenda"}, "Invalid calendar view 'agenda'."),
            ({"type": "calendar", "upcoming_days": "7"}, "Calendar upcoming_days must be 7, 14, or 30."),
            ({"type": "tasks", "task_list_ids": "list-1"}, "Task list filters must be a list."),
            ({"type": "tasks", "task_list_ids": ["other"]}, "Task list filters must belong to your account."),
            ({"type": "tasks", "task_list_ids": [" ", None]}, "Select at least one task list or choose All."),
            ({"type": "tasks", "deadline_days": "7"}, "Task deadline_days must be 7 or 30."),
            ({"type": "tasks", "priorities": "high"}, "Task priorities must be a list."),
            ({"type": "tasks", "priorities": [None]}, "Unknown task priority: blank."),
            ({"type": "tasks", "priorities": []}, "Select at least one task priority."),
        ]
        cases.extend(
            ({"type": "tasks", field: 1}, f"{field} must be true or false.")
            for field in ("include_overdue", "include_undated", "starred_only")
        )
        for tile, message in cases:
            with self.subTest(tile=tile):
                self.assert_rejected(self.save_tiles([tile]), message)

    def test_envelope_and_quote_rejections_precede_tile_validation(self):
        cases = [
            ({}, "tile_layout must be an object or list."),
            ({"tile_layout": {}}, "tile_layout tiles must be a list."),
            ({"tiles": ["calendar"] * 13}, "Dashboard layouts support at most 12 tiles."),
            ({"dashboard_layout": {"tiles": ["unknown"], "daily_quote_visible": 1}},
             "daily_quote_visible must be true or false."),
        ]
        for payload, message in cases:
            with self.subTest(payload=payload):
                self.assert_rejected(self.save(payload), message)
        self.list_rows.assert_not_called()

    def test_duplicate_rules_and_legacy_versions_preserve_error_order(self):
        cases = [
            (4, [{"type": "tasks", "instance_id": "same"}] * 2,
             "Duplicate dashboard tile instance: same."),
            (3, [{"type": "tasks", "instance_id": f"tasks-{i}"} for i in range(2)],
             "Duplicate dashboard tile: tasks."),
            (4, [{"type": "notes", "instance_id": f"notes-{i}"} for i in range(2)],
             "Duplicate dashboard tile: notes."),
            (4, [{"type": "calendar", "instance_id": f"calendar-{i}"} for i in range(5)],
             "Dashboard supports at most 4 calendar tiles."),
        ]
        for version, tiles, message in cases:
            with self.subTest(version=version, message=message):
                self.assert_rejected(self.save_tiles(tiles, version=version), message)

    def test_later_invalid_tile_does_not_persist_earlier_valid_tiles(self):
        self.assert_rejected(
            self.save_tiles([
                {"type": "tasks", "task_list_ids": ["list-1"]},
                {"type": "calendar", "view": "agenda"},
            ]),
            "Invalid calendar view 'agenda'.",
        )
        self.list_rows.assert_called_once()

    def test_task_filters_load_once_and_normalize_each_duplicate_independently(self):
        result, status = self.save_tiles([
            {"type": "tasks", "instance_id": "first", "task_list_ids": [" list-1 ", "list-1", ""]},
            {"type": "tasks", "instance_id": "second", "task_list_ids": ["list-2"]},
        ], daily_quote_visible=False)
        self.assertEqual(status, 200)
        tiles = result["tile_layout"]
        self.assertEqual(tiles[0]["task_list_ids"], ["list-1"])
        self.assertEqual(tiles[1]["task_list_ids"], ["list-2"])
        self.assertFalse(result["dashboard_layout"]["daily_quote_visible"])
        self.list_rows.assert_called_once_with(
            dashboard_layout.COLLECTIONS.get("task_lists", "task_lists"),
            [dashboard_layout.Query.equal("user_id", ["user-1"])],
        )
        persisted = json.loads(self.update_row.call_args.args[2]["dashboard_layout_json"])
        self.assertEqual(persisted, result["dashboard_layout"])

    def test_empty_filters_and_other_tile_fields_do_not_load_task_lists(self):
        result, status = self.save_tiles([
            {"type": "tasks", "task_list_ids": []},
            {"type": "calendar", "task_list_ids": "ignored"},
        ])
        self.assertEqual(status, 200)
        self.assertNotIn("task_list_ids", result["tile_layout"][0])
        self.list_rows.assert_not_called()

    def test_task_ownership_error_precedes_invalid_preferences(self):
        self.assert_rejected(
            self.save_tiles([{"type": "tasks", "task_list_ids": ["other"], "deadline_days": 8}]),
            "Task list filters must belong to your account.",
        )
        self.list_rows.assert_called_once()

    def test_task_lookup_failure_is_500_and_cannot_create_settings(self):
        self.list_rows.side_effect = AppwriteException("unavailable")
        with patch.object(dashboard_layout.logger, "exception"):
            self.assert_rejected(
                self.save_tiles([{"type": "tasks", "task_list_ids": ["list-1"]}]),
                "Unable to validate task list filters.",
                500,
            )

    def test_legacy_aliases_migrate_sizes_and_custom_settings(self):
        result, status = self.save({"order": ["courses", "notes"]})
        self.assertEqual(status, 200)
        self.assertEqual([tile["size"] for tile in result["tile_layout"]], ["wide", "standard"])
        result, status = self.save({"layout": {"version": 2, "tiles": [
            {"id": "calendar", "size": "large", "view": " WEEK ", "upcoming_days": 14},
            {"id": "tasks", "size": "medium", "title": "  Work  ", "density": " COMPACT ",
             "item_limit": "8", "priorities": [" LOW ", "low", "high"],
             "deadline_days": 7, "include_overdue": False, "include_undated": False, "starred_only": True},
        ]}})
        self.assertEqual(status, 200)
        calendar, tasks = result["tile_layout"]
        self.assertEqual((calendar["size"], calendar["view"], calendar["upcoming_days"]), ("wide", "week", 14))
        self.assertEqual((tasks["size"], tasks["title"], tasks["density"], tasks["item_limit"]),
                         ("standard", "Work", "compact", 8))
        # Saved task priorities retain the canonical order used when reading a layout.
        self.assertEqual(tasks["priorities"], ["high", "low"])
        self.assertEqual(tasks["deadline_days"], 7)
        self.assertFalse(tasks["include_overdue"])
        self.assertFalse(tasks["include_undated"])
        self.assertTrue(tasks["starred_only"])

    def test_persistence_failure_preserves_service_error(self):
        self.update_row.side_effect = AppwriteException("unavailable")
        with patch.object(dashboard_layout.logger, "exception"):
            self.assertEqual(self.save_tiles(["notes"]), ({"error": "Unable to save dashboard layout."}, 500))
        self.ensure_settings.assert_called_once_with("user-1")
        self.update_row.assert_called_once()


if __name__ == "__main__":
    unittest.main()
