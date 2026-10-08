"""SQLite CAS and authoritative replacements retain the latest accepted state."""

import base64
import json
import subprocess
import sqlite3
from pathlib import Path
from contextlib import closing
from types import SimpleNamespace
from unittest.mock import patch

from flask import Flask

import blueprints.notes_api as notes_api
from services import database, note_store, notes_access, notes_collaboration
from tests.test_notes_collaboration import CollaborationDatabaseTestCase


def ydoc(title):
    result = subprocess.run(
        ['node', '--input-type=module', '-e', '''
import * as Y from 'yjs';
const d = new Y.Doc(); d.getText('title').insert(0, process.argv[1]);
console.log(JSON.stringify({blob:Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'),
vector:Buffer.from(Y.encodeStateVector(d)).toString('base64')}));
''', title], text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


def read_ydoc(blob):
    result = subprocess.run(
        ['node', '--input-type=module', '-e', '''
import * as Y from 'yjs';
import { yDocToProsemirrorJSON } from 'y-prosemirror';
const d = new Y.Doc(); Y.applyUpdate(d, Buffer.from(process.argv[1], 'base64'));
console.log(JSON.stringify({title:d.getText('title').toString(),
generation:d.getMap('nest:meta').get('documentGeneration'),
body:d.getXmlFragment('document-store').length ? yDocToProsemirrorJSON(d, 'document-store') : null,
settings:Object.fromEntries(d.getMap('note-settings').entries())}));
''', base64.b64encode(blob).decode('ascii')], text=True, capture_output=True, check=True,
    )
    return json.loads(result.stdout)


class NotesDocumentReplacementTests(CollaborationDatabaseTestCase):
    def setUp(self):
        super().setUp()
        self.app = Flask(__name__)
        self.app.config['TESTING'] = True
        self.app.config['LOGIN_DISABLED'] = True
        self.app.secret_key = 'test-secret'
        self.app.register_blueprint(notes_api.notes_api_bp)
        self.client = self.app.test_client()
        configured = SimpleNamespace(notes_collaboration_internal_secret='secret', notes_collaboration_secret='')
        environment = patch.object(notes_api, 'runtime_environment_config', return_value=configured)
        environment.start()
        self.addCleanup(environment.stop)
        self.headers = {'X-Nest-Collaboration-Secret': 'secret'}
        self.initial = ydoc('Initial')
        self.assertEqual(self.put(self.initial['blob'], 0).status_code, 200)

    def put(self, encoded, revision, generation='initial', title='Initial'):
        return self.client.put('/api/internal/notes/note-1/collaboration-document', headers=self.headers, json={
            'ydoc_base64': encoded, 'expected_revision': revision,
            'document_generation': generation, 'title': title,
        })

    def test_stale_internal_put_rejects_blob_and_projection_together(self):
        latest = ydoc('Latest')
        accepted = self.put(latest['blob'], 1, title='Latest')
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json['durable_revision'], 2)
        stale = self.put(self.initial['blob'], 1, title='Stale')
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json['error'], 'collaboration_revision_conflict')
        self.assertEqual(self.row("SELECT title FROM notes WHERE id = 'note-1'")['title'], 'Latest')
        loaded = self.client.get('/api/internal/notes/note-1/collaboration-document', headers=self.headers)
        self.assertEqual(loaded.headers['X-Nest-Durable-Revision'], '2')
        self.assertEqual(loaded.headers['X-Nest-Document-Generation'], 'initial')
        self.assertEqual(loaded.data, base64.b64decode(latest['blob']))

    def test_internal_save_requires_revision_and_generation_and_checks_both(self):
        for fields in ({'ydoc_base64': self.initial['blob']},
                       {'ydoc_base64': self.initial['blob'], 'expected_revision': True},
                       {'ydoc_base64': self.initial['blob'], 'expected_revision': 1}):
            self.assertEqual(self.client.put('/api/internal/notes/note-1/collaboration-document',
                                             headers=self.headers, json=fields).status_code, 400)
        self.assertEqual(self.put(self.initial['blob'], 1, 'obsolete').status_code, 409)
        for revision in (-1, True, 1.5, '1', None):
            response = self.put(self.initial['blob'], revision)
            self.assertEqual(response.status_code, 400)
            self.assertIn('expected_revision', response.json['error'])
        for generation in ('', ' ', None, 1):
            response = self.put(self.initial['blob'], 1, generation)
            self.assertEqual(response.status_code, 400)
            self.assertIn('document_generation', response.json['error'])
        self.assertEqual(self.client.put('/api/internal/notes/note-1/collaboration-document',
                                         headers=self.headers, json=['invalid']).status_code, 400)

    def test_restore_flushes_checkpoint_then_fences_old_inflight_save(self):
        version = notes_collaboration.create_version('note-1', 'owner')
        latest = ydoc('Accepted before restore')
        paths = []
        def callback(path, payload, **kwargs):
            paths.append(path)
            if path == 'prepare-replacement':
                self.assertEqual(self.put(latest['blob'], 1, title='Accepted before restore').status_code, 200)
            return True
        with patch.object(notes_collaboration, '_post_collaboration_callback', side_effect=callback):
            restored = notes_collaboration.restore_version('note-1', version['id'], 'owner')
        self.assertEqual(restored['title'], 'Initial')
        checkpoint = self.row("SELECT title, ydoc_blob FROM note_versions WHERE reason = 'before_restore'")
        self.assertEqual(checkpoint['title'], 'Accepted before restore')
        self.assertEqual(checkpoint['ydoc_blob'], base64.b64decode(latest['blob']))
        document = notes_collaboration.get_collaboration_document('note-1')
        self.assertEqual(document['durable_revision'], 3)
        self.assertNotEqual(document['document_generation'], 'initial')
        decoded = read_ydoc(document['ydoc_blob'])
        self.assertEqual(decoded['generation'], document['document_generation'])
        self.assertEqual(decoded['title'], 'Initial')
        self.assertEqual(paths, ['prepare-replacement', 'reload'])
        self.assertEqual(self.put(latest['blob'], 2, title='Must not return').status_code, 409)
        self.assertEqual(self.put(latest['blob'], 3, 'initial', title='Must not return').status_code, 409)
        self.assertEqual(self.put(base64.b64encode(document['ydoc_blob']).decode('ascii'), 3,
                                  document['document_generation']).status_code, 200)
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1')['document_generation'],
                         document['document_generation'])

    def test_prepare_outage_keeps_document_and_review_open(self):
        version = notes_collaboration.create_version('note-1', 'owner')
        before = notes_collaboration.get_collaboration_document('note-1')
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=False):
            with self.assertRaises(notes_collaboration.CollaborationReplacementUnavailable) as failure:
                notes_collaboration.restore_version('note-1', version['id'], 'owner')
        self.assertFalse(failure.exception.committed)
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1'), before)
        self.assertEqual(self.row("SELECT COUNT(*) AS n FROM note_versions WHERE reason = 'before_restore'")['n'], 0)

    def test_title_suggestion_applies_to_flushed_state_and_failed_reload_stays_resolved(self):
        latest = ydoc('Latest accepted text')
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'operations': [{'type': 'replace_title', 'after': 'Reviewed title'}],
                'target_kind': 'title', 'base_state_vector': latest['vector'],
            })
        paths = []
        def callback(path, payload, **kwargs):
            paths.append(path)
            if path == 'prepare-replacement':
                self.assertEqual(self.put(latest['blob'], 1, title='Latest accepted text').status_code, 200)
            return path != 'reload'
        with patch.object(notes_collaboration, '_post_collaboration_callback', side_effect=callback):
            with self.assertRaises(notes_collaboration.CollaborationReplacementUnavailable) as failure:
                notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        self.assertTrue(failure.exception.committed)
        self.assertEqual(paths, ['prepare-replacement', 'reload'])
        self.assertEqual(self.row("SELECT title FROM notes WHERE id = 'note-1'")['title'], 'Reviewed title')
        self.assertEqual(self.row('SELECT status FROM note_suggestions WHERE id = ?', [suggestion['id']])['status'], 'accepted')
        with self.assertRaisesRegex(ValueError, 'already resolved'):
            notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        self.assertEqual(self.put(latest['blob'], 2, title='Stale').status_code, 409)
        document = notes_collaboration.get_collaboration_document('note-1')
        decoded = read_ydoc(document['ydoc_blob'])
        self.assertEqual(decoded['generation'], document['document_generation'])
        self.assertEqual(decoded['title'], 'Reviewed title')

    def test_replacement_generation_is_visible_in_access_token_and_verification(self):
        with patch.object(notes_api, 'current_user', SimpleNamespace(id='owner', is_authenticated=True)):
            old_token = self.client.post('/api/notes/note-1/collaboration-token').json['token']
        # Accepting a suggestion does not change the ACL revision; its distinct
        # generation still invalidates the old ticket before browser sync.
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'operations': [{'type': 'replace_title', 'after': 'Reviewed'}],
                'target_kind': 'title', 'base_state_vector': self.initial['vector'],
            })
            notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        generation = notes_collaboration.get_collaboration_document('note-1')['document_generation']
        self.assertEqual(notes_access.collaboration_access('note-1', 'owner')['document_generation'], generation)
        with patch.object(notes_api, 'current_user', SimpleNamespace(id='owner', is_authenticated=True)):
            ticket = self.client.post('/api/notes/note-1/collaboration-token').json
        with self.app.app_context():
            self.assertEqual(notes_api._collaboration_serializer().loads(ticket['token'])['document_generation'], generation)
        self.assertEqual(ticket['document_generation'], generation)
        with patch.object(notes_api, 'current_user', SimpleNamespace(id='owner', is_authenticated=True)), patch.object(
            notes_api, '_load_global_notes_page_setup', return_value={},
        ):
            public_document = self.client.get('/api/notes/note-1')
        self.assertEqual(public_document.status_code, 200)
        self.assertEqual(public_document.headers['X-Nest-Document-Generation'], generation)
        self.assertEqual(public_document.json['document_generation'], generation)
        verify = '/api/internal/notes/collaboration-token/verify'
        self.assertEqual(self.client.post(verify, headers=self.headers,
                                         json={'ticket': old_token, 'note_id': 'note-1'}).status_code, 401)
        fresh = self.client.post(verify, headers=self.headers, json={'ticket': ticket['token'], 'note_id': 'note-1'})
        self.assertEqual(fresh.status_code, 200)
        self.assertEqual(fresh.json['document_generation'], generation)

    def test_restore_rechecks_actor_after_prepare_and_cancels_without_replacement(self):
        note_store.replace_resource_grants('note', 'note-1', 'owner', public=False,
                                          grants=[{'user_id': 'editor', 'role': 'editor'}], granted_by_user_id='owner')
        version = notes_collaboration.create_version('note-1', 'owner')
        before = notes_collaboration.get_collaboration_document('note-1')
        paths = []
        def callback(path, payload, **kwargs):
            paths.append(path)
            if path == 'prepare-replacement':
                with database.db_connection(self.path) as conn:
                    conn.execute("DELETE FROM note_access_grants WHERE principal_id = 'editor'")
            return True
        with patch.object(notes_collaboration, '_post_collaboration_callback', side_effect=callback):
            with self.assertRaisesRegex(ValueError, 'sharing_access_denied'):
                notes_collaboration.restore_version('note-1', version['id'], 'editor')
        self.assertEqual(paths, ['prepare-replacement', 'cancel-replacement'])
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1'), before)

    def test_restore_cas_rejects_a_write_after_the_flushed_read(self):
        version = notes_collaboration.create_version('note-1', 'owner')
        transform = notes_collaboration._run_document_transform
        def concurrent_transform(script, payload):
            output = transform(script, payload)
            self.assertEqual(self.put(self.initial['blob'], 1, title='Concurrent accepted edit').status_code, 200)
            return output
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True) as callback, patch.object(
            notes_collaboration, '_run_document_transform', side_effect=concurrent_transform,
        ):
            with self.assertRaises(notes_collaboration.CollaborationRevisionConflict):
                notes_collaboration.restore_version('note-1', version['id'], 'owner')
        self.assertEqual([call.args[0] for call in callback.call_args_list], ['prepare-replacement', 'cancel-replacement'])
        self.assertEqual(self.row("SELECT title FROM notes WHERE id = 'note-1'")['title'], 'Concurrent accepted edit')
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1')['document_generation'], 'initial')

    def test_reload_outage_route_reports_committed_and_keeps_review_single_use(self):
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'operations': [{'type': 'replace_title', 'after': 'Accepted'}],
                'target_kind': 'title', 'base_state_vector': self.initial['vector'],
            })
        url = f"/api/notes/note-1/suggestions/{suggestion['id']}/accept"
        with patch.object(notes_api, 'current_user', SimpleNamespace(id='owner', is_authenticated=True)), patch.object(
            notes_collaboration, '_post_collaboration_callback', side_effect=lambda path, *args, **kwargs: path != 'reload',
        ):
            response = self.client.post(url)
            again = self.client.post(url)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json, {'error': 'collaboration_replacement_reload_failed', 'document_committed': True})
        self.assertEqual(again.status_code, 400)
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1')['durable_revision'], 2)

    def test_flush_outage_restore_route_reports_uncommitted(self):
        version = notes_collaboration.create_version('note-1', 'owner')
        with patch.object(notes_api, 'current_user', SimpleNamespace(id='owner', is_authenticated=True)), patch.object(
            notes_collaboration, '_post_collaboration_callback', return_value=False,
        ):
            response = self.client.post(f"/api/notes/note-1/versions/{version['id']}/restore")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json, {'error': 'collaboration_replacement_flush_failed', 'document_committed': False})
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1')['durable_revision'], 1)

    def test_body_suggestion_replacement_projects_the_blob_and_keeps_settings(self):
        converted, blob = notes_collaboration._run_document_transform('convert-note.mjs', {
            'title': 'Body title', 'blocks': [{'type': 'paragraph', 'content': 'Before review'}],
            'page_setup': {'zoom': 1.25},
        })
        self.assertEqual(self.put(converted['ydoc_base64'], 1, title='Body title').status_code, 200)
        before = read_ydoc(blob)['body']
        after = json.loads(json.dumps(before))
        def rewrite(node):
            if node.get('type') == 'text':
                node['text'] = 'Accepted body'
            for child in node.get('content', []):
                rewrite(child)
        rewrite(after)
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'target_kind': 'body', 'operations': [{'type': 'replace_document', 'before': before, 'after': after}],
                'base_state_vector': converted['state_vector_base64'],
            })
            notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        document = notes_collaboration.get_collaboration_document('note-1')
        decoded = read_ydoc(document['ydoc_blob'])
        note = note_store.get_note('note-1')
        self.assertEqual(decoded['generation'], document['document_generation'])
        self.assertEqual(decoded['title'], note['title'])
        self.assertEqual(decoded['body'], after)
        self.assertIn('Accepted body', note['content'])
        self.assertIn('Accepted body', note['preview_text'])
        self.assertEqual(json.loads(note['page_setup_json']), decoded['settings'])
        self.assertEqual(decoded['settings']['zoom'], 1.25)

    def test_generation_migration_defaults_existing_documents_without_changing_revision(self):
        with closing(sqlite3.connect(':memory:')) as conn:
            conn.execute('CREATE TABLE note_collaboration_documents (note_id TEXT, durable_revision INTEGER)')
            conn.execute("INSERT INTO note_collaboration_documents VALUES ('legacy', 17)")
            migration = Path(database.BASE_DIR, 'migrations', '026_notes_document_generation.sql').read_text()
            conn.executescript(migration)
            self.assertEqual(conn.execute('SELECT durable_revision, document_generation FROM note_collaboration_documents').fetchone(),
                             (17, 'initial'))

    def test_health_fails_closed_until_generation_migration_exists(self):
        health = '/api/internal/notes/collaboration-health'
        self.assertEqual(self.client.get(health, headers=self.headers).status_code, 200)
        with database.db_connection(self.path) as conn:
            conn.execute('ALTER TABLE note_collaboration_documents DROP COLUMN document_generation')
        response = self.client.get(health, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertFalse(response.json['ok'])

    def test_prepare_outage_leaves_suggestion_open(self):
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'operations': [{'type': 'replace_title', 'after': 'Not committed'}],
                'target_kind': 'title', 'base_state_vector': self.initial['vector'],
            })
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=False):
            with self.assertRaises(notes_collaboration.CollaborationReplacementUnavailable):
                notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        self.assertEqual(self.row('SELECT status FROM note_suggestions WHERE id = ?', [suggestion['id']])['status'], 'open')
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1')['durable_revision'], 1)

    def test_failed_prepare_preserves_an_edit_flushed_before_the_outage(self):
        version = notes_collaboration.create_version('note-1', 'owner')
        latest = ydoc('Accepted edit remains')
        def callback(path, payload, **kwargs):
            if path == 'prepare-replacement':
                self.assertEqual(self.put(latest['blob'], 1, title='Accepted edit remains').status_code, 200)
                return False
            return True
        with patch.object(notes_collaboration, '_post_collaboration_callback', side_effect=callback):
            with self.assertRaises(notes_collaboration.CollaborationReplacementUnavailable):
                notes_collaboration.restore_version('note-1', version['id'], 'owner')
        document = notes_collaboration.get_collaboration_document('note-1')
        self.assertEqual(document['ydoc_blob'], base64.b64decode(latest['blob']))
        self.assertEqual(document['document_generation'], 'initial')
        self.assertEqual(note_store.get_note('note-1')['title'], 'Accepted edit remains')
        self.assertEqual(self.row("SELECT COUNT(*) AS n FROM note_versions WHERE reason = 'before_restore'")['n'], 0)

    def test_body_projection_failure_rolls_back_blob_generation_and_suggestion_resolution(self):
        converted, blob = notes_collaboration._run_document_transform('convert-note.mjs', {
            'title': 'Body title', 'blocks': [{'type': 'paragraph', 'content': 'Before review'}],
        })
        self.assertEqual(self.put(converted['ydoc_base64'], 1, title='Body title').status_code, 200)
        before = notes_collaboration.get_collaboration_document('note-1')
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'target_kind': 'body', 'operations': [{'type': 'replace_document', 'before': read_ydoc(blob)['body'],
                                                     'after': read_ydoc(blob)['body']}],
                'base_state_vector': converted['state_vector_base64'],
            })
            with patch.object(notes_collaboration.note_media, 'sync_note_media', side_effect=RuntimeError('media write failed')):
                with self.assertRaisesRegex(RuntimeError, 'media write failed'):
                    notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1'), before)
        self.assertEqual(self.row('SELECT status FROM note_suggestions WHERE id = ?', [suggestion['id']])['status'], 'open')

    def test_body_suggestion_cannot_resurrect_delete_only_edit_with_unchanged_vector(self):
        converted, blob = notes_collaboration._run_document_transform('convert-note.mjs', {
            'title': 'Title', 'blocks': [{'type': 'paragraph', 'content': 'Removed after proposal'}],
        })
        self.assertEqual(self.put(converted['ydoc_base64'], 1, title='Title').status_code, 200)
        before = read_ydoc(blob)['body']
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            suggestion = notes_collaboration.create_suggestion('note-1', 'reviewer', {
                'target_kind': 'body', 'base_state_vector': converted['state_vector_base64'],
                'operations': [{'type': 'replace_document', 'before': before, 'after': before}],
            })
        result = subprocess.run(['node', '--input-type=module', '-e', '''
import * as Y from 'yjs';
const d = new Y.Doc(); Y.applyUpdate(d, Buffer.from(process.argv[1], 'base64'));
function removeText(node) {
  if (node instanceof Y.XmlText) node.delete(0, node.length);
  else for (const child of node.toArray()) removeText(child);
}
removeText(d.getXmlFragment('document-store'));
console.log(JSON.stringify({blob:Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64'),
vector:Buffer.from(Y.encodeStateVector(d)).toString('base64')}));
''', converted['ydoc_base64']], text=True, capture_output=True, check=True)
        deleted = json.loads(result.stdout)
        self.assertEqual(deleted['vector'], converted['state_vector_base64'])
        self.assertEqual(self.put(deleted['blob'], 2, title='Title').status_code, 200)
        durable = notes_collaboration.get_collaboration_document('note-1')
        with patch.object(notes_collaboration, '_post_collaboration_callback', return_value=True):
            resolved = notes_collaboration.resolve_suggestion('note-1', suggestion['id'], 'owner', 'accepted')
        self.assertEqual(resolved['status'], 'conflicted')
        self.assertEqual(notes_collaboration.get_collaboration_document('note-1'), durable)
        self.assertNotIn('Removed after proposal', json.dumps(read_ydoc(durable['ydoc_blob'])['body']))
