const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFeatureModule } = require('./helpers/feature-modules.cjs');

const utils = loadFeatureModule('courses/utils.js');

test('Courses exposes one minute-count contract for Atlas times and midnight', () => {
  const atlas = loadFeatureModule('courses/atlas-time.js');
  for (const [token, expected] of [
    ['0930', 570], ['930', 570], ['1435', 875], ['0000', 0], [0, 0],
    ['2359', 1439], ['2400', 1440], ['24:00', 1440], ['2401', null],
    ['2430', null], ['2360', null], ['2500', null], ['TBA', null], ['', null], [null, null],
  ]) {
    assert.equal(atlas.parseAtlasTimeToken(token), expected, String(token));
    assert.equal(utils.parseAtlasTimeToken(token), expected, String(token));
  }
  assert.equal(utils.formatAtlasTime('2400'), '12:00 AM');
  assert.equal(utils.formatAtlasTime('0000'), '12:00 AM');
  assert.equal(utils.formatAtlasTime('1200'), '12:00 PM');
  assert.equal(utils.formatAtlasTime('2430'), 'TBA');
});

const meetings = [
  { day: 'Mon', start: '2330', end: '2400' },
  { day: 'Mon', start: '0000', end: '0100' },
  { day: 'Mon', start: '2330', end: '2430' },
  { day: 'Mon', start: '2400', end: '2400' },
  { day: 'Mon', start: '1100', end: '1000' },
];
const section = {
  id: 'late-course', section_id: 'late-course', term: 'Fall_2026',
  course_code: 'CS 253', course_title: 'Data Structures', meetings,
  date_range: { start: '2026-10-05', end: '2026-10-05' },
};

test('Courses public render accepts end-of-day and midnight, and omits invalid intervals', () => {
  const root = { innerHTML: '' };
  const { createCourseCalendar } = loadFeatureModule('courses/calendar.js', {
    window: {}, document: { getElementById: id => id === 'courses-calendar-root' ? root : null },
  });
  const calendar = createCourseCalendar({
    state: {
      selectedTerm: 'Fall_2026', terms: ['Fall_2026'], sections: [section],
      savedCoursesBySection: new Map([[section.id, section]]), removedSelectedSections: new Set(),
    },
    COURSE_DAYS: [{ key: 'Mon' }], COURSE_START_MINUTES: 0, COURSE_END_MINUTES: 1440,
    COMPACT_COURSES_QUERY: { matches: true }, getSection: () => section,
    getCourseColor: () => ({ key: 'course-color-01' }), utils,
  });
  calendar.renderCalendar();
  assert.equal((root.innerHTML.match(/<article /g) || []).length, 2);
  assert.match(root.innerHTML, /11:30 PM-12:00 AM/);
  assert.match(root.innerHTML, /12:00 AM-1:00 AM/);
});

test('Calendar public simulated events derive local Dates from the shared minute count', () => {
  const { createCalendarCourses } = loadFeatureModule('calendar/integrations/courses.js');
  const calendar = createCalendarCourses({
    root: {}, runtimeWindow: {},
    state: {
      courses: { selectedSectionIds: new Set([section.id]), sectionsById: { [section.id]: section } },
    },
    constants: { simulatedCalendarName: 'Simulated Courses' }, escapeHtml: utils.escapeHtml,
  });
  const events = calendar.buildSimulatedMeetingEvents(new Date(2026, 9, 5), new Date(2026, 9, 5));
  assert.equal(events.length, 2);
  assert.equal(events[0].startDate.getHours(), 0);
  assert.equal(events[0].endDate.getHours(), 1);
  assert.equal(events[1].startDate.getHours(), 23);
  assert.equal(events[1].startDate.getMinutes(), 30);
  assert.equal(events[1].endDate.getHours(), 0);
  assert.equal(events[1].endDate.getDate(), 6);
  assert.equal(events[1].endDate.getMonth(), 9);
  assert.equal(events[1].endDate.getFullYear(), 2026);
});
