import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { createSettingsDOM } from './helpers/settings-dom.mjs';

const settingsDirectory = new URL('../../static/js/settings/', import.meta.url);
const httpSource = await readFile(new URL('../../static/js/core/http.js', import.meta.url), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function installSharedHttp(window, pendingMutations) {
  window.FormData = FormData;
  vm.runInNewContext(httpSource, { window, URL, Error, FormData });
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window, pendingMutations });
}

async function withSettings(url, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nest-settings-test-'));
  const dom = createSettingsDOM(url);
  const { window } = dom;
  window.matchMedia = () => ({ matches: false });
  const toasts = [];
  const requests = [];
  window.APStudyToast = { show: (toast) => toasts.push(toast) };
  window.APStudyUIPrimitives = { escapeHtml(value) { const node = window.document.createElement('span'); node.textContent = value; return node.innerHTML; } };
  window.APStudyFormField = { markInvalid() {}, clearInvalid() {}, clearAll() {}, bindAutoClear() {} };
  window.APStudyNotifications = {
    support: () => ({ supported: false }),
    api: async () => ({ push_configured: false, devices: [], preferences: {} }),
  };
  window.APSTUDY_SET_THEME_PREFERENCE = (theme) => window.document.documentElement.setAttribute('data-theme', theme);
  window.APStudyHttp = { fetchJson: async (url, options = {}) => { requests.push({ url, options }); return {}; } };
  const globals = { window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, history: window.history, CustomEvent: window.CustomEvent, FormData: globalThis.FormData, requestAnimationFrame: (callback) => callback(), matchMedia: window.matchMedia, APStudyCoreServices: {} };
  const previous = new Map();
  for (const [name, value] of Object.entries(globals)) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    await cp(settingsDirectory, path.join(directory, 'settings'), { recursive: true });
    await cp(new URL('../../static/js/calendar/feed-links.js', import.meta.url), path.join(directory, 'calendar/feed-links.js'), { recursive: true });
    await cp(new URL('../../static/js/core/profile-policy.js', import.meta.url), path.join(directory, 'core/profile-policy.js'), { recursive: true });
    for (const name of ['escaping.js', 'ui-primitives-module.js']) {
      await cp(new URL(`../../static/js/core/${name}`, import.meta.url), path.join(directory, 'core', name), { recursive: true });
    }
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    const load = (name) => import(pathToFileURL(path.join(directory, 'settings', `${name}.js`)));
    await run({ window, document: window.document, load, toasts, requests });
  } finally {
    window.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    await rm(directory, { recursive: true, force: true });
  }
}

const bootstrap = {
  profile: { id: 'member-1', name: 'Taylor', username: 'taylor', email: 'taylor@example.com', picture_url: '/avatar.png', school: 'Emory University', major: 'Biology', graduation_year: '2028' },
  settings: { interface_theme: 'nest-dark', sidebar_default: 'expanded', language: 'en', timezone: 'America/New_York', canvas_ical_url: 'https://canvas.example.com/feed', email_notifications: true, product_updates: false, task_sound_enabled: true, chat_sound_enabled: false },
  other_calendar_urls: ['https://calendar.example.com/one'],
  discord: { linked: true, username: 'Taylor' },
  storage_usage_bytes: 1024,
  notes_count: 2,
  files_count: 1,
  entitlements: { label: 'Free', storage_usage_bytes: 1024, storage_limit_bytes: 2048, limits: {}, usage: {} },
};

test('settings composition hydrates domains, preserves hash navigation, profile saves, and preference preview', async () => {
  await withSettings('https://nest.example/settings/#preferences', async ({ window, document, load, requests }) => {
    window.APStudyHttp.fetchJson = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/bootstrap')) return structuredClone(bootstrap);
      if (url.endsWith('/profile')) return { name: 'New name', username: 'new_name', picture_url: '/avatar.png' };
      if (url.endsWith('/interface-preferences')) return JSON.parse(options.body);
      if (url.endsWith('/invites')) return { invites: [] };
      return {};
    };
    const { initializeSettingsPage } = await load('page');
    await initializeSettingsPage();
    assert.equal(document.getElementById('settings-skeleton').hidden, true);
    assert.equal(document.querySelector('.settings-sections').getAttribute('aria-busy'), 'false');
    assert.equal(document.getElementById('preferences').hidden, false);
    assert.equal(document.getElementById('account').hidden, true);
    assert.equal(document.getElementById('settings-display-name').value, 'Taylor');
    assert.equal(document.getElementById('settings-language').value, 'en');
    assert.equal(document.querySelector('[data-tier-storage-progress]').style.transform, 'scaleX(0.5)');
    document.querySelector('[data-tab="data"]').click();
    assert.equal(window.location.hash, '#data');
    assert.equal(document.getElementById('data').hidden, false);
    assert.equal(document.querySelector('[data-tab="data"]').getAttribute('aria-current'), 'page');
    window.history.replaceState(null, '', '#notifications');
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    assert.equal(document.getElementById('notifications').hidden, false);

    const name = document.getElementById('settings-display-name');
    name.value = 'New name'; name.dispatchEvent(new window.Event('input'));
    document.getElementById('settings-username-input').value = 'NEW_NAME';
    const dirty = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    assert.equal(dirty.defaultPrevented, true);
    document.getElementById('settings-save-profile').click();
    await settle();
    const profileRequest = requests.find(({ url }) => url.endsWith('/profile'));
    assert.equal(JSON.parse(profileRequest.options.body).username, 'new_name');
    assert.equal(document.getElementById('settings-preview-name').textContent, 'New name');
    const saved = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saved);
    assert.equal(saved.defaultPrevented, false);

    document.querySelector('[data-theme="parchment-light"]').click();
    assert.equal(document.documentElement.getAttribute('data-theme'), 'parchment-light');
    assert.equal(requests.some(({ url }) => url.endsWith('/interface-preferences')), false);
    document.querySelector('[data-toggle-field="product_updates"]').click();
    document.getElementById('settings-sidebar-default').value = 'collapsed';
    document.getElementById('settings-save-appearance').click();
    await settle();
    const preferenceRequest = requests.find(({ url }) => url.endsWith('/interface-preferences'));
    const preferences = JSON.parse(preferenceRequest.options.body);
    assert.equal(preferences.interface_theme, 'parchment-light');
    assert.equal(preferences.product_updates, true);
    assert.equal(preferences.timezone, 'America/New_York');
    assert.equal(window.localStorage.getItem('sidebar-collapsed'), 'true');
    assert.equal(window.APStudySettingsUtils, undefined);
    assert.equal(window.APStudySettingsProfile, undefined);
  });
});

test('calendar form removes and restores rows in place and saves through its existing endpoint', async () => {
  await withSettings('https://nest.example/settings/', async ({ document, load, requests, toasts }) => {
    const { createSettingsCalendar } = await load('calendar');
    const preferences = { settings: { canvas_ical_url: '' } };
    const state = { otherCalendarUrls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'] };
    const calendar = createSettingsCalendar(state, preferences);
    calendar.mount(); calendar.hydrate();
    const host = document.getElementById('settings-other-calendar-links');
    host.children[1].querySelector('button').click();
    assert.deepEqual([...host.querySelectorAll('input')].map((node) => node.value), ['https://example.com/a', 'https://example.com/c']);
    toasts.at(-1).action.onClick();
    assert.deepEqual([...host.querySelectorAll('input')].map((node) => node.value), state.otherCalendarUrls);
    document.getElementById('settings-save-calendar-links').click();
    await settle();
    assert.equal(requests[0].url, '/settings/api/feed-url');
    assert.deepEqual(JSON.parse(requests[0].options.body).other_ical_urls, state.otherCalendarUrls);
    assert.deepEqual(preferences.settings.other_calendar_urls, state.otherCalendarUrls);
    host.querySelectorAll('input')[1].value = 'https://example.com/a';
    document.getElementById('settings-save-calendar-links').click();
    await settle();
    assert.equal(requests.length, 1, 'duplicates must be rejected without a mutation');
    assert.equal(toasts.at(-1).type, 'error');
  });
});

test('profile save preserves drafts entered in other settings forms while it is pending', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests }) => {
    let completeProfile;
    window.APStudyHttp.fetchJson = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/bootstrap')) return structuredClone(bootstrap);
      if (url.endsWith('/profile')) return new Promise((resolve) => { completeProfile = resolve; });
      if (url.endsWith('/interface-preferences')) return JSON.parse(options.body);
      return {};
    };
    await (await load('page')).initializeSettingsPage();
    const name = document.getElementById('settings-display-name');
    name.value = 'Edited name'; name.dispatchEvent(new window.Event('input'));
    document.getElementById('settings-save-profile').click();

    document.getElementById('settings-language').value = 'fr';
    document.getElementById('settings-timezone').value = 'Europe/Paris';
    document.querySelector('[data-theme="parchment-light"]').click();
    document.getElementById('settings-sidebar-default').value = 'collapsed';
    document.querySelector('[data-toggle-field="product_updates"]').click();
    const canvas = document.getElementById('settings-canvas-feed-url');
    canvas.value = 'https://canvas.example.com/draft';
    const host = document.getElementById('settings-other-calendar-links');
    const originalRow = host.children[0];
    originalRow.querySelector('input').value = 'https://calendar.example.com/draft';
    document.getElementById('settings-add-other-calendar').click();
    const addedRow = host.children[1];
    addedRow.querySelector('input').value = 'https://calendar.example.com/new';
    completeProfile({ name: 'Saved name', username: 'taylor' });
    await settle();

    assert.equal(name.value, 'Saved name');
    assert.equal(document.getElementById('settings-preview-name').textContent, 'Saved name');
    const saved = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saved);
    assert.equal(saved.defaultPrevented, false, 'saved profile becomes the profile baseline');
    assert.equal(document.getElementById('settings-language').value, 'fr');
    assert.equal(document.getElementById('settings-timezone').value, 'Europe/Paris');
    assert.equal(document.getElementById('settings-theme').value, 'parchment-light');
    assert.equal(document.getElementById('settings-sidebar-default').value, 'collapsed');
    assert.equal(document.querySelector('[data-toggle-field="product_updates"]').getAttribute('aria-pressed'), 'true');
    assert.equal(canvas.value, 'https://canvas.example.com/draft');
    assert.equal(host.children[0], originalRow);
    assert.equal(host.children[1], addedRow);
    assert.deepEqual(host.querySelectorAll('input').map((input) => input.value), ['https://calendar.example.com/draft', 'https://calendar.example.com/new']);
    assert.equal(requests.filter(({ url }) => !url.endsWith('/bootstrap')).length, 1);

    document.getElementById('settings-save-region').click();
    document.getElementById('settings-save-calendar-links').click();
    await settle();
    const preferences = JSON.parse(requests.find(({ url }) => url.endsWith('/interface-preferences')).options.body);
    assert.equal(preferences.language, 'fr');
    assert.equal(preferences.timezone, 'Europe/Paris');
    const calendar = JSON.parse(requests.find(({ url }) => url.endsWith('/feed-url')).options.body);
    assert.equal(calendar.canvas_ical_url, 'https://canvas.example.com/draft');
    assert.deepEqual(calendar.other_ical_urls, ['https://calendar.example.com/draft', 'https://calendar.example.com/new']);
  });
});

test('Discord unlink stays undoable and callback query cleanup preserves the active hash', async () => {
  await withSettings('https://nest.example/settings/?discord=error&source=profile#account', async ({ window, document, load, requests }) => {
    let staged;
    window.APStudyUndo = { stage: (operation) => { staged = operation; } };
    const state = { discord: { linked: true, username: 'Taylor' } };
    const { createSettingsDiscord } = await load('discord');
    const discord = createSettingsDiscord(state);
    discord.renderDiscordButton(); discord.bindDiscordControls(); discord.notifyDiscordLinkResult();
    assert.equal(window.location.search, '?source=profile');
    assert.equal(window.location.hash, '#account');
    document.getElementById('settings-discord-button').click();
    assert.equal(document.getElementById('settings-discord-modal').hidden, false);
    document.getElementById('settings-discord-unlink').click();
    assert.equal(state.discord.linked, false);
    assert.equal(requests.length, 0);
    staged.restore();
    assert.equal(state.discord.linked, true);
    assert.equal(document.getElementById('settings-discord-button').classList.contains('is-linked'), true);
    await staged.commit({ reason: 'pagehide' });
    assert.equal(requests[0].url, '/settings/api/discord/unlink');
    assert.equal(requests[0].options.keepalive, true);
  });
});

test('account deletion waits for confirm and undo commit before logout', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests }) => {
    let staged; let logouts = 0;
    window.APStudyConfirm = { request: async () => true };
    window.APStudyUndo = { stage: (operation) => { staged = operation; } };
    window.APStudyAuth = { logout: () => { logouts += 1; } };
    const { createSettingsAccount } = await load('account');
    createSettingsAccount(() => 'current@example.com').mount();
    document.getElementById('settings-delete-account').click();
    await settle();
    assert.equal(requests.length, 0); assert.equal(logouts, 0);
    staged.restore(); assert.equal(logouts, 0);
    await staged.commit({ reason: 'pagehide' });
    staged.onCommit();
    assert.equal(requests[0].url, '/settings/api/account/delete');
    assert.equal(requests[0].options.keepalive, true); assert.equal(logouts, 1);
  });
});

test('failed bootstrap clears loading UI and still resolves invalid hashes', async () => {
  await withSettings('https://nest.example/settings/#unknown', async ({ window, document, load, toasts }) => {
    window.APStudyHttp.fetchJson = async () => { throw new Error('Settings are unavailable'); };
    const originalError = console.error;
    console.error = () => {};
    try { await (await load('page')).initializeSettingsPage(); }
    finally { console.error = originalError; }
    assert.equal(document.getElementById('settings-skeleton').hidden, true);
    assert.equal(document.getElementById('account').hidden, false);
    assert.equal(toasts.at(-1).title, 'Couldn’t load settings');
  });
});

test('avatar controller validates uploads and preserves profile preview and modal behavior', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, toasts }) => {
    const mutations = [];
    let capturedBaselines = 0;
    const state = { profile: { name: 'Taylor', picture_url: '/old.png' } };
    window.fetch = async (url, options) => {
      mutations.push({ url, options });
      return { ok: true, headers: { get: () => 'application/json' }, json: async () => ({ picture_url: '/new.png' }) };
    };
    installSharedHttp(window);
    const { createSettingsAvatar } = await load('avatar');
    createSettingsAvatar(state, () => {}, () => { capturedBaselines += 1; }).bind();
    document.getElementById('settings-avatar-upload-button').click();
    assert.equal(document.getElementById('settings-avatar-modal').hidden, false);
    assert.equal(document.body.classList.contains('settings-avatar-modal-open'), true);
    const dropzone = document.getElementById('settings-avatar-dropzone');
    dropzone.dispatchEvent(new window.Event('drop', { cancelable: true, dataTransfer: { types: ['Files'], files: [new Blob(['text'], { type: 'text/plain' })] } }));
    assert.equal(mutations.length, 0);
    assert.equal(toasts.at(-1).type, 'error');
    dropzone.dispatchEvent(new window.Event('drop', { cancelable: true, dataTransfer: { types: ['Files'], files: [new Blob(['image'], { type: 'image/png' })] } }));
    await settle();
    assert.equal(mutations[0].url, '/settings/api/avatar-upload');
    assert.equal(mutations[0].options.body.get('avatar').type, 'image/png');
    assert.equal(state.profile.name, 'Taylor');
    assert.equal(state.profile.picture_url, '/new.png');
    assert.equal(document.getElementById('settings-avatar-preview').src, '/new.png');
    assert.equal(capturedBaselines, 1);
    document.dispatchEvent(new window.Event('keydown', { key: 'Escape' }));
    assert.equal(document.getElementById('settings-avatar-modal').hidden, true);
  });
});

test('multipart settings saves keep browser headers and remain pending through response decoding', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, load }) => {
    let completeDecode;
    let pending = 0;
    let tracked = 0;
    const requests = [];
    window.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, headers: { get: () => 'application/json' }, json: () => new Promise((resolve) => { completeDecode = resolve; }) };
    };
    installSharedHttp(window, { track(promise, label) {
      assert.equal(label, 'settings-save');
      tracked += 1; pending += 1;
      return promise.finally(() => { pending -= 1; });
    } });
    const body = new FormData(); body.set('avatar', new Blob(['image'], { type: 'image/png' }));
    const { fetchFormData } = await load('utils');
    const request = fetchFormData('/settings/api/avatar-upload', body);
    await settle();
    assert.equal(pending, 1, 'decoding is still part of the pending save');
    assert.equal(tracked, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.body, body);
    assert.equal(Object.keys(requests[0].options.headers).some((name) => name.toLowerCase() === 'content-type'), false, 'browser must generate the multipart boundary');
    completeDecode({ picture_url: '/saved.png' });
    assert.deepEqual(await request, { picture_url: '/saved.png' });
    assert.equal(pending, 0);
  });
});

test('multipart settings errors retain HTTP context and settle pending saves after decoding failure', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, load }) => {
    const cause = new SyntaxError('Bad response JSON');
    const responses = [
      { ok: false, status: 503, statusText: 'Service Unavailable', url: 'https://nest.example/settings/api/avatar-upload', headers: { get: () => 'application/json' }, json: async () => { throw cause; } },
      { ok: true, status: 200, url: '', headers: { get: () => 'application/json' }, json: async () => { throw cause; } },
      { ok: false, status: 413, statusText: 'Payload Too Large', url: '', headers: { get: () => 'text/html' }, json: async () => { throw cause; } },
      { ok: false, status: 422, statusText: 'Unprocessable Content', url: '', headers: { get: () => 'application/json' }, json: async () => ({ error: 'Choose a smaller image.', code: 'avatar_size' }) },
    ];
    let response;
    let pending = 0;
    let tracked = 0;
    window.fetch = async () => response;
    installSharedHttp(window, { track(promise) {
      tracked += 1; pending += 1;
      return promise.finally(() => { pending -= 1; });
    } });
    const { fetchFormData } = await load('utils');
    const url = '/settings/api/avatar-upload';
    for (const item of responses) {
      response = item;
      await assert.rejects(fetchFormData(url, new FormData()), (error) => {
        assert.equal(error.status, item.status);
        assert.equal(error.url, item.url || url);
        assert.equal(error.response, item);
        assert.equal(error.cause, item.status === 503 || item.status === 413 || item.ok ? cause : undefined);
        assert.equal(error.message, item.ok ? 'Invalid JSON response.' : item.status === 422 ? 'Choose a smaller image.' : item.statusText);
        if (item.status === 422) assert.equal(error.code, 'avatar_size');
        return true;
      });
      assert.equal(pending, 0);
    }
    const networkError = new TypeError('Connection lost');
    window.fetch = async () => { throw networkError; };
    await assert.rejects(fetchFormData(url, new FormData()), (error) => error === networkError);
    assert.equal(pending, 0);
    assert.equal(tracked, 5);
  });
});

test('notification initialization binds and saves when the page is already ready', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load }) => {
    const save = document.createElement('button'); save.id = 'notification-save'; save.setAttribute('id', 'notification-save'); document.body.appendChild(save);
    const toggle = document.createElement('button'); toggle.setAttribute('data-push-toggle', 'dm_enabled'); document.body.appendChild(toggle);
    const requests = [];
    window.APStudyNotifications.api = async (url, options = {}) => {
      requests.push({ url, options });
      return { push_configured: false, devices: [], preferences: options.body ? JSON.parse(options.body) : { dm_enabled: false } };
    };
    (await load('notifications')).initializeNotificationSettings();
    await settle();
    toggle.click(); save.click();
    await settle();
    assert.equal(requests[1].url, '/api/notifications/preferences');
    assert.equal(requests[1].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[1].options.body), { dm_enabled: true });
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  });
});

test('failed profile and preference saves retain edits and report actionable errors', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    window.APStudyHttp.fetchJson = async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/bootstrap')) return structuredClone(bootstrap);
      throw new Error('Please retry after reconnecting');
    };
    await (await load('page')).initializeSettingsPage();
    const name = document.getElementById('settings-display-name');
    name.value = 'Unsaved name'; name.dispatchEvent(new window.Event('input'));
    document.getElementById('settings-save-profile').click();
    await settle();
    assert.equal(name.value, 'Unsaved name');
    assert.equal(toasts.at(-1).title, 'Couldn’t save profile');
    const dirty = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    assert.equal(dirty.defaultPrevented, true);
    document.querySelector('[data-theme="parchment-light"]').click();
    document.getElementById('settings-sidebar-default').value = 'collapsed';
    document.getElementById('settings-save-appearance').click();
    await settle();
    assert.equal(toasts.at(-1).title, 'Couldn’t save preferences');
    assert.equal(document.documentElement.getAttribute('data-theme'), 'parchment-light');
    assert.equal(document.getElementById('settings-sidebar-default').value, 'collapsed');
    assert.equal(window.localStorage.getItem('sidebar-collapsed'), null);
    assert.equal(requests.filter(({ url }) => url.endsWith('/profile')).length, 1);
    assert.equal(requests.filter(({ url }) => url.endsWith('/interface-preferences')).length, 1);
  });
});

test('account cancellation and deletion failure never log out or lose recovery feedback', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    let confirmed = false; let logouts = 0;
    window.APStudyConfirm = { request: async () => confirmed };
    window.APStudyAuth = { logout: () => { logouts += 1; } };
    window.APStudyHttp.fetchJson = async (url, options = {}) => {
      requests.push({ url, options });
      throw new Error('Account service unavailable');
    };
    (await load('account')).createSettingsAccount(() => 'current@example.com').mount();
    document.getElementById('settings-delete-account').click();
    await settle();
    assert.equal(requests.length, 0);
    confirmed = true;
    document.getElementById('settings-delete-account').click();
    await settle();
    assert.equal(requests[0].url, '/settings/api/account/delete');
    assert.equal(logouts, 0);
    assert.equal(toasts.at(-1).title, 'Couldn’t delete account');
    document.getElementById('settings-change-password').click();
    const originalError = console.error;
    console.error = () => {};
    try { await settle(); } finally { console.error = originalError; }
    assert.equal(requests[1].url, '/settings/api/account/recovery');
    assert.equal(toasts.at(-1).title, 'Couldn’t send reset email');
  });
});

test('Discord unlink failure restores the linked account and closes the modal', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    const state = { discord: { linked: true, username: 'Taylor' } };
    window.APStudyHttp.fetchJson = async (url, options = {}) => {
      requests.push({ url, options });
      throw new Error('Discord service unavailable');
    };
    const discord = (await load('discord')).createSettingsDiscord(state);
    discord.bindDiscordControls(); discord.renderDiscordButton();
    document.getElementById('settings-discord-button').click();
    document.getElementById('settings-discord-unlink').click();
    assert.equal(state.discord.linked, false);
    await settle();
    assert.deepEqual(state.discord, { linked: true, username: 'Taylor' });
    assert.equal(document.getElementById('settings-discord-button').classList.contains('is-linked'), true);
    assert.equal(document.getElementById('settings-discord-modal').hidden, true);
    assert.equal(requests[0].url, '/settings/api/discord/unlink');
    assert.equal(toasts.at(-1).title, 'Couldn’t unlink Discord');
  });
});


test('settings clipboard fallback rejects failed copying, cleans up, and reports failure', async () => {
  await withSettings('https://nest.example/settings/', async ({ document, load, toasts }) => {
    const originalCreate = document.createElement;
    let temporaryInput;
    document.createElement = (tag) => {
      const node = originalCreate(tag);
      node.select = () => {};
      if (tag === 'input') temporaryInput = node;
      return node;
    };
    const { copyText } = await load('utils');
    document.execCommand = () => false;
    const initialChildren = document.body.children.length;
    await assert.rejects(copyText('feed-address'), /Clipboard access failed/);
    assert.equal(document.body.children.length, initialChildren);
    assert.equal(document.body.children.includes(temporaryInput), false);
    document.execCommand = () => { throw new Error('Copy was denied'); };
    await assert.rejects(copyText('feed-address'), /Copy was denied/);
    assert.equal(document.body.children.length, initialChildren);

    const button = document.createElement('button');
    button.setAttribute('data-copy-target', 'settings-canvas-feed-url');
    button.innerHTML = 'Copy';
    document.body.appendChild(button);
    document.getElementById('settings-canvas-feed-url').value = 'feed-address';
    (await load('copy-controls')).bindSettingsCopyButtons();
    document.execCommand = () => false;
    button.click();
    await settle();
    assert.equal(button.innerHTML, 'Copy');
    assert.equal(button.classList.contains('is-copied'), false);
    assert.equal(toasts.at(-1).type, 'error');
    assert.match(toasts.at(-1).message, /Clipboard access failed/);
    assert.equal(document.body.children.length, initialChildren + 1);

    document.execCommand = () => true;
    button.click();
    await settle();
    assert.equal(button.classList.contains('is-copied'), true);
    assert.equal(toasts.at(-1).type, 'success');
    assert.equal(document.body.children.length, initialChildren + 1);
  });
});

test('settings copy controls report native clipboard rejection without success feedback', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, toasts }) => {
    window.navigator.clipboard = { writeText: async () => { throw new Error('Clipboard permission denied'); } };
    const button = document.createElement('button');
    button.setAttribute('data-copy-target', 'settings-user-id');
    button.innerHTML = 'Copy';
    document.body.appendChild(button);
    document.getElementById('settings-user-id').value = 'user-1';
    (await load('copy-controls')).bindSettingsCopyButtons();
    button.click();
    await settle();
    assert.equal(button.innerHTML, 'Copy');
    assert.equal(button.classList.contains('is-copied'), false);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, 'error');
    assert.equal(toasts[0].message, 'Clipboard permission denied');
  });
});

test('calendar validation identifies the offending row once, including blanks and Canvas equivalence', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    const invalid = [];
    window.APStudyFormField.markInvalid = (input) => invalid.push(input);
    const preferences = { settings: { canvas_ical_url: 'https://canvas.example/feed/' } };
    const state = { otherCalendarUrls: ['', 'webcal://CANVAS.example/feed#calendar'] };
    const calendar = (await load('calendar')).createSettingsCalendar(state, preferences);
    calendar.mount(); calendar.hydrate();
    const host = document.getElementById('settings-other-calendar-links');
    const inputs = host.querySelectorAll('input');
    const save = document.getElementById('settings-save-calendar-links');
    save.click(); await settle();
    assert.equal(requests.length, 0);
    assert.deepEqual(invalid, [inputs[1]]);
    assert.match(toasts.at(-1).message, /Canvas calendar/);
    inputs[1].value = 'calendar.example/no-scheme';
    save.click(); await settle();
    assert.equal(requests.length, 0);
    assert.equal(invalid.at(-1), inputs[1]);
    inputs[0].value = 'https://calendar.example/feed/';
    inputs[1].value = 'webcal://CALENDAR.example/feed';
    save.click(); await settle();
    assert.equal(requests.length, 0);
    assert.equal(invalid.at(-1), inputs[1]);
    assert.match(toasts.at(-1).message, /Duplicate/);
    inputs[1].value = 'webcal://calendar.example/other';
    save.click(); await settle();
    assert.deepEqual(JSON.parse(requests[0].options.body).other_ical_urls, ['https://calendar.example/feed/', 'webcal://calendar.example/other']);
  });
});

async function installExtensionControls(window, document, load) {
  for (const [tag, id] of [['div', 'extension-connection-accounts'], ['p', 'extension-connection-status'], ['button', 'extension-connection-refresh']]) {
    const node = document.createElement(tag); node.setAttribute('id', id); document.body.appendChild(node);
  }
  const pendingSource = await readFile(new URL('../../static/js/core/pending-mutations.js', import.meta.url), 'utf8');
  vm.runInNewContext(pendingSource, { window, document, CustomEvent: window.CustomEvent });
  window.APStudyPendingMutations = window.APStudyCoreServices.pendingMutations.createPendingMutations({ window, document });
  const tracked = [];
  const failures = [];
  const track = window.APStudyPendingMutations.track;
  window.APStudyPendingMutations.track = (promise, label) => {
    tracked.push(label);
    return track(promise.catch(error => { failures.push(error); throw error; }), label);
  };
  (await load('extension')).initializeExtensionSettings();
  await settle();
  const button = (label) => document.getElementById('extension-connection-accounts').querySelectorAll('button').find(node => node.textContent === label);
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
  };
  return { button, unload, tracked, failures, status: document.getElementById('extension-connection-status') };
}
const extensionData = {
  ok: true,
  capabilities: { calendar_upload: true, calendar_two_way_writeback: true, calendar_mirroring: true },
  sources: [{ source_ref: 'canvas/one', label: 'Canvas', access: { '1': { granted: false }, '2': { granted: false, scopes: [] } }, activity: [{ event_ref: 'event-1', id: 'write-1', state: 'conflict' }] }],
};
const extensionResponse = (data) => ({ ok: true, status: 200, url: '', json: async () => data });

// Exercise the actual controls with the shell's pending service and unload listener.
test('extension PUT/POST saves guard navigation through fetch and decode; GET refresh stays untracked', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load }) => {
    const previousFetch = globalThis.fetch;
    const requests = [];
    let completeFetch; let completeDecode; let completeGet;
    globalThis.fetch = (url, options) => {
      requests.push({ url, options });
      if (options.method !== 'GET') return new Promise(resolve => { completeFetch = () => resolve({ ok: true, status: 200, json: () => new Promise(done => { completeDecode = done; }) }); });
      if (url.endsWith('/conflict')) return Promise.resolve(extensionResponse({ ok: true, conflict: { canvasSnapshot: { title: 'Canvas' }, nestSnapshot: { title: 'Nest' }, expected_revision: 2 } }));
      return Promise.resolve(extensionResponse(extensionData));
    };
    try {
      const controls = await installExtensionControls(window, document, load);
      assert.deepEqual(controls.tracked, []); assert.equal(controls.unload(), false);
      controls.button('Allow history and ongoing reads').click();
      assert.equal(controls.unload(), true);
      assert.equal(window.APStudyPendingMutations.count(), 1);
      assert.equal(document.documentElement.getAttribute('data-pending-save'), '');
      const consent = requests.at(-1);
      assert.equal(consent.options.method, 'PUT');
      assert.equal(consent.url, '/api/extension/connection/canvas%2Fone/consent');
      assert.equal(consent.options.credentials, 'same-origin');
      assert.equal(consent.options.cache, 'no-store');
      assert.equal(consent.options.headers.Accept, 'application/json');
      assert.equal(JSON.parse(consent.options.body).version, 1);
      completeFetch(); await settle();
      assert.equal(controls.unload(), true, 'response decoding still guards navigation');
      completeDecode({ ok: true }); await settle();
      assert.equal(window.APStudyPendingMutations.count(), 0);
      assert.equal(controls.unload(), false);
      controls.button('Review conflict').click(); await settle();
      controls.button('Keep Nest').click();
      assert.equal(requests.at(-1).options.method, 'POST');
      assert.deepEqual(JSON.parse(requests.at(-1).options.body), { choice: 'keep_nest', expected_revision: 2 });
      assert.equal(controls.unload(), true);
      completeFetch(); await settle(); assert.equal(controls.unload(), true);
      completeDecode({ ok: true }); await settle();
      assert.equal(controls.unload(), false);
      assert.deepEqual(controls.tracked, ['settings-save', 'settings-save']);
      globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(resolve => { completeGet = resolve; }) });
      document.getElementById('extension-connection-refresh').click(); await settle();
      assert.equal(controls.unload(), false, 'GET decoding does not guard navigation');
      assert.deepEqual(controls.tracked, ['settings-save', 'settings-save']);
      completeGet(extensionData); await settle();
    } finally { globalThis.fetch = previousFetch; }
  });
});

test('extension errors retain HTTP status and cause, settle pending state, and preserve write drafts', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load }) => {
    const previousFetch = globalThis.fetch;
    const cause = new SyntaxError('Broken JSON');
    const networkError = new TypeError('Offline');
    let failure = { ok: false, status: 401, url: '/consent', json: async () => { throw cause; } };
    globalThis.fetch = async (url, options) => {
      if (options.method === 'GET') return extensionResponse(extensionData);
      if (failure instanceof Error) throw failure;
      return failure;
    };
    try {
      const controls = await installExtensionControls(window, document, load);
      const checkbox = document.getElementById('extension-connection-accounts').querySelectorAll('input')[0];
      checkbox.checked = true; checkbox.dispatchEvent(new window.Event('change'));
      controls.button('Save write access').click(); await settle();
      assert.equal(controls.failures.at(-1).status, 401);
      assert.equal(controls.failures.at(-1).cause, cause);
      assert.equal(controls.failures.at(-1).response, failure);
      assert.match(controls.status.textContent, /Sign in/);
      assert.equal(checkbox.checked, true);
      assert.equal(window.APStudyPendingMutations.count(), 0); assert.equal(controls.unload(), false);
      failure = { ok: true, status: 200, json: async () => ({ ok: false, error: { message: 'Access changed. Retry.' } }) };
      controls.button('Save write access').click(); await settle();
      assert.equal(controls.failures.at(-1).status, 200);
      assert.equal(controls.status.textContent, 'Access changed. Retry.');
      assert.equal(checkbox.checked, true);
      failure = networkError;
      controls.button('Save write access').click(); await settle();
      assert.equal(controls.failures.at(-1), networkError);
      assert.equal(controls.status.textContent, 'Offline');
      assert.equal(controls.unload(), false);
      assert.equal(controls.button('Save write access').disabled, false);
    } finally { globalThis.fetch = previousFetch; }
  });
});

test('extension timeout preserves AbortError cause and releases navigation protection', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load }) => {
    const previousFetch = globalThis.fetch;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const abort = new Error('Aborted'); abort.name = 'AbortError';
    let expire;
    globalThis.setTimeout = (callback, duration) => { assert.equal(duration, 12000); expire = callback; return 1; };
    globalThis.clearTimeout = () => {};
    globalThis.fetch = async (url, options) => {
      if (options.method === 'GET') return extensionResponse(extensionData);
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(abort)));
    };
    try {
      const controls = await installExtensionControls(window, document, load);
      controls.button('Allow history and ongoing reads').click();
      assert.equal(controls.unload(), true);
      expire(); await settle();
      assert.equal(controls.failures.at(-1).cause, abort);
      assert.match(controls.status.textContent, /too long/);
      assert.equal(controls.unload(), false);
      assert.equal(window.APStudyPendingMutations.count(), 0);
      assert.equal(controls.button('Allow history and ongoing reads').disabled, false);
    } finally {
      globalThis.fetch = previousFetch;
      globalThis.setTimeout = previousSetTimeout;
      globalThis.clearTimeout = previousClearTimeout;
    }
  });
});

test('calendar save accepts its baseline while preserving newer typing and list edits for retry', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    let complete;
    window.APStudyHttp.fetchJson = (url, options) => {
      requests.push({ url, options });
      return new Promise(resolve => { complete = resolve; });
    };
    const preferences = { settings: { canvas_ical_url: 'https://canvas.example/original' } };
    const state = { otherCalendarUrls: ['https://calendar.example/original', 'https://calendar.example/remove'] };
    const calendar = (await load('calendar')).createSettingsCalendar(state, preferences);
    calendar.mount(); calendar.hydrate();
    const save = document.getElementById('settings-save-calendar-links');
    const canvas = document.getElementById('settings-canvas-feed-url');
    const host = document.getElementById('settings-other-calendar-links');
    const originalRow = host.children[0];
    save.click();
    assert.equal(save.disabled, true);
    canvas.value = 'https://canvas.example/draft'; canvas.dispatchEvent(new window.Event('input'));
    const originalInput = originalRow.querySelector('input');
    originalInput.value = 'https://calendar.example/draft'; originalInput.dispatchEvent(new window.Event('input'));
    host.children[1].querySelector('button').click();
    document.getElementById('settings-add-other-calendar').click();
    const addedRow = host.children[1];
    addedRow.querySelector('input').value = 'https://calendar.example/new';
    addedRow.querySelector('input').dispatchEvent(new window.Event('input'));
    complete({ canvas_ical_url: 'https://canvas.example/canonical', other_ical_urls: ['https://calendar.example/canonical', 'https://calendar.example/remove'] });
    await settle();
    assert.equal(preferences.settings.canvas_ical_url, 'https://canvas.example/canonical');
    assert.deepEqual(state.otherCalendarUrls, ['https://calendar.example/canonical', 'https://calendar.example/remove']);
    assert.equal(canvas.value, 'https://canvas.example/draft');
    assert.equal(host.children[0], originalRow);
    assert.equal(host.children[1], addedRow);
    assert.deepEqual(host.querySelectorAll('input').map(input => input.value), ['https://calendar.example/draft', 'https://calendar.example/new']);
    assert.equal(save.disabled, false);
    save.click();
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), { canvas_ical_url: 'https://canvas.example/draft', other_ical_urls: ['https://calendar.example/draft', 'https://calendar.example/new'] });
    complete({ canvas_ical_url: 'https://canvas.example/draft-normalized', other_ical_urls: ['https://calendar.example/draft-normalized', 'https://calendar.example/new'] }); await settle();
    assert.equal(canvas.value, 'https://canvas.example/draft-normalized');
    assert.deepEqual(host.querySelectorAll('input').map(input => input.value), ['https://calendar.example/draft-normalized', 'https://calendar.example/new']);
    assert.equal(toasts.at(-1).message, 'Calendar links saved.');
  });
});

test('calendar canonical response hydrates only current fields and retains changed-back or undone list edits', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, toasts }) => {
    let complete;
    window.APStudyHttp.fetchJson = () => new Promise(resolve => { complete = resolve; });
    const preferences = { settings: { canvas_ical_url: 'https://canvas.example/original' } };
    const state = { otherCalendarUrls: ['https://calendar.example/original'] };
    const calendar = (await load('calendar')).createSettingsCalendar(state, preferences);
    calendar.mount(); calendar.hydrate();
    const save = document.getElementById('settings-save-calendar-links');
    const canvas = document.getElementById('settings-canvas-feed-url');
    const host = document.getElementById('settings-other-calendar-links');
    save.click();
    canvas.value = 'https://canvas.example/temporary'; canvas.dispatchEvent(new window.Event('input'));
    canvas.value = 'https://canvas.example/original'; canvas.dispatchEvent(new window.Event('input'));
    complete({ canvas_ical_url: 'https://canvas.example/normalized', other_ical_urls: ['https://calendar.example/normalized'] }); await settle();
    assert.equal(canvas.value, 'https://canvas.example/original', 'editing revision protects changed-back drafts');
    assert.equal(host.querySelector('input').value, 'https://calendar.example/normalized', 'unchanged sibling list accepts canonical response');
    save.click();
    host.querySelector('button').click();
    toasts.at(-1).action.onClick();
    const restoredRow = host.children[0];
    complete({ canvas_ical_url: 'https://canvas.example/current-normalized', other_ical_urls: ['https://calendar.example/second-normalized'] }); await settle();
    assert.equal(canvas.value, 'https://canvas.example/current-normalized', 'unchanged sibling Canvas accepts canonical response');
    assert.equal(host.children[0], restoredRow);
    assert.equal(host.querySelector('input').value, 'https://calendar.example/normalized', 'remove/Undo is a newer list revision even with the same values');
  });
});

test('calendar failed save keeps newer draft and list edits and retry submits them', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    let rejectSave;
    window.APStudyHttp.fetchJson = (url, options) => {
      requests.push({ url, options });
      return new Promise((resolve, reject) => { rejectSave = reject; });
    };
    const preferences = { settings: { canvas_ical_url: 'https://canvas.example/original' } };
    const state = { otherCalendarUrls: ['https://calendar.example/original'] };
    const calendar = (await load('calendar')).createSettingsCalendar(state, preferences);
    calendar.mount(); calendar.hydrate();
    const save = document.getElementById('settings-save-calendar-links');
    const canvas = document.getElementById('settings-canvas-feed-url');
    const host = document.getElementById('settings-other-calendar-links');
    save.click();
    canvas.value = 'https://canvas.example/retry'; canvas.dispatchEvent(new window.Event('input'));
    host.querySelector('button').click();
    document.getElementById('settings-add-other-calendar').click();
    host.querySelector('input').value = 'https://calendar.example/retry';
    host.querySelector('input').dispatchEvent(new window.Event('input'));
    rejectSave(new Error('Disconnected')); await settle();
    assert.equal(save.disabled, false);
    assert.equal(canvas.value, 'https://canvas.example/retry');
    assert.equal(host.querySelector('input').value, 'https://calendar.example/retry');
    assert.equal(preferences.settings.canvas_ical_url, 'https://canvas.example/original');
    assert.deepEqual(state.otherCalendarUrls, ['https://calendar.example/original']);
    assert.equal(toasts.at(-1).title, 'Couldn’t save calendar links');
    window.APStudyHttp.fetchJson = async (url, options) => { requests.push({ url, options }); return {}; };
    save.click(); await settle();
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), { canvas_ical_url: 'https://canvas.example/retry', other_ical_urls: ['https://calendar.example/retry'] });
    assert.equal(preferences.settings.canvas_ical_url, 'https://canvas.example/retry');
    assert.deepEqual(state.otherCalendarUrls, ['https://calendar.example/retry']);
  });
});

test('settings hydration keeps the server default avatar, handles failed providers, and sizes uploaded pictures', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load }) => {
    const fallback = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"%3E%3C/svg%3E';
    const preview = document.getElementById('settings-avatar-preview');
    preview.setAttribute('data-default-avatar-url', fallback);
    preview.src = fallback;
    for (const [tag, id] of [['img', 'settings-avatar-dropzone-preview'], ['div', 'settings-avatar-dropzone-placeholder']]) {
      const node = document.createElement(tag); node.setAttribute('id', id); document.body.appendChild(node);
    }
    const navbar = document.createElement('button'); navbar.setAttribute('id', 'navbar-avatar-btn');
    const navbarImage = document.createElement('img'); navbar.appendChild(navbarImage); document.body.appendChild(navbar);
    window.APSTUDY_AVATAR_URL_FOR_SIZE = (url, size) => {
      if (!url) return '';
      return url.startsWith('data:') ? url : `${url}?size=${size}`;
    };
    window.APStudyHttp.fetchJson = async (url) => url.endsWith('/bootstrap')
      ? { ...structuredClone(bootstrap), profile: { ...bootstrap.profile, picture_url: '' } }
      : {};
    await (await load('page')).initializeSettingsPage();
    assert.equal(preview.src, fallback);
    assert.equal(preview.getAttribute('srcset'), null);
    assert.equal(document.getElementById('settings-avatar-dropzone-preview').getAttribute('hidden'), '');
    assert.equal(document.getElementById('settings-avatar-dropzone-placeholder').getAttribute('hidden'), null);

    const avatar = (await load('avatar')).createSettingsAvatar({ profile: {} }, () => {}, () => {});
    avatar.updateAvatarPreview('https://provider.example/picture');
    assert.equal(preview.src, 'https://provider.example/picture?size=150');
    assert.equal(preview.srcset, 'https://provider.example/picture?size=150 1x, https://provider.example/picture?size=300 2x');
    assert.equal(document.getElementById('settings-avatar-dropzone-preview').src, 'https://provider.example/picture?size=176');
    assert.equal(document.getElementById('settings-avatar-dropzone-placeholder').getAttribute('hidden'), '');
    preview.onerror(new window.Event('error'));
    assert.equal(preview.src, fallback);
    assert.equal(preview.getAttribute('srcset'), null);
    assert.equal(preview.onerror, null);
    avatar.updateAvatarPreview('data:image/png;base64,aW1hZ2U=');
    assert.equal(preview.src, 'data:image/png;base64,aW1hZ2U=');
    assert.equal(preview.getAttribute('srcset'), null);
    avatar.updateNavbarAvatar('data:image/png;base64,aW1hZ2U=');
    assert.equal(navbarImage.src, 'data:image/png;base64,aW1hZ2U=');
    assert.equal(navbarImage.getAttribute('srcset'), null);
    avatar.updateAvatarPreview('/uploads/avatar.png');
    avatar.updateNavbarAvatar('/uploads/avatar.png');
    assert.equal(preview.src, '/uploads/avatar.png?size=150');
    assert.equal(preview.srcset, '/uploads/avatar.png?size=150 1x, /uploads/avatar.png?size=300 2x');
    assert.equal(navbarImage.srcset, '/uploads/avatar.png?size=48 1x, /uploads/avatar.png?size=96 2x');
  });
});

test('settings profile rejects invalid usernames locally and saves normalized boundary values', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests, toasts }) => {
    const invalid = [];
    window.APStudyFormField.markInvalid = input => invalid.push(input);
    const profile = (await load('profile')).createSettingsProfile({ profile: { ...bootstrap.profile } }, () => {});
    profile.mount(); profile.hydrate();
    const username = document.getElementById('settings-username-input');
    const save = document.getElementById('settings-save-profile');
    const rejected = [
      ['  ', 'Username is required.'],
      ['ab', 'Username must be between 3 and 20 characters.'],
      ['u', 'Username must be between 3 and 20 characters.'],
      ['a'.repeat(21), 'Username must be between 3 and 20 characters.'],
      ['person😀', 'Please only use numbers, letters, dashes -, or underscores _.'],
      ...['account', 'admin', 'api', 'auth', 'calendar', 'dashboard', 'data', 'files', 'login', 'logout', 'notes', 'onboarding', 'preferences', 'profile', 'settings', 'signup', 'user', 'users'].map(value => [` ${value.toUpperCase()} `, 'That username is reserved.']),
    ];
    for (const [value, message] of rejected) {
      username.value = value; save.click(); await settle();
      assert.equal(toasts.at(-1).message, message);
      assert.equal(invalid.at(-1), username);
      assert.equal(requests.length, 0, `invalid username ${value} cannot reach save`);
      assert.equal(username.value, value, 'rejected input stays available for correction');
    }
    for (const value of [' ABC ', ` ${'A'.repeat(20)} `]) {
      username.value = value; save.click(); await settle();
      assert.equal(username.value, value.trim().toLowerCase());
      assert.equal(JSON.parse(requests.at(-1).options.body).username, value.trim().toLowerCase());
    }
  });
});

test('settings profile text counters and save validation share Unicode limits and trimmed payloads', async () => {
  await withSettings('https://nest.example/settings/', async ({ window, document, load, requests }) => {
    const fields = [['display-name', 'Display name', 80], ['school', 'School', 160], ['major', 'Major', 120]];
    for (const [field] of fields) {
      for (const suffix of ['counter', 'error']) {
        const node = document.createElement('span'); node.setAttribute('id', `settings-${field}-${suffix}`); document.body.appendChild(node);
      }
    }
    const profile = (await load('profile')).createSettingsProfile({ profile: { ...bootstrap.profile } }, () => {});
    profile.mount(); profile.hydrate();
    const save = document.getElementById('settings-save-profile');
    for (const [field, label, maximum] of fields) {
      const input = document.getElementById(`settings-${field}`);
      const error = document.getElementById(`settings-${field}-error`);
      input.value = ` ${'😀'.repeat(maximum + 1)} `; input.dispatchEvent(new window.Event('input'));
      assert.equal(document.getElementById(`settings-${field}-counter`).textContent, `${maximum + 1} / ${maximum} characters`);
      assert.equal(input.validationMessage, `${label} must be ${maximum} characters or fewer.`);
      assert.equal(input.getAttribute('aria-invalid'), 'true'); assert.equal(error.hidden, false);
      save.click(); await settle(); assert.equal(requests.length, 0);
      input.value = ` ${'😀'.repeat(maximum)} `; input.dispatchEvent(new window.Event('input'));
      assert.equal(input.validationMessage, ''); assert.equal(input.getAttribute('aria-invalid'), 'false'); assert.equal(error.hidden, true);
      assert.equal(document.getElementById(`settings-${field}-counter`).textContent, `${maximum} / ${maximum} characters`);
    }
    const name = document.getElementById('settings-display-name');
    const validName = name.value;
    name.value = ' \t '; name.dispatchEvent(new window.Event('input'));
    save.click(); await settle(); assert.equal(requests.length, 0);
    assert.equal(name.validationMessage, 'Display name is required.');
    name.value = validName; name.dispatchEvent(new window.Event('input'));
    save.click(); await settle();
    const payload = JSON.parse(requests.at(-1).options.body);
    assert.equal(payload.name, '😀'.repeat(80)); assert.equal(payload.school, '😀'.repeat(160)); assert.equal(payload.major, '😀'.repeat(120));
    for (const field of ['school', 'major']) {
      const input = document.getElementById(`settings-${field}`); input.value = '  '; input.dispatchEvent(new window.Event('input'));
      assert.equal(input.validationMessage, '');
    }
    save.click(); await settle();
    assert.equal(JSON.parse(requests.at(-1).options.body).school, '');
    assert.equal(JSON.parse(requests.at(-1).options.body).major, '');
  });
});

test('missing notification service disables its controls once and leaves settings bootstrap usable', async () => {
  await withSettings('https://nest.example/settings/#notifications', async ({ window, document, load, requests }) => {
    delete window.APStudyNotifications;
    const save = document.createElement('button'); save.setAttribute('id', 'notification-save'); document.body.appendChild(save);
    const toggle = document.createElement('button'); toggle.setAttribute('data-push-toggle', 'calendar_enabled'); document.body.appendChild(toggle);
    const status = document.createElement('p'); status.setAttribute('id', 'notification-action-status'); document.body.appendChild(status);
    window.APStudyHttp.fetchJson = async (url, options = {}) => { requests.push({ url, options }); return url.endsWith('/bootstrap') ? structuredClone(bootstrap) : {}; };
    const oldTimeout = globalThis.setTimeout;
    let retries = 0;
    globalThis.setTimeout = () => { retries++; return 0; };
    try {
      await (await load('page')).initializeSettingsPage();
      await settle();
      assert.equal(retries, 0, 'missing notification script never starts a retry timer');
      assert.equal(document.getElementById('settings-display-name').value, 'Taylor');
      assert.equal(document.getElementById('settings-skeleton').hidden, true);
      for (const id of ['notification-enable', 'notification-test', 'notification-save']) assert.equal(document.getElementById(id).disabled, true);
      assert.equal(toggle.disabled, true);
      assert.equal(document.getElementById('notification-permission-status').textContent, 'Notification settings unavailable');
      assert.equal(document.getElementById('notification-recovery').hidden, false);
      assert.match(document.getElementById('notification-recovery').textContent, /Refresh the page/);
      assert.equal(status.dataset.type, 'error');
      assert.equal(status.hidden, false);
      assert.equal(document.getElementById('notification-enable').listeners.get('click'), undefined, 'unavailable service actions are never bound');
      assert.ok(!requests.some((request) => request.url.startsWith('/api/notifications')));
    } finally { globalThis.setTimeout = oldTimeout; }
  });
});

test('settings declares its notification dependency before startup with the navbar deduplication marker', async () => {
  const template = await readFile(new URL('../../templates/settings.html', import.meta.url), 'utf8');
  const script = template.match(/<script[^>]*js\/core\/notifications\.js[^>]*><\/script>/)?.[0];
  assert.ok(script);
  assert.match(script, /data-nest-notifications="true"/);
  assert.match(script, /\bdefer\b/);
  assert.ok(template.indexOf(script) < template.indexOf('js/settings/index.js'));
});
