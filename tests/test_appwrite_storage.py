import unittest

from appwrite.exception import AppwriteException

from services.appwrite_storage import (
    appwrite_upload_error,
    appwrite_upload_failure,
    note_media_upload_failure,
)


class AppwriteStorageHelperTests(unittest.TestCase):
    def test_appwrite_upload_error_maps_size_limit(self):
        exc = AppwriteException("File size is larger than maximum allowed size", 400, "general_file_too_large")
        self.assertEqual(
            appwrite_upload_error(exc),
            "File exceeds the storage bucket size limit.",
        )
        self.assertEqual(
            appwrite_upload_error(exc, image=True),
            "Image exceeds the storage bucket size limit.",
        )

    def test_note_media_upload_failure_maps_bucket_not_found(self):
        exc = AppwriteException("Bucket with the requested ID could not be found.", 404)
        status, message = note_media_upload_failure(exc)
        self.assertEqual(status, 500)
        self.assertEqual(message, "File storage is not configured. Contact support.")

    def test_appwrite_upload_failure_returns_400_for_disallowed_extension(self):
        exc = AppwriteException("File extension not allowed", 400)
        status, message = appwrite_upload_failure(exc, image=True)
        self.assertEqual(status, 400)
        self.assertEqual(message, "This image type is not allowed.")


if __name__ == "__main__":
    unittest.main()
