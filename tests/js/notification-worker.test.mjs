import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../static/service-worker.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function worker({ windows = [] } = {}) {
    const listeners = new Map();
    const shown = []; const badges = []; const opened = [];
    const self = {
        location: { origin: 'https://nest.example' },
        addEventListener: (name, callback) => listeners.set(name, callback),
        registration: { showNotification: async (title, options) => shown.push({ title, options }) },
        navigator: { setAppBadge: async count => badges.push(count), clearAppBadge: async () => badges.push(0) },
    };
    const clients = {
        async matchAll(options) { assert.deepEqual({ ...options }, { type: 'window', includeUncontrolled: true }); return windows; },
        async openWindow(url) { opened.push(url); return { url }; },
    };
    vm.runInNewContext(source, { self, clients, URL, Date, console });
    async function dispatch(type, event) {
        let completion;
        listeners.get(type)({ ...event, waitUntil: promise => { completion = promise; } });
        assert.ok(completion, 'The browser owns work until the handler completes');
        return completion;
    }
    return { dispatch, shown, badges, opened };
}

test('service worker push preserves notification content, badge count and a same-origin target', async () => {
    const w = worker();
    await w.dispatch('push', { data: { json: () => ({ id: 'one', title: 'Course update', body: 'A seat opened', url: '/courses?q=BIO#saved', badgeCount: 4 }) } });
    assert.equal(w.shown[0].title, 'Course update');
    assert.equal(w.shown[0].options.body, 'A seat opened');
    assert.equal(w.shown[0].options.tag, 'one');
    assert.equal(w.shown[0].options.data.url, '/courses?q=BIO#saved');
    assert.deepEqual(w.badges, [4]);
});

test('malformed push payload uses the default message and clears the badge', async () => {
    const w = worker();
    await w.dispatch('push', { data: { json: () => { throw new SyntaxError('Malformed'); } } });
    assert.equal(w.shown[0].title, 'Nest.APStudy');
    assert.equal(w.shown[0].options.body, 'You have a new notification.');
    assert.equal(w.shown[0].options.data.url, '/dashboard?notifications=open');
    assert.deepEqual(w.badges, [0]);
});

for (const target of ['https://outside.example/private', '//outside.example/private', 'javascript:alert(1)']) test(`notification clicks contain unsafe target ${target}`, async () => {
    const w = worker(); let closed = false;
    await w.dispatch('notificationclick', { notification: { data: { url: target }, close: () => { closed = true; } } });
    assert.equal(closed, true);
    assert.deepEqual(w.opened, ['/dashboard?notifications=open']);
});

test('notification click waits for an existing window to navigate before focusing its result', async () => {
    const navigation = Promise.withResolvers();
    const calls = [];
    const navigated = { focus: async () => calls.push('focus-destination') };
    const w = worker({ windows: [
        { url: 'https://outside.example/', navigate: async () => assert.fail('An outside window cannot be selected') },
        { url: 'https://nest.example/chat', navigate: url => { calls.push(`navigate:${url}`); return navigation.promise; }, focus: async () => calls.push('focus-before-navigation') },
    ] });
    const completion = w.dispatch('notificationclick', { notification: { data: { url: '/tasks?view=today' }, close() {} } });
    try {
        await flush();
        assert.deepEqual(calls, ['navigate:/tasks?view=today']);
    } finally { navigation.resolve(navigated); }
    await completion;
    assert.deepEqual(calls, ['navigate:/tasks?view=today', 'focus-destination']);
    assert.deepEqual(w.opened, []);
});

for (const failure of ['rejected', 'closed']) test(`notification click opens a fresh target when existing navigation is ${failure}`, async () => {
    const w = worker({ windows: [{ url: 'https://nest.example/chat',
        navigate: async () => { if (failure === 'rejected') throw new Error('Window closed'); return null; },
        focus: async () => assert.fail('A failed navigation cannot be focused'),
    }] });
    await w.dispatch('notificationclick', { notification: { data: { url: '/notes#shared' }, close() {} } });
    assert.deepEqual(w.opened, ['/notes#shared']);
});
