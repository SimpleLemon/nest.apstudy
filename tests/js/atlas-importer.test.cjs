// All metadata and rosters here are synthetic; these tests make no HTTP requests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseMetadataHtml, validateMetadata, undergraduateCareers } = require('../../scripts/atlas/metadata');
const { parseOptions, selectTerms, runCli } = require('../../scripts/atlas/cli');
const { AtlasAccessRefused, createTransport, fetchAllResults } = require('../../scripts/atlas/transport');
const { collectRoster, enrichRoster, importTerm } = require('../../scripts/atlas/importer');
const { atomicJson, readJson, publishSnapshot, acquireImportLock } = require('../../scripts/atlas/snapshots');

function metadata(overrides = {}) {
  return validateMetadata({ version: 1, complete: true, source: 'https://atlas.emory.edu/',
    discovered_at: '2026-03-01T00:00:00Z',
    terms: { Spring_2026: { srcdb: '5261', label: 'Spring 2026' }, Fall_2026: { srcdb: '5269', label: 'Fall 2026' } },
    careers: [{ value: 'UGRD', label: 'Undergraduate' }, { value: 'GRAD', label: 'Graduate' }],
    subjects: [{ value: 'TEST', label: 'Test subject' }, { value: 'ENG_OX', label: 'Oxford test subject' }], ...overrides });
}

function section(index, extra = {}) {
  return { code: 'TEST 700', crn: String(1000 + index), no: String(index + 1).padStart(3, '0'),
    key: String(5000 + index), srcdb: '5269', academic_career: 'UGRD', total: '30',
    instr: 'Jane Example', campus: 'Atlanta', ...extra };
}

function rosterTransport(rows, transform = value => value) {
  const requests = [];
  return { requests, async post(route, body) {
    requests.push({ route, body });
    assert.equal(route, 'search');
    const filters = Object.fromEntries(body.criteria.map(item => [item.field, item.value]));
    const result = rows.filter(row => row.academic_career === filters.acad_career
      && (!filters.subject || row.code.split(' ')[0] === filters.subject));
    return transform({ srcdb: body.other.srcdb, total: result.length, results: result.slice(body.other.offset, body.other.offset + body.other.limit) }, body);
  } };
}

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-atlas-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('discovers published terms, careers, and exact Oxford subject codes from selectors', () => {
  const html = `<select id="crit-srcdb"><option value="">Select</option><option value="5269">Fall 2026</option></select>
    <select name="acad_career"><option value="UGRD">Undergraduate</option><option value="GRAD">Graduate</option></select>
    <select data-field="subject"><option value="all">All</option><option value="ENG_OX">English &amp; Writing</option></select>`;
  const discovered = parseMetadataHtml(html);
  assert.equal(discovered.terms.Fall_2026.srcdb, '5269');
  assert.deepEqual(discovered.subjects, [{ value: 'ENG_OX', label: 'English & Writing' }]);
  assert.deepEqual(undergraduateCareers(discovered).map(item => item.value), ['UGRD']);
  assert.throws(() => parseMetadataHtml('<select name="srcdb"><option value="5269">Fall 2026</option></select>'), /complete term, career, and subject/);
  assert.throws(() => parseMetadataHtml(html.replace('</select>', '<option value="9999">Fall 2026</option></select>')), /Duplicate Atlas term/);
});

test('undergraduate scope requires all schools and respects explicit graduate exclusions', () => {
  const careers = [
    { value: 'UCOL', label: 'Emory College' }, { value: 'UOXF', label: 'Oxford College' },
    { value: 'UBUS', label: 'Business BBA', undergraduate: true },
    { value: 'UNUR', label: 'Nursing BSN', undergraduate: true },
    { value: 'GOXF', label: 'Oxford graduate', undergraduate: false },
  ];
  assert.deepEqual(undergraduateCareers(metadata({ careers })).map(item => item.value), ['UCOL', 'UOXF', 'UBUS', 'UNUR']);
  assert.throws(() => undergraduateCareers(metadata({ careers: careers.slice(0, 2) })), /business, undergraduate nursing/);
  assert.throws(() => validateMetadata({ ...metadata(), complete: false }), /complete:true/);
  assert.throws(() => validateMetadata({ ...metadata(), subjects: [{ value: 'A', label: 'A' }, { value: 'A', label: 'Again' }] }), /duplicate subjects/);
});

test('CLI options override environment and unknown modes, terms, or partial writes fail', () => {
  const parsed = parseOptions(['--terms', 'Fall_2026', '--details', 'off', '--delay-ms', '2', '--requirements', 'off'],
    { ATLAS_TERMS: 'Spring_2026', ATLAS_UPCOMING: '1', ATLAS_DETAILS: 'on', ATLAS_REQUEST_DELAY_MS: '100', ATLAS_REQUIREMENTS: 'HAP' });
  assert.deepEqual(parsed.terms, ['Fall_2026']);
  assert.equal(parsed.upcoming, false);
  assert.equal(parsed.details, false);
  assert.equal(parsed.delay, 2);
  assert.deepEqual(parsed.requirements, []);
  assert.throws(() => parseOptions(['--terms', 'Fall_2026', '--subjects', 'TEST'], {}), /require --dry-run/);
  assert.throws(() => parseOptions(['--terms', 'Fall_2026', '--upcoming'], {}), /exactly one/);
  assert.throws(() => selectTerms(metadata(), { terms: ['Fall_2027'] }), /Unknown or unpublished/);
  assert.deepEqual(selectTerms(metadata(), { upcoming: true }, new Date('2026-03-01')), ['Fall_2026']);
  assert.throws(() => selectTerms(metadata(), { upcoming: true }, new Date('2027-01-01')), /no published upcoming/);
});

test('search exhausts explicit totals and continuation cursors instead of dropping after 500', async () => {
  const rows = Array.from({ length: 625 }, (_, index) => section(index));
  const transport = rosterTransport(rows);
  const result = await fetchAllResults(transport.post, '5269', [{ field: 'acad_career', value: 'UGRD' }]);
  assert.equal(result.rows.length, 625);
  assert.deepEqual(transport.requests.map(item => item.body.other.offset), [0, 500]);
  let page = 0;
  const cursor = await fetchAllResults(async () => ++page === 1
    ? { srcdb: '5269', results: [rows[0]], next_offset: 1 } : { srcdb: '5269', results: [rows[1]], has_more: false }, '5269', []);
  assert.equal(cursor.rows.length, 2);
  assert.equal(cursor.source_total, null);
});

test('search refuses truncation, ignored pagination, changing totals, and wrong-term rows', async () => {
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', results: [section(0)], truncated: true }), '5269', []), /truncated/);
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', results: [section(0)] }), '5269', [], { pageSize: 1 }), /unverified result limit/);
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', results: [section(0)], total: 2 }), '5269', [], { pageSize: 1 }), /Duplicate/);
  let page = 0;
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', results: [section(page++)], total: page === 1 ? 3 : 2 }), '5269', []), /total changed/);
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', results: [section(0, { srcdb: '5261' })] }), '5269', []), /another term/);
  const result = await fetchAllResults(async () => ({ srcdb: '5269', results: [section(0, { total: '200' })] }), '5269', []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.source_total, null); // row.total counts sections of one course, not the roster
});

test('broad and subject rosters must reconcile every identity including Oxford and high course numbers', async () => {
  const rows = [section(0), section(1, { code: 'ENG_OX 900', campus: 'Oxford' })];
  const result = await collectRoster(metadata(), metadata().terms.Fall_2026, rosterTransport(rows));
  assert.equal(result.coverage.sections, 2);
  assert.equal(result.coverage.subjects.ENG_OX, 1);
  const missing = rosterTransport(rows, (payload, body) => body.criteria.some(item => item.value === 'ENG_OX')
    ? { srcdb: '5269', results: [], total: 0 } : payload);
  await assert.rejects(collectRoster(metadata(), metadata().terms.Fall_2026, missing), error => {
    assert.equal(error.reconciliation.missing.length, 1);
    return /roster mismatch/.test(error.message);
  });
  const ignored = rosterTransport(rows, (payload, body) => body.criteria.some(item => item.value === 'ENG_OX')
    ? { srcdb: '5269', results: [rows[0]], total: 1 } : payload);
  await assert.rejects(collectRoster(metadata(), metadata().terms.Fall_2026, ignored), /ignored subject filter/);
  await assert.rejects(collectRoster(metadata(), metadata().terms.Fall_2026, rosterTransport([])), /empty undergraduate roster/);
});

test('Atlas access refusal halts later requests, including per-section enrichment', async () => {
  for (const response of [new Response('', { status: 403 }), new Response('', { status: 202 }),
    new Response('', { status: 302 }), new Response('captcha verification', { status: 503 })]) {
    let calls = 0;
    const transport = createTransport({ delay: 0, detailsDelay: 0, fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      return response;
    } });
    await assert.rejects(enrichRoster([section(0), section(1)], '5269', transport), AtlasAccessRefused);
    await assert.rejects(transport.fetchText('https://atlas.emory.edu/'), AtlasAccessRefused);
    assert.equal(calls, 1);
  }
});

test('detail identity failures never publish partial enrichment', async (t) => {
  const root = tempRoot(t);
  const transport = rosterTransport([section(0)]);
  const search = transport.post;
  transport.post = (route, body) => route === 'details' ? { srcdb: '5269', code: 'WRONG 100' } : search(route, body);
  await assert.rejects(importTerm({ metadata: metadata(), termName: 'Fall_2026', atlasRoot: path.join(root, 'data/atlas'),
    legacyRoot: root, transport }), /enrichment is incomplete/);
  assert.equal(fs.existsSync(path.join(root, 'data/atlas/manifest.json')), false);
  assert.equal(fs.readdirSync(path.join(root, 'data/atlas/reports')).length, 1);
});

test('wrong or missing search and detail terms preserve the active snapshot', async (t) => {
  const root = tempRoot(t);
  const atlasRoot = path.join(root, 'data/atlas');
  const row = section(0);
  const args = { metadata: metadata(), termName: 'Fall_2026', atlasRoot, legacyRoot: root };
  await importTerm({ ...args, transport: rosterTransport([row]), options: { details: false } });
  const manifestFile = path.join(atlasRoot, 'manifest.json');
  const before = fs.readFileSync(manifestFile, 'utf8');
  for (const route of ['search', 'details']) {
    for (const srcdb of ['5261', undefined]) {
      const transport = rosterTransport([row], payload => route === 'search' ? { ...payload, srcdb } : payload);
      const search = transport.post;
      transport.post = (requestRoute, body) => requestRoute === 'details'
        ? { code: row.code, crn: row.crn, key: row.key, section: row.no, srcdb } : search(requestRoute, body);
      await assert.rejects(importTerm({ ...args, transport }), route === 'search'
        ? /search response term does not match/ : /enrichment is incomplete/);
      assert.equal(fs.readFileSync(manifestFile, 'utf8'), before);
    }
  }
});

test('full CLI atomically publishes snapshots, retains history, and reports removed legacy sections', async (t) => {
  const root = tempRoot(t);
  const source = path.join(root, 'metadata.json');
  const output = path.join(root, 'output');
  atomicJson(source, metadata());
  atomicJson(path.join(output, 'Fall_2026/TEST/700.json'), { course_code: 'TEST 700', sections: [
    { crn: '999', section_number: 'OLD' }] });
  const run = rows => runCli(['--terms', 'Fall_2026', '--metadata', source, '--output-dir', output, '--details', 'off'], {},
    { log() {}, transport: rosterTransport(rows) });
  const first = await run([section(0), section(1, { code: 'ENG_OX 900' })]);
  assert.equal(first.status, 'complete');
  assert.deepEqual(first.reports[0].reconciliation.removed, ['TEST 700|999|OLD']);
  const atlasRoot = path.join(output, 'data/atlas');
  const initial = readJson(path.join(atlasRoot, 'manifest.json')).terms.Fall_2026;
  const saved = readJson(path.join(atlasRoot, initial.path, 'TEST/700.json'));
  assert.equal(saved.sections[0].academic_career, 'UGRD');
  assert.equal(saved.sections[0].crn, '1000');
  await run([section(0)]);
  const updated = readJson(path.join(atlasRoot, 'manifest.json')).terms.Fall_2026;
  assert.notEqual(initial.generation, updated.generation);
  assert.equal(updated.previous_generations[0].generation, initial.generation);
  assert.equal(fs.existsSync(path.join(atlasRoot, initial.path, 'ENG_OX/900.json')), true);
  const before = fs.readFileSync(path.join(atlasRoot, 'manifest.json'), 'utf8');
  await assert.rejects(run([]), /empty undergraduate/);
  assert.equal(fs.readFileSync(path.join(atlasRoot, 'manifest.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(atlasRoot, '.import.lock')), false);
});

test('dry run, list-terms, help, and unknown terms leave output untouched', async (t) => {
  const root = tempRoot(t);
  const source = path.join(root, 'metadata.json');
  const output = path.join(root, 'output');
  atomicJson(source, metadata());
  const common = ['--metadata', source, '--output-dir', output];
  const dependencies = { log() {}, transport: rosterTransport([section(0)]) };
  assert.equal((await runCli(['--list-terms', ...common], {}, dependencies)).status, 'listed');
  assert.equal((await runCli(['--help'], {}, { log() {} })).status, 'help');
  assert.equal((await runCli(['--terms', 'Fall_2026', '--dry-run', '--details', 'off', ...common], {}, dependencies)).status, 'dry_run');
  await assert.rejects(runCli(['--terms', 'Fall_2027', ...common], {}, dependencies), /Unknown or unpublished/);
  assert.equal(fs.existsSync(output), false);
});

test('interrupted publication leaves the previous generation active and lock prevents concurrent writers', (t) => {
  const root = tempRoot(t);
  const args = { atlasRoot: root, term: 'Fall_2026', metadata: metadata().terms.Fall_2026, rows: [section(0)],
    report: { status: 'validated', finished_at: '2026-03-01T00:00:00Z', errors: [],
      coverage: { scope: 'undergraduate', verification: 'career_subject_roster_identity', sections: 1 } } };
  publishSnapshot(args);
  const manifest = fs.readFileSync(path.join(root, 'manifest.json'), 'utf8');
  assert.throws(() => publishSnapshot({ ...args, beforePublish() { throw new Error('Interrupted'); } }), /Interrupted/);
  assert.equal(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'), manifest);
  const release = acquireImportLock(root);
  assert.throws(() => acquireImportLock(root), /lock exists/);
  release();
  acquireImportLock(root)();
});
