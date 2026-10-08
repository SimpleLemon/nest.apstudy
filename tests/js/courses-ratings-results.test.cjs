const assert = require('node:assert/strict');
const test = require('node:test');
const { parseFragment } = require('parse5');
const { loadFeatureModule } = require('./helpers/feature-modules.cjs');

const { renderProfessorRatings, renderCourseCardSchedule, safeRatingUrl } = loadFeatureModule('courses/ratings.js', { URL });
const { renderCourseInstructors } = loadFeatureModule('courses/instructors.js', { URL });
const { visibleCourseResults, showMoreCourseResults } = loadFeatureModule('courses/results.js');
const { catalogStatusText } = loadFeatureModule('courses/catalog-status.js');

const rating = {
  name: 'Ada Example', status: 'matched', overall_rating: 4.8, difficulty: 2.3,
  rating_count: 12, fetched_at: '2026-10-01T10:00:00Z',
  profile_url: 'https://www.ratemyprofessors.com/professor/123',
  search_url: 'https://www.ratemyprofessors.com/search/professors/340?q=Ada',
};

test('detail instructor links hide emails and keep each rating with its teacher when ratings arrive out of order', () => {
  const html = renderCourseInstructors({
    instructors: [{ name: 'Ada Example', email: 'ada@example.edu' }, { name: 'Grace Example', email: 'grace@example.edu' }],
    professor_ratings: [{ ...rating, name: 'Grace Example', overall_rating: 2.4 }, rating],
  });
  const rows = elements(parseFragment(html), node => hasClass(node, 'course-instructor'));
  assert.equal(rows.length, 2);
  for (const [index, name, email, score] of [[0, 'Ada Example', 'ada@example.edu', '4.8'], [1, 'Grace Example', 'grace@example.edu', '2.4']]) {
    const link = elements(rows[index], node => hasClass(node, 'course-instructor-email'))[0];
    assert.equal(textContent(link), name);
    assert.equal(attribute(link, 'href'), `mailto:${email}`);
    assert.equal(attribute(link, 'target'), '_blank');
    assert.equal(attribute(link, 'rel'), 'noopener noreferrer');
    assert.equal(textContent(elements(rows[index], node => hasClass(node, 'course-rating-badge'))[0]), score);
  }
  assert.doesNotMatch(textContent(parseFragment(html)), /example.edu|Professor ratings|Difficulty|12 ratings/);
});

test('detail instructors without email or ratings remain readable and placeholders have no badge', () => {
  const html = renderCourseInstructors({ instructors: ['Ada Example', { name: 'Staff' }], professor_ratings: [
    { ...rating, name: 'Another Teacher' },
  ] });
  const rows = elements(parseFragment(html), node => hasClass(node, 'course-instructor'));
  assert.equal(textContent(rows[0]), 'Ada Example–');
  assert.equal(textContent(rows[1]), 'Staff');
  assert.doesNotMatch(html, /<a /);
  assert.match(renderCourseInstructors({}), /TBA/);
});

test('detail instructor names are escaped and email links cannot add mail headers', () => {
  const html = renderCourseInstructors({ instructors: [{ name: '<img src=x>', email: 'ada@example.edu?bcc=other@example.edu' }] });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<a /);
  const encoded = renderCourseInstructors({ instructors: [{ name: 'Ada', email: 'ada+courses@example.edu' }] });
  assert.match(encoded, /href="mailto:ada%2Bcourses@example.edu"/);
});

function attribute(node, name) {
  return node.attrs?.find(item => item.name === name)?.value;
}

function hasClass(node, name) {
  return (attribute(node, 'class') || '').split(/\s+/).includes(name);
}

function elements(root, predicate) {
  return (root.childNodes || []).flatMap(node => [
    ...(node.tagName && predicate(node) ? [node] : []), ...elements(node, predicate),
  ]);
}

function textContent(node) {
  return node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textContent).join('');
}

function parsedRatings(section, options = { compact: true }) {
  const html = renderProfessorRatings(section, options);
  const tree = parseFragment(html);
  return { html, tree, rows: elements(tree, node => hasClass(node, 'course-rating')) };
}

function ratingParts(row) {
  const heading = elements(row, node => hasClass(node, 'course-rating-heading'))[0] || row;
  const children = heading.childNodes.filter(node => node.tagName);
  assert.equal(children.length, 2, 'each instructor heading contains only its name and badge');
  assert.equal(children[0].tagName, 'strong');
  assert.ok(hasClass(children[1], 'course-rating-badge'), 'badge immediately follows the name');
  assert.equal(elements(row, node => hasClass(node, 'course-rating-badge')).length, 1);
  return { name: textContent(children[0]), badge: children[1] };
}

test('each professor keeps their own rating and details, with safe attributed links', () => {
  const { html, rows } = parsedRatings({ professor_ratings: [rating, {
    ...rating, name: 'Grace Example', overall_rating: 2.4, stale: true,
    profile_url: 'https://www.ratemyprofessors.com/professor/456',
  }] }, { compact: false });
  assert.equal(rows.length, 2);
  const first = ratingParts(rows[0]);
  const second = ratingParts(rows[1]);
  assert.equal(first.name, 'Ada Example');
  assert.equal(textContent(first.badge), '4.8');
  assert.equal(attribute(first.badge, 'href'), rating.profile_url);
  assert.equal(second.name, 'Grace Example');
  assert.equal(textContent(second.badge), '2.4');
  assert.equal(attribute(second.badge, 'href'), 'https://www.ratemyprofessors.com/professor/456');
  assert.match(html, /12 ratings · Difficulty 2.3\/5 · Updated/);
  assert.match(html, /Older saved rating/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Source: Rate My Professors/);
  assert.doesNotMatch(html, /3.6\/5/);
});

test('card schedule shows each professor once with their own rating beside the name', () => {
  const section = { schedule_display: 'TTh 4–5:15 PM', instructor: 'Allen Tullos', professor_ratings: [{
    ...rating, name: 'Allen Tullos', overall_rating: 4.2, rating_count: 18,
  }] };
  const html = renderCourseCardSchedule(section);
  const tree = parseFragment(html);
  const rows = elements(tree, node => hasClass(node, 'course-rating'));
  assert.match(html, /TTh 4–5:15 PM/);
  assert.equal((html.match(/<strong>Allen Tullos<\/strong>/g) || []).length, 1);
  assert.equal(rows.length, 1);
  const { name, badge } = ratingParts(rows[0]);
  assert.equal(name, 'Allen Tullos');
  assert.equal(textContent(badge), '4.2');
  assert.ok(hasClass(badge, 'is-green'));
  assert.doesNotMatch(textContent(tree), /\/5|18 ratings|RMP|Rate My Professors/);
  for (const label of [attribute(badge, 'aria-label'), attribute(badge, 'title')]) {
    assert.match(label, /Allen Tullos/);
    assert.match(label, /4\.2 (?:out of|of) 5|4\.2\/5/);
    assert.match(label, /18 ratings/);
    assert.match(label, /Updated/);
    assert.match(label, /Rate My Professors/);
    assert.match(label, /new tab/);
  }
  assert.equal(badge.tagName, 'a');
  assert.equal(attribute(badge, 'href'), rating.profile_url);
  assert.equal(attribute(badge, 'target'), '_blank');
  assert.equal(attribute(badge, 'rel'), 'noopener noreferrer');

  const multiple = parsedRatings({ professor_ratings: [rating, {
    ...rating, name: 'Grace Example', overall_rating: 2.4,
    profile_url: 'https://www.ratemyprofessors.com/professor/456',
  }] });
  assert.equal(multiple.rows.length, 2);
  const first = ratingParts(multiple.rows[0]);
  const second = ratingParts(multiple.rows[1]);
  assert.equal(first.name, 'Ada Example');
  assert.equal(textContent(first.badge), '4.8');
  assert.equal(attribute(first.badge, 'href'), rating.profile_url);
  assert.equal(second.name, 'Grace Example');
  assert.equal(textContent(second.badge), '2.4');
  assert.equal(attribute(second.badge, 'href'), 'https://www.ratemyprofessors.com/professor/456');
  assert.match(renderCourseCardSchedule({ ...section, instructor: 'My nickname', overrides: { instructor: 'My nickname' } }), /<strong>My nickname<\/strong>/);
});

test('quality badge colors use the RMP thresholds without averaging instructors', () => {
  for (const [score, color, label] of [
    [1, 'is-red', '1.0'], [2.9, 'is-red', '2.9'], [3, 'is-yellow', '3.0'],
    [3.9, 'is-yellow', '3.9'], [3.99, 'is-yellow', '4.0'],
    [4, 'is-green', '4.0'], [5, 'is-green', '5.0'], ['4.2', 'is-green', '4.2'],
  ]) {
    const { rows } = parsedRatings({ professor_ratings: [{ ...rating, overall_rating: score }] });
    const { badge } = ratingParts(rows[0]);
    assert.equal(textContent(badge), label);
    assert.ok(hasClass(badge, color), `${score} uses ${color}`);
    assert.equal(badge.tagName, 'a');
  }
});

test('missing, malformed, out-of-range and explicitly unrated scores use a gray en dash', () => {
  for (const unknown of [null, undefined, '', ' ', false, {}, NaN, Infinity, -1, 0, 0.9, 5.1, 'invalid']) {
    const { rows } = parsedRatings({ professor_ratings: [{ ...rating, overall_rating: unknown }] });
    const { badge } = ratingParts(rows[0]);
    assert.equal(textContent(badge), '–');
    assert.ok(hasClass(badge, 'is-unrated'));
  }
  for (const count of [0, '0']) {
    const { rows } = parsedRatings({ professor_ratings: [{ ...rating, rating_count: count }] });
    const { badge } = ratingParts(rows[0]);
    assert.equal(textContent(badge), '–');
    assert.ok(hasClass(badge, 'is-unrated'));
  }
  for (const unknown of [null, undefined, '', ' ', false, {}, NaN]) {
    const html = renderProfessorRatings({ professor_ratings: [{ ...rating, overall_rating: unknown, difficulty: unknown, rating_count: unknown }] });
    assert.doesNotMatch(html, /0\.0\/5|0 ratings/);
    assert.match(html, /Difficulty unavailable/);
  }
});

test('unmatched, ambiguous, unavailable, and unrated professors use explicit states', () => {
  const states = { unmatched: 'No matching profile', ambiguous: 'Profile match uncertain', unavailable: 'Ratings unavailable', unrated: 'No ratings yet' };
  for (const [status, text] of Object.entries(states)) {
    const { html, rows, tree } = parsedRatings({ professor_ratings: [{ ...rating, status, profile_url: status === 'unrated' ? rating.profile_url : null, overall_rating: null, rating_count: null, difficulty: null }] });
    const { badge } = ratingParts(rows[0]);
    assert.equal(textContent(badge), '–');
    assert.ok(hasClass(badge, 'is-unrated'));
    assert.match(attribute(badge, 'aria-label'), new RegExp(text));
    assert.ok(html.includes(text));
    assert.equal(attribute(badge, 'href'), status === 'unrated' ? rating.profile_url : rating.search_url);
    assert.equal(attribute(badge, 'target'), '_blank');
    assert.equal(attribute(badge, 'rel'), 'noopener noreferrer');
    assert.doesNotMatch(textContent(tree), /No matching profile|Profile match uncertain|Ratings unavailable|No ratings yet|RMP/);
  }
});

test('a numeric badge requires a safe professor profile, while safe searches remain gray', () => {
  for (const profile of [null, '', 'javascript:alert(1)', 'https://ratemyprofessors.com.evil.test/professor/123',
    rating.search_url, 'https://www.ratemyprofessors.com/professor/0', 'https://www.ratemyprofessors.com/professor/abc']) {
    const { rows } = parsedRatings({ professor_ratings: [{ ...rating, profile_url: profile }] });
    const { badge } = ratingParts(rows[0]);
    assert.equal(textContent(badge), '–');
    assert.ok(hasClass(badge, 'is-unrated'));
    assert.equal(attribute(badge, 'href'), rating.search_url);
    assert.match(attribute(badge, 'aria-label'), /Search/);
  }
});

test('named instructors without rating records keep their name and a gray unlinked badge', () => {
  for (const professor_ratings of [undefined, []]) {
    const section = { schedule_display: 'TTh 4–5:15 PM', instructor: 'Allen Tullos', professor_ratings };
    const tree = parseFragment(renderCourseCardSchedule(section));
    const rows = elements(tree, node => hasClass(node, 'course-rating'));
    assert.equal(rows.length, 1);
    const { name, badge } = ratingParts(rows[0]);
    assert.equal(name, 'Allen Tullos');
    assert.equal(textContent(badge), '–');
    assert.equal(badge.tagName, 'span');
    assert.ok(hasClass(badge, 'is-unrated'));
    assert.equal(attribute(badge, 'href'), undefined);
    assert.equal(elements(tree, node => node.tagName === 'a').length, 0);
    assert.match(textContent(tree), /TTh 4–5:15 PM/);
  }
  const { rows } = parsedRatings({ instructor: 'Ada Example', instructors: [
    { name: 'Ada Example', atlas_id: 'a' }, { name: 'Grace Example', atlas_id: 'b' },
  ] });
  assert.deepEqual(rows.map(row => ratingParts(row).name), ['Ada Example', 'Grace Example']);
  for (const row of rows) {
    const { badge } = ratingParts(row);
    assert.equal(textContent(badge), '–');
    assert.equal(badge.tagName, 'span');
  }
});

test('staff and TBA placeholders retain plain schedule text without a rating badge', () => {
  for (const instructor of ['Staff', 'TBA']) {
    const html = renderCourseCardSchedule({ schedule_display: 'TTh 4–5:15 PM', instructor });
    assert.equal(html, `TTh 4–5:15 PM | ${instructor}`);
  }
  assert.equal(renderCourseCardSchedule({}), 'TBA');
});

test('ratings escape names and reject unsafe profile and search destinations', () => {
  const html = renderProfessorRatings({ professor_ratings: [{ ...rating, name: '<img src=x onerror=alert(1)>', profile_url: 'javascript:alert(1)', search_url: 'https://ratemyprofessors.com.evil.test/' }] });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<a /);
  for (const url of ['http://www.ratemyprofessors.com/', 'https://evil.test/', 'https://user:pass@www.ratemyprofessors.com/']) assert.equal(safeRatingUrl(url), '');
});

test('custom instructor labels explain that ratings retain the Atlas identity', () => {
  for (const field of ['instructor', 'instructor_name']) {
    const html = renderProfessorRatings({ overrides: { [field]: 'My nickname' }, professor_ratings: [rating] }, { compact: true });
    assert.match(html, /Ratings refer to Atlas instructors; your instructor label is customized/);
    assert.match(html, /Ada Example/);
    assert.doesNotMatch(textContent(parseFragment(html)), /12 ratings|RMP|\/5/);
    assert.doesNotMatch(html, /Difficulty/);
  }
});

test('a failed refresh still displays the verified saved rating and profile', () => {
  const { html, rows } = parsedRatings({ professor_ratings: [{ ...rating, status: 'unavailable', stale: true }] }, { compact: false });
  const { badge } = ratingParts(rows[0]);
  assert.equal(textContent(badge), '4.8');
  assert.ok(hasClass(badge, 'is-green'));
  assert.match(attribute(badge, 'aria-label'), /Older saved rating/);
  assert.match(html, /12 ratings · Difficulty 2.3\/5 · Updated/);
  assert.match(html, /href="https:\/\/www.ratemyprofessors.com\/professor\/123"/);
  assert.doesNotMatch(html, /Ratings unavailable|Search Rate My Professors/);
});

function state() {
  return { selectedTerm: 'Fall_2026', activeCourseView: 'search', searchQuery: '', dayFilters: new Set(), statusFilters: new Set(), campusFilter: 'all', requirementFilter: 'all', timeEnabled: false, timeStart: '06:00', timeEnd: '23:59' };
}

test('all 625 matching sections remain reachable in 100-result batches', () => {
  const query = state();
  const sections = Array.from({ length: 625 }, (_, index) => ({ id: index }));
  assert.equal(visibleCourseResults(query, sections).length, 100);
  for (let count = 200; count <= 600; count += 100) {
    showMoreCourseResults(query);
    assert.equal(visibleCourseResults(query, sections).length, count);
  }
  showMoreCourseResults(query);
  assert.equal(visibleCourseResults(query, sections).at(-1).id, 624);
  query.detailSectionId = 624;
  query.detailSectionId = null;
  assert.equal(visibleCourseResults(query, sections).length, 625);
});

test('every query filter, term and view change resets the visible count', () => {
  const sections = Array.from({ length: 625 }, (_, id) => ({ id }));
  for (const change of [
    { selectedTerm: 'Spring_2027' }, { activeCourseView: 'selected' }, { searchQuery: 'biology' },
    { dayFilters: new Set(['Mon']) }, { statusFilters: new Set(['open']) },
    { campusFilter: 'oxford' }, { requirementFilter: 'WR' }, { timeEnabled: true },
    { timeStart: '10:00' }, { timeEnd: '13:00' },
  ]) {
    const query = state();
    visibleCourseResults(query, sections);
    showMoreCourseResults(query);
    assert.equal(visibleCourseResults(query, sections).length, 200);
    Object.assign(query, change);
    assert.equal(visibleCourseResults(query, sections).length, 100);
  }
});

test('catalog freshness distinguishes legacy and unverified coverage without completeness claims', () => {
  for (const status of ['legacy', 'unverified', 'legacy/unverified']) assert.match(catalogStatusText({ status }), /Coverage unverified/);
  assert.match(catalogStatusText({ status: 'unavailable' }), /unavailable/);
  assert.match(catalogStatusText({ status: 'complete', last_successful_refresh: '2026-10-01T10:00:00Z' }), /Updated/);
  assert.match(catalogStatusText({ status: 'complete', tentative: true }), /Tentative schedule/);
  assert.match(catalogStatusText(null), /Refresh date unavailable/);
});
