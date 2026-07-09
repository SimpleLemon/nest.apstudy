import unittest
from unittest.mock import patch

from appwrite_client import COLLECTIONS
from services import entitlements


class EntitlementServiceTestCase(unittest.TestCase):
    def test_default_tiers_have_expected_limits_and_free_is_safe_default(self):
        definitions = entitlements.normalize_definitions(entitlements.DEFAULT_TIER_DEFINITIONS)

        self.assertEqual(entitlements.normalize_tier(None), "free")
        self.assertEqual(entitlements.normalize_tier("Grade AA"), "grade_aa")
        self.assertEqual(definitions["free"]["storage_bytes"], 1024 ** 3)
        self.assertEqual(definitions["free"]["max_file_size_bytes"], 25 * 1024 ** 2)
        self.assertEqual(definitions["grade_a"]["max_notes"], 50)
        self.assertEqual(definitions["grade_aa"]["max_seat_tracks"], 25)
        self.assertIsNone(definitions["developer"]["storage_bytes"])

    def test_configuration_validation_normalizes_unlimited_and_rejects_unknown_tiers(self):
        raw = {
            "free": {"max_notes": "unlimited"},
            "grade_a": {"max_notes": "50"},
        }
        normalized = entitlements.normalize_definitions(raw)

        self.assertIsNone(normalized["free"]["max_notes"])
        self.assertEqual(normalized["grade_a"]["max_notes"], 50)
        with self.assertRaises(ValueError):
            entitlements.save_tier_definitions({"free": {}, "gold": {}})

    def test_usage_aggregates_files_note_media_and_avatar_bytes(self):
        rows = {
            COLLECTIONS["shared_files"]: [{"file_size_bytes": 100}],
            COLLECTIONS["note_media"]: [{"file_size_bytes": 200}, {"file_size_bytes": 300}],
            COLLECTIONS["notes"]: [{"id": "note-1"}, {"id": "note-2"}],
            COLLECTIONS["user_courses"]: [{"id": "course-1"}],
            COLLECTIONS["course_seat_tracks"]: [
                {"id": "track-1", "enabled": True},
                {"id": "track-2", "enabled": False},
            ],
        }

        with patch.object(entitlements, "_rows", side_effect=lambda table, queries: rows[table]), \
                patch.object(entitlements, "_calendar_feed_count", return_value=2):
            usage = entitlements.usage_for_user(
                "user-1",
                {"id": "user-1", "avatar_file_size_bytes": 400},
            )

        self.assertEqual(usage, {
            "storage_bytes": 1000,
            "files": 1,
            "notes": 2,
            "saved_courses": 1,
            "seat_tracks": 1,
            "calendar_feeds": 2,
        })

    def test_lowered_limits_block_new_additions_and_unlimited_skips_checks(self):
        limited = {
            "limits": {"max_notes": 2, "storage_bytes": 1000},
            "usage": {"storage_bytes": 900},
        }

        with self.assertRaises(entitlements.EntitlementLimitError) as context:
            entitlements.check_limit(limited, "max_notes", 2)
        self.assertEqual(context.exception.payload()["code"], "tier_limit")

        with self.assertRaises(entitlements.EntitlementLimitError):
            entitlements.check_storage(limited, 101)

        unlimited = {
            "limits": {"max_notes": None, "storage_bytes": None},
            "usage": {"storage_bytes": 10 ** 20},
        }
        entitlements.check_limit(unlimited, "max_notes", 10 ** 20)
        entitlements.check_storage(unlimited, 10 ** 20)

    def test_user_tier_is_normalized_when_loading_payload(self):
        user = {"id": "user-1", "tier": "not-a-tier", "avatar_file_size_bytes": 0}
        definitions = entitlements.normalize_definitions(entitlements.DEFAULT_TIER_DEFINITIONS)
        usage = {
            "storage_bytes": 0,
            "files": 0,
            "notes": 0,
            "saved_courses": 0,
            "seat_tracks": 0,
            "calendar_feeds": 0,
        }
        with patch.object(entitlements, "get_tier_definitions", return_value=definitions), \
                patch.object(entitlements, "usage_for_user", return_value=usage):
            payload = entitlements.entitlements_for_user("user-1", user)

        self.assertEqual(payload["key"], "free")
        self.assertEqual(payload["label"], "Free")


if __name__ == "__main__":
    unittest.main()
