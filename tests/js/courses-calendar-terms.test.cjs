const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFeatureModule } = require('./helpers/feature-modules.cjs');

const { createCourseData } = loadFeatureModule('courses/data.js');

test('planner terms keep Spring 2026 before Fall and put newer years and seasons to the right', async () => {
  const state = { selectedTerm: 'Fall_2026' };
  const data = createCourseData({ state, fetchJson: async () => ({
    terms: ['Spring_2028', 'Winter_2027', 'Fall_2027', 'Summer_2027', 'Spring_2027', 'Fall_2026', 'Spring_2026', 'Fall_2026'],
    default_term: 'Spring_2027',
  }) });
  await data.loadTerms();
  assert.deepEqual(Array.from(state.terms), ['Spring_2026', 'Fall_2026', 'Spring_2027', 'Summer_2027', 'Fall_2027', 'Winter_2027', 'Spring_2028']);
  assert.equal(state.selectedTerm, 'Fall_2026');
});

test('a selected Spring 2026 term stays selected after sorting', async () => {
  const state = { selectedTerm: 'Spring_2026' };
  await createCourseData({ state, fetchJson: async () => ({
    terms: ['Spring_2027', 'Fall_2026', 'Spring_2026'], default_term: 'Spring_2027',
  }) }).loadTerms();
  assert.equal(state.selectedTerm, 'Spring_2026');
});

test('an unavailable selected term falls back to the default or earliest available term', async () => {
  for (const [defaultTerm, expected] of [['Spring_2027', 'Spring_2027'], ['Fall_2025', 'Spring_2026']]) {
    const state = { selectedTerm: 'Fall_2025' };
    await createCourseData({ state, fetchJson: async () => ({
      terms: ['Spring_2027', 'Fall_2026', 'Spring_2026'], default_term: defaultTerm,
    }) }).loadTerms();
    assert.equal(state.selectedTerm, expected);
  }
});

test('calendar credits count saved classes once in the displayed term and stay stable during previews', () => {
  const nodes = Object.fromEntries(['courses-calendar-root', 'courses-week-title', 'courses-term-dates', 'courses-prev-term', 'courses-next-term']
    .map(id => [id, { innerHTML: '', textContent: '' }]));
  const document = { getElementById: id => nodes[id] || null };
  const context = { document };
  const utils = loadFeatureModule('courses/utils.js', context);
  const { createCourseCalendar } = loadFeatureModule('courses/calendar.js', context);
  const meetings = [{ day: 'Mon', start: '0900', end: '1000' }, { day: 'Wed', start: '0900', end: '1000' }];
  const courses = [
    { id: 'old-spring', term: 'Spring_2026', course_code: 'OLD-SPRING', credit_hours: 2, meetings },
    { id: 'fall-a', term: 'Fall_2026', course_code: 'FALL-A', credit_hours: '3', meetings },
    { id: 'fall-b', term: 'Fall_2026', course_code: 'FALL-B', credits: 4, meetings },
    { id: 'spring-a', term: 'Spring_2027', course_code: 'SPRING-A', credit_hours: '4.5', meetings },
    { id: 'unknown', term: 'Spring_2027', credit_hours: 'TBA', meetings: [] },
    { id: 'invalid', term: 'Spring_2027', credit_hours: Infinity, meetings: [] },
    { id: 'zero', term: 'Spring_2027', credit_hours: 0, meetings: [] },
  ];
  const preview = { id: 'preview', term: 'Fall_2026', course_code: 'PREVIEW', credit_hours: 6, meetings };
  const registry = new Map([...courses, preview].map(course => [course.id, course]));
  const state = {
    loading: false, selectedTerm: 'Fall_2026', terms: ['Spring_2026', 'Fall_2026', 'Spring_2027', 'Summer_2027'],
    sections: [], savedCoursesBySection: new Map(courses.map(course => [course.id, course])),
    removedSelectedSections: new Map(), hoveredSectionId: 'preview',
  };
  const calendar = createCourseCalendar({
    state, COURSE_DAYS: [{ key: 'Mon' }, { key: 'Wed' }],
    COURSE_START_HOUR: 6, COURSE_END_HOUR: 24, COURSE_START_MINUTES: 360, COURSE_END_MINUTES: 1440,
    COURSE_HOUR_HEIGHT: 64, COMPACT_COURSES_QUERY: { matches: true },
    getCourseColor: () => ({ key: 'course-color-01' }), getSection: id => registry.get(id), utils,
  });
  calendar.renderCalendar();
  assert.match(nodes['courses-week-title'].innerHTML, /Fall 2026.*>7 credits</);
  assert.match(nodes['courses-calendar-root'].innerHTML, /FALL-A|FALL-B/);
  assert.match(nodes['courses-calendar-root'].innerHTML, /PREVIEW/);
  assert.doesNotMatch(nodes['courses-calendar-root'].innerHTML, /SPRING-A/);
  assert.equal(nodes['courses-prev-term'].disabled, false);
  assert.equal(nodes['courses-next-term'].disabled, false);

  state.selectedTerm = 'Spring_2027';
  calendar.renderCalendar();
  assert.match(nodes['courses-week-title'].innerHTML, /Spring 2027.*>4.5 credits</);
  assert.match(nodes['courses-calendar-root'].innerHTML, /SPRING-A/);
  assert.doesNotMatch(nodes['courses-calendar-root'].innerHTML, /FALL-A|FALL-B|PREVIEW/);

  state.selectedTerm = 'Summer_2027';
  calendar.renderCalendar();
  assert.match(nodes['courses-week-title'].innerHTML, /Summer 2027.*>0 credits</);
  assert.doesNotMatch(nodes['courses-calendar-root'].innerHTML, /FALL-A|FALL-B|SPRING-A|PREVIEW/);
  assert.equal(nodes['courses-prev-term'].disabled, false);
  assert.equal(nodes['courses-next-term'].disabled, true);

  state.selectedTerm = 'Spring_2026';
  calendar.renderCalendar();
  assert.match(nodes['courses-week-title'].innerHTML, /Spring 2026.*>2 credits</);
  assert.match(nodes['courses-calendar-root'].innerHTML, /OLD-SPRING/);
  assert.doesNotMatch(nodes['courses-calendar-root'].innerHTML, /FALL-A|FALL-B|SPRING-A|PREVIEW/);
  assert.equal(nodes['courses-prev-term'].disabled, true);
});
