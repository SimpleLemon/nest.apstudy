import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const directory = await mkdtemp(path.join(os.tmpdir(), 'nest-profile-policy-test-'));
await cp(new URL('../../static/js/core/profile-policy.js', import.meta.url), path.join(directory, 'profile-policy.js'));
await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
const { validateUsername, validateProfileText } = await import(pathToFileURL(path.join(directory, 'profile-policy.js')));
await rm(directory, { recursive: true, force: true });

test('profile username policy normalizes and preserves bounds, allowed characters and error ordering', () => {
  assert.deepEqual(validateUsername('  User-Name_123  '), { value: 'user-name_123', error: '' });
  assert.equal(validateUsername('abc').error, '');
  assert.equal(validateUsername('a'.repeat(20)).error, '');
  for (const value of ['ab', 'a'.repeat(21)]) {
    assert.equal(validateUsername(value).error, 'Username must be between 3 and 20 characters.');
  }
  assert.equal(validateUsername(' \t ').error, 'Username is required.');
  for (const value of ['first last', 'éclair', 'person😀', 'a'.repeat(20) + '!']) {
    assert.equal(validateUsername(value).error, 'Please only use numbers, letters, dashes -, or underscores _.');
  }
});

test('profile username policy rejects every reserved name after normalization', () => {
  const reserved = ['account', 'admin', 'api', 'auth', 'calendar', 'dashboard', 'data', 'files', 'login', 'logout', 'notes', 'onboarding', 'preferences', 'profile', 'settings', 'signup', 'u', 'user', 'users'];
  for (const name of reserved) {
    const result = validateUsername(` ${name.toUpperCase()} `);
    assert.equal(result.value, name);
    assert.equal(result.error, name === 'u' ? 'Username must be between 3 and 20 characters.' : 'That username is reserved.');
  }
});

test('profile text policy trims, counts Unicode codepoints and preserves required and optional fields', () => {
  for (const [field, label, maximum] of [['displayName', 'Display name', 80], ['school', 'School', 160], ['major', 'Major', 120]]) {
    assert.deepEqual(validateProfileText(field, `  ${'😀'.repeat(maximum)}\n`), { value: '😀'.repeat(maximum), error: '', length: maximum, maximum });
    assert.equal(validateProfileText(field, '😀'.repeat(maximum + 1)).error, `${label} must be ${maximum} characters or fewer.`);
    assert.equal(validateProfileText(field, ' \t ').error, field === 'displayName' ? 'Display name is required.' : '');
    assert.equal(validateProfileText(field, ' e\u0301 ').length, 2, 'combining marks count as codepoints rather than graphemes');
  }
});
