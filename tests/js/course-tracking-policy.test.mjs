import featureModules from './helpers/feature-modules.cjs';
const { loadFeatureModule } = featureModules;
import assert from 'node:assert/strict';
import test from 'node:test';

const { describe } = loadFeatureModule('courses/tracking-policy.js');
const upcoming = { state: 'upcoming', effective_state: 'upcoming', available: true, label: 'Spring 2027' };

test('upcoming trackers are queued without claiming alerts are running', () => {
  const view = describe(upcoming, true);
  assert.equal(view.canEnable, true);
  assert.equal(view.active, false);
  assert.equal(view.status, 'queued');
  assert.match(view.description, /Queued/);
  assert.equal(view.next, 'When the term opens');
});

test('closed terms block enabling and do not describe a pending next check', () => {
  const view = describe({ ...upcoming, state: 'closed', effective_state: 'closed' }, true);
  assert.equal(view.canEnable, false);
  assert.equal(view.active, false);
  assert.equal(view.next, 'Term closed');
});

test('a page left open crosses schedule boundaries without misleading status', () => {
  const policy = { ...upcoming, opens_at: '2027-01-01T12:00:00Z', closes_at: '2027-01-02T12:00:00Z' };
  assert.equal(describe(policy, true, Date.parse('2027-01-01T11:59:00Z')).status, 'queued');
  assert.equal(describe(policy, true, Date.parse(policy.opens_at)).status, 'active');
  assert.equal(describe(policy, true, Date.parse(policy.closes_at)).canEnable, false);
  assert.equal(describe(policy, false, Date.parse(policy.opens_at)).status, 'paused');
});

test('missing policy fails closed in the student control', () => {
  assert.equal(describe(null, false).canEnable, false);
  assert.equal(describe(null, true).active, false);
});
