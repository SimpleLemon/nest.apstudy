const { loadFeatureModule } = require('./helpers/feature-modules.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');

const STATUS_LABELS = { open: 'Open', closed: 'Closed', waitlist: 'Waitlist' };

function loadFilters() {
  return loadFeatureModule('courses/filters.js', { window: {} });
}

function catalogVerifiedAvailability(section) {
  const raw = String((section && section.enrollment_status) || '').trim().toLowerCase();
  return { phase: 'verified', status: STATUS_LABELS[raw] || null, source: 'catalog' };
}

function createFilters(statusFilters, options = {}) {
  const overrides = new Map(Object.entries(options.availability || {}));
  const state = {
    activeCourseView: 'search',
    sections: [
      { id: 'open', term: 'Fall_2026', enrollment_status: 'Open' },
      { id: 'closed', term: 'Fall_2026', enrollment_status: 'Closed' },
      { id: 'waitlist', term: 'Fall_2026', enrollment_status: 'Waitlist' },
    ],
    selectedTerm: 'Fall_2026',
    searchQuery: '',
    campusFilter: 'all',
    requirementFilter: 'all',
    statusFilters: new Set(statusFilters),
    dayFilters: new Set(),
    timeEnabled: false,
    savedCoursesBySection: new Map(),
    tracksBySection: new Map(),
    removedSelectedSections: new Map(),
  };
  return loadFilters().createCourseFilters({
    state,
    COURSE_START_MINUTES: 360,
    COURSE_END_MINUTES: 1440,
    getSection: () => null,
    rememberSection: (section) => section,
    getEffectiveAvailability: (section) => (
      overrides.has(section.id) ? overrides.get(section.id) : catalogVerifiedAvailability(section)
    ),
    utils: {
      buildSectionSearchBlob: () => '',
      compareCourseSections: () => 0,
      parseAtlasTimeToken: () => null,
      parseTimeInput: () => null,
    },
  });
}

test('courses availability filter supports multiple selected enrollment statuses', () => {
  const { getFilteredSections } = createFilters(['open', 'waitlist']);
  assert.deepEqual(
    getFilteredSections().map((section) => section.id),
    ['open', 'waitlist'],
  );
});

test('courses availability filter treats an empty checklist as all statuses', () => {
  const { getFilteredSections } = createFilters([]);
  assert.equal(getFilteredSections().length, 3);
});

test('ignoreStatus returns non-status candidates despite active status checkbox', () => {
  const { getFilteredSections } = createFilters(['closed'], {
    availability: { open: { phase: 'pending', status: 'Checking' } },
  });
  assert.deepEqual(
    getFilteredSections({ ignoreStatus: true }).map((section) => section.id),
    ['open', 'closed', 'waitlist'],
  );
  assert.deepEqual(
    getFilteredSections().map((section) => section.id),
    ['closed'],
  );
});

test('verified Closed effective status overrides stale section Open and matches Closed only', () => {
  const { getFilteredSections } = createFilters(['closed'], {
    availability: {
      open: { phase: 'verified', status: 'Closed', source: 'live' },
      closed: { phase: 'unverified', status: 'Closed' },
    },
  });
  const ids = getFilteredSections().map((section) => section.id);
  assert.deepEqual(ids, ['open']);
  assert.equal(ids.includes('closed'), false);
});

test('pending/unavailable/unverified phases never match active statuses', () => {
  const { getFilteredSections } = createFilters(['open', 'closed', 'waitlist'], {
    availability: {
      open: { phase: 'pending', status: 'Checking' },
      closed: { phase: 'unavailable', status: 'Unavailable' },
      waitlist: { phase: 'unverified', status: 'Open' },
    },
  });
  assert.deepEqual(getFilteredSections(), []);
});

test('verification pending gate requires active status filters and a pending candidate', () => {
  const activeAndPending = createFilters(['open'], {
    availability: { open: { phase: 'pending', status: 'Checking' } },
  });
  assert.equal(activeAndPending.isAvailabilityVerificationPending(), true);

  const nonStatusCandidatePending = createFilters(['open'], {
    availability: { closed: { phase: 'pending', status: 'Checking' } },
  });
  assert.equal(nonStatusCandidatePending.isAvailabilityVerificationPending(), true);

  const explicitCandidates = createFilters(['open'], {
    availability: { closed: { phase: 'pending', status: 'Checking' } },
  });
  assert.equal(
    explicitCandidates.isAvailabilityVerificationPending([{ id: 'waitlist' }]),
    false,
  );
  assert.equal(
    explicitCandidates.isAvailabilityVerificationPending([{ id: 'closed' }]),
    true,
  );

  const activeWithoutPending = createFilters(['open']);
  assert.equal(activeWithoutPending.isAvailabilityVerificationPending(), false);

  const inactiveWithPending = createFilters([], {
    availability: { open: { phase: 'pending', status: 'Checking' } },
  });
  assert.equal(inactiveWithPending.isAvailabilityVerificationPending(), false);
});

test('empty status filters preserve all candidates regardless of availability phase', () => {
  const { getFilteredSections } = createFilters([], {
    availability: {
      open: { phase: 'pending', status: 'Checking' },
      closed: { phase: 'unavailable', status: 'Unavailable' },
      waitlist: { phase: 'unverified', status: 'Open' },
    },
  });
  assert.deepEqual(
    getFilteredSections().map((section) => section.id),
    ['open', 'closed', 'waitlist'],
  );
});

test('default fallback derives catalog status but marks it unverified', () => {
  const source = loadFilters();
  const state = {
    activeCourseView: 'search',
    sections: [
      { id: 'open', term: 'Fall_2026', enrollment_status: 'Open' },
      { id: 'closed', term: 'Fall_2026', enrollment_status: 'Closed' },
    ],
    selectedTerm: 'Fall_2026',
    searchQuery: '',
    campusFilter: 'all',
    requirementFilter: 'all',
    statusFilters: new Set(['open']),
    dayFilters: new Set(),
    timeEnabled: false,
    savedCoursesBySection: new Map(),
    tracksBySection: new Map(),
    removedSelectedSections: new Map(),
  };
  const { getFilteredSections } = source.createCourseFilters({
    state,
    COURSE_START_MINUTES: 360,
    COURSE_END_MINUTES: 1440,
    getSection: () => null,
    rememberSection: (section) => section,
    utils: {
      buildSectionSearchBlob: () => '',
      compareCourseSections: () => 0,
      parseAtlasTimeToken: () => null,
      parseTimeInput: () => null,
    },
  });
  assert.deepEqual(getFilteredSections(), []);
});

test('tracked view includes enabled trackers and drops courses turned off', () => {
  const tracksBySection = new Map([
    ['enabled', { id: 'enabled', term: 'Fall_2026', enabled: true }],
    ['off', { id: 'off', term: 'Fall_2026', enabled: false }],
  ]);
  const state = {
    activeCourseView: 'tracked', tracksBySection, selectedTerm: 'Fall_2026',
    searchQuery: '', campusFilter: 'all', requirementFilter: 'all',
    statusFilters: new Set(), dayFilters: new Set(), timeEnabled: false,
  };
  const { getFilteredSections } = loadFilters().createCourseFilters({
    state, getSection: () => null, rememberSection: (track) => track,
    utils: { buildSectionSearchBlob: () => '', compareCourseSections: () => 0 },
  });
  assert.deepEqual(Array.from(getFilteredSections(), (section) => section.id), ['enabled']);
  tracksBySection.get('enabled').enabled = false;
  assert.equal(getFilteredSections().length, 0);
});
