import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = await readFile(path.join(repoRoot, 'static/js/core/global-chrome.js'), 'utf8');

function createRuntime({ retention = '' } = {}) {
  const windowListeners = new Map();
  const documentListeners = new Map();
  const navigation = [];
  const location = {
    href: 'https://nest.example/notes/note-1',
    origin: 'https://nest.example',
    assign(url) { navigation.push({ mode: 'assign', url }); },
    replace(url) { navigation.push({ mode: 'replace', url }); },
  };
  const window = {
    location,
    addEventListener(type, listener) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(listener);
    },
  };
  const document = {
    body: { dataset: { navigationRetention: retention } },
    addEventListener(type, listener) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(listener);
    },
  };

  vm.runInNewContext(source, { window, document, URL, console });
  return {
    window,
    document,
    navigation,
    emitWindow(type, event = {}) {
      for (const listener of windowListeners.get(type) || []) listener(event);
    },
    emitDocument(type, event = {}) {
      for (const listener of documentListeners.get(type) || []) listener(event);
    },
  };
}

test('page lifecycle pauses, resumes, and disposes registrations exactly once', () => {
  const runtime = createRuntime();
  const calls = [];
  runtime.window.APStudyPageLifecycle.register({
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
    dispose: () => calls.push('dispose'),
  });

  runtime.emitWindow('pagehide', { persisted: true });
  runtime.emitWindow('pagehide', { persisted: true });
  runtime.emitWindow('pageshow', { persisted: true });
  runtime.emitWindow('pageshow', { persisted: true });
  runtime.emitWindow('pagehide', { persisted: false });
  runtime.emitWindow('pagehide', { persisted: false });

  assert.deepEqual(calls, ['pause', 'resume', 'dispose']);
  assert.equal(runtime.window.APStudyPageLifecycle.state(), 'disposed');

  runtime.window.APStudyPageLifecycle.register({ dispose: () => calls.push('late-dispose') });
  assert.deepEqual(calls, ['pause', 'resume', 'dispose', 'late-dispose']);
});

test('unregistered lifecycle hooks are not invoked', () => {
  const runtime = createRuntime();
  const calls = [];
  const unregister = runtime.window.APStudyPageLifecycle.register({ pause: () => calls.push('pause') });
  unregister();
  runtime.emitWindow('pagehide', { persisted: true });
  assert.deepEqual(calls, []);
});

test('navigation assigns normally and replaces when the current document is discardable', () => {
  const normal = createRuntime();
  assert.equal(normal.window.APStudyNavigation.go('/dashboard'), true);
  assert.deepEqual(normal.navigation, [{ mode: 'assign', url: 'https://nest.example/dashboard' }]);

  const discard = createRuntime({ retention: 'discard' });
  discard.window.APStudyNavigation.go('/dashboard');
  discard.window.APStudyNavigation.go('/settings', { replace: false });
  assert.deepEqual(discard.navigation, [
    { mode: 'replace', url: 'https://nest.example/dashboard' },
    { mode: 'assign', url: 'https://nest.example/settings' },
  ]);
});

test('discard-page click interception preserves modified and external links', () => {
  const runtime = createRuntime({ retention: 'discard' });
  const localAnchor = {
    href: 'https://nest.example/dashboard',
    dataset: {},
    hasAttribute: () => false,
    getAttribute: () => '',
  };
  const externalAnchor = { ...localAnchor, href: 'https://example.com/help' };

  const localEvent = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: { closest: () => localAnchor },
    preventDefault() { this.defaultPrevented = true; },
  };
  runtime.emitDocument('click', localEvent);
  assert.equal(localEvent.defaultPrevented, true);
  assert.equal(runtime.navigation.at(-1).mode, 'replace');

  const modifiedEvent = { ...localEvent, defaultPrevented: false, metaKey: true, preventDefault() { this.defaultPrevented = true; } };
  runtime.emitDocument('click', modifiedEvent);
  assert.equal(modifiedEvent.defaultPrevented, false);

  const externalEvent = { ...localEvent, defaultPrevented: false, target: { closest: () => externalAnchor }, preventDefault() { this.defaultPrevented = true; } };
  runtime.emitDocument('click', externalEvent);
  assert.equal(externalEvent.defaultPrevented, false);
});
