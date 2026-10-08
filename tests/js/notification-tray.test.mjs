import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../../static/js/core/notification-tray.js', import.meta.url), 'utf8');

function element(dataset = {}) {
  const listeners = new Map();
  return {
    dataset,
    classList: { toggle() {} },
    addEventListener(type, callback) { listeners.set(type, callback); },
    dispatch(type, event = {}) { return listeners.get(type)?.(event); },
    setAttribute() {},
    focus() {},
  };
}

async function mountTray({ undo = true, deleteRequest = async () => ({ unread_count: 6 }) } = {}) {
  const selectors = [
    '.notification-bell', '.notification-tray', '[data-list]', '[data-select-all]',
    '.notification-badge', '[data-unread-label]', '[data-read-all]', '[data-footer]',
    '[data-result-summary]', '[data-bulk-actions]', '[data-close]', '[data-category]',
    '[data-search]', '[data-mark-selected]', '[data-delete-selected]', '[data-more]',
  ];
  const controls = new Map(selectors.map(selector => [selector, element()]));
  const statuses = ['all', 'unread', 'read'].map(status => element({ status }));
  const host = {
    dataset: {},
    querySelector: selector => controls.get(selector),
    querySelectorAll: () => statuses,
  };
  const notifications = [
    { id: 'read', title: 'Already read', is_read: 1 },
    { id: 'unread', title: 'Unread notification', is_read: 0 },
    { id: 'keep', title: 'Keep this', is_read: 0 },
  ];
  const counts = [];
  const errors = [];
  const requests = [];
  let staged;
  const window = {
    APStudyUIPrimitives: { escapeHtml: value => String(value ?? '') },
    APStudyConfirm: { request: async () => true },
    location: { href: 'https://nest.example/dashboard' },
  };
  if (undo) window.APStudyUndo = { stage: action => { staged = action; } };
  vm.runInNewContext(source, { window, document: element(), URL, URLSearchParams });
  const tray = window.APStudyNotificationTray.mount(host, {
    api: async (url, options) => {
      if (options?.method === 'DELETE') {
        requests.push({ url, ...options });
        return deleteRequest();
      }
      return { notifications: notifications.map(item => ({ ...item })), unread_count: 7 };
    },
    setUnreadCount: count => counts.push(count),
    showError: error => errors.push(error),
  });
  tray.open();
  await tray.refresh();

  return {
    tray, counts, errors, requests,
    get staged() { return staged; },
    get count() { return Number(controls.get('.notification-badge').textContent); },
    get visibleIds() {
      return [...controls.get('[data-list]').innerHTML.matchAll(/<article[^>]*data-id="([^"]+)"/g)].map(match => match[1]);
    },
    get selectionLabel() { return controls.get('[data-result-summary]').textContent; },
    select(...ids) {
      for (const id of ids) {
        controls.get('[data-list]').dispatch('change', {
          target: {
            closest: selector => selector === '[data-select-item]' ? { checked: true } : { dataset: { id } },
          },
        });
      }
    },
    deleteSelected: () => controls.get('[data-delete-selected]').dispatch('click'),
  };
}

test('optimistic notification deletion counts only unread selections and undo restores order and selection', async () => {
  const fixture = await mountTray();
  fixture.select('read', 'unread');
  await fixture.deleteSelected();

  assert.equal(fixture.count, 6);
  assert.equal(fixture.counts.at(-1), 6);
  assert.deepEqual(fixture.visibleIds, ['keep']);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.errors.length, 0);

  fixture.staged.restore();
  assert.equal(fixture.count, 7);
  assert.equal(fixture.counts.at(-1), 7);
  assert.deepEqual(fixture.visibleIds, ['read', 'unread', 'keep']);
  assert.equal(fixture.selectionLabel, '2 selected');
});

test('notification undo preserves unrelated unread-count updates', async () => {
  const fixture = await mountTray();
  fixture.select('unread');
  await fixture.deleteSelected();
  fixture.tray.setUnreadCount(9);

  fixture.staged.restore();
  assert.equal(fixture.count, 10);
  assert.equal(fixture.counts.at(-1), 10);
});

test('immediate notification deletion leaves read selections out of the unread decrement', async () => {
  for (const [id, expectedCount] of [['read', 7], ['unread', 6]]) {
    let resolveDelete;
    const fixture = await mountTray({
      undo: false,
      deleteRequest: () => new Promise(resolve => { resolveDelete = resolve; }),
    });
    fixture.select(id);
    const deleting = fixture.deleteSelected();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(fixture.count, expectedCount);
    assert.ok(!fixture.visibleIds.includes(id));
    resolveDelete({ unread_count: expectedCount });
    await deleting;
    assert.equal(fixture.count, expectedCount);
    assert.equal(fixture.errors.length, 0);
    assert.deepEqual(JSON.parse(fixture.requests[0].body).ids, [id]);
  }
});

test('failed immediate deletion restores notification rows, selection, and unread count', async () => {
  const failure = new Error('Delete failed');
  const fixture = await mountTray({
    undo: false,
    deleteRequest: async () => { throw failure; },
  });
  fixture.select('read', 'unread');
  await fixture.deleteSelected();

  assert.deepEqual(fixture.visibleIds, ['read', 'unread', 'keep']);
  assert.equal(fixture.selectionLabel, '2 selected');
  assert.equal(fixture.count, 7);
  assert.equal(fixture.counts.at(-1), 7);
  assert.deepEqual(fixture.errors, [failure]);
});
