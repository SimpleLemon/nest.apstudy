/* global CustomEvent */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const serviceNames = ['csrf', 'pending-mutations', 'accessibility', 'date-time', 'session', 'http', 'presence', 'shell-chrome'];
const sourceFor = name => fs.readFileSync(`static/js/core/${name}.js`, 'utf8');

function runtime({ authenticated = false } = {}) {
    const eventSurface = () => {
        const listeners = new Map();
        return {
            addEventListener(type, listener) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(listener);
            },
            dispatchEvent(event) {
                for (const listener of listeners.get(event.type) || []) listener(event);
            },
        };
    };
    const storage = () => {
        const values = new Map();
        return {
            getItem: name => values.get(name) ?? null,
            setItem: (name, value) => values.set(name, value),
            clear: () => values.clear(),
            get length() { return values.size; },
        };
    };
    const attributes = new Set();
    const document = {
        ...eventSurface(),
        cookie: '',
        readyState: 'loading',
        hidden: false,
        documentElement: {
            toggleAttribute(name, value) { if (value) attributes.add(name); else attributes.delete(name); },
            hasAttribute: name => attributes.has(name),
        },
        body: { classList: { contains: () => false } },
        querySelector: selector => authenticated && selector.startsWith('global.thenav') ? {} : null,
        querySelectorAll: () => [],
        getElementById: () => ({ textContent: '[]' }),
    };
    const navigation = [];
    const window = {
        ...eventSurface(),
        location: {
            origin: 'https://nest.example', href: 'https://nest.example/chat', pathname: '/chat',
            assign: url => navigation.push(url),
        },
        sessionStorage: storage(), localStorage: storage(),
        fetch: async () => ({ ok: true }),
        Date,
    };
    Object.assign(window, { window, document, Request, Headers, URL, CustomEvent, Date,
        console: { warn() {}, error() {} },
    });
    const context = vm.createContext(window);
    window.eval = source => vm.runInContext(source, context);
    for (const name of serviceNames) window.eval(sourceFor(name));
    return { dom: { window: { close() {} } }, window, document, navigation, services: window.APStudyCoreServices };
}

test('definitions stay idle until the classic entry installs compatibility APIs', () => {
    const { dom, window } = runtime();
    try {
        const fetchBeforeInstall = window.fetch;
        assert.equal(window.APStudyPendingMutations, undefined);
        assert.equal(window.APStudyAccessibility, undefined);
        // The dynamic consent/viewport imports remain separately covered by their own suites.
        window.eval(sourceFor('global'));
        assert.notEqual(window.fetch, fetchBeforeInstall);
        assert.equal(typeof window.runLogoutFlow, 'function');
        assert.equal(window.runLogoutFlow, window.APStudyAuth.logout);
        assert.equal(typeof window.APStudyPendingMutations.track, 'function');
        assert.equal(typeof window.APStudyHttp.uploadXhr, 'function');
        assert.equal(window.APStudyDate.localInputToIso('invalid'), null);
        assert.equal(window.APStudyDate.toLocalInputValue(new window.Date(2026, 0, 2, 3, 4)), '2026-01-02T03:04');
    } finally {
        dom.window.close();
    }
});

test('pending mutations balance rejected work and guard unload only while saves are active', async () => {
    const { dom, window, document, services } = runtime();
    try {
        const pending = services.pendingMutations.createPendingMutations({ window, document });
        const counts = [];
        window.addEventListener('apstudy-pending-save-change', event => counts.push(event.detail.pending));
        const end = pending.begin('first');
        const rejection = pending.track(Promise.reject(new Error('save failed')), 'second');
        assert.equal(pending.count(), 2);
        const blocked = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(blocked);
        assert.equal(blocked.defaultPrevented, true);
        await assert.rejects(rejection, /save failed/);
        end();
        end();
        assert.deepEqual(counts, [1, 2, 1, 0]);
        assert.equal(document.documentElement.hasAttribute('data-pending-save'), false);
        const allowed = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(allowed);
        assert.equal(allowed.defaultPrevented, false);
    } finally {
        dom.window.close();
    }
});

test('presence keeps room scopes, visibility cadence, focus pauses, and lifecycle hooks', async () => {
    const { dom, window, document, services } = runtime({ authenticated: true });
    try {
        const requests = [];
        const intervals = new Map();
        let intervalId = 0;
        let lifecycle;
        window.fetch = async (url, options) => { requests.push({ url, ...options }); return { ok: true }; };
        window.setInterval = (_callback, delay) => { intervals.set(++intervalId, delay); return intervalId; };
        window.clearInterval = id => intervals.delete(id);
        window.APStudyPageLifecycle = { register: hooks => { lifecycle = hooks; } };
        const presence = services.presence.initializePresenceHeartbeat({ window, document });
        assert.equal(intervals.get(intervalId), 15000);
        presence.setChatRoom('room-1');
        assert.deepEqual(JSON.parse(requests.at(-1).body).scopes, [
            { scope_type: 'chat', scope_id: 'global' }, { scope_type: 'chat', scope_id: 'room-1' },
        ]);
        document.hidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        assert.equal(intervals.get(intervalId), 60000);
        window.dispatchEvent(new CustomEvent('apstudy:focus-state', { detail: { active: true } }));
        assert.equal(intervals.size, 0);
        lifecycle.resume();
        assert.equal(intervals.size, 0);
        window.dispatchEvent(new CustomEvent('apstudy:focus-state', { detail: { active: false } }));
        assert.equal(intervals.size, 1);
        lifecycle.pause();
        assert.equal(intervals.size, 0);
        lifecycle.resume();
        assert.equal(intervals.size, 1);
        presence.stop();
        const afterStop = requests.length;
        await presence.send();
        assert.equal(requests.length, afterStop);
        assert.equal(intervals.size, 0);
    } finally {
        dom.window.close();
    }
});

test('logout revokes subscriptions before clearing local state and preserves cookies for the server POST', async () => {
    const { dom, window, document, navigation, services } = runtime();
    try {
        const order = [];
        const cookies = 'csrf_token=token';
        document.cookie = cookies;
        window.sessionStorage.setItem('session', 'value');
        window.localStorage.setItem('local', 'value');
        window.APStudyPresenceHeartbeat = { stop: () => order.push('stop') };
        window.APStudyNotifications = { disableCurrent: async () => order.push('revoke') };
        window.APStudyToast = { show: () => order.push('toast') };
        window.fetch = async (url, options) => {
            order.push('post');
            assert.equal(url, '/logout');
            assert.equal(options.method, 'POST');
            assert.equal(document.cookie, cookies);
            assert.equal(window.localStorage.length, 0);
            assert.equal(window.sessionStorage.getItem('apstudy-logged-out'), 'true');
            return { ok: true };
        };
        await services.session.createSessionService({ window, document }).logout();
        assert.deepEqual(order, ['stop', 'revoke', 'post']);
        assert.deepEqual(navigation, ['https://nest.example/login']);
    } finally {
        dom.window.close();
    }
});

test('the shared classic script chain loads every service definition after primitives', () => {
    const partial = fs.readFileSync('templates/_shared_runtime_assets.html', 'utf8');
    for (const name of serviceNames) {
        const token = `js/core/${name}.js`;
        assert.ok(partial.indexOf(token) > partial.indexOf('js/core/ui-primitives.js'));
        assert.match(partial.split('\n').find(line => line.includes(token)), / defer>/);
        const adapter = sourceFor(`${name}-module`);
        assert.ok(adapter.includes(`import './${name}.js'`));
        assert.ok(adapter.includes('export const'));
    }
});


test('CSRF installation publishes one reusable handle and wraps fetch only once', async () => {
    const { window, document, services } = runtime();
    document.cookie = 'csrf_token=old-token';
    const requests = [];
    window.fetch = async (input) => {
        requests.push(input);
        if (input === '/auth/csrf') {
            document.cookie = 'csrf_token=fresh-token';
            return new Response('{}');
        }
        return new Response('{}', requests.length === 1
            ? { status: 400, headers: { 'X-APStudy-CSRF-Error': '1' } }
            : {});
    };
    const first = services.csrf.installCsrfFetch({ window, document });
    const installedFetch = window.fetch;
    assert.equal(window.APStudyCsrf, first);
    assert.equal(services.csrf.installCsrfFetch({ window, document }), first);
    assert.equal(window.fetch, installedFetch);
    await window.fetch('https://nest.example/api/focus', { method: 'POST', body: '{}' });
    assert.equal(requests.length, 3);
    assert.equal(requests[0].headers.get('X-CSRFToken'), 'old-token');
    assert.equal(requests[2].headers.get('X-CSRFToken'), 'fresh-token');
    assert.equal(first.token(), 'fresh-token');
});

test('HTTP preserves decoded JSON values including null and false', async () => {
    const { window, services } = runtime();
    const http = services.http.createHttpService({ window });
    for (const jsonMode of ['required', 'optional', 'content-type']) {
        for (const value of [null, false, 0, '', [], { saved: true }]) {
            window.fetch = async () => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
            assert.equal(JSON.stringify(await http.fetchJson('/decoded', { jsonMode })), JSON.stringify(value));
        }
    }
});

test('HTTP HEAD and 204/205 skip JSON decoding for both required and default modes', async () => {
    const { window, services } = runtime();
    const http = services.http.createHttpService({ window });
    for (const jsonMode of ['required', 'content-type']) {
        for (const [method, status] of [['HEAD', 200], ['GET', 204], ['POST', 205]]) {
            const response = new Response(null, { status, headers: { 'Content-Type': 'application/json' } });
            let decoded = false;
            response.json = () => { decoded = true; throw new Error('Bodyless response was decoded'); };
            window.fetch = async () => response;
            assert.equal(JSON.stringify(await http.fetchJson('/empty', { method, jsonMode })), '{}');
            assert.equal(decoded, false);
        }
    }
});

test('HTTP inherits Request methods for bodyless decoding and pending writes, with explicit options taking precedence', async () => {
    const { window, document, services } = runtime();
    const pending = services.pendingMutations.createPendingMutations({ window, document });
    const http = services.http.createHttpService({ window, pendingMutations: pending });
    const head = new Request('https://nest.example/empty', { method: 'HEAD' });
    window.fetch = async () => new Response(null, { headers: { 'Content-Type': 'application/json' } });
    assert.equal(JSON.stringify(await http.fetchJson(head, { jsonMode: 'required' })), '{}');

    const response = Promise.withResolvers();
    window.fetch = () => response.promise;
    const post = new Request('https://nest.example/save', { method: 'POST' });
    const operation = http.fetchJson(post, { pendingLabel: 'save' });
    assert.equal(pending.count(), 1);
    response.resolve(new Response('{"saved":true}', { headers: { 'Content-Type': 'application/json' } }));
    assert.equal((await operation).saved, true);
    assert.equal(pending.count(), 0);

    const overridden = Promise.withResolvers();
    window.fetch = (input, options) => {
        assert.equal(input, post);
        assert.equal(options.method, 'GET');
        return overridden.promise;
    };
    const read = http.fetchJson(post, { method: 'GET', pendingLabel: 'save' });
    assert.equal(pending.count(), 0);
    overridden.resolve(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    await read;
});

test('HTTP retains Request headers and reports its URL, with explicit headers replacing the original set', async () => {
    const { window, services } = runtime();
    const http = services.http.createHttpService({ window });
    const input = new Request('https://nest.example/request', { headers: { Accept: 'application/json', 'X-Request-ID': 'original' } });
    window.fetch = async (url, options) => {
        assert.equal(url, input);
        assert.equal(options.headers.accept, 'application/json');
        assert.equal(options.headers['x-request-id'], 'original');
        return new Response('broken', { headers: { 'Content-Type': 'application/json' } });
    };
    await assert.rejects(http.fetchJson(input), error => error.url === input.url && error.cause instanceof SyntaxError);
    window.fetch = async (_url, options) => {
        assert.deepEqual({ ...options.headers }, { 'X-Request-ID': 'replacement' });
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    };
    await http.fetchJson(input, { headers: { 'X-Request-ID': 'replacement' } });
});

test('required JSON rejects ordinary malformed, empty and HTML successes with context and clears pending work', async () => {
    const { window, document, services } = runtime();
    const pending = services.pendingMutations.createPendingMutations({ window, document });
    const http = services.http.createHttpService({ window, pendingMutations: pending });
    for (const [body, contentType] of [['broken', 'application/json'], ['', 'application/json'], ['<html>Login</html>', 'text/html']]) {
        const response = new Response(body, { headers: { 'Content-Type': contentType } });
        const decode = Promise.withResolvers();
        const originalJson = response.json.bind(response);
        response.json = async () => { await decode.promise; return originalJson(); };
        window.fetch = async () => response;
        const operation = http.fetchJson('/mandatory', { method: 'PATCH', jsonMode: 'required', pendingLabel: 'save' });
        assert.equal(pending.count(), 1);
        await Promise.resolve();
        assert.equal(pending.count(), 1);
        decode.resolve();
        await assert.rejects(operation, error => {
            assert.equal(error.status, 200);
            assert.equal(error.url, '/mandatory');
            assert.equal(error.response, response);
            assert.ok(error.cause instanceof SyntaxError);
            return true;
        });
        assert.equal(pending.count(), 0);
    }
});

test('HTTP required failures retain errorFactory message, failed decode and transport identity', async () => {
    const { window, services } = runtime();
    const http = services.http.createHttpService({ window });
    const response = new Response('invalid', { status: 503 });
    window.fetch = async () => response;
    await assert.rejects(http.fetchJson('/mandatory', { jsonMode: 'required', errorFactory: () => new Error('Feature failed') }), error => {
        assert.equal(error.message, 'Feature failed');
        assert.equal(error.status, 503);
        assert.equal(error.response, response);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
    });
    const networkError = new Error('Network offline');
    window.fetch = async () => { throw networkError; };
    await assert.rejects(http.fetchJson('/mandatory', { jsonMode: 'required' }), error => error === networkError);
});

test('HTTP response validators reject before decoding and always release pending work', async () => {
    const { window, document, services } = runtime();
    const pending = services.pendingMutations.createPendingMutations({ window, document });
    const http = services.http.createHttpService({ window, pendingMutations: pending });
    const response = new Response('<html>Login</html>');
    let decoded = false;
    response.json = () => { decoded = true; throw new Error('Unexpected decode'); };
    let requestOptions;
    window.fetch = async (_url, options) => { requestOptions = options; return response; };
    const rejected = new Error('Sign in again');
    const operation = http.fetchJson('/guarded', { method: 'POST', pendingLabel: 'save', jsonMode: 'required',
        validateResponse: value => { assert.equal(value, response); throw rejected; } });
    assert.equal(pending.count(), 1);
    await assert.rejects(operation, error => error === rejected && error.status === 200 && error.response === response && error.url === '/guarded');
    assert.equal(decoded, false);
    assert.equal(pending.count(), 0);
    assert.equal('validateResponse' in requestOptions, false);
});

test('HTTP payload validators share failed-decode and server metadata while default HTTP failures still reject', async () => {
    const { window, services } = runtime();
    const http = services.http.createHttpService({ window });
    let response = new Response('invalid');
    window.fetch = async () => response;
    await assert.rejects(http.fetchJson('/envelope', { jsonMode: 'optional', validatePayload: () => { throw new Error('Acknowledgment missing'); } }), error => {
        assert.equal(error.message, 'Acknowledgment missing');
        assert.equal(error.response, response);
        assert.ok(error.cause instanceof SyntaxError);
        return true;
    });
    response = new Response('{"ok":false,"code":"quota","limit":3,"current":3}', { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(http.fetchJson('/envelope', { validatePayload: (payload, value) => {
        assert.equal(value, response);
        assert.equal(payload.ok, false);
        throw new Error('No capacity');
    } }), error => error.status === 200 && error.code === 'quota' && error.limit === 3 && error.current === 3);
    response = new Response('{"message":"Server unavailable"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(http.fetchJson('/envelope', { validateResponse() {}, validatePayload() {} }), error => error.status === 503 && error.message === 'Server unavailable');
});
