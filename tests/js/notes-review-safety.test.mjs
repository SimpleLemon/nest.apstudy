import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, FakeElement, ok, settle } from './helpers/notes-runtime.mjs';

function setupReview() {
    const harness = createHarness();
    const { bindReviewPanel } = harness.load('review/review-panel.js', ['bindReviewPanel']);
    const panel = new FakeElement();
    panel.hidden = true;
    const body = new FakeElement();
    const title = new FakeElement();
    panel.selectors.set('[data-review-panel-body]', [body]);
    panel.selectors.set('[data-review-panel-title]', [title]);
    const toasts = [];
    const changes = [];
    const runtime = bindReviewPanel({
        noteId: 'review-note', panel, canReview: true, canManageReviews: true, canViewVersions: true,
        toast: { show: (message) => toasts.push(message) }, onThreads: (...args) => changes.push(args),
    });
    return { ...harness, runtime, panel, body, title, toasts, changes };
}

const failures = [
    { name: 'network', reject: new Error('offline'), message: /connection/ },
    { name: '401', response: { ok: false, status: 401 }, message: /Sign in/ },
    { name: 'redirected sign-in', response: { redirected: true, ok: true }, message: /Sign in/ },
    { name: '403', response: { ok: false, status: 403, json: async () => ({}) }, message: /permission/ },
    { name: 'invalid JSON', response: { ok: true, json: async () => { throw new Error('html response'); } }, message: /invalid review data/ },
    { name: 'missing schema', response: ok({}), message: /invalid review data/ },
    { name: 'invalid record', response: ok({ threads: [null] }), message: /invalid review data/ },
    { name: 'invalid replies', response: ok({ threads: [{ id: 'a', replies: {} }] }), message: /invalid review data/ },
];

for (const failure of failures) {
    test(`review ${failure.name} failure is shown and preserves loaded comments on refresh`, async () => {
        const h = setupReview();
        const initial = h.runtime.open();
        h.requests[0].resolve(ok({ threads: [{ id: 'a', body: 'Existing comment', status: 'open' }] }));
        await initial;
        assert.match(h.body.innerHTML, /Existing comment/);
        const markup = h.body.innerHTML;
        const changes = h.changes.length;
        const refresh = h.runtime.refresh();
        if (failure.reject) h.requests[1].reject(failure.reject);
        else h.requests[1].resolve(failure.response);
        await refresh;
        assert.equal(h.body.innerHTML, markup);
        assert.equal(h.changes.length, changes, 'invalid data does not replace thread decorations');
        assert.match(h.toasts[0].message, failure.message);
        assert.equal(h.toasts[0].type, 'error');
        h.runtime.destroy();
    });
}

test('initial review load failure leaves visible error content and can retry', async () => {
    const h = setupReview();
    const initial = h.runtime.open();
    h.requests[0].reject(new Error('offline'));
    await initial;
    assert.match(h.body.innerHTML, /Check your connection/);
    const refresh = h.runtime.refresh();
    h.requests[1].resolve(ok({ threads: [] }));
    await refresh;
    assert.match(h.body.innerHTML, /No open comments/);
    h.runtime.destroy();
});

test('review action catches failure, releases duplicate guard and keeps existing panel', async () => {
    const h = setupReview();
    const loading = h.runtime.open();
    h.requests[0].resolve(ok({ threads: [{ id: 'a', body: 'Existing comment', status: 'open' }] }));
    await loading;
    const markup = h.body.innerHTML;
    const card = new FakeElement({ commentId: 'a' });
    const button = new FakeElement({ commentAction: 'resolve' });
    button.selectors.set('closest:[data-comment-id]', [card]);
    button.selectors.set('closest:[data-comment-action]', [button]);
    button.selectors.set('closest:button,input,form', [button]);
    h.panel.dispatch('click', { target: button });
    h.panel.dispatch('click', { target: button });
    assert.equal(h.requests.length, 2, 'duplicate action is coalesced');
    assert.match(h.requests[1].url, /comments\/a\/resolve$/);
    h.requests[1].reject(new Error('offline'));
    await settle();
    assert.equal(h.body.innerHTML, markup);
    assert.match(h.toasts[0].message, /connection/);
    h.panel.dispatch('click', { target: button });
    assert.equal(h.requests.length, 3, 'failed action can be retried');
    h.requests[2].resolve(ok({}));
    await settle();
    h.requests[3].resolve(ok({ threads: [{ id: 'a', body: 'Existing comment', status: 'resolved' }] }));
    await settle();
    assert.match(h.body.innerHTML, /No open comments/);
    h.runtime.destroy();
});

test('destroyed review ignores a late response and cannot reopen or notify', async () => {
    const h = setupReview();
    const loading = h.runtime.open();
    h.runtime.destroy();
    assert.equal(h.requests[0].options.signal.aborted, true);
    const markup = h.body.innerHTML;
    h.requests[0].resolve(ok({ threads: [{ id: 'a', status: 'open', body: 'Late comment' }] }));
    await loading;
    assert.equal(h.body.innerHTML, markup);
    assert.equal(h.panel.hidden, true);
    assert.equal(h.toasts.length, 0);
    await h.runtime.open();
    assert.equal(h.requests.length, 1);
    assert.equal(h.panel.hidden, true);
});

test('remote refresh coalesces bursts and retains active comment/reply drafts and selection', async () => {
    const h = createHarness();
    const panel = new FakeElement();
    const body = new FakeElement();
    panel.ownerDocument = { activeElement: null };
    panel.selectors.set('[data-review-panel-body]', [body]);
    panel.selectors.set('[data-review-panel-title]', [new FakeElement()]);
    let markup = '';
    let fields = [];
    Object.defineProperty(body, 'innerHTML', {
        get: () => markup,
        set: (value) => {
            markup = value;
            fields = ['reply', ...(value.includes('data-comment-create') ? ['comment'] : [])].map((kind) => {
                const field = new FakeElement();
                const form = { dataset: { commentReply: 'thread' }, matches: (selector) => selector === (kind === 'reply' ? '[data-comment-reply]' : '[data-comment-create]') };
                field.selectors.set('closest:form', [form]);
                field.focus = () => { panel.ownerDocument.activeElement = field; };
                field.setSelectionRange = (start, end) => { field.selectionStart = start; field.selectionEnd = end; };
                return field;
            });
            body.selectors.set('input[name], textarea[name]', fields);
        },
    });
    const { bindReviewPanel } = h.load('review/review-panel.js', ['bindReviewPanel']);
    const runtime = bindReviewPanel({ noteId: 'note', panel, canReview: true });
    const thread = { id: 'thread', body: 'Original', status: 'open', replies: [] };
    const opened = runtime.open();
    h.requests[0].resolve(ok({ threads: [thread] }));
    await opened;
    runtime.startComment({ kind: 'document', state: 'detached', version: 1 });
    h.requests[1].resolve(ok({ threads: [thread] }));
    await settle();
    const comment = fields[1];
    comment.value = 'Unsent comment';
    const reply = fields[0];
    reply.value = 'Unsent reply';
    reply.focus();
    reply.setSelectionRange(3, 7);
    const firstRefresh = runtime.refresh();
    for (let i = 0; i < 12; i++) assert.equal(runtime.refresh(), firstRefresh);
    assert.equal(h.requests.length, 3, 'one request stays in flight');
    assert.equal(h.requests[2].options.signal.aborted, false);
    h.requests[2].resolve(ok({ threads: [{ ...thread, body: 'Updated remotely' }] }));
    await settle();
    assert.equal(h.requests.length, 4, 'events during the request require one follow-up');
    h.requests[3].resolve(ok({ threads: [{ ...thread, body: 'Latest remote comment' }] }));
    await firstRefresh;
    assert.match(body.innerHTML, /Latest remote comment/);
    assert.equal(fields[1].value, 'Unsent comment');
    const retainedReply = fields[0];
    assert.equal(retainedReply.value, 'Unsent reply');
    assert.equal(panel.ownerDocument.activeElement, retainedReply);
    assert.equal(retainedReply.selectionStart, 3);
    assert.equal(retainedReply.selectionEnd, 7);
    const finalRefresh = runtime.refresh();
    runtime.refresh();
    runtime.destroy();
    assert.equal(h.requests[4].options.signal.aborted, true);
    h.requests[4].resolve(ok({ threads: [] }));
    await finalRefresh;
    assert.equal(h.requests.length, 5, 'disposal cancels the queued follow-up');
    assert.equal(h.timers.size, 0, 'alignment work is canceled on disposal');
});

test('refresh waits for initial open and a closed panel loads fresh activity on reopen', async () => {
    const h = setupReview();
    const open = h.runtime.open();
    const refresh = h.runtime.refresh();
    h.runtime.refresh();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].options.signal.aborted, false);
    h.requests[0].resolve(ok({ threads: [] }));
    await open;
    await settle();
    assert.equal(h.requests.length, 2);
    h.requests[1].resolve(ok({ threads: [] }));
    await refresh;
    h.runtime.close();
    await h.runtime.refresh();
    assert.equal(h.requests.length, 2);
    const reopened = h.runtime.open();
    h.requests[2].resolve(ok({ threads: [{ id: 'new', body: 'While closed', status: 'open' }] }));
    await reopened;
    assert.match(h.body.innerHTML, /While closed/);
    h.runtime.destroy();
});
