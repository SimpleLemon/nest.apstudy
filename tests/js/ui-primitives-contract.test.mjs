import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const templatesRoot = path.join(repoRoot, 'templates');
const baseTemplate = fs.readFileSync(path.join(templatesRoot, 'base.html'), 'utf8');
const baseExtendsPattern = /{%\s*extends\s+['"]base\.html['"]\s*%}/;
const blockPattern = /{%\s*block\s+([A-Za-z_][A-Za-z0-9_]*)\s*%}([\s\S]*?){%\s*endblock\s*%}/g;
const primitives = fs.readFileSync(path.join(repoRoot, 'static/js/core/ui-primitives.js'), 'utf8');
const primitivesModule = fs.readFileSync(path.join(repoRoot, 'static/js/core/ui-primitives-module.js'), 'utf8');
const escaping = fs.readFileSync(path.join(repoRoot, 'static/js/core/escaping.js'), 'utf8');
const feedbackOverlays = fs.readFileSync(path.join(repoRoot, 'static/css/core/feedback-overlays.css'), 'utf8');

function loadUiPrimitives() {
    const window = { addEventListener() {} };
    const document = {
        addEventListener() {},
    };
    const context = vm.createContext({ document, window });
    vm.runInContext(escaping, context);
    vm.runInContext(primitives, context);
    return window.APStudyUIPrimitives;
}

function resolvedTemplateSource(filename) {
    const source = fs.readFileSync(path.join(templatesRoot, filename), 'utf8');
    if (!baseExtendsPattern.test(source)) return source;

    let inherited = baseTemplate;
    for (const match of source.matchAll(blockPattern)) {
        const [, name, body] = match;
        const inheritedBlock = new RegExp(`{%\\s*block\\s+${name}\\s*%}[\\s\\S]*?{%\\s*endblock\\s*%}`);
        assert.match(inherited, inheritedBlock, `${filename} overrides missing base block ${name}`);
        inherited = inherited.replace(inheritedBlock, body);
    }
    return inherited;
}

test('shared escapeHtml primitive escapes markup and quotes behaviorally', () => {
    const { escapeHtml } = loadUiPrimitives();
    assert.equal(escapeHtml('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
});

test('shared UI primitive module has substantive owned APIs', () => {
    for (const api of ['APStudyFormField', 'APStudyLoader', 'APStudySkeleton', 'APStudyToast', 'APStudyUndo', 'APStudyConfirm']) {
        assert.match(primitives, new RegExp(`window\\.${api}`));
    }
    assert.match(primitives, /window\.APStudyUIPrimitives = Object\.freeze/);
    assert.match(primitives, /const \{ escapeHtml \} = globalThis\.APStudyCoreServices\.escaping/);
    assert.match(primitives, /Object\.freeze\(\{\s*escapeHtml,/);
    assert.match(primitivesModule, /import '\.\/escaping\.js(\?v=[0-9a-f]{64})?'/);
    assert.match(primitivesModule, /export const \{ escapeHtml \} = globalThis\.APStudyCoreServices\.escaping/);
    assert.ok(primitives.length > 8_000, 'ui-primitives.js must not become an empty compatibility shim');
    const globalSource = fs.readFileSync(path.join(repoRoot, 'static/js/core/global.js'), 'utf8');
    assert.doesNotMatch(globalSource, /window\.APStudy(?:FormField|Loader|Skeleton|Toast|Confirm)\s*=/);
});

test('toast primitive normalizes content, timing, and accessibility states', () => {
    assert.match(primitives, /if \(!primaryText\) return null/);
    assert.match(primitives, /toast\.setAttribute\('aria-atomic', 'true'\)/);
    assert.match(primitives, /toast\.append\(createToastIcon\(type\), copy, close\)/);
    assert.match(primitives, /if \(hasAction\) return 10_000/);
    assert.match(primitives, /return 7_000/);
    assert.match(primitives, /return 4_000/);
    assert.match(primitives, /remaining = Math\.max\(0, remaining - \(performance\.now\(\) - startedAt\)\)/);
    assert.doesNotMatch(primitives, /host\.setAttribute\('aria-live'/);
});

test('undo primitive delays commits, restores failures, and flushes on navigation', () => {
    assert.match(primitives, /function stageUndoableAction\(options = \{\}\)/);
    assert.match(primitives, /actionLabel \|\| 'Undo'/);
    assert.match(primitives, /if \(reason !== 'action'\) void commit\(reason\)/);
    assert.match(primitives, /await restore\('commit-error'\)/);
    assert.match(primitives, /window\.addEventListener\('pagehide'/);
    assert.match(primitives, /pendingUndoOperations/);
});

test('toast presentation follows the shared spacing, target-size, and viewport contracts', () => {
    assert.match(feedbackOverlays, /grid-template-columns:\s*32px minmax\(0, 1fr\) 32px/);
    assert.match(feedbackOverlays, /\.apstudy-toast\s*\{[^}]*flex:\s*0 0 auto/s);
    assert.match(feedbackOverlays, /\.apstudy-toast\.is-compact\s*\{[^}]*align-items:\s*center/s);
    assert.match(feedbackOverlays, /\.apstudy-toast__action\s*\{[^}]*min-height:\s*44px/s);
    assert.match(feedbackOverlays, /\.apstudy-toast__close::before\s*\{[^}]*inset:\s*-6px/s);
    assert.match(feedbackOverlays, /max-height:\s*calc\(var\(--app-viewport-height/);
    assert.match(feedbackOverlays, /env\(safe-area-inset-right/);
    assert.match(feedbackOverlays, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.apstudy-toast__progress\.is-running\s*\{\s*display:\s*none/s);
});

test('every template using global.js receives primitives first through the shared asset partial', () => {
    const diagnostics = fs.readFileSync(path.join(repoRoot, 'templates/_diagnostics_assets.html'), 'utf8');
    const runtime = fs.readFileSync(path.join(repoRoot, 'templates/_shared_runtime_assets.html'), 'utf8');
    assert.match(diagnostics, /include "_shared_runtime_assets\.html"/);
    assert.match(runtime, /js\/core\/ui-primitives\.js/);
    assert.ok(runtime.indexOf('js/core/escaping.js') < runtime.indexOf('js/core/ui-primitives.js'));

    const templates = fs.readdirSync(templatesRoot)
        .filter((filename) => filename.endsWith('.html'));
    for (const filename of templates) {
        const source = resolvedTemplateSource(filename);
        if (!source.includes("js/core/global.js")) continue;
        assert.ok(source.includes('_diagnostics_assets.html'), `${filename} skips shared runtime assets`);
        assert.ok(source.indexOf('_diagnostics_assets.html') < source.indexOf('js/core/global.js'), `${filename} loads primitives after global.js`);
    }
});

function undoRuntime() {
    const elements = [];
    const listeners = new Map();
    const timers = new Map();
    const errors = [];
    let timerId = 0;
    function element(tag) {
        const callbacks = new Map();
        const node = {
            tag, children: [], className: '', style: { setProperty() {} },
            classList: { add() {}, remove() {}, toggle() {} },
            setAttribute() {}, removeAttribute() {},
            appendChild(child) { this.children.push(child); },
            append(...children) { this.children.push(...children); },
            prepend(child) { this.children.unshift(child); },
            remove() { this.removed = true; }, contains: () => false,
            addEventListener(type, callback) { callbacks.set(type, callback); },
            fire: type => callbacks.get(type)?.({ relatedTarget: null }),
        };
        elements.push(node);
        return node;
    }
    const document = {
        body: element('body'), addEventListener() {},
        getElementById: id => elements.find(node => node.id === id),
        createElement: element, createElementNS: (_namespace, tag) => element(tag),
    };
    const window = {
        addEventListener(type, callback) { listeners.set(type, callback); },
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id),
    };
    const context = vm.createContext({ document, window, Error, console: { error: (...values) => errors.push(values) }, performance: { now: () => 0 }, requestAnimationFrame: callback => callback() });
    vm.runInContext(escaping, context);
    vm.runInContext(primitives, context);
    return {
        api: window.APStudyUndo, errors,
        pagehide: () => listeners.get('pagehide')(),
        timeout() { const timer = [...timers.values()].find(entry => entry.delay === 10_000); assert.ok(timer); timer.callback(); },
        action: () => elements.find(node => node.className === 'apstudy-toast__action'),
        close: () => elements.find(node => node.className === 'apstudy-toast__close'),
        feedback: () => elements.filter(node => node.className === 'apstudy-toast is-error'),
    };
}

for (const winner of ['commit', 'dismiss', 'undo']) {
    test(`Undo ${winner} returns one winning promise through repeated and competing controls`, async () => {
        const fixture = undoRuntime();
        const work = Promise.withResolvers();
        const calls = [];
        let reentrant;
        const controller = fixture.api.stage({ message: 'Removed',
            commit: async () => { calls.push('commit'); reentrant = controller.undo(); await work.promise; },
            restore: async () => { calls.push('restore'); reentrant = controller.commit(); await work.promise; },
        });
        assert.equal(fixture.api.pendingCount(), 1);
        const completion = controller[winner]();
        assert.equal(fixture.api.pendingCount(), 0);
        for (const action of ['undo', 'commit', 'dismiss', winner]) assert.equal(controller[action](), completion);
        await Promise.resolve();
        assert.equal(reentrant, completion);
        let finished = false;
        completion.then(() => { finished = true; });
        await Promise.resolve();
        assert.equal(finished, false);
        work.resolve();
        const result = await completion;
        assert.equal(result.action, winner === 'undo' ? 'undo' : 'commit');
        assert.equal(result.ok, true);
        assert.deepEqual(calls, [winner === 'undo' ? 'restore' : 'commit']);
    });
}

test('Undo actual toast action restores once and all later controller calls share its completion', async () => {
    const fixture = undoRuntime();
    const work = Promise.withResolvers();
    let restored = 0;
    let committed = 0;
    const controller = fixture.api.stage({ message: 'Removed', restore: async () => { restored += 1; await work.promise; }, commit: () => { committed += 1; } });
    const click = fixture.action().fire('click');
    assert.equal(fixture.action().disabled, true);
    const completion = controller.commit();
    assert.equal(controller.undo(), completion);
    work.resolve();
    await click;
    assert.equal((await completion).action, 'undo');
    assert.equal(restored, 1);
    assert.equal(committed, 0);
    assert.equal(fixture.action().disabled, false);
});

for (const automatic of ['timeout', 'pagehide', 'close']) {
    test(`Undo ${automatic} contains commit, restoration and feedback failure and exposes the same handled result`, async () => {
        const fixture = undoRuntime();
        const commitError = new Error('Deletion failed');
        const restoreError = new Error('Restoration failed');
        const feedbackError = new Error('Feedback failed');
        const calls = [];
        const controller = fixture.api.stage({ message: 'Removed',
            commit: async ({ reason }) => { calls.push(reason); throw commitError; },
            restore: async ({ reason }) => { calls.push(reason); throw restoreError; },
            onCommitError: async () => { calls.push('feedback'); throw feedbackError; },
        });
        if (automatic === 'close') fixture.close().fire('click');
        else fixture[automatic]();
        const completion = controller.undo();
        assert.equal(controller.dismiss(), completion);
        const result = await completion;
        assert.equal(result.action, 'commit');
        assert.equal(result.ok, false);
        assert.equal(result.error, commitError);
        assert.equal(result.restoreError, restoreError);
        assert.deepEqual(calls, [automatic, 'commit-error', 'feedback']);
        assert.equal(fixture.errors.length, 2);
        assert.equal(fixture.api.pendingCount(), 0);
    });
}

test('Undo restoration failure resolves a handled failure and renders real error feedback', async () => {
    const fixture = undoRuntime();
    const restoreError = new Error('Restore failed');
    const controller = fixture.api.stage({ message: 'Removed', restore: async () => { throw restoreError; } });
    const result = await controller.undo();
    assert.equal(result.action, 'undo');
    assert.equal(result.ok, false);
    assert.equal(result.error, restoreError);
    assert.equal(fixture.feedback().length, 1);
});
