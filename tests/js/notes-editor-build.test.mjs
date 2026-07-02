import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const distDir = path.join(repoRoot, 'static/js/notes/dist');

test('notes editor bundle keeps generated assets relative to its Flask static directory', () => {
    const css = fs.readFileSync(path.join(distDir, 'notes-editor.css'), 'utf8');
    const scripts = fs.readdirSync(distDir)
        .filter((filename) => filename.endsWith('.js'))
        .map((filename) => fs.readFileSync(path.join(distDir, filename), 'utf8'));
    const versionedEntry = path.join(distDir, 'notes-editor-bundle-15.js');

    assert.ok(fs.existsSync(versionedEntry), 'missing versioned notes editor entry');
    assert.doesNotMatch(css, /url\(\s*["']?\/notes-editor/);
    scripts.forEach((script) => {
        assert.doesNotMatch(script, /(?:from|import\()\s*["']\/notes-editor/);
        assert.doesNotMatch(script, /notes-editor-bundle-15\.js\?/);
    });
    assert.match(css, /url\(\.\/notes-editor/);

    const generatedReferences = [css, ...scripts].flatMap((source) => (
        [...source.matchAll(/\.\/(notes-editor[-A-Za-z0-9.]+)/g)].map((match) => match[1])
    ));
    generatedReferences.forEach((filename) => {
        assert.ok(fs.existsSync(path.join(distDir, filename)), `missing generated asset: ${filename}`);
    });
});
