const assert = require('node:assert/strict');
const test = require('node:test');
const { loadFeatureModule } = require('./helpers/feature-modules.cjs');

const settle = () => new Promise(resolve => setImmediate(resolve));
const textContent = element => element.textContent + element.children.map(textContent).join('');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function mount() {
  const { createParsedDOM } = await import('./helpers/parsed-dom.mjs');
  const { window, document } = createParsedDOM('http://localhost/courses');
  const container = document.createElement('div');
  container.innerHTML = `<main>
    <aside class="courses-panel"><section class="courses-panel-header"><p id="courses-result-summary"></p></section>
      <section class="courses-search-stack"><input id="courses-search-input"><select id="courses-term-select"></select></section>
      <div id="courses-panel-content"></div></aside>
    <h2 id="courses-week-title"></h2><p id="courses-term-dates"></p>
    <button id="courses-prev-term"></button><button id="courses-next-term"></button>
    <div id="courses-calendar-root"></div></main>`;
  document.body.appendChild(container);
  const elementPrototype = Object.getPrototypeOf(container);
  const baseMatches = elementPrototype.matches;
  elementPrototype.matches = function (selector) {
    const compound = selector.match(/^(\.[\w-]+)(\[.+\])$/);
    return compound ? baseMatches.call(this, compound[1]) && baseMatches.call(this, compound[2])
      : baseMatches.call(this, selector);
  };
  elementPrototype.getBoundingClientRect = () => ({ top: 0, bottom: 200, width: 420, height: 200 });
  window.HTMLElement = elementPrototype.constructor;
  window.innerHeight = 800;
  window.scrollX = 0;
  window.scrollY = 0;
  Object.defineProperty(document, 'readyState', { value: 'complete' });
  window.matchMedia = () => ({ matches: false });
  window.requestAnimationFrame = callback => callback();
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  function runTimer(delay) {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `a ${delay}ms task is scheduled`);
    timers.delete(entry[0]);
    return entry[1].callback();
  }
  const section = {
    id: 'fall-section', section_id: 'fall-section', term: 'Fall_2026', course_code: 'DEMO 100',
    course_title: 'Demo course', campus: 'Atlanta', enrollment_status: 'Open', credit_hours: 3,
    meetings: [{ day: 'Mon', start: '0900', end: '1000' }],
    date_range: { start: '2026-08-26', end: '2026-12-09' },
  };
  const sectionsRequest = deferred();
  let delaySections = false;
  window.APStudyHttp = { fetchJson: async url => {
    if (url === '/api/atlas/terms') return { terms: ['Fall_2026', 'Spring_2027'], default_term: 'Fall_2026' };
    if (url === '/api/courses/saved') return { courses: [{ ...section, id: 'saved-course', color_key: 'course-color-01' }] };
    if (url === '/api/courses/tracks') return { tracks: [] };
    if (url.startsWith('/api/atlas/sections?')) {
      if (delaySections) return sectionsRequest.promise;
      return { sections: [section] };
    }
    throw new Error(`Unexpected request: ${url}`);
  } };
  window.fetch = async (_url, options) => {
    const input = JSON.parse(options.body);
    return { ok: true, json: async () => ({
      verified_by_id: Object.fromEntries(input.section_ids.map(id => [id, { enrollment_status: 'Open' }])),
      details_by_id: Object.fromEntries((input.detail_ids || []).map(id => [id, { enrollment_status: 'Open', seats_available: 8 }])),
    }) };
  };
  loadFeatureModule('courses/index.js', {
    window, document, URL, URLSearchParams, HTMLElement: window.HTMLElement, console,
  });
  await settle();
  await runTimer(140);
  await settle();
  const calendar = document.getElementById('courses-calendar-root');
  const scroller = document.getElementById('courses-week-scroller');
  scroller.scrollTop = 220;
  return { window, document, calendar, scroller, section, runTimer, sectionsRequest,
    delay: () => { delaySections = true; } };
}

test('search loading, completion and live seat hydration preserve the calendar nodes and scroll', async () => {
  const view = await mount();
  try {
    const frame = view.calendar.children[0];
    const dates = view.document.getElementById('courses-term-dates').textContent;
    const next = view.document.getElementById('courses-next-term');
    view.delay();
    const search = view.document.getElementById('courses-search-input');
    search.value = 'DEMO';
    search.dispatchEvent(new view.window.Event('input', { bubbles: true }));
    view.runTimer(500);
    await settle();
    assert.ok(view.document.querySelector('.courses-results-skeleton'));
    assert.equal(view.document.querySelector('.courses-schedule-skeleton'), null);
    assert.equal(view.calendar.children[0], frame);
    assert.equal(view.document.getElementById('courses-term-dates').textContent, dates);
    assert.equal(next.disabled, false);
    view.sectionsRequest.resolve({ sections: [view.section] });
    await settle();
    await view.runTimer(140);
    await settle();
    assert.equal(view.calendar.children[0], frame);
    assert.equal(view.document.getElementById('courses-week-scroller'), view.scroller);
    assert.equal(view.scroller.scrollTop, 220);
    assert.match(textContent(view.document.getElementById('courses-panel-content')), /8 seats/);
  } finally { view.window.close(); }
});

test('changing terms updates the schedule immediately and fills in its dates after the catalog request', async () => {
  const view = await mount();
  try {
    view.delay();
    const term = view.document.getElementById('courses-term-select');
    term.value = 'Spring_2027';
    term.dispatchEvent(new view.window.Event('change', { bubbles: true }));
    assert.match(textContent(view.document.getElementById('courses-week-title')), /Spring 2027/);
    assert.equal(view.calendar.querySelector('.courses-event'), null);
    assert.equal(view.calendar.querySelector('.courses-schedule-skeleton'), null);
    view.sectionsRequest.resolve({ sections: [{ ...view.section, id: 'spring-section', section_id: 'spring-section', term: 'Spring_2027',
      date_range: { start: '2027-01-11', end: '2027-04-26' } }] });
    await settle();
    assert.match(view.document.getElementById('courses-term-dates').textContent, /Jan 11, 2027/);
    assert.equal(view.document.getElementById('courses-prev-term').disabled, false);
  } finally { view.window.close(); }
});
