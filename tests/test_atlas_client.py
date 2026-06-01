import unittest

from services.atlas_client import is_section_trackable


class AtlasClientTests(unittest.TestCase):
    def test_zero_seat_sections_are_trackable_even_with_status_mismatch(self):
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": 0,
        }))
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Open",
            "seats_available": "0 seats",
        }))
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Waitlist",
            "seats_available": "0",
        }))

    def test_positive_seat_sections_are_not_trackable(self):
        self.assertFalse(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": 1,
        }))
        self.assertFalse(is_section_trackable({
            "enrollment_status": "Open",
            "seats_available": 3,
        }))

    def test_closed_sections_without_explicit_seats_are_trackable(self):
        self.assertTrue(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": None,
        }))

    def test_cancelled_sections_are_not_trackable(self):
        self.assertFalse(is_section_trackable({
            "enrollment_status": "Closed",
            "seats_available": 0,
            "is_cancelled": True,
        }))


if __name__ == "__main__":
    unittest.main()
