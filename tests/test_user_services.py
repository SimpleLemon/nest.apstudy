from unittest.mock import patch

from appwrite.exception import AppwriteException

from services.user_cleanup import delete_user_data
from services.user_profile import (
    is_early_member,
    is_emory_school,
    normalize_banner_color,
    profile_handle,
)


class TestUserProfile:
    def test_normalize_banner_color_valid(self):
        assert normalize_banner_color("#AbCdEf") == "#abcdef"

    def test_normalize_banner_color_invalid(self):
        assert normalize_banner_color("not-a-color") == "#fecae1"

    def test_profile_handle_prefers_username(self):
        assert profile_handle("Jane Doe", "user-1", username="jdoe") == "@jdoe"

    def test_is_emory_school(self):
        assert is_emory_school("Emory University") is True
        assert is_emory_school("Georgia Tech") is False

    def test_is_early_member(self):
        assert is_early_member("2026-01-01T00:00:00+00:00") is True
        assert is_early_member("2030-01-01T00:00:00+00:00") is False


class TestUserCleanup:
    @patch("services.user_cleanup.delete_row_safe")
    @patch("services.user_cleanup.list_rows_all", return_value=[])
    @patch("services.user_cleanup.delete_calendar_rows_by_user")
    def test_delete_user_data_returns_empty_on_success(self, _calendar, _list_rows, _delete_row):
        assert delete_user_data("user-1") == []

    @patch("services.user_cleanup.delete_row_safe")
    @patch("services.user_cleanup.list_rows_all", return_value=[])
    @patch("services.user_cleanup.delete_calendar_rows_by_user", side_effect=AppwriteException("calendar failed"))
    def test_delete_user_data_records_calendar_failure(self, _calendar, _list_rows, _delete_row):
        errors = delete_user_data("user-1")
        assert "calendar" in errors
