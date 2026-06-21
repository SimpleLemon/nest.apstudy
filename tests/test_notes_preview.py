import unittest

from services.notes_preview import preview_text_from_content


class NotesPreviewTests(unittest.TestCase):
    def test_blank_content_returns_blank_preview(self):
        self.assertEqual(preview_text_from_content(""), "Blank note")
        self.assertEqual(preview_text_from_content("   "), "Blank note")

    def test_extracts_paragraph_text(self):
        content = '[{"type":"paragraph","content":[{"text":"Hello world"}]}]'
        self.assertEqual(preview_text_from_content(content), "Hello world")

    def test_extracts_heading_and_nested_children(self):
        content = (
            '[{"type":"heading","content":[{"text":"Title"}],"children":['
            '{"type":"paragraph","content":[{"text":"Body copy"}]}]}]'
        )
        self.assertEqual(preview_text_from_content(content), "Title Body copy")

    def test_truncates_long_preview(self):
        long_text = "word " * 120
        content = f'[{{"type":"paragraph","content":[{{"text":"{long_text.strip()}"}}]}}]'
        preview = preview_text_from_content(content)
        self.assertLessEqual(len(preview), 280)
        self.assertTrue(preview.endswith("…"))


if __name__ == "__main__":
    unittest.main()
