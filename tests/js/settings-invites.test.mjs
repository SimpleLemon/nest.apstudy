import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createParsedDOM } from './helpers/parsed-dom.mjs';
import { loadFeatureModule } from './helpers/feature-modules.cjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const invite = (changes = {}) => ({
    id: 'invite/1', code: 'STUDY', label: 'Study group', url: 'https://nest.example/invite/STUDY',
    is_active: true, invited_count: 1, joined_count: 1,
    people: [{ user_id: 'user/1', name: 'Ada', can_message: true, status: 'joined' }], ...changes,
});
const payload = (changes = {}) => ({ invites: [invite()], can_create: true, empty_invite_limit: 5, ...changes });
function harness() {
    const { window, document } = createParsedDOM('https://nest.example/settings');
    const template = fs.readFileSync('templates/settings.html', 'utf8');
    const start = template.indexOf('<article class="settings-card settings-invites-card"');
    const section = document.createElement('section');
    section.innerHTML = template.slice(start, template.indexOf('</article>', start) + '</article>'.length);
    document.body.appendChild(section);
    const requests = [], toasts = [], copied = [], navigations = [], timers = [];
    let clipboardError = null;
    window.fetch = (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
    window.APStudyToast = { show: toast => toasts.push(toast) };
    window.setTimeout = callback => { timers.push(callback); return timers.length; };
    window.location.assign = url => navigations.push(url);
    const navigator = { clipboard: { async writeText(value) { if (clipboardError) throw clipboardError; copied.push(value); } } };
    const context = vm.createContext({ window, document, navigator, Error, URL, setTimeout: window.setTimeout, clearTimeout() {} });
    vm.runInContext(fs.readFileSync('static/js/core/http.js', 'utf8'), context);
    window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
    const { createSettingsInvites } = loadFeatureModule('settings/invites.js', context);
    const controller = createSettingsInvites();
    controller.bindInviteControls();
    return {
        document, window, requests, toasts, copied, navigations, controller,
        query: selector => document.querySelector(selector),
        submit(form) { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); },
        async respond(index, value, status = 200) {
            requests[index].resolve(new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }));
            await settle();
        },
        denyClipboard() { clipboardError = new Error('Clipboard denied'); },
        flushTimers() { timers.splice(0).forEach(callback => callback()); },
    };
}
async function load(h, value = payload()) {
    const activation = h.controller.activateInvites();
    await h.respond(0, value);
    await activation;
}

test('invite load failure retries through the rendered control and successful hydration is reused', async () => {
    const h = harness();
    const activation = h.controller.activateInvites();
    await h.respond(0, { error: 'Invite service unavailable.' }, 503);
    await activation;
    assert.match(h.query('#settings-invites-list').innerHTML, /Invite service unavailable/);
    h.query('[data-invite-action="retry"]').click();
    await h.respond(1, payload({ invites: [] }));
    assert.match(h.query('#settings-invites-list').innerHTML, /No invite links yet/);
    await h.controller.activateInvites();
    assert.equal(h.requests.length, 2);
});

test('invite creation retains the label on failure and applies the acknowledged quota', async () => {
    const h = harness();
    await load(h, payload({ invites: [] }));
    const input = h.query('#settings-invite-label');
    const button = h.query('#settings-invite-create-button');
    input.value = '  Group work  ';
    h.submit(h.query('#settings-invite-create'));
    assert.equal(button.disabled, true);
    assert.equal(h.requests[1].options.method, 'POST');
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { label: 'Group work' });
    await h.respond(1, { error: 'Quota check unavailable.' }, 503);
    assert.equal(input.value, '  Group work  ');
    assert.equal(button.disabled, false);
    h.submit(h.query('#settings-invite-create'));
    await h.respond(2, payload({ can_create: false }));
    assert.equal(input.value, '');
    assert.equal(button.disabled, true);
    assert.equal(input.disabled, true);
    assert.match(h.query('#settings-invites-status').textContent, /limit of 5 unused invite links/);
    assert.equal(h.toasts.at(-1).message, 'Invite link created.');
});

test('invite rename cancellation restores focus and failed saves retain the edited label', async () => {
    const h = harness();
    await load(h);
    let rename = h.query('[data-invite-action="rename"]');
    rename.click();
    const form = h.query('[data-invite-rename]');
    const input = form.querySelector('input');
    assert.equal(form.hidden, false);
    assert.equal(h.document.activeElement, input);
    input.dispatchEvent(new h.window.Event('keydown', { bubbles: true, key: 'Escape' }));
    assert.equal(form.hidden, true);
    assert.equal(h.document.activeElement, rename);
    rename.click();
    input.value = '  Research group  ';
    h.submit(form);
    assert.equal(h.requests[1].url, '/settings/api/invites/invite%2F1');
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { label: 'Research group' });
    await h.respond(1, { error: 'Rename denied.' }, 403);
    assert.equal(h.query('[data-invite-rename]'), form);
    assert.equal(input.value, '  Research group  ');
    assert.equal(form.hidden, false);
    h.submit(form);
    await h.respond(2, payload({ invites: [invite({ label: 'Research group' })] }));
    rename = h.query('[data-invite-action="rename"]');
    assert.equal(h.document.activeElement, rename);
    assert.equal(h.query('[data-invite-label-display]').querySelector('strong').textContent, 'Research group');
});

test('invite active-state changes use acknowledged rows and preserve the existing row on failure', async () => {
    const h = harness();
    await load(h, payload({ can_create: false }));
    const deactivate = h.query('[data-invite-action="deactivate"]');
    deactivate.click();
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { is_active: false });
    await h.respond(1, { error: 'Update failed.' }, 500);
    assert.equal(h.query('[data-invite-action="deactivate"]'), deactivate);
    deactivate.click();
    await h.respond(2, payload({ invites: [invite({ is_active: false })] }));
    const reactivate = h.query('[data-invite-action="reactivate"]');
    assert.equal(h.document.activeElement, reactivate);
    assert.equal(h.query('#settings-invite-create-button').disabled, false);
    reactivate.click();
    assert.deepEqual(JSON.parse(h.requests[3].options.body), { is_active: true });
    await h.respond(3, payload());
    assert.equal(h.document.activeElement, h.query('[data-invite-action="deactivate"]'));
});

test('invite copy and message controls recover on failure and navigate only with a thread acknowledgment', async () => {
    const h = harness();
    await load(h);
    const copy = h.query('[data-invite-action="copy"]');
    copy.click(); await settle();
    assert.deepEqual(h.copied, ['https://nest.example/invite/STUDY']);
    assert.equal(copy.textContent, 'Copied');
    h.flushTimers();
    assert.equal(copy.textContent, 'Copy link');
    h.denyClipboard();
    copy.click(); await settle();
    assert.equal(h.toasts.at(-1).type, 'error');
    const message = h.query('[data-invite-action="message"]');
    message.click();
    assert.equal(message.disabled, true);
    assert.deepEqual(JSON.parse(h.requests[1].options.body), { user_id: 'user/1' });
    await h.respond(1, {});
    assert.equal(message.disabled, false);
    assert.deepEqual(h.navigations, []);
    message.click();
    await h.respond(2, { thread: { id: 'thread/1' } });
    assert.deepEqual(h.navigations, ['/chat?thread=thread%2F1']);
});
