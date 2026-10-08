import assert from 'node:assert/strict';
import test from 'node:test';
import featureModules from './helpers/feature-modules.cjs';

const { loadFeatureModule } = featureModules;
const settle = async () => { for (let i = 0; i < 12; i += 1) await new Promise(resolve => setImmediate(resolve)); };

class Element {
    constructor() {
        this.listeners = new Map();
        this.dataset = {};
        this.attributes = new Map();
        this.children = [];
        this.style = {};
        this.textContent = '';
        this._html = '';
        this.value = '';
        this.hidden = false;
        const classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
            toggle: (name, force) => {
                const active = force ?? !classes.has(name);
                if (active) classes.add(name); else classes.delete(name);
                return active;
            },
        };
    }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html; }
    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) || [];
        callbacks.push(callback);
        this.listeners.set(name, callbacks);
    }
    async emit(name, event = {}) {
        for (const callback of this.listeners.get(name) || []) {
            await callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
        }
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.children.push(child); return child; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    focus() {}
}

function browser(ids, respond, { readyState = 'loading', search = '' } = {}) {
    const elements = Object.fromEntries(ids.map(id => [id, new Element()]));
    const document = new Element();
    Object.assign(document, {
        readyState,
        body: new Element(),
        getElementById: id => elements[id] || null,
        createElement: () => new Element(),
    });
    const calls = [];
    const toasts = [];
    const window = new Element();
    Object.assign(window, {
        document,
        location: { href: `http://localhost/notes${search}`, search, hash: '' },
        navigator: { userAgent: 'iPhone' },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        setTimeout: () => 1,
        clearTimeout() {},
        APStudyHttp: { fetchJson: async (url, options = {}) => {
            calls.push({ url, options });
            return respond(url, options);
        } },
        APStudyLoader: { html: label => `<span>${label}</span>` },
        APStudyToast: { show: toast => toasts.push(toast) },
    });
    const context = { window, document, URL, URLSearchParams, AbortController, console };
    return { context, elements, window, calls, toasts, document };
}

function assertNoFeatureRegistries(window) {
    assert.deepEqual(Object.keys(window).filter(key => /^APStudy(Courses|Dashboard|NotesList)/.test(key)), []);
}

for (const readyState of ['loading', 'complete']) {
    test(`courses entry starts from ${readyState} without sibling registries and renders imported panel`, async () => {
        const fixture = browser(['courses-result-summary', 'courses-panel-content', 'courses-term-select', 'courses-availability-filter'], url => {
            if (url === '/api/atlas/terms') return { terms: ['Fall_2026'], default_term: 'Fall_2026' };
            if (url === '/api/courses/saved') return { courses: [] };
            if (url === '/api/courses/tracks') return { tracks: [] };
            if (url.startsWith('/api/atlas/sections?')) return { sections: [{ id: 'bio', term: 'Fall_2026', course_code: 'BIO 101', course_title: '<Biology>', enrollment_status: 'Open' }] };
            throw new Error(`Unexpected request ${url}`);
        }, { readyState });
        fixture.window.fetch = async (url, options) => {
            assert.equal(url, '/api/atlas/sections/verify');
            assert.deepEqual(JSON.parse(options.body).section_ids, ['bio']);
            return { ok: true, json: async () => ({ verified_by_id: { bio: { enrollment_status: 'Open', seats_available: 2 } } }) };
        };
        loadFeatureModule('courses/index.js', fixture.context);
        if (readyState === 'loading') {
            assert.equal(fixture.calls.length, 0);
            await fixture.document.emit('DOMContentLoaded');
        }
        await settle();
        assert.ok(fixture.calls.some(call => call.url.startsWith('/api/atlas/sections?term=Fall_2026')));
        assert.match(fixture.elements['courses-term-select'].innerHTML, /Fall 2026/);
        assert.match(fixture.elements['courses-panel-content'].innerHTML, /&lt;Biology&gt;/);
        const closedInput = { value: 'closed', checked: true, closest() { return this; } };
        await fixture.elements['courses-availability-filter'].emit('change', { target: closedInput });
        assert.match(fixture.elements['courses-panel-content'].innerHTML, /No sections match your filters/);
        closedInput.checked = false;
        await fixture.elements['courses-availability-filter'].emit('change', { target: closedInput });
        assert.match(fixture.elements['courses-panel-content'].innerHTML, /&lt;Biology&gt;/);
        assertNoFeatureRegistries(fixture.window);
    });
}

test('dashboard entry imports renderers and editor; actual edit and done controls work', async () => {
    const fixture = browser(['dashboard-tiles', 'dashboard-edit-layout', 'dashboard-cancel-layout'], url => {
        assert.equal(url, '/api/dashboard/summary');
        return { available_tiles: ['courses'], tiles: { courses: { items: [{ code: '<BIO>', name: 'Biology' }] } } };
    });
    loadFeatureModule('dashboard/index.js', fixture.context);
    await fixture.document.emit('DOMContentLoaded');
    await settle();
    assert.match(fixture.elements['dashboard-tiles'].innerHTML, /&lt;BIO&gt;/);
    assert.match(fixture.elements['dashboard-tiles'].innerHTML, /Biology/);
    const edit = fixture.elements['dashboard-edit-layout'];
    await edit.emit('click');
    assert.equal(edit.getAttribute('aria-pressed'), 'true');
    assert.equal(fixture.document.body.classList.contains('dashboard-editing-layout'), true);
    await edit.emit('click');
    assert.equal(edit.getAttribute('aria-pressed'), 'false');
    assert.equal(fixture.calls.length, 1);
    assertNoFeatureRegistries(fixture.window);
});

test('dashboard startup failure renders escaped retry feedback without sibling globals', async () => {
    const fixture = browser(['dashboard-tiles'], () => { throw new Error('<Reload dashboard>'); }, { readyState: 'complete' });
    loadFeatureModule('dashboard/index.js', fixture.context);
    await settle();
    assert.match(fixture.elements['dashboard-tiles'].innerHTML, /&lt;Reload dashboard&gt;/);
    assertNoFeatureRegistries(fixture.window);
});

test('notes entry renders shared cards from imported definitions and opens the actual note', async () => {
    const fixture = browser(['notes-grid', 'notes-page', 'notes-view-label'], url => {
        assert.equal(url, '/api/notes/shared');
        return { notes: [{ id: 'note/1', title: '<Shared>', preview_text: 'Review <draft>' }], folders: [] };
    }, { readyState: 'complete', search: '?view=shared' });
    loadFeatureModule('notes/list.js', fixture.context);
    await settle();
    assert.equal(fixture.elements['notes-view-label'].textContent, 'Shared with Me');
    const card = fixture.elements['notes-grid'].children[0];
    assert.ok(card, 'shared note card rendered by the imported cards factory');
    assert.match(card.innerHTML, /&lt;Shared&gt;/);
    assert.match(card.innerHTML, /Review &lt;draft&gt;/);
    await card.emit('click');
    assert.equal(fixture.window.location.href, '/notes/note%2F1');
    assert.equal(fixture.elements['notes-page'].classList.contains('is-loading'), false);
    assert.equal(fixture.calls[0].options.pendingLabel, 'notes-save');
    assertNoFeatureRegistries(fixture.window);
});

test('notes parser startup failure keeps the page usable and reports the actual request error', async () => {
    const fixture = browser(['notes-grid', 'notes-page', 'notes-empty-state'], () => {
        throw new Error('Connection interrupted');
    });
    loadFeatureModule('notes/list.js', fixture.context);
    assert.equal(fixture.calls.length, 0);
    await fixture.document.emit('DOMContentLoaded');
    await settle();
    assert.equal(fixture.calls[0].url, '/api/notes');
    assert.equal(fixture.elements['notes-page'].classList.contains('is-loading'), false);
    assert.equal(fixture.elements['notes-empty-state'].style.display, '');
    assert.equal(fixture.toasts[0].title, 'Couldn’t load notes');
    assert.equal(fixture.toasts[0].message, 'Connection interrupted');
    assertNoFeatureRegistries(fixture.window);
});
