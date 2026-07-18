import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = path.join(repoRoot, 'static/js/notes/dist');

test('notes editor bundle keeps generated assets relative to its Flask static directory', () => {
    const css = fs.readFileSync(path.join(distDir, 'notes-editor.css'), 'utf8');
    const scripts = fs.readdirSync(distDir)
        .filter((filename) => filename.endsWith('.js'))
        .map((filename) => fs.readFileSync(path.join(distDir, filename), 'utf8'));

    assert.doesNotMatch(css, /url\(\s*["']?\/notes-editor/);
    scripts.forEach((script) => {
        assert.doesNotMatch(script, /(?:from|import\()\s*["']\/notes-editor/);
    });
    const generatedReferences = [css, ...scripts].flatMap((source) => (
        [...source.matchAll(/\.\/(notes-editor[-A-Za-z0-9.]+)/g)].map((match) => match[1])
    ));
    generatedReferences.forEach((filename) => {
        assert.ok(fs.existsSync(path.join(distDir, filename)), `missing generated asset: ${filename}`);
    });
});

test('notes editor bundle has one canonical versioned entry URL', () => {
    const filenames = fs.readdirSync(distDir).filter((filename) => filename.endsWith('.js'));
    const scripts = filenames.map((filename) => fs.readFileSync(path.join(distDir, filename), 'utf8'));

    assert.ok(filenames.includes('notes-editor-v17.js'));
    assert.equal(filenames.includes('notes-editor.js'), false);
    assert.equal(scripts.reduce((count, script) => count + (script.match(/Yjs was already imported/g) || []).length, 0), 1);
    scripts.forEach((script) => {
        assert.doesNotMatch(script, /["']\.\/notes-editor-v17\.js\?v=/);
    });
});

test('notes editor keeps first-load JavaScript within its gzip budget', () => {
    const entry = fs.readFileSync(path.join(distDir, 'notes-editor-v17.js'));
    const gzipBytes = gzipSync(entry, { level: 9 }).byteLength;

    assert.ok(gzipBytes <= 360_000, `notes editor entry is ${gzipBytes} gzip bytes; budget is 360000`);
});

test('notes editor defers optional runtimes and reuses shared site fonts', () => {
    const filenames = fs.readdirSync(distDir);
    const entry = fs.readFileSync(path.join(distDir, 'notes-editor-v17.js'), 'utf8');

    for (const feature of ['collaboration', 'print', 'review-panel']) {
        const chunk = filenames.find((filename) => filename === `notes-editor-${feature}.js`);
        assert.ok(chunk, `missing lazy ${feature} chunk`);
        assert.match(entry, new RegExp(`\\./notes-editor-${feature}\\.js`));
    }
    assert.equal(filenames.some((filename) => /\\.woff2?$/.test(filename)), false);
});
