import assert from 'node:assert/strict';
import test from 'node:test';
import { flushNotifications, notificationWorld } from './helpers/notification-runtime.mjs';

const delivered = (id, extra = {}) => ({ id, title: `Update ${id}`, body: 'A new update', is_read: false, ...extra });
const syncs = tab => tab.requests().filter(request => request.url.endsWith('/sync') && request.body.active);

for (const useLocks of [true, false]) test(`foreground notification ${useLocks ? 'lock' : 'lease'} leadership hands off between real shells`, async () => {
    const world = notificationWorld({ useLocks });
    const respond = request => request.url.endsWith('/sync')
        ? { active: request.body.active, notifications: [], unread_count: 7, focus_mode_active: true }
        : { unread_count: 0 };
    const first = world.tab('first', { respond });
    const second = world.tab('second', { respond });
    await first.start(); await second.start();
    assert.equal(syncs(first).length, 1);
    assert.equal(syncs(second).length, 0);
    await world.advance(15000);
    assert.equal(syncs(first).length, 2);
    assert.equal(syncs(second).length, 0);
    assert.equal(second.badge.textContent, '7');
    assert.equal(second.tray.unread, 7);
    assert.equal(second.focusModes.at(-1), true);
    await first.blur(); await world.advance(5000);
    assert.equal(syncs(first).length, 2);
    assert.equal(syncs(second).length, 1);
    const relinquish = first.requests().find(request => request.url.endsWith('/sync') && !request.body.active);
    assert.equal(relinquish.options.keepalive, true);
    await second.visibility(true); await first.focus();
    assert.equal(syncs(first).length, 3);
    assert.equal(syncs(second).length, 1);
});

test('foreground bootstrap, deduplication and acknowledgement retry preserve delivery meaning', async () => {
    const world = notificationWorld();
    let cycle = 0; let acknowledgements = 0;
    const tab = world.tab('delivery', { respond(request) {
        if (request.url.endsWith('/foreground-ack')) {
            acknowledgements += 1;
            if (acknowledgements === 1) throw new Error('Acknowledgement offline');
            return { ok: true };
        }
        if (!request.url.endsWith('/sync')) return { unread_count: 0 };
        cycle += 1;
        return cycle === 1
            ? { active: true, notifications: [delivered('historical'), delivered('pending'), delivered('already-read', { is_read: true }), delivered('muted', { foreground_enabled: false })], pending_foreground_ids: ['pending', 'not-in-feed'], unread_count: 3 }
            : { active: true, notifications: [delivered('historical'), delivered('pending'), delivered('next')], pending_foreground_ids: ['pending'], unread_count: 4 };
    } });
    await tab.start();
    assert.deepEqual(tab.toasts.map(toast => toast.title), ['Update pending']);
    assert.equal(acknowledgements, 1);
    await world.advance(15000);
    assert.deepEqual(tab.toasts.map(toast => toast.title), ['Update pending', 'Update next']);
    assert.equal(acknowledgements, 2);
    const acknowledgementsSent = tab.requests().filter(request => request.url.endsWith('/foreground-ack'));
    assert.deepEqual(acknowledgementsSent.map(request => request.body.ids), [['pending'], ['pending']]);
    assert.equal(tab.badge.textContent, '4');
});

test('failed open-tray refresh retries presentation before acknowledging pending items', async () => {
    const world = notificationWorld();
    const tab = world.tab('tray', { respond: request => request.url.endsWith('/sync')
        ? { active: true, notifications: [delivered('pending')], pending_foreground_ids: ['pending'], unread_count: 1 }
        : { unread_count: 0 } });
    tab.tray.opened = true;
    tab.tray.refreshFailure = new Error('Tray offline');
    await tab.start();
    assert.equal(tab.tray.refreshes, 1);
    assert.equal(tab.requests().filter(request => request.url.endsWith('/foreground-ack')).length, 0);
    tab.tray.refreshFailure = null;
    await world.advance(15000);
    assert.equal(tab.tray.refreshes, 2);
    assert.equal(tab.toasts.length, 0);
    assert.equal(tab.requests().filter(request => request.url.endsWith('/foreground-ack')).length, 1);
});

for (const transition of ['blur', 'visibility', 'pagehide']) test(`an active sync completed after ${transition} cannot deliver or acknowledge`, async () => {
    const world = notificationWorld();
    const pending = Promise.withResolvers();
    const tab = world.tab('late', { respond: request => request.url.endsWith('/sync') && request.body.active
        ? pending.promise : { active: false, unread_count: 0 } });
    await tab.start();
    if (transition === 'blur') await tab.blur();
    else if (transition === 'visibility') await tab.visibility(true);
    else await tab.dispatch('pagehide', { persisted: true });
    pending.resolve({ active: true, notifications: [delivered('late')], pending_foreground_ids: ['late'], unread_count: 1 });
    await flushNotifications();
    assert.equal(tab.toasts.length, 0);
    assert.equal(tab.requests().filter(request => request.url.endsWith('/foreground-ack')).length, 0);
});

test('BFCache suspension releases all delivery timers and restores one channel on pageshow', async () => {
    const world = notificationWorld();
    const tab = world.tab('lifecycle');
    await tab.start();
    assert.equal(world.channelCount(), 1);
    assert.equal(syncs(tab).length, 1);
    await tab.dispatch('pagehide', { persisted: true });
    assert.equal(tab.activeTimers(), 0);
    assert.equal(world.channelCount(), 0);
    assert.equal(world.leader(), null);
    await world.advance(30000);
    assert.equal(syncs(tab).length, 1);
    await tab.dispatch('pageshow', { persisted: true });
    assert.equal(world.channelCount(), 1);
    assert.equal(syncs(tab).length, 2);
    await tab.dispatch('pageshow', { persisted: true });
    await world.advance(15000);
    assert.equal(world.channelCount(), 1);
    assert.equal(syncs(tab).length, 3);
});

test('a response from an earlier foreground tenure cannot overwrite resumed delivery', async () => {
    const world = notificationWorld();
    const pending = [Promise.withResolvers(), Promise.withResolvers()];
    let activeCalls = 0;
    const tab = world.tab('resumed', { respond: request => request.url.endsWith('/sync') && request.body.active
        ? pending[activeCalls++].promise : { active: false, unread_count: 0 } });
    await tab.start(); await tab.blur(); await tab.focus();
    assert.equal(activeCalls, 2);
    pending[1].resolve({ active: true, notifications: [delivered('current')], pending_foreground_ids: ['current'], unread_count: 2, focus_mode_active: false });
    await flushNotifications();
    pending[0].resolve({ active: true, notifications: [delivered('obsolete')], pending_foreground_ids: ['obsolete'], unread_count: 9, focus_mode_active: true });
    await flushNotifications();
    assert.deepEqual(tab.toasts.map(toast => toast.title), ['Update current']);
    assert.equal(tab.badge.textContent, '2');
    assert.equal(tab.focusModes.at(-1), false);
    assert.deepEqual(tab.requests().filter(request => request.url.endsWith('/foreground-ack')).map(request => request.body.ids), [['current']]);
});

test('push enable replaces a changed application key and persists the new subscription', async () => {
    const world = notificationWorld();
    const operations = [];
    const existing = { endpoint: 'https://push.example/old', options: { applicationServerKey: new Uint8Array([1]) }, unsubscribe: async () => operations.push('unsubscribe') };
    const replacement = { endpoint: 'https://push.example/new', options: { applicationServerKey: new Uint8Array([2]) }, toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'test-key', auth: 'test-auth' } }) };
    const tab = world.tab('push', { pushManager: {
        getSubscription: async () => existing,
        subscribe: async options => { operations.push('subscribe'); assert.equal(options.userVisibleOnly, true); assert.deepEqual([...options.applicationServerKey], [2]); return replacement; },
    }, respond(request) {
        if (request.url.endsWith('/preferences')) return { push_configured: true, vapid_public_key: 'Ag==' };
        operations.push(request.url.endsWith('/current/delete') ? 'delete-old' : 'save-new');
        return { saved: true };
    } });
    assert.deepEqual(await tab.api.enable('Test desktop'), { saved: true });
    assert.deepEqual(operations, ['unsubscribe', 'subscribe', 'delete-old', 'save-new']);
    const writes = tab.requests().filter(request => request.options.method === 'POST');
    assert.deepEqual(writes[0].body, { endpoint: 'https://push.example/old' });
    assert.deepEqual(writes[1].body, { subscription: replacement.toJSON(), device_name: 'Test desktop' });
    assert.equal(tab.subscriptions[0].url, '/service-worker.js');
});

test('push disable retains the browser subscription when server deletion fails', async () => {
    const world = notificationWorld();
    let unsubscribed = 0; let offline = true;
    const tab = world.tab('disable', { pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/existing', unsubscribe: async () => { unsubscribed += 1; } }) },
        respond() { if (offline) throw new Error('Delete offline'); return { ok: true }; } });
    await assert.rejects(tab.api.disableCurrent(), /Delete offline/);
    assert.equal(unsubscribed, 0);
    offline = false; await tab.api.disableCurrent();
    assert.equal(unsubscribed, 1);
    assert.deepEqual(tab.requests().at(-1).body, { endpoint: 'https://push.example/existing' });
});

for (const forceRefresh of [false, true]) test(`a matching push key ${forceRefresh ? 'can be explicitly refreshed' : 'reuses the current subscription'}`, async () => {
    const world = notificationWorld();
    let removals = 0; let creations = 0;
    const subscription = { endpoint: 'https://push.example/current', options: { applicationServerKey: new Uint8Array([2]) },
        unsubscribe: async () => { removals += 1; }, toJSON: () => ({ endpoint: 'https://push.example/current' }) };
    const tab = world.tab('matching', { pushManager: {
        getSubscription: async () => subscription, subscribe: async () => { creations += 1; return subscription; },
    }, respond: request => request.url.endsWith('/preferences') ? { push_configured: true, vapid_public_key: 'Ag==' } : { ok: true } });
    await tab.api.enable('Desktop', { forceRefresh });
    assert.equal(removals, forceRefresh ? 1 : 0);
    assert.equal(creations, forceRefresh ? 1 : 0);
    assert.equal(tab.requests().filter(request => request.url.endsWith('/current/delete')).length, forceRefresh ? 1 : 0);
});

test('denied push permission reports its cause before registering or subscribing', async () => {
    const world = notificationWorld();
    const tab = world.tab('denied', { pushManager: { getSubscription: async () => assert.fail('Permission was denied') },
        respond: () => ({ push_configured: true, vapid_public_key: 'Ag==' }) });
    tab.window.Notification.permission = 'default';
    tab.window.Notification.requestPermission = async () => 'denied';
    await assert.rejects(tab.api.enable(), error => {
        assert.match(error.message, /Notifications are blocked/);
        assert.equal(error.cause.name, 'NotAllowedError');
        return true;
    });
    assert.equal(tab.subscriptions.length, 0);
});

test('mobile shells do not register foreground activity or acknowledge desktop delivery', async () => {
    const world = notificationWorld();
    const tab = world.tab('mobile', { mobile: true });
    await tab.start(); await world.advance(30000); await tab.dispatch('pagehide');
    assert.equal(tab.requests().filter(request => /\/(sync|foreground-ack)$/.test(request.url)).length, 0);
    assert.equal(tab.toasts.length, 0);
});
