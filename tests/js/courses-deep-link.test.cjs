const { loadFeatureModule } = require('./helpers/feature-modules.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');

function loadCoursesUtils() {
  return loadFeatureModule('courses/utils.js', { URLSearchParams });
}

test('parseCoursesSectionDeepLink reads hash section param', () => {
  const { parseCoursesSectionDeepLink } = loadCoursesUtils();
  const sectionId = 'Spring_2026|JPN|101|1234|1';
  const encoded = encodeURIComponent(sectionId);
  const parsed = parseCoursesSectionDeepLink({
    hash: `#section=${encoded}`,
    search: '',
  });
  assert.equal(parsed, sectionId);
});

test('parseCoursesSectionDeepLink falls back to query section param', () => {
  const { parseCoursesSectionDeepLink } = loadCoursesUtils();
  const sectionId = 'Spring_2026|JPN|101|1234|1';
  const encoded = encodeURIComponent(sectionId);
  const parsed = parseCoursesSectionDeepLink({
    hash: '',
    search: `?section=${encoded}`,
  });
  assert.equal(parsed, sectionId);
});

test('parseCoursesSectionDeepLink returns null when missing', () => {
  const { parseCoursesSectionDeepLink } = loadCoursesUtils();
  assert.equal(parseCoursesSectionDeepLink({ hash: '', search: '' }), null);
});
