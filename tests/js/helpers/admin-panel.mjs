import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Element, response, settle } from './admin-tracking-terms.mjs';

export { response, settle };

export const sectionHtml = (version = 'initial') => `<section data-section-version="${version}">
  <select id="admin-tracking-refresh"><option selected>5</option><option>10</option></select>
  <section data-tracking-terms>
    <select data-term-year><option selected>2026</option></select>
    <p data-term-timezone></p><p data-terms-notice></p><button data-terms-reload></button>
    <form data-add-year><input type="number"></form><div data-term-rows></div>
  </section>
  <div id="admin-tracking-list">
    <div data-track-group data-term="Fall_2026" data-subject="CS" data-catalog="170" data-crn="12345">
      <button data-group-toggle="true">Resume group</button>
      <div data-track-id="track/17"><button data-track-toggle="false">Pause row</button></div>
    </div>
  </div>
</section>`;

const eventClass = class {
  constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
};

// Execute the real classic entries, shared HTTP owner and HTML replacement
// paths. This DOM implements selectors and bubbling, without exposing closures.
export async function adminPanelRuntime({ initialTab = 'course-tracking', scripts = ['admin-course-tracking-terms.js', 'admin-requests.js', 'admin-auth.js'], html } = {}) {
  const document = new Element('document', null);
  document.document = document;
  document.innerHTML = html || `<body data-initial-auth-tab="${initialTab}">
    <input id="admin-csrf-token" value="fixture-csrf">
    <main id="admin-auth-shell"><div id="admin-auth-tabs">
      <button data-auth-tab="users">Users</button><button data-auth-tab="course-tracking">Tracking</button>
    </div><div id="admin-auth-panel"></div><div id="admin-auth-overlay"><div id="admin-auth-overlay-content"></div></div></main>
  </body>`;
  document.body = document.querySelector('body');
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.createElement = (tag) => new Element(tag, document);
  const requests = [];
  const notices = [];
  const errors = [];
  const timers = new Map();
  let timerId = 0;
  const window = {
    document,
    location: { origin: 'https://example.test', href: `https://example.test/admin/auth?tab=${initialTab}` },
    history: { replaceState(_state, _title, url) { window.location.href = String(url); } },
    setInterval(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearInterval(id) { timers.delete(id); },
    APStudyToast: { show: (notice) => notices.push(notice) },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  };
  const context = vm.createContext({
    document, window, URL, Date, Intl,
    console: { error: (...args) => errors.push(args) },
    fetch: window.fetch, CustomEvent: eventClass,
    Option: class extends Element {
      constructor(text, value) { super('option', document, { value }); this.textContent = text; }
    },
    DOMParser: class {
      parseFromString(source) { const parsed = new Element('document', document); parsed.innerHTML = source; return parsed; }
    },
  });
  const load = async (filename) => vm.runInContext(await readFile(new URL(`../../../static/js/${filename}`, import.meta.url), 'utf8'), context, { filename: `static/js/${filename}` });
  await load('core/http.js');
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
  for (const filename of scripts) await load(filename);
  const panel = document.getElementById('admin-auth-panel');
  return {
    document, window, panel, requests, notices, errors, timers,
    emit(target, type, detail) {
      const event = { type, detail, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      target.dispatchEvent(event);
      return event;
    },
    async loadTracking(version = 'initial') {
      requests.at(-1).resolve({ ok: true, text: async () => sectionHtml(version) });
      await settle();
    },
  };
}
