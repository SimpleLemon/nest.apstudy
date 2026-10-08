const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  buildCourseObject,
  parseCatalogCourseCards,
  parseEnrollmentStatus,
  parseEnvList,
  firstPresent,
  normalizeCampus,
  normalizeRequirements,
  parseInstructors,
  decodeHtmlEntities,
  parseMeetingTimes,
  splitCourseCode,
  stripTags,
} = require('../../scripts/atlas/atlasMainScraper.js');

const repoRoot = path.resolve(__dirname, '../..');
const scraperPath = path.join(repoRoot, 'scripts/atlas/atlasMainScraper.js');

// Exercise actual file placement without network access or writing semester data.
function loadWriter(env = {}) {
  const writes = [];
  const directories = [];
  const scraperRequire = createRequire(scraperPath);
  const context = vm.createContext({
    __dirname: path.dirname(scraperPath),
    module: { exports: {} },
    process: { env },
    require(name) {
      if (name === 'fs') return {
        mkdirSync(directory) { directories.push(directory); },
        writeFileSync(...args) { writes.push(args); },
      };
      return scraperRequire(name);
    },
    fetch() { throw new Error('Importing the scraper must not request the network'); },
  });
  vm.runInContext(fs.readFileSync(scraperPath, 'utf8'), context, { filename: scraperPath });
  return { write: context.writeCourseFile, writes, directories };
}

test('relocated scraper preserves repository-root semester output', () => {
  const writer = loadWriter();
  const course = { subject: 'CS', catalog_number: '253', course_title: 'Data Structures' };
  writer.write('Fall_2026', course);
  assert.deepEqual(writer.directories, [path.join(repoRoot, 'Fall_2026/CS')]);
  assert.equal(writer.writes[0][0], path.join(repoRoot, 'Fall_2026/CS/253.json'));
  assert.deepEqual(JSON.parse(writer.writes[0][1]), course);
  assert.equal(writer.writes[0][2], 'utf-8');
});

test('Atlas output override resolves from cwd and dry run skips writes', () => {
  for (const output of ['custom-atlas-output', path.join(repoRoot, 'custom-atlas-output')]) {
    const writer = loadWriter({ ATLAS_OUTPUT_DIR: output });
    writer.write('Spring_2026', { subject: 'MATH', catalog_number: '111' });
    assert.equal(writer.writes[0][0], path.join(path.resolve(output), 'Spring_2026/MATH/111.json'));
  }
  const dryRun = loadWriter({ ATLAS_DRY_RUN: '1' });
  dryRun.write('Fall_2026', { subject: 'CS', catalog_number: '253' });
  assert.deepEqual(dryRun.writes, []);
  assert.deepEqual(dryRun.directories, []);
});

test('npm scrape command and package entry resolve to the relocated scraper', () => {
  const packageJson = require('../../package.json');
  assert.equal(path.resolve(repoRoot, packageJson.main), scraperPath);
  assert.equal(packageJson.scripts['scrape:atlas'], `node ${packageJson.main}`);
});

test('parses comma-separated environment lists defensively', () => {
  assert.deepEqual(parseEnvList(' Fall_2026, Spring_2026 ,, '), ['Fall_2026', 'Spring_2026']);
  assert.deepEqual(parseEnvList(undefined), []);
});

test('parses Atlas meetingTimes payloads and invalid inputs', () => {
  const parsed = parseMeetingTimes(JSON.stringify([{
    meet_day: '1',
    start_time: 900,
    end_time: 1015,
  }]));

  assert.deepEqual(parsed, [{
    day: 'Tue',
    start: '900',
    end: '1015',
  }]);
  assert.deepEqual(parseMeetingTimes('not-json'), []);
  assert.deepEqual(parseMeetingTimes([]), []);
});

test('normalizes enrollment, course codes, tags, and instructors', () => {
  assert.equal(parseEnrollmentStatus('O'), 'Open');
  assert.equal(parseEnrollmentStatus('X'), 'X');
  assert.deepEqual(splitCourseCode('CS 253'), { subject: 'CS', catalog: '253' });
  assert.deepEqual(splitCourseCode('BADCODE'), { subject: 'BADCODE', catalog: 'UNKNOWN' });
  assert.equal(stripTags('<p>Data &amp; Society&nbsp;</p>'), 'Data & Society');
  assert.equal(decodeHtmlEntities('MATH &#65; &lt;CS&gt;'), 'MATH A <CS>');
  assert.equal(firstPresent({ empty: '', fallback: 'room 101' }, ['missing', 'empty', 'fallback']), 'room 101');
  assert.equal(normalizeCampus('Oxford College', 'OXBI'), 'Oxford');
  assert.equal(normalizeCampus('Main Campus', 'CS'), 'Atlanta');
  assert.deepEqual(normalizeRequirements({ ger: 'First Year Writing(*)' }, { requirements: ['Race and Ethnicity(*)'] }), [
    'First Year Writing(*)',
    'Race and Ethnicity(*)',
  ]);
  assert.deepEqual(parseInstructors({ instructors: [{ name: 'Ada', email: 'ada@example.test' }, 'Grace Hopper'] }), [
    { name: 'Ada', email: 'ada@example.test' },
    { name: 'Grace Hopper', email: null },
  ]);
  assert.deepEqual(parseInstructors({ instr: 'Staff; Ada Lovelace | TBA; Grace Hopper' }), [
    { name: 'Ada Lovelace', email: null },
    { name: 'Grace Hopper', email: null },
  ]);
});

test('extracts catalog card metadata used for course enrichment', () => {
  const html = '<div class="card"><div class="card-header"><button>CS 253: Data Structures</button></div><div class="card-body"><p class="card-text">Algorithms &amp; structures.</p><dt>Credit Hours</dt><dd>4</dd><dt>Requisites</dt><dd>CS 170</dd></div></div></div>';

  assert.deepEqual(parseCatalogCourseCards(html), {
    'CS|253': {
      course_title: 'Data Structures',
      credit_hours: '4',
      requirement_designation: null,
      requirements: [],
      course_description: 'Algorithms & structures.',
      course_notes: 'CS 170',
      requisites: 'CS 170',
      cross_listed: null,
    },
  });
});

test('builds enriched course objects from Atlas sections', () => {
  const course = buildCourseObject('CS 253', [{
    code: 'CS 253',
    title: 'Atlas title',
    crn: '12345',
    no: '1',
    schd: 'LEC',
    instr: 'Ada Lovelace',
    enrl_stat: 'O',
    total: 25,
    campus: 'Oxford College',
    requirement_designation: 'First Year Seminar(*)',
    meetingTimes: JSON.stringify([{ meet_day: '0', start_time: 1000, end_time: 1050 }]),
    instructors: [{ name: 'Ada Lovelace' }],
    start_date: '2026-08-26',
    end_date: '2026-12-09',
  }], 'Fall_2026', '5269', {
    'CS|253': { course_title: 'Catalog title', course_description: 'Catalog description', credit_hours: '4', requisites: 'CS 170' },
  });

  assert.equal(course.subject, 'CS');
  assert.equal(course.catalog_number, '253');
  assert.equal(course.course_title, 'Atlas title');
  assert.equal(course.course_description, 'Catalog description');
  assert.equal(course.credit_hours, '4');
  assert.deepEqual(course.requirements, ['First Year Seminar(*)']);
  assert.equal(course.requisites, 'CS 170');
  assert.deepEqual(course.instructors_unique, ['Ada Lovelace']);
  assert.equal(course.sections[0].enrollment_status, 'Open');
  assert.equal(course.sections[0].campus, 'Oxford');
  assert.deepEqual(course.sections[0].schedule.meetings, [{ day: 'Mon', start: '1000', end: '1050' }]);
});

// Run the public scraper API against controlled HTTP and an in-memory output
// filesystem. Every request is intercepted; there are no live Atlas calls.
function loadControlledScraper(respond, env = {}) {
  const output = path.join(repoRoot, 'controlled-atlas-output');
  const preservedPath = path.join(output, 'Fall_2026/CS/253.json');
  const preservedBody = '{"existing":"complete-campus-data"}';
  const files = new Map([[preservedPath, preservedBody]]);
  const requests = [];
  const logs = [];
  const fakeProcess = { env: {
    ATLAS_OUTPUT_DIR: output, ATLAS_TERMS: 'Fall_2026', ATLAS_SUBJECTS: 'CS,MATH',
    ATLAS_DETAILS: 'off', ATLAS_REQUIREMENTS: 'off', ...env,
  } };
  const scraperRequire = createRequire(scraperPath);
  const context = vm.createContext({
    __dirname: path.dirname(scraperPath), module: { exports: {} }, process: fakeProcess,
    URL, AbortController,
    console: Object.fromEntries(['log', 'warn', 'error'].map(level => [level, (...args) => logs.push(args.join(' '))])),
    setTimeout(callback, delay) { if (delay === 1500) callback(); return 1; },
    clearTimeout() {},
    require(name) {
      if (name === 'fs') return {
        mkdirSync() {},
        writeFileSync(file, contents) { files.set(file, contents); },
      };
      return scraperRequire(name);
    },
    async fetch(url, options) {
      if (!options?.body) return { ok: true, text: async () => '' };
      const body = JSON.parse(options.body);
      const subject = body.criteria.find(item => item.field === 'subject').value;
      const campus = body.criteria.find(item => item.field === 'campus')?.value || 'all';
      requests.push({ subject, campus });
      const payload = await respond(subject, campus);
      if (payload?.httpStatus) return { ok: false, status: payload.httpStatus };
      return { ok: true, async json() {
        if (payload instanceof Error) throw payload;
        return payload;
      } };
    },
  });
  vm.runInContext(fs.readFileSync(scraperPath, 'utf8'), context, { filename: scraperPath });
  return { api: context.module.exports, files, requests, logs, fakeProcess, preservedPath, preservedBody, output };
}

function subjectResults(subject, campus) {
  return { results: [{ code: `${subject} ${subject === 'CS' ? '253' : '111'}`, crn: '12345', no: '1', campus }] };
}

test('fetchSubject returns null only for recognized invalid searches and rejects real failures', async () => {
  const invalid = loadControlledScraper(() => ({ fatal: 'Invalid search criteria.' }));
  assert.equal(await invalid.api.fetchSubject('CS', '5269'), null);
  const empty = loadControlledScraper(() => ({ results: [] }));
  assert.deepEqual(Array.from(await empty.api.fetchSubject('CS', '5269')), []);

  for (const payload of [null, '', {}, { results: {} }, { fatal: 'Service temporarily unavailable' }, { httpStatus: 503 }, new SyntaxError('Unexpected token in JSON')]) {
    const controlled = loadControlledScraper(() => payload);
    await assert.rejects(controlled.api.fetchSubject('CS', '5269'));
  }
  const transport = loadControlledScraper(() => { throw new Error('Connection reset'); });
  await assert.rejects(transport.api.fetchSubject('CS', '5269'), /Connection reset/);
});

test('partial campus failures preserve existing subject output, continue other subjects, and fail CLI status', async () => {
  for (const failedCampus of ['all', 'Oxford']) {
    for (const failure of [new Error('Connection reset'), new SyntaxError('Invalid JSON'), { httpStatus: 503 }, { results: {} }]) {
      const controlled = loadControlledScraper((subject, campus) => {
        if (subject === 'CS' && campus === failedCampus) {
          if (failure.name === 'Error') throw failure;
          return failure;
        }
        return subjectResults(subject, campus);
      });
      const meta = await controlled.api.runCli();
      assert.equal(meta.status, 'partial');
      assert.equal(controlled.fakeProcess.exitCode, 1);
      assert.equal(controlled.files.get(controlled.preservedPath), controlled.preservedBody);
      assert.ok(controlled.files.has(path.join(controlled.output, 'Fall_2026/MATH/111.json')));
      assert.equal(controlled.requests.length, 4);
      const term = meta.terms.Fall_2026;
      assert.equal(term.subjects_attempted, 2);
      assert.equal(term.subjects_failed, 1);
      assert.equal(term.subjects_with_data, 1);
      assert.equal(term.courses_written, 1);
      assert.equal(term.errors.length, 1);
      assert.equal(term.errors[0].subject, 'CS');
      assert.equal(term.errors[0].campus, failedCampus);
      assert.ok(term.errors[0].message);
      const savedMeta = JSON.parse(controlled.files.get(path.join(controlled.output, '_meta.json')));
      assert.equal(savedMeta.status, 'partial');
      assert.deepEqual(savedMeta.terms.Fall_2026.errors, JSON.parse(JSON.stringify(term.errors)));
      assert.ok(controlled.logs.some(log => /Scrape Partial/.test(log)));
      assert.ok(controlled.logs.some(log => /existing course files preserved/.test(log)));
    }
  }
});

test('all failed campuses are recorded even when another campus succeeds', async () => {
  const controlled = loadControlledScraper((subject, campus) => {
    if (subject === 'CS') throw new Error(`Failed ${campus}`);
    return subjectResults(subject, campus);
  });
  const meta = await controlled.api.runScrape();
  assert.equal(meta.status, 'partial');
  assert.deepEqual(Array.from(meta.terms.Fall_2026.errors, error => error.campus), ['all', 'Oxford']);
  assert.equal(controlled.files.get(controlled.preservedPath), controlled.preservedBody);
});

test('recognized invalid campus search permits a complete successful scrape', async () => {
  const controlled = loadControlledScraper((subject, campus) => campus === 'Oxford'
    ? { fatal: 'Invalid search' }
    : subjectResults(subject, campus));
  const meta = await controlled.api.runCli();
  assert.equal(meta.status, 'complete');
  assert.equal(controlled.fakeProcess.exitCode, 0);
  assert.equal(meta.terms.Fall_2026.errors.length, 0);
  assert.equal(meta.terms.Fall_2026.subjects_failed, 0);
  assert.equal(meta.terms.Fall_2026.courses_written, 2);
  assert.notEqual(controlled.files.get(controlled.preservedPath), controlled.preservedBody);
});

test('partial dry runs report failure metadata without writing any output', async () => {
  const controlled = loadControlledScraper(() => { throw new Error('Offline'); }, { ATLAS_DRY_RUN: '1' });
  const meta = await controlled.api.runCli();
  assert.equal(meta.status, 'partial');
  assert.equal(controlled.fakeProcess.exitCode, 1);
  assert.equal(controlled.files.size, 1);
  assert.equal(controlled.files.get(controlled.preservedPath), controlled.preservedBody);
  assert.equal(meta.terms.Fall_2026.errors.length, 4);
});
