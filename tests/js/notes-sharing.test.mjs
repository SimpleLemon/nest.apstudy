import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingHarness, sharingRecord, openSharing, settleSharing } from './helpers/notes-sharing.mjs';

for (const resourceType of ['note', 'folder']) {
    test(`${resourceType} sharing edits real roles, visibility and invitations and commits removal on Save`, async () => {
        const h = sharingHarness();
        const saved = [];
        const returnFocus = h.document.createElement('button');
        h.document.body.appendChild(returnFocus);
        returnFocus.focus();
        const modal = await openSharing(h, resourceType, 'resource/1', value => saved.push(value));
        assert.equal(h.requests[0].url, resourceType === 'note' ? '/api/notes/resource%2F1/sharing' : '/api/notes/folders/resource%2F1/sharing');
        assert.equal(h.document.activeElement, modal.querySelector('[data-share-search]'));
        h.change(modal.querySelector('[data-share-public]'), 'public');
        h.change(modal.querySelector('[data-user-role="user-a"]'), 'editor');
        modal.querySelector('[data-remove-user="user-a"]').click();
        assert.equal(modal.querySelector('[data-user-role="user-a"]'), null);
        h.actions[0].undo();
        assert.equal(modal.querySelector('[data-user-role="user-a"]').value, 'editor');
        modal.querySelector('[data-remove-pending="friend@example.org"]').click();
        const save = modal.querySelector('[data-share-save]');
        save.click();
        assert.equal(h.actions[1].committed, true);
        assert.equal(save.disabled, true);
        assert.equal(saved.length, 0);
        assert.deepEqual(JSON.parse(h.requests[1].options.body), {
            expected_revision: 1, public: true, grants: [{ user_id: 'user-a', role: 'editor' }], invitations: [],
        });
        const updated = sharingRecord(resourceType, 'resource/1', { revision: 2, public: true, pending_invitations: [] });
        await h.respond(1, updated);
        assert.deepEqual(saved, [updated]);
        assert.equal(h.modal(), null);
        assert.equal(h.document.activeElement, returnFocus);
        assert.equal(h.toasts.at(-1).message, 'Sharing updated.');
    });
}

test('sharing loads reject login HTML, malformed JSON and decoded empty acknowledgments', async () => {
    for (const payload of ['<!doctype html>Login', '{broken', {}, null, sharingRecord('folder')]) {
        const h = sharingHarness();
        const opening = h.sharing.open({ resourceType: 'note', resourceId: 'note/1' });
        await h.respond(0, payload);
        await opening;
        assert.equal(h.modal(), null);
        assert.equal(h.toasts.at(-1).type, 'error');
        assert.equal(h.document.body.classList.contains('notes-modal-open'), false);
    }
});

test('sharing failed save retains edited controls and exposes decode, acknowledgment and revision conflict recovery', async () => {
    for (const [payload, status, expectedError] of [
        ['<!doctype html>Login', 200, /Invalid JSON response/],
        ['{broken', 200, /Invalid JSON response/],
        [{}, 200, /did not confirm/],
        [sharingRecord('note', 'another'), 200, /did not confirm/],
        [{ error: 'Conflict', code: 'sharing_revision_conflict' }, 409, /Sharing changed in another tab/],
    ]) {
        const h = sharingHarness();
        const saved = [];
        const modal = await openSharing(h, 'note', 'note/1', value => saved.push(value));
        h.change(modal.querySelector('[data-user-role="user-a"]'), 'editor');
        const save = modal.querySelector('[data-share-save]');
        save.click();
        await h.respond(1, payload, status);
        assert.equal(h.modal(), modal);
        assert.equal(save.disabled, false);
        assert.equal(modal.querySelector('[data-user-role="user-a"]').value, 'editor');
        assert.match(modal.querySelector('[data-share-error]').textContent, expectedError);
        assert.deepEqual(saved, []);
        assert.equal(h.toasts.filter(toast => toast.type === 'success').length, 0);
        save.click();
        assert.equal(JSON.parse(h.requests[2].options.body).grants[0].role, 'editor');
        await h.respond(2, sharingRecord('note', 'note/1', { revision: 2 }));
        assert.equal(saved.length, 1);
        assert.equal(h.modal(), null);
    }
});

test('sharing search adds users and email invitations using the selected role', async () => {
    const h = sharingHarness();
    const modal = await openSharing(h);
    const search = modal.querySelector('[data-share-search]');
    h.change(modal.querySelector('[data-share-add-role]'), 'reviewer');
    h.search(search, '@new');
    h.runTimers();
    assert.equal(h.requests[1].url, '/api/notes/share-users?q=%40new');
    await h.respond(1, { results: [{ id: 'user-b', name: 'New user' }] });
    modal.querySelector('[data-add-user="user-b"]').click();
    assert.equal(modal.querySelector('[data-user-role="user-b"]').value, 'reviewer');
    h.search(search, 'other@example.org');
    h.runTimers();
    await h.respond(2, { results: [], email: { query: 'other@example.org', status: 'unmatched' } });
    modal.querySelector('[data-add-email="other@example.org"]').click();
    h.change(modal.querySelector('[data-pending-role="other@example.org"]'), 'editor');
    modal.querySelector('[data-share-save]').click();
    assert.deepEqual(JSON.parse(h.requests[3].options.body), {
        expected_revision: 1, public: false,
        grants: [{ user_id: 'user-a', role: 'viewer' }, { user_id: 'user-b', role: 'reviewer' }],
        invitations: [{ email: 'friend@example.org', role: 'reviewer' }, { email: 'other@example.org', role: 'editor' }],
    });
    await h.respond(3, sharingRecord('note', 'note/1', { revision: 2 }));
});

test('sharing search responses cannot repaint a newer query or a dismissed dialog', async () => {
    const h = sharingHarness();
    const modal = await openSharing(h);
    const search = modal.querySelector('[data-share-search]');
    h.search(search, 'older'); h.runTimers();
    h.search(search, 'current'); h.runTimers();
    await h.respond(2, { results: [{ id: 'current', name: 'Current result' }] });
    await h.respond(1, { results: [{ id: 'older', name: 'Old result' }] });
    assert.ok(modal.querySelector('[data-add-user="current"]'));
    assert.equal(modal.querySelector('[data-add-user="older"]'), null);
    h.search(search, 'later'); h.runTimers();
    const results = modal.querySelector('[data-share-results]').innerHTML;
    h.sharing.close();
    await h.respond(3, { results: [{ id: 'late', name: 'Late result' }] });
    assert.equal(modal.querySelector('[data-share-results]').innerHTML, results);
    assert.equal(h.modal(), null);
});

test('a late sharing load cannot replace a newer dialog or resurrect a dismissed load', async () => {
    const h = sharingHarness();
    const older = h.sharing.open({ resourceType: 'note', resourceId: 'older' });
    const newer = h.sharing.open({ resourceType: 'folder', resourceId: 'newer' });
    await h.respond(1, sharingRecord('folder', 'newer'));
    await newer;
    const modal = h.modal();
    await h.respond(0, sharingRecord('note', 'older'));
    await older;
    assert.equal(h.modal(), modal);
    assert.equal(h.document.body.querySelectorAll('.notes-modal').length, 1);
    h.sharing.close();
    const dismissed = h.sharing.open({ resourceType: 'note', resourceId: 'dismissed' });
    h.sharing.close();
    await h.respond(2, sharingRecord('note', 'dismissed'));
    await dismissed;
    assert.equal(h.modal(), null);
});

test('a previous sharing save cannot close or change feedback in a newly opened dialog', { timeout: 5000 }, async () => {
    for (const success of [true, false]) {
        const h = sharingHarness();
        const saved = [];
        const old = await openSharing(h, 'note', 'old', value => saved.push(value));
        old.querySelector('[data-share-save]').click();
        const current = await openSharing(h, 'folder', 'current');
        current.querySelector('[data-share-error]').textContent = 'Current feedback';
        await h.respond(1, success ? sharingRecord('note', 'old', { revision: 2 }) : { error: 'Old save failed.' }, success ? 200 : 403);
        assert.equal(h.modal(), current);
        assert.equal(current.querySelector('[data-share-error]').textContent, 'Current feedback');
        assert.equal(saved.length, success ? 1 : 0);
        h.sharing.close();
        await settleSharing();
    }
});
