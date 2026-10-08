"""Document conversions resolve their runtime before starting a subprocess."""

import base64
import json
import shutil
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from services import database, notes_collaboration
from tests.test_notes_collaboration import CollaborationDatabaseTestCase


def converted_document():
    return SimpleNamespace(
        returncode=0, stderr="",
        stdout=json.dumps({"ydoc_base64": base64.b64encode(b"converted").decode("ascii")}),
    )


class NotesCollaborationTransformTests(unittest.TestCase):
    def test_document_transform_uses_the_resolved_node_executable(self):
        with patch.object(shutil, "which", return_value="/runtime/bin/node"), patch.object(
            notes_collaboration.subprocess, "run", return_value=converted_document(),
        ) as run:
            _, blob = notes_collaboration._run_document_transform("convert-note.mjs", {"blocks": []})
        self.assertEqual(blob, b"converted")
        self.assertEqual(run.call_args.args[0][0], "/runtime/bin/node")
        self.assertEqual(json.loads(run.call_args.kwargs["input"]), {"blocks": []})

    def test_missing_node_fails_before_starting_a_transform(self):
        with patch.object(shutil, "which", return_value=None), patch.object(
            notes_collaboration.subprocess, "run", return_value=converted_document(),
        ) as run:
            with self.assertRaisesRegex(ValueError, "Node.js"):
                notes_collaboration._run_document_transform("convert-note.mjs", {"blocks": []})
        run.assert_not_called()


class NotesCollaborationMigrationTransformTests(CollaborationDatabaseTestCase):
    def setUp(self):
        super().setUp()
        with database.db_connection(self.path) as connection:
            connection.execute("UPDATE notes SET content = '[]' WHERE id = 'note-1'")

    def test_migration_uses_the_same_resolved_runtime(self):
        with patch.object(shutil, "which", return_value="/runtime/bin/node"), patch.object(
            notes_collaboration.subprocess, "run", return_value=converted_document(),
        ) as run:
            result = notes_collaboration.migrate_notes_to_collaboration(note_ids=["note-1"])
        self.assertEqual((result["checked"], result["ready"], result["migrated"], result["failed"]), (1, 1, 0, []))
        self.assertEqual(run.call_args.args[0][0], "/runtime/bin/node")
        self.assertFalse(self.row("SELECT collaboration_enabled FROM notes WHERE id = 'note-1'")[0])

    def test_missing_runtime_is_a_per_note_failure_and_keeps_legacy_content(self):
        with patch.object(shutil, "which", return_value=None), patch.object(
            notes_collaboration.subprocess, "run", return_value=converted_document(),
        ) as run:
            result = notes_collaboration.migrate_notes_to_collaboration(note_ids=["note-1"])
        self.assertEqual((result["checked"], result["ready"], result["migrated"]), (1, 0, 0))
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(result["failed"][0]["note_id"], "note-1")
        self.assertIn("Node.js", result["failed"][0]["error"])
        run.assert_not_called()
        self.assertEqual(self.row("SELECT content FROM notes WHERE id = 'note-1'")[0], "[]")
        self.assertEqual(self.row("SELECT COUNT(*) FROM note_collaboration_documents")[0], 0)
