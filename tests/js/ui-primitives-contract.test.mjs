import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const primitives = fs.readFileSync(path.join(repoRoot, 'static/js/core/ui-primitives.js'), 'utf8');

test('shared UI primitive module has substantive owned APIs', () => {
    for (const api of ['APStudyFormField', 'APStudyLoader', 'APStudySkeleton', 'APStudyToast', 'APStudyConfirm']) {
        assert.match(primitives, new RegExp(`window\\.${api}`));
    }
    assert.match(primitives, /window\.APStudyUIPrimitives = Object\.freeze/);
    assert.ok(primitives.length > 8_000, 'ui-primitives.js must not become an empty compatibility shim');
    const globalSource = fs.readFileSync(path.join(repoRoot, 'static/js/core/global.js'), 'utf8');
    assert.doesNotMatch(globalSource, /window\.APStudy(?:FormField|Loader|Skeleton|Toast|Confirm)\s*=/);
});

test('every template using global.js receives primitives first through the shared asset partial', () => {
    const diagnostics = fs.readFileSync(path.join(repoRoot, 'templates/_diagnostics_assets.html'), 'utf8');
    const runtime = fs.readFileSync(path.join(repoRoot, 'templates/_shared_runtime_assets.html'), 'utf8');
    assert.match(diagnostics, /include "_shared_runtime_assets\.html"/);
    assert.match(runtime, /js\/core\/ui-primitives\.js/);

    const templates = fs.readdirSync(path.join(repoRoot, 'templates'))
        .filter((filename) => filename.endsWith('.html'));
    for (const filename of templates) {
        const source = fs.readFileSync(path.join(repoRoot, 'templates', filename), 'utf8');
        if (!source.includes("js/core/global.js")) continue;
        assert.ok(source.includes('_diagnostics_assets.html'), `${filename} skips shared runtime assets`);
        assert.ok(source.indexOf('_diagnostics_assets.html') < source.indexOf('js/core/global.js'), `${filename} loads primitives after global.js`);
    }
});
