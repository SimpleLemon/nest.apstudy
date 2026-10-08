import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));

function lockedDependency(from, name) {
  let parent = from;
  while (true) {
    const key = parent ? `${parent}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[key]) return lock.packages[key];
    if (!parent) return null;
    parent = path.posix.dirname(parent);
    if (parent === '.') parent = '';
  }
}

test('collaboration codec is an exact direct dependency and jsdom is absent from the lock', () => {
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.equal(manifest.dependencies.lib0, '0.2.117');
  assert.equal(lock.packages['node_modules/lib0'].version, '0.2.117');
  assert.equal(manifest.dependencies.jsdom, undefined);
  assert.equal(lock.packages['node_modules/jsdom'], undefined);
  assert.equal(manifest.dependencies.cmdk, undefined);
});

test('removing jsdom retains all required lock dependency edges', () => {
  for (const [from, pkg] of Object.entries(lock.packages)) {
    for (const name of Object.keys(pkg.dependencies || {})) {
      if (pkg.optionalDependencies?.[name]) continue;
      assert.ok(lockedDependency(from, name), `${from || 'root'} cannot resolve ${name}`);
    }
  }
});

test('palette imports its runtime locally and ships a bundled entry with public controls', async () => {
  for (const filename of ['command-palette.js', 'command-palette/command-palette-workspace.js', 'command-palette/command-palette-controls.js']) {
    const source = await readFile(new URL(`../../static/js/core/${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:import|from)\s*['"]https?:/);
  }
  const built = await readFile(new URL('../../static/js/core/dist/command-palette.js', import.meta.url), 'utf8');
  assert.doesNotMatch(built, /(?:import|from)\s*['"](?:https?:|react(?:-dom)?(?:\/client)?['"])/);
  assert.match(built, /export\{[^}]*commandPalette/);
  assert.match(manifest.scripts.build, /npm run build:palette/);
});
