import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const globalSource = fs.readFileSync('static/js/core/global.js', 'utf8');

test('same-origin unsafe fetches receive the CSRF header', () => {
    assert.match(globalSource, /unsafeMethods = new Set\(\["POST", "PUT", "PATCH", "DELETE"\]\)/);
    assert.match(globalSource, /url\.origin !== window\.location\.origin/);
    assert.match(globalSource, /headers\.set\("X-CSRFToken", token\)/);
});

test('logout uses a CSRF-protected POST instead of navigation GET', () => {
    assert.match(globalSource, /fetch\("\/logout", \{/);
    assert.match(globalSource, /method: "POST"/);
    assert.doesNotMatch(globalSource, /location\.assign\(`\$\{window\.location\.origin\}\/logout`\)/);
});
