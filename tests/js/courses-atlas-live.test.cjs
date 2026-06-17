const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAdapter(fetchImpl, storage = new Map(), browserDirectEnabled = true) {
  const source = fs.readFileSync(path.join(__dirname, '../../static/js/courses/atlas-live.js'), 'utf8');
  const context = {
    console,
    URL,
    fetch: fetchImpl,
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    window: {
      APSTUDY_ATLAS_SRCDB: { Fall_2026: '5269' },
      APSTUDY_ATLAS_BROWSER_DIRECT_ENABLED: browserDirectEnabled,
    },
  };
  context.window.console = console;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.APStudyAtlasLive;
}

test('browser Atlas adapter posts FOSE subject search and normalizes rows', async () => {
  const calls = [];
  const adapter = loadAdapter(async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        results: [{
          code: 'CHEM 150',
          title: 'General Chemistry I',
          crn: '12345',
          no: '1',
          schd: 'LEC',
          instr: 'Ada Lovelace',
          enrl_stat: 'C',
          total: 30,
          campus: 'Oxford College',
          requirements: ['First Year Writing(*)'],
          meetingTimes: JSON.stringify([{ meet_day: '0', start_time: 900, end_time: 950 }]),
        }],
      }),
    };
  });

  const section = await adapter.fetchSectionStatus({
    term: 'Fall_2026',
    subject: 'CHEM',
    catalog_number: '150',
    crn: '12345',
    section_number: '1',
    campus: 'Oxford',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /page=fose/);
  assert.match(calls[0].url, /route=search/);
  assert.equal(JSON.parse(calls[0].options.body).other.srcdb, '5269');
  assert.deepEqual(JSON.parse(calls[0].options.body).criteria, [
    { field: 'subject', value: 'CHEM' },
    { field: 'campus', value: 'Oxford' },
  ]);
  assert.equal(section.id, 'Fall_2026|CHEM|150|12345|1');
  assert.equal(section.campus, 'Oxford');
  assert.deepEqual(JSON.parse(JSON.stringify(section.requirements)), ['First Year Writing(*)']);
  assert.equal(section.enrollment_status, 'Closed');
  assert.equal(section.seats_available, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(section.meetings)), [{ day: 'Mon', start: '900', end: '950' }]);
});

test('browser Atlas adapter caches subject results in session storage', async () => {
  let count = 0;
  const adapter = loadAdapter(async () => {
    count += 1;
    return {
      ok: true,
      json: async () => ({ results: [{ code: 'CS 171', crn: '77777', no: '2', enrl_stat: 'O' }] }),
    };
  });

  await adapter.fetchSubjectSections('Fall_2026', 'CS');
  await adapter.fetchSubjectSections('Fall_2026', 'CS');

  assert.equal(count, 1);
});

test('browser Atlas adapter propagates CORS or network failures without fallback', async () => {
  const adapter = loadAdapter(async () => {
    throw new Error('CORS blocked');
  });

  await assert.rejects(
    adapter.fetchSubjectSections('Fall_2026', 'CS'),
    /Atlas blocks browser live requests/
  );
});

test('browser Atlas adapter is disabled by default to avoid production CORS errors', async () => {
  let count = 0;
  const adapter = loadAdapter(async () => {
    count += 1;
    return { ok: true, json: async () => ({ results: [] }) };
  }, new Map(), false);

  await assert.rejects(
    adapter.fetchSubjectSections('Fall_2026', 'CS'),
    /Atlas blocks browser live requests/
  );
  assert.equal(count, 0);
});
