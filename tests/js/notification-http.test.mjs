import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const httpSource = await readFile(new URL('../../static/js/core/http.js', import.meta.url), 'utf8');
const notificationSource = await readFile(new URL('../../static/js/core/notifications.js', import.meta.url), 'utf8');

function runtime(fetch, { pushFailure } = {}) {
    const badge = { textContent: '', hidden: true };
    const host = { querySelector: () => badge };
    const listeners = new Map();
    const prompts = [];
    const feedback = [];
    const createControl = () => {
        const handlers = new Map();
        return { disabled: false, addEventListener(type, callback) { handlers.set(type, callback); }, click: () => handlers.get('click')?.() };
    };
    const document = {
        readyState: 'loading', cookie: 'csrf_token=token', addEventListener() {},
        getElementById: () => host,
        querySelector: () => prompts.find(prompt => !prompt.removed) || null,
        body: { appendChild: prompt => prompts.push(prompt) },
        createElement() {
            const controls = new Map(['[data-not-now]', '[data-enable]'].map(selector => [selector, createControl()]));
            return { setAttribute() {}, querySelector: selector => controls.get(selector), remove() { this.removed = true; } };
        },
    };
    let pending = 0;
    const tracker = { track(operation) { pending += 1; return operation.finally(() => { pending -= 1; }); } };
    const Notification = { permission: pushFailure ? 'granted' : 'default' };
    const window = { fetch, document, Notification, APStudyToast: { show: options => feedback.push(options) },
        addEventListener(type, callback) { listeners.set(type, callback); },
    };
    const navigator = {};
    if (pushFailure) {
        const registration = { update: async () => {}, pushManager: { getSubscription: async () => { throw pushFailure; } } };
        Object.assign(window, { isSecureContext: true, PushManager: {} });
        navigator.serviceWorker = { register: async () => registration, ready: Promise.resolve(registration) };
    }
    const context = vm.createContext({ window, document, navigator, Notification, URL, FormData, console,
        setTimeout, clearTimeout, atob: globalThis.atob });
    vm.runInContext(httpSource, context);
    window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations: tracker });
    vm.runInContext(notificationSource, context);
    return { api: window.APStudyNotifications, badge, prompts, feedback, showIntent: () => listeners.get("apstudy:notification-intent")(), pending: () => pending };
}

for (const [name, expectedMessage] of [
    ['NotAllowedError', /Notifications are blocked/], ['AbortError', /push service/],
    ['InvalidStateError', /no longer valid/], ['SecurityError', /HTTPS connection/],
]) {
    test(`notification ${name} feedback preserves its original exception`, async () => {
        const failure = new globalThis.DOMException('Browser failure', name);
        const { api } = runtime(async () => new Response('{"push_configured":true,"vapid_public_key":"AQ=="}',
            { headers: { 'Content-Type': 'application/json' } }), { pushFailure: failure });
        await assert.rejects(api.enable('Test browser'), error => {
            assert.match(error.message, expectedMessage);
            assert.equal(error.cause, failure);
            return true;
        });
    });
}

test('notification malformed success rejects with HTTP context and leaves unread count intact', async () => {
    let response = new Response('{"unread_count":5}', { headers: { 'Content-Type': 'application/json' } });
    const { api, badge } = runtime(async () => response);
    await api.refreshCount();
    assert.equal(badge.textContent, '5');
    response = new Response('invalid', { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(api.api('/api/notifications/unread-count'), error => {
        assert.equal(error.status, 200);
        assert.equal(error.url, '/api/notifications/unread-count');
        assert.equal(error.response, response);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
    });
    response = new Response('invalid', { headers: { 'Content-Type': 'application/json' } });
    await api.refreshCount();
    assert.equal(badge.textContent, '5');
    assert.equal(badge.hidden, false);
});

test('notification HTTP failure preserves status, response and failed decode cause', async () => {
    const response = new Response('invalid', { status: 503 });
    const { api } = runtime(async () => response);
    await assert.rejects(api.api('/api/notifications/subscriptions'), error => {
        assert.equal(error.status, 503);
        assert.equal(error.url, '/api/notifications/subscriptions');
        assert.equal(error.response, response);
        assert.ok(error.cause instanceof SyntaxError);
        assert.match(error.message, /Notification request failed/);
        return true;
    });
});

test('notification writes stay pending until their response decoding finishes', async () => {
    let decode;
    const decoding = Promise.withResolvers();
    const response = { ok: true, status: 200, url: '', headers: new Headers(),
        json: () => new Promise(resolve => { decode = resolve; decoding.resolve(); }) };
    const { api, pending } = runtime(async (_url, options) => {
        assert.equal(options.headers['X-CSRFToken'], 'token');
        return response;
    });
    const operation = api.api('/api/notifications/subscriptions', { method: 'POST', body: '{}' });
    await decoding.promise;
    assert.equal(pending(), 1);
    decode({ ok: true });
    assert.deepEqual(await operation, { ok: true });
    assert.equal(pending(), 0);
});

test('actual Not now listener contains rejected PATCH, retains prompt and allows a successful retry', async () => {
    const failure = new Error('Offline');
    let writes = 0;
    const fixture = runtime(async (_url, options) => {
        if (options.method === 'PATCH') {
            writes += 1;
            assert.deepEqual(JSON.parse(options.body), { prompt_dismissed: true });
            if (writes === 1) throw failure;
            return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{"preferences":{"prompt_dismissed":false}}', { headers: { 'Content-Type': 'application/json' } });
    });
    await fixture.showIntent();
    assert.equal(fixture.prompts.length, 1);
    const prompt = fixture.prompts[0];
    const button = prompt.querySelector('[data-not-now]');
    const dismissal = button.click();
    assert.equal(button.disabled, true);
    assert.equal(fixture.pending(), 1);
    await assert.doesNotReject(dismissal);
    assert.equal(prompt.removed, undefined);
    assert.equal(button.disabled, false);
    assert.equal(fixture.pending(), 0);
    assert.match(fixture.feedback[0].title, /Couldn’t dismiss/);
    assert.match(fixture.feedback[0].message, /Not now.*again/);
    await button.click();
    assert.equal(prompt.removed, true);
    assert.equal(writes, 2);
});
