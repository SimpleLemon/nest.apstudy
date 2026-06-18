const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildCourseObject,
  mergeSectionWithDetails,
  parseAtlasDetailsPayload,
  parseSeatsHtml,
} = require('../../atlasCourseUtils');

const fixtureDir = path.join(__dirname, '..', 'fixtures', 'atlas');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

test('parseSeatsHtml extracts capacity, availability, and waitlist', () => {
  const chem = parseSeatsHtml('<strong>Maximum Enrollment</strong>: 36 / <strong>Seats Avail</strong>: 34');
  assert.equal(chem.enrollment_capacity, 36);
  assert.equal(chem.seats_available, 34);

  const eng = parseSeatsHtml(
    '<strong>Maximum Enrollment</strong>: 16 / <strong>Seats Avail</strong>: 16<br/><strong>Waitlist Total</strong>: 0 of 6, Auto-Enroll'
  );
  assert.equal(eng.enrollment_capacity, 16);
  assert.equal(eng.seats_available, 16);
  assert.equal(eng.waitlist_total, 0);
  assert.equal(eng.waitlist_capacity, 6);
});

test('parseAtlasDetailsPayload maps CHEM 150 section 1 fields', () => {
  const search = loadFixture('search_chem_150_crn_2760.json');
  const details = loadFixture('details_chem_150_key_3449.json');
  const parsed = parseAtlasDetailsPayload(details, search);

  assert.equal(parsed.credit_hours, '3');
  assert.equal(parsed.enrollment_capacity, 36);
  assert.equal(parsed.seats_available, 34);
  assert.equal(parsed.grading_mode, 'Student Option');
  assert.equal(parsed.instruction_method, 'In Person');
  assert.equal(parsed.enrollment_status, 'Open');
  assert.equal(parsed.requirement_designation, 'Natural Sciences(*)');
  assert.equal(parsed.campus_description, 'ATL@ATLANTA');
  assert.equal(parsed.location, 'Atwood Chemistry Bldg. 260');
  assert.equal(parsed.instructors[0].email, 'dlynn2@emory.edu');
});

test('parseAtlasDetailsPayload maps ENG_OX 185 section 1 fields', () => {
  const search = loadFixture('search_eng_ox_185_crn_4196.json');
  const details = loadFixture('details_eng_ox_185_key_2463.json');
  const parsed = parseAtlasDetailsPayload(details, search);

  assert.equal(parsed.credit_hours, '3');
  assert.equal(parsed.enrollment_capacity, 16);
  assert.equal(parsed.seats_available, 16);
  assert.equal(parsed.waitlist_total, 0);
  assert.equal(parsed.waitlist_capacity, 6);
  assert.equal(parsed.grading_mode, 'Student Option');
  assert.equal(parsed.instruction_method, 'In Person');
  assert.equal(parsed.requirement_designation, 'First-Year Writing(*)');
  assert.equal(parsed.campus_description, 'OXF@OXFORD');
  assert.equal(parsed.location, 'Humanities Hall 201');
  assert.equal(parsed.instructors[0].email, 'aivey@emory.edu');
});

test('buildCourseObject writes enriched section fields from merged rows', () => {
  const search = loadFixture('search_chem_150_crn_2760.json');
  const details = loadFixture('details_chem_150_key_3449.json');
  const merged = mergeSectionWithDetails(search, details);
  const course = buildCourseObject('CHEM 150', [merged], 'Fall_2026', '5269');
  const section = course.sections[0];

  assert.equal(section.atlas_key, '3449');
  assert.equal(section.credit_hours, '3');
  assert.equal(section.seats_available, 34);
  assert.equal(section.enrollment_capacity, 36);
  assert.equal(section.grading_mode, 'Student Option');
  assert.equal(section.instruction_method, 'In Person');
  assert.equal(section.requirement_designation, 'Natural Sciences(*)');
  assert.equal(section.campus, 'Atlanta');
  assert.equal(section.campus_description, 'ATL@ATLANTA');
  assert.equal(section.location, 'Atwood Chemistry Bldg. 260');
});
