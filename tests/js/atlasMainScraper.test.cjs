const assert = require('node:assert/strict');
const test = require('node:test');

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
} = require('../../atlasMainScraper.js');

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
