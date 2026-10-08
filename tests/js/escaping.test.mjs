import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const coreRoot = path.join(repoRoot, 'static/js/core');

test('the real utility bridge imports without DOM globals or installing UI', async () => {
    const moduleRoot = await mkdtemp(path.join(os.tmpdir(), 'apstudy-escaping-esm-'));
    const originalServices = Object.getOwnPropertyDescriptor(globalThis, 'APStudyCoreServices');
    const existingService = {};
    globalThis.APStudyCoreServices = { existingService };
    try {
        await writeFile(path.join(moduleRoot, 'package.json'), '{"type":"module"}\n');
        for (const filename of ['escaping.js', 'ui-primitives-module.js']) {
            await cp(path.join(coreRoot, filename), path.join(moduleRoot, filename));
        }
        assert.equal(typeof globalThis.window, 'undefined');
        assert.equal(typeof globalThis.document, 'undefined');
        const { escapeHtml } = await import(pathToFileURL(path.join(moduleRoot, 'ui-primitives-module.js')).href);
        assert.equal(globalThis.APStudyCoreServices.existingService, existingService);
        assert.equal(escapeHtml, globalThis.APStudyCoreServices.escaping.escapeHtml);
        assert.equal(escapeHtml(`<a title="x&y">'text'</a>`), '&lt;a title=&quot;x&amp;y&quot;&gt;&#39;text&#39;&lt;/a&gt;');
        assert.equal(escapeHtml('&lt;'), '&amp;lt;');
        assert.equal(escapeHtml('a\u00a0b\n雪'), 'a&nbsp;b\n雪');
        for (const [value, expected] of [[null, ''], [undefined, ''], [0, '0'], [false, 'false'], [42n, '42']]) {
            assert.equal(escapeHtml(value), expected);
        }
        assert.equal(escapeHtml({ toString: () => '<object>' }), '&lt;object&gt;');
        for (const api of ['APStudyUIPrimitives', 'APStudyFormField', 'APStudyLoader', 'APStudySkeleton', 'APStudyToast', 'APStudyUndo', 'APStudyConfirm']) {
            assert.equal(globalThis[api], undefined, `${api} must not be installed by a utility import`);
        }
    } finally {
        if (originalServices) Object.defineProperty(globalThis, 'APStudyCoreServices', originalServices);
        else delete globalThis.APStudyCoreServices;
        await rm(moduleRoot, { recursive: true, force: true });
    }
});

test('classic definitions register no listeners and UI runtime reuses the same escaping function', async () => {
    const listeners = [];
    const window = { addEventListener: type => listeners.push(['window', type]) };
    const document = {
        addEventListener: type => listeners.push(['document', type]),
        createElement() { assert.fail('escaping must not create DOM elements'); },
    };
    const context = vm.createContext({ window, document });
    const escapingSource = await readFile(path.join(coreRoot, 'escaping.js'), 'utf8');
    vm.runInContext(escapingSource, context);
    const original = context.APStudyCoreServices.escaping.escapeHtml;
    vm.runInContext(escapingSource, context);
    assert.equal(context.APStudyCoreServices.escaping.escapeHtml, original);
    assert.deepEqual(listeners, []);
    assert.deepEqual(Object.keys(window), ['addEventListener']);

    vm.runInContext(await readFile(path.join(coreRoot, 'ui-primitives.js'), 'utf8'), context);
    assert.equal(window.APStudyUIPrimitives.escapeHtml, original);
    assert.match(window.APStudyLoader.html('<Loading>'), /&lt;Loading&gt;/);
    assert.ok(window.APStudyToast);
    assert.ok(window.APStudyConfirm);
    assert.ok(listeners.length > 0, 'only the explicit UI runtime installs listeners');
});
