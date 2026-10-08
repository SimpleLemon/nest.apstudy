import os
import sqlite3
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from flask import Blueprint, Flask
from werkzeug.exceptions import NotFound

import blueprints.dashboard as dashboard
import blueprints.notes_api as notes_api
from services import database, note_store, notes_access, notes_collaboration


class NotesSharingStoreTests(unittest.TestCase):
    def setUp(self):
        handle, self.path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(handle)
        self.addCleanup(lambda: os.path.exists(self.path) and os.remove(self.path))
        self.env = patch.dict(os.environ, {"DATABASE_PATH": self.path})
        self.env.start()
        self.addCleanup(self.env.stop)
        database.init_db(path=self.path)
        with database.db_connection(self.path) as conn:
            conn.executemany(
                "INSERT INTO users (id, google_id, name, username, email, picture_url, created_at) VALUES (?, ?, ?, ?, ?, '', ?)",
                [
                    ("owner", "google-owner", "Owner Name", "owner", "owner@example.test", "2026-01-01T00:00:00Z"),
                    ("viewer", "google-viewer", "Viewer Name", "viewer", "viewer@example.test", "2026-01-01T00:00:00Z"),
                    ("other", "google-other", "Other User", "other", "other@example.test", "2026-01-01T00:00:00Z"),
                ],
            )
            conn.execute(
                "INSERT INTO note_folders (id, user_id, name, \"order\", created_at) VALUES ('folder-1', 'owner', 'Shared Folder', 1, '2026-01-01T00:00:00Z')"
            )
            conn.executemany(
                """
                INSERT INTO notes (id, user_id, folder_id, title, content, preview_text, "order", created_at, updated_at)
                VALUES (?, 'owner', ?, ?, '[]', ?, 1, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')
                """,
                [
                    ("folder-note", "folder-1", "Folder Note", "Inside folder"),
                    ("standalone-note", None, "Standalone Note", "Outside folder"),
                ],
            )

    def test_public_named_and_folder_access_is_dynamic(self):
        folder_note = note_store.get_note("folder-note")
        self.assertFalse(note_store.resolve_note_access(folder_note)["can_view"])

        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=True, user_ids=["viewer"], granted_by_user_id="owner"
        )
        self.assertEqual(note_store.resolve_note_access(folder_note)["source"], "folder_public")
        self.assertEqual(note_store.resolve_note_access(folder_note, "viewer")["source"], "folder_user")
        self.assertTrue(note_store.resolve_note_access(folder_note, "owner")["can_edit"])

        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET folder_id = NULL WHERE id = 'folder-note'")
        moved = note_store.get_note("folder-note")
        self.assertFalse(note_store.resolve_note_access(moved, "viewer")["can_view"])

        note_store.replace_resource_grants(
            "note", "folder-note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        self.assertEqual(note_store.resolve_note_access(moved, "viewer")["source"], "note_user")

    def test_grants_are_unique_replaceable_and_removed_with_resource(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=True,
            user_ids=["viewer", "viewer"], granted_by_user_id="owner",
        )
        state = note_store.sharing_state("note", "standalone-note")
        self.assertTrue(state["public"])
        self.assertEqual([user["id"] for user in state["users"]], ["viewer"])

        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            user_ids=["other"], granted_by_user_id="owner",
        )
        state = note_store.sharing_state("note", "standalone-note")
        self.assertFalse(state["public"])
        self.assertEqual([user["id"] for user in state["users"]], ["other"])
        note_store.delete_note("standalone-note")
        self.assertEqual(note_store.resource_grants("note", "standalone-note"), [])

    def test_admitted_editor_cannot_restore_sharing_after_revocation_or_downgrade(self):
        for resource_type, resource_id in [("note", "standalone-note"), ("folder", "folder-1")]:
            for replacement_role in [None, "viewer", "reviewer"]:
                with self.subTest(resource_type=resource_type, replacement_role=replacement_role):
                    note_store.replace_resource_grants(
                        resource_type, resource_id, "owner", public=False,
                        grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
                    )
                    resource = note_store.get_note(resource_id) if resource_type == "note" else note_store.get_folder(resource_id)
                    resolve = note_store.resolve_note_access if resource_type == "note" else note_store.resolve_folder_access
                    self.assertTrue(resolve(resource, "viewer")["can_share"])
                    replacement = [{"user_id": "viewer", "role": replacement_role}] if replacement_role else []
                    note_store.replace_resource_grants(
                        resource_type, resource_id, "owner", public=False,
                        grants=replacement, granted_by_user_id="owner",
                    )
                    before = note_store.sharing_state(resource_type, resource_id)
                    with self.assertRaisesRegex(ValueError, "sharing_access_denied"), patch.object(
                        notes_collaboration, "invalidate_access"
                    ) as invalidate:
                        note_store.replace_resource_grants(
                            resource_type, resource_id, "owner", public=True,
                            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="viewer",
                        )
                    invalidate.assert_not_called()
                    self.assertEqual(note_store.sharing_state(resource_type, resource_id), before)

    def test_inherited_editor_cannot_restore_access_after_folder_revocation(self):
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        admitted_note = note_store.get_note("folder-note")
        self.assertTrue(note_store.resolve_note_access(admitted_note, "viewer")["can_share"])
        revision = int(admitted_note["access_version"])
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=False, grants=[], granted_by_user_id="owner",
        )
        self.assertEqual(int(note_store.get_note("folder-note")["access_version"]), revision)
        with self.assertRaisesRegex(ValueError, "sharing_access_denied"):
            note_store.replace_resource_grants(
                "note", "folder-note", "owner", public=False,
                grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="viewer",
                expected_revision=revision,
            )
        self.assertEqual(note_store.resource_grants("note", "folder-note"), [])

    def test_live_direct_and_inherited_editors_can_manage_sharing(self):
        for grant_type, grant_id, resource_type, resource_id in [
            ("note", "standalone-note", "note", "standalone-note"),
            ("folder", "folder-1", "folder", "folder-1"),
            ("folder", "folder-1", "note", "folder-note"),
        ]:
            with self.subTest(resource_type=resource_type, grant_type=grant_type):
                note_store.replace_resource_grants(
                    grant_type, grant_id, "owner", public=False,
                    grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
                )
                note_store.replace_resource_grants(
                    resource_type, resource_id, "owner", public=True,
                    grants=[{"user_id": "other", "role": "reviewer"}], granted_by_user_id="viewer",
                )
                state = note_store.sharing_state(resource_type, resource_id)
                self.assertTrue(state["public"])
                self.assertEqual([(user["id"], user["role"]) for user in state["users"]], [("other", "reviewer")])

    def test_moved_note_and_transferred_folder_do_not_keep_inherited_sharing_power(self):
        for mutation in [
            "UPDATE notes SET folder_id = NULL WHERE id = 'folder-note'",
            "UPDATE note_folders SET user_id = 'other' WHERE id = 'folder-1'",
        ]:
            with self.subTest(mutation=mutation):
                with database.db_connection(self.path) as conn:
                    conn.execute("UPDATE note_folders SET user_id = 'owner' WHERE id = 'folder-1'")
                    conn.execute("UPDATE notes SET folder_id = 'folder-1' WHERE id = 'folder-note'")
                note_store.replace_resource_grants(
                    "folder", "folder-1", "owner", public=False,
                    grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
                )
                self.assertTrue(note_store.resolve_note_access(note_store.get_note("folder-note"), "viewer")["can_share"])
                with database.db_connection(self.path) as conn:
                    conn.execute(mutation)
                with self.assertRaisesRegex(ValueError, "sharing_access_denied"):
                    note_store.replace_resource_grants(
                        "note", "folder-note", "owner", public=False,
                        grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="viewer",
                    )
                self.assertEqual(note_store.resource_grants("note", "folder-note"), [])

    def test_sharing_actor_check_holds_writer_lock_until_grants_commit(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        require_share = note_store._require_resource_share
        def try_revoke_after_authorization(conn, *args):
            require_share(conn, *args)
            with database.db_connection(self.path) as competing_conn:
                competing_conn.execute("PRAGMA busy_timeout=0")
                with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                    competing_conn.execute(
                        "DELETE FROM note_access_grants WHERE resource_type = 'note' AND resource_id = 'standalone-note'"
                    )
        with patch.object(note_store, "_require_resource_share", side_effect=try_revoke_after_authorization):
            note_store.replace_resource_grants(
                "note", "standalone-note", "owner", public=True,
                grants=[{"user_id": "other", "role": "viewer"}], granted_by_user_id="viewer",
            )
        self.assertTrue(note_store.sharing_state("note", "standalone-note")["public"])

    def test_invitations_and_grants_share_locked_authorization_and_one_commit(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        replace_invitations = notes_collaboration.replace_pending_invitations
        def try_revoke_before_invitations(*args, **kwargs):
            self.assertTrue(kwargs["conn"].in_transaction)
            with database.db_connection(self.path) as competing_conn:
                competing_conn.execute("PRAGMA busy_timeout=0")
                with self.assertRaisesRegex(sqlite3.OperationalError, "locked"):
                    competing_conn.execute("DELETE FROM note_access_grants WHERE principal_id = 'viewer'")
            return replace_invitations(*args, **kwargs)
        observed = []
        def observe_commit(*args):
            observed.append((
                note_store.resolve_note_access(note_store.get_note("standalone-note"), "viewer")["can_share"],
                notes_collaboration.list_pending_invitations("note", "standalone-note"),
            ))
        with patch.object(notes_collaboration, "replace_pending_invitations", side_effect=try_revoke_before_invitations), patch.object(
            notes_collaboration, "invalidate_access", side_effect=observe_commit
        ):
            note_store.replace_resource_grants(
                "note", "standalone-note", "owner", public=False, grants=[], granted_by_user_id="viewer",
                invitations=[{"email": "new@example.test", "role": "editor"}],
            )
        self.assertEqual(len(observed), 1)
        self.assertFalse(observed[0][0])
        self.assertEqual([(entry["email"], entry["role"]) for entry in observed[0][1]], [("new@example.test", "editor")])

    def test_grant_failure_rolls_back_grants_invitations_and_revision(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
            invitations=[{"email": "old@example.test", "role": "viewer"}],
        )
        before = note_store.sharing_state("note", "standalone-note")
        before_invitations = notes_collaboration.list_pending_invitations("note", "standalone-note")
        with database.db_connection(self.path) as conn:
            conn.execute("""
                CREATE TRIGGER fail_grant_insert BEFORE INSERT ON note_access_grants
                WHEN NEW.principal_id = 'other'
                BEGIN SELECT RAISE(ABORT, 'injected grant write failure'); END
            """)
        app = Flask(__name__)
        app.secret_key = "test"
        with app.test_request_context(
            "/api/notes/standalone-note/sharing", method="PATCH",
            json={"public": True, "grants": [{"user_id": "other", "role": "viewer"}],
                  "invitations": [{"email": "new@example.test", "role": "editor"}]},
        ), patch.object(notes_api, "current_user", SimpleNamespace(id="viewer", is_authenticated=True)), patch.object(
            notes_collaboration, "invalidate_access"
        ) as invalidate:
            response, status = notes_api.note_sharing.__wrapped__("standalone-note")
        self.assertEqual(status, 500)
        invalidate.assert_not_called()
        self.assertEqual(note_store.sharing_state("note", "standalone-note"), before)
        self.assertEqual(notes_collaboration.list_pending_invitations("note", "standalone-note"), before_invitations)

    def test_standalone_invitation_mutation_rechecks_revoked_editor(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
            invitations=[{"email": "old@example.test", "role": "viewer"}],
        )
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False, grants=[], granted_by_user_id="owner",
        )
        before = notes_collaboration.list_pending_invitations("note", "standalone-note")
        with self.assertRaisesRegex(ValueError, "sharing_access_denied"):
            notes_collaboration.replace_pending_invitations(
                "note", "standalone-note", "owner", [{"email": "new@example.test", "role": "editor"}], "viewer",
            )
        self.assertEqual(notes_collaboration.list_pending_invitations("note", "standalone-note"), before)

    def test_note_inheritance_requires_live_folder_with_same_owner(self):
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=True,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE note_folders SET user_id = 'other' WHERE id = 'folder-1'")
        note = note_store.get_note("folder-note")
        self.assertFalse(note_store.resolve_note_access(note, "viewer")["can_view"])
        self.assertFalse(note_store.resolve_note_access(note)["can_view"])
        self.assertIsNone(notes_access.collaboration_access("folder-note", "viewer"))
        with database.db_connection(self.path) as conn:
            conn.execute("DELETE FROM note_folders WHERE id = 'folder-1'")
        self.assertFalse(note_store.resolve_note_access(note, "viewer")["can_view"])
        note_store.replace_resource_grants(
            "note", "folder-note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        self.assertTrue(note_store.resolve_note_access(note, "viewer")["can_share"])

    def test_http_admission_cannot_restore_editor_after_recipient_validation_race(self):
        app = Flask(__name__)
        app.secret_key = "test"
        actor = SimpleNamespace(id="viewer", is_authenticated=True)
        get_safe_user = note_store.get_safe_user
        for resource_type, resource_id, route in [
            ("note", "standalone-note", notes_api.note_sharing),
            ("folder", "folder-1", notes_api.folder_sharing),
        ]:
            with self.subTest(resource_type=resource_type):
                note_store.replace_resource_grants(
                    resource_type, resource_id, "owner", public=False,
                    grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
                )
                def revoke_during_validation(user_id):
                    note_store.replace_resource_grants(
                        resource_type, resource_id, "owner", public=False, grants=[], granted_by_user_id="owner",
                    )
                    return get_safe_user(user_id)
                with app.test_request_context(
                    f"/api/notes/{'folders/' if resource_type == 'folder' else ''}{resource_id}/sharing", method="PATCH",
                    json={"public": True, "grants": [{"user_id": "viewer", "role": "editor"}]},
                ), patch.object(notes_api, "current_user", actor), patch.object(
                    note_store, "get_safe_user", side_effect=revoke_during_validation
                ), patch.object(notes_collaboration, "replace_pending_invitations") as invitations:
                    with self.assertRaises(NotFound):
                        route.__wrapped__(resource_id)
                invitations.assert_not_called()
                state = note_store.sharing_state(resource_type, resource_id)
                self.assertFalse(state["public"])
                self.assertEqual(state["users"], [])

    def test_owner_transfer_during_sharing_admission_denies_previous_owner(self):
        app = Flask(__name__)
        app.secret_key = "test"
        get_safe_user = note_store.get_safe_user
        for resource_type, resource_id, route in [
            ("note", "standalone-note", notes_api.note_sharing),
            ("folder", "folder-1", notes_api.folder_sharing),
        ]:
            with self.subTest(resource_type=resource_type):
                table = "notes" if resource_type == "note" else "note_folders"
                def transfer_during_validation(user_id):
                    with database.db_connection(self.path) as conn:
                        conn.execute(f"UPDATE {table} SET user_id = 'other' WHERE id = ?", [resource_id])
                    return get_safe_user(user_id)
                with app.test_request_context(
                    f"/api/notes/{'folders/' if resource_type == 'folder' else ''}{resource_id}/sharing", method="PATCH",
                    json={"public": True, "grants": [{"user_id": "viewer", "role": "editor"}]},
                ), patch.object(notes_api, "current_user", SimpleNamespace(id="owner", is_authenticated=True)), patch.object(
                    note_store, "get_safe_user", side_effect=transfer_during_validation
                ), patch.object(notes_collaboration, "replace_pending_invitations") as invitations:
                    with self.assertRaises(NotFound):
                        route.__wrapped__(resource_id)
                invitations.assert_not_called()
                self.assertEqual(note_store.resource_grants(resource_type, resource_id), [])

    def test_migration_enforces_one_grant_per_resource_principal(self):
        grant = (
            "grant-1", "owner", "note", "standalone-note", "user", "viewer",
            "viewer", "owner", "2026-01-01T00:00:00Z",
        )
        with database.db_connection(self.path) as conn:
            conn.execute(
                """
                INSERT INTO note_access_grants (
                    id, owner_user_id, resource_type, resource_id, principal_type,
                    principal_id, access_level, granted_by_user_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                grant,
            )
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    INSERT INTO note_access_grants (
                        id, owner_user_id, resource_type, resource_id, principal_type,
                        principal_id, access_level, granted_by_user_id, created_at
                    ) VALUES ('grant-2', 'owner', 'note', 'standalone-note',
                              'user', 'viewer', 'viewer', 'owner',
                              '2026-01-01T00:00:00Z')
                    """
                )

    def test_shared_with_me_groups_folder_notes_and_deduplicates_direct_grants(self):
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        note_store.replace_resource_grants(
            "note", "folder-note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False, user_ids=["viewer"], granted_by_user_id="owner"
        )
        payload = note_store.list_shared_for_user("viewer")
        self.assertEqual([folder["id"] for folder in payload["folders"]], ["folder-1"])
        self.assertEqual([note["id"] for note in payload["folders"][0]["notes"]], ["folder-note"])
        self.assertEqual([note["id"] for note in payload["notes"]], ["standalone-note"])

    def test_user_search_uses_public_profile_fields_only(self):
        results = note_store.search_share_users("@view", "owner")
        self.assertEqual([user["id"] for user in results], ["viewer"])
        self.assertNotIn("email", results[0])

    def test_public_note_api_returns_owner_and_read_only_capabilities(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=True, user_ids=[], granted_by_user_id="owner"
        )
        app = Flask(__name__)
        app.secret_key = "test"
        with app.test_request_context("/api/notes/standalone-note"):
            anonymous = SimpleNamespace(is_authenticated=False)
            with patch.object(notes_api, "current_user", anonymous), patch.object(
                notes_api, "_load_global_notes_page_setup", return_value={}
            ):
                response = notes_api.get_note("standalone-note")
        payload = response.get_json()
        self.assertEqual(payload["access"]["role"], "viewer")
        self.assertFalse(payload["access"]["can_edit"])
        self.assertEqual(payload["owner"]["id"], "owner")
        self.assertEqual(payload["owner"]["profile_url"], "/u/owner")
        self.assertNotIn("email", payload["owner"])

    def test_private_note_api_requires_login_then_hides_from_other_users(self):
        app = Flask(__name__)
        app.secret_key = "test"
        with app.test_request_context("/api/notes/standalone-note"):
            with patch.object(notes_api, "current_user", SimpleNamespace(is_authenticated=False)):
                response, status = notes_api.get_note("standalone-note")
        self.assertEqual(status, 401)
        self.assertTrue(response.get_json()["login_required"])

        with app.test_request_context("/api/notes/standalone-note"):
            outsider = SimpleNamespace(id="other", is_authenticated=True)
            with patch.object(notes_api, "current_user", outsider):
                response, status = notes_api.get_note("standalone-note")
        self.assertEqual(status, 404)
        self.assertEqual(response.get_json()["error"], "Not found.")

    def test_owner_can_replace_public_and_named_sharing_together(self):
        app = Flask(__name__)
        app.secret_key = "test"
        owner = SimpleNamespace(id="owner", is_authenticated=True)
        with app.test_request_context(
            "/api/notes/standalone-note/sharing",
            method="PATCH",
            json={"public": True, "user_ids": ["viewer"]},
        ):
            with patch.object(notes_api, "current_user", owner), patch.object(
                notes_api, "_sharing_url", return_value="https://example.test/notes/standalone-note"
            ):
                response = notes_api.note_sharing.__wrapped__("standalone-note")
        payload = response.get_json()
        self.assertTrue(payload["public"])
        self.assertEqual([user["id"] for user in payload["users"]], ["viewer"])

    def test_sharing_update_rejects_non_boolean_public_state(self):
        app = Flask(__name__)
        app.secret_key = "test"
        owner = SimpleNamespace(id="owner", is_authenticated=True)
        with app.test_request_context(
            "/api/notes/standalone-note/sharing",
            method="PATCH",
            json={"public": "yes", "user_ids": []},
        ), patch.object(notes_api, "current_user", owner):
            response, status = notes_api._replace_sharing(
                "note", "standalone-note", "owner"
            )
        self.assertEqual(status, 400)
        self.assertEqual(response.get_json()["error"], "public must be a boolean.")

    def test_current_collaboration_access_tracks_folder_note_owner_and_move_revisions(self):
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        original = notes_access.collaboration_access("folder-note", "viewer")
        self.assertTrue(original["can_write"])
        note_store.replace_resource_grants(
            "folder", "folder-1", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "viewer"}], granted_by_user_id="owner",
        )
        downgraded = notes_access.collaboration_access("folder-note", "viewer")
        self.assertFalse(downgraded["can_write"])
        self.assertNotEqual(original["permission_revision"], downgraded["permission_revision"])
        owner_before = notes_access.collaboration_access("folder-note", "owner")
        note_store.update_note("folder-note", {"folder_id": None})
        self.assertIsNone(notes_access.collaboration_access("folder-note", "viewer"))
        self.assertNotEqual(owner_before["permission_revision"], notes_access.collaboration_access("folder-note", "owner")["permission_revision"])
        with database.db_connection(self.path) as conn:
            conn.execute("UPDATE notes SET user_id = 'other' WHERE id = 'folder-note'")
        self.assertIsNone(notes_access.collaboration_access("folder-note", "owner"))
        self.assertEqual(notes_access.collaboration_access("folder-note", "other")["role"], "owner")

    def test_sharing_and_ownership_callbacks_run_after_committed_permissions(self):
        observed = []
        def observe(resource_type, resource_id, **kwargs):
            observed.append((resource_type, resource_id, notes_access.collaboration_access("folder-note", "viewer")))
        with patch.object(notes_collaboration, "invalidate_access", side_effect=observe):
            note_store.replace_resource_grants(
                "folder", "folder-1", "owner", public=False,
                grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
            )
            note_store.replace_resource_grants(
                "folder", "folder-1", "owner", public=False, grants=[], granted_by_user_id="owner",
            )
        self.assertTrue(observed[0][2]["can_write"])
        self.assertIsNone(observed[1][2])

    def test_current_collaboration_access_does_not_mix_acl_generations(self):
        note = note_store.get_note("standalone-note")
        newer = {**note, "access_version": int(note.get("access_version") or 1) + 1}
        with patch.object(note_store, "get_note", side_effect=[note, newer]):
            with self.assertRaisesRegex(RuntimeError, "changed during resolution"):
                notes_access.collaboration_access("standalone-note", "owner")

    def test_admission_capabilities_and_signed_revision_use_the_same_current_acl(self):
        note_store.replace_resource_grants(
            "note", "standalone-note", "owner", public=False,
            grants=[{"user_id": "viewer", "role": "editor"}], granted_by_user_id="owner",
        )
        original = note_store.get_note("standalone-note")
        def downgrade_after_preflight(note_id):
            note_store.replace_resource_grants(
                "note", note_id, "owner", public=False,
                grants=[{"user_id": "viewer", "role": "viewer"}], granted_by_user_id="owner",
            )
            return original
        app = Flask(__name__)
        app.secret_key = "test"
        with app.test_request_context("/api/notes/standalone-note/collaboration-token", method="POST"), patch.object(
            notes_api, "current_user", SimpleNamespace(id="viewer", is_authenticated=True)
        ), patch.object(notes_api, "_note_or_404", side_effect=downgrade_after_preflight), patch.object(
            notes_api, "runtime_environment_config", return_value=SimpleNamespace(notes_collaboration_secret="test")
        ):
            payload = notes_api.create_note_collaboration_token("standalone-note").get_json()
            claims = notes_api._collaboration_serializer().loads(payload["token"])
        current = notes_access.collaboration_access("standalone-note", "viewer")
        self.assertFalse(payload["access"]["can_edit"])
        self.assertEqual(payload["access"]["role"], "viewer")
        self.assertEqual(claims["role"], "viewer")
        self.assertEqual(claims["permission_revision"], current["permission_revision"])
        self.assertEqual(claims["access_revision"], current["access_revision"])


class NotesSharingPageTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.secret_key = "test"
        self.app.config["SERVER_NAME"] = "example.test"
        auth = Blueprint("auth", __name__)
        auth.add_url_rule("/", "index", lambda: "")
        auth.add_url_rule("/login", "login", lambda: "")
        self.app.register_blueprint(auth)
        self.app.register_blueprint(dashboard.dashboard_bp)
        self.note = {
            "$id": "note-1",
            "id": "note-1",
            "user_id": "owner",
            "folder_id": None,
            "title": "Shared Note",
        }
        self.owner = {"id": "owner", "name": "Owner Name", "username": "owner", "picture_url": ""}

    def test_logged_out_restricted_note_renders_login_gate(self):
        anonymous = SimpleNamespace(is_authenticated=False)
        denied = note_store._access_payload()
        with self.app.test_request_context("/notes/note-1"), patch.object(
            dashboard, "current_user", anonymous
        ), patch.object(dashboard.note_store, "get_note", return_value=self.note), patch.object(
            dashboard.note_store, "resolve_note_access", return_value=denied
        ), patch.object(dashboard.note_store, "get_safe_user", return_value=self.owner), patch.object(
            dashboard, "render_template", return_value="login gate"
        ) as render:
            body, status = dashboard.note_document("note-1")
        self.assertEqual((body, status), ("login gate", 401))
        self.assertEqual(render.call_args.kwargs["page_state"], "login_required")
        self.assertIsNone(render.call_args.kwargs["owner"])
        self.assertIn("next=/notes/note-1", render.call_args.kwargs["login_url"])

    def test_public_note_page_is_ready_without_authentication(self):
        anonymous = SimpleNamespace(is_authenticated=False)
        access = note_store._access_payload(role="viewer", source="note_public", source_id="note-1")
        with self.app.test_request_context("/notes/note-1"), patch.object(
            dashboard, "current_user", anonymous
        ), patch.object(dashboard.note_store, "get_note", return_value=self.note), patch.object(
            dashboard.note_store, "resolve_note_access", return_value=access
        ), patch.object(dashboard.note_store, "get_safe_user", return_value=self.owner), patch.object(
            dashboard, "render_template", return_value="public note"
        ) as render:
            response = dashboard.note_document("note-1")
        self.assertEqual(response, "public note")
        self.assertEqual(render.call_args.kwargs["page_state"], "ready")
        self.assertFalse(render.call_args.kwargs["viewer_authenticated"])
        self.assertFalse(render.call_args.kwargs["access"]["can_edit"])

    def test_legacy_editor_url_redirects_to_canonical_note(self):
        with self.app.test_request_context("/notes/editor/note-1?from=dashboard"):
            response = dashboard.legacy_notes_editor("note-1")
        self.assertEqual(response.status_code, 308)
        self.assertEqual(response.location, "/notes/note-1?from=dashboard")

    def test_anonymous_shared_folder_back_link_does_not_point_to_itself(self):
        anonymous = SimpleNamespace(is_authenticated=False)
        folder = {
            "$id": "folder-1",
            "id": "folder-1",
            "user_id": "owner",
            "name": "Shared Folder",
        }
        access = note_store._access_payload(
            role="viewer", source="folder_public", source_id="folder-1"
        )
        with self.app.test_request_context("/notes/folders/folder-1"), patch.object(
            dashboard, "current_user", anonymous
        ), patch.object(dashboard.note_store, "get_folder", return_value=folder), patch.object(
            dashboard.note_store, "resolve_folder_access", return_value=access
        ), patch.object(dashboard.note_store, "get_safe_user", return_value=self.owner), patch.object(
            dashboard.note_store, "list_notes_in_folder", return_value=[]
        ), patch.object(dashboard, "render_template", return_value="shared folder") as render:
            response = dashboard.shared_note_folder("folder-1")
        self.assertEqual(response, "shared folder")
        self.assertEqual(render.call_args.kwargs["back_url"], "/")
        self.assertEqual(render.call_args.kwargs["back_label"], "Nest.APStudy")

    def test_unauthorized_folder_page_does_not_expose_folder_metadata(self):
        outsider = SimpleNamespace(
            id="outsider", is_authenticated=True, onboarding_complete=True
        )
        folder = {
            "$id": "folder-1",
            "id": "folder-1",
            "user_id": "owner",
            "name": "Private Folder Name",
        }
        denied = note_store._access_payload()
        with self.app.test_request_context("/notes/folders/folder-1"), patch.object(
            dashboard, "current_user", outsider
        ), patch.object(
            dashboard, "_user_payload", return_value={"id": "outsider"}
        ), patch.object(
            dashboard, "_load_user_settings", return_value=None
        ), patch.object(dashboard.note_store, "get_folder", return_value=folder), patch.object(
            dashboard.note_store, "resolve_folder_access", return_value=denied
        ), patch.object(dashboard, "render_template", return_value="unavailable") as render:
            body, status = dashboard.shared_note_folder("folder-1")
        self.assertEqual((body, status), ("unavailable", 404))
        self.assertIsNone(render.call_args.kwargs["folder"])
        self.assertIsNone(render.call_args.kwargs["owner"])


if __name__ == "__main__":
    unittest.main()
