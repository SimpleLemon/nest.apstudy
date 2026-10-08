const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBrowserExportTransport } = require('../../scripts/atlas/browser-export');
const { fetchAllResults, createTransport } = require('../../scripts/atlas/transport');
const { collectRoster, enrichRoster } = require('../../scripts/atlas/importer');
const { parseMetadataHtml } = require('../../scripts/atlas/metadata');

function section(index) {
  return { code: 'ENG_OX 185', crn: String(index + 1000), no: String(index + 1), srcdb: '5269' };
}

test('official tentative scheduling notices remain part of discovered term metadata', () => {
  const html = '<select id="crit-srcdb"><option value="5271">Spring 2027</option></select>'
    + '<select id="crit-subject"><option value="ENG">English</option></select>'
    + '<select id="crit-career"><option value="UCOL">Emory College</option></select>'
    + '<p>Note: Spring 2027 Classes are tentatively scheduled and subject to change.</p>';
  const term = parseMetadataHtml(html).terms.Spring_2027;
  assert.equal(term.tentative, true);
  assert.match(term.notice, /subject to change/);
});

test('subjects omitted from Atlas selectors are discovered from and reconciled against the career roster', async () => {
  const row = { ...section(0), code: 'SIRE 299R', academic_career: 'UGRD' };
  const queried = [];
  const transport = { async post(_route, body) {
    const subject = body.criteria.find(item => item.field === 'subject')?.value;
    if (subject) queried.push(subject);
    const results = !subject || subject === 'SIRE' ? [row] : [];
    return { srcdb: '5269', count: results.length, results };
  } };
  const metadata = { career_field: 'career', subject_field: 'subject', subjects: [{ value: 'ENG', label: 'English' }],
    careers: [{ value: 'UGRD', label: 'Undergraduate' }] };
  const result = await collectRoster(metadata, { srcdb: '5269' }, transport);
  assert.deepEqual(queried, ['ENG', 'SIRE']);
  assert.equal(result.coverage.sections, 1);
  assert.deepEqual(result.coverage.discovered_subjects.SIRE.careers, ['UGRD']);
});

test('native Atlas count supports complete responses above the requested page size', async () => {
  const rows = Array.from({ length: 600 }, (_, index) => section(index));
  const result = await fetchAllResults(async () => ({ srcdb: '5269', count: rows.length, results: rows }), '5269', []);
  assert.equal(result.rows.length, 600);
  assert.equal(result.source_total, 600);
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', count: 600, results: rows.slice(0, 500) }), '5269', []), /Duplicate/);
  await assert.rejects(fetchAllResults(async () => ({ srcdb: '5269', count: 600, results: rows }), '5269', [], { unpagedLimit: 600 }), /native unpaged result limit/);
});

test('native search responses require the requested term even when individual rows have no term', async () => {
  const row = { code: 'AAS 100', crn: '1918', no: '1', key: '74' };
  for (const srcdb of ['5269', undefined, null, '']) {
    await assert.rejects(fetchAllResults(async () => ({ srcdb, count: 1, results: [row] }), '5271', []), /response term does not match/);
    await assert.rejects(fetchAllResults(async () => ({ srcdb, count: 0, results: [] }), '5271', []), /response term does not match/);
  }
  assert.equal((await fetchAllResults(async () => ({ srcdb: 5271, count: 1, results: [row] }), '5271', [])).rows.length, 1);
  let page = 0;
  await assert.rejects(fetchAllResults(async () => ++page === 1
    ? { srcdb: '5271', count: 2, results: [row], next_offset: 1 }
    : { srcdb: '5269', count: 2, results: [{ ...row, crn: '1919', no: '2' }] }, '5271', []), /response term does not match/);
});

test('public Atlas transport uses the percent-encoded JSON format used by its browser', async () => {
  const transport = createTransport({ delay: 0, fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(decodeURIComponent(options.body)), { other: { srcdb: '5269' }, criteria: [] });
    return new Response(JSON.stringify({ srcdb: '5269', count: 0, results: [] }));
  } });
  assert.equal((await transport.post('search', { other: { srcdb: '5269' }, criteria: [] })).count, 0);
});

test('nondefault term details use Atlas native top-level srcdb instead of the search format', async () => {
  const transport = createTransport({ delay: 0, detailsDelay: 0, fetchImpl: async (_url, options) => {
    assert.deepEqual(JSON.parse(decodeURIComponent(options.body)), { group: 'key:42', srcdb: '5271' });
    return new Response(JSON.stringify({ srcdb: '5271', code: 'AAS 100' }));
  } });
  assert.equal((await transport.post('details', { other: { srcdb: '5271' }, group: 'key:42' })).srcdb, '5271');
});

test('native browser detail captures must match the requested nondefault term', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-browser-detail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = { srcdb: '5271', group: 'key:42' };
  const record = { route: 'details', body, url: 'https://atlas.emory.edu/api/?page=fose&route=details',
    status: 200, fetched_at: '2026-10-07T19:00:00Z', data: { srcdb: '5271', code: 'AAS 100' } };
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schema_version: 1, source: 'public-atlas-brave',
    origin: 'https://atlas.emory.edu', captured_at: record.fetched_at, requests: [{ file: '000000.json', route: 'details', body }] }));
  const write = () => fs.writeFileSync(path.join(root, '000000.json'), JSON.stringify(record));
  write();
  const transport = createBrowserExportTransport(root);
  assert.equal((await transport.post('details', { other: { srcdb: '5271' }, group: 'key:42' })).code, 'AAS 100');
  record.data.srcdb = '5269';
  write();
  await assert.rejects(transport.post('details', { other: { srcdb: '5271' }, group: 'key:42' }), /provenance or term/);
  delete record.data.srcdb;
  write();
  await assert.rejects(transport.post('details', { other: { srcdb: '5271' }, group: 'key:42' }), /provenance or term/);
});

test('detail enrichment requires its verified term even when course, key and class number coincide', async () => {
  const row = { code: 'AAS 100', crn: '1918', no: '1', key: '74' };
  for (const srcdb of ['5269', undefined, null, '']) {
    const result = await enrichRoster([row], '5271', { post: async () => ({
      code: row.code, crn: row.crn, section: row.no, key: row.key, srcdb,
    }) });
    assert.equal(result.details.status, 'partial');
    assert.match(result.details.errors[0].message, /term does not match/);
    assert.deepEqual(result.rows, [row]);
  }
  const valid = await enrichRoster([row], '5271', { post: async () => ({
    code: row.code, crn: row.crn, section: row.no, key: row.key, srcdb: 5271,
  }) });
  assert.equal(valid.details.status, 'complete');
});

test('browser exports require captured public responses and never invent missing requests', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const body = { other: { srcdb: '5269' }, criteria: [{ field: 'career', value: 'UOXF' }] };
  const record = { route: 'search', body, url: 'https://atlas.emory.edu/api/?page=fose&route=search',
    status: 200, fetched_at: '2026-10-07T15:00:00Z', data: { srcdb: '5269', count: 1, results: [section(0)] } };
  const index = { schema_version: 1, source: 'public-atlas-brave', origin: 'https://atlas.emory.edu',
    captured_at: record.fetched_at, requests: [{ file: '000000.json', route: 'search', body }] };
  const write = () => {
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(index));
    fs.writeFileSync(path.join(root, '000000.json'), JSON.stringify(record));
  };
  write();
  const transport = createBrowserExportTransport(root);
  assert.equal((await transport.post('search', { ...body, other: { srcdb: '5269', offset: 0, limit: 500, page: 1 } })).count, 1);
  await assert.rejects(transport.post('search', { ...body, criteria: [{ field: 'subject', value: 'ENG_OX' }] }), /Missing captured/);
  record.status = 202;
  write();
  await assert.rejects(transport.post('search', body), /provenance or term/);
  record.status = 200;
  record.data.srcdb = '5271';
  write();
  await assert.rejects(transport.post('search', body), /provenance or term/);
  index.requests[0].file = '../000000.json';
  write();
  assert.throws(() => createBrowserExportTransport(root), /Unsafe/);
});
