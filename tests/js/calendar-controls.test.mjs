import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { calendarScript } from './helpers/calendar-script.mjs';

function fixture() {
    class BrowserEvent {
        constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
        preventDefault() { this.defaultPrevented = true; }
    }
    class Element {
        constructor(attributes = {}) { this.attributes = attributes; this.listeners = new Map(); this.children = []; this.style = {}; this.value = ''; }
        getAttribute(key) { return this.attributes[key] ?? null; }
        setAttribute(key, value) { this.attributes[key] = value; }
        addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
        removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
        dispatchEvent(event) { event.target ||= this; for (const listener of this.listeners.get(event.type) || []) listener(event); if (event.bubbles) this.parent?.dispatchEvent(event); }
        click() { this.dispatchEvent(new BrowserEvent('click', { bubbles: true })); }
        closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
        matches(selector) {
            if (selector.startsWith('#')) return this.attributes.id === selector.slice(1);
            if (selector.startsWith('.')) return this.attributes.class === selector.slice(1);
            const attribute = selector.match(/^\[([^=\]]+)(?:="([^"]+)")?\]$/);
            return attribute ? this.attributes[attribute[1]] !== undefined && (!attribute[2] || this.attributes[attribute[1]] === attribute[2]) : this.tag === selector;
        }
        querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const nested = child.querySelector(selector); if (nested) return nested; } return null; }
        appendChild(child) { child.parent = this; this.children.push(child); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
        contains(node) { return node === this || this.children.some(child => child.contains(node)); }
        getBoundingClientRect() { return { left: 20, right: 120, top: 20, bottom: 60, width: 100, height: 40 }; }
    }
    const view = new Element(); Object.assign(view, { Element, Event: BrowserEvent, MouseEvent: BrowserEvent, FocusEvent: BrowserEvent, KeyboardEvent: BrowserEvent, CustomEvent: BrowserEvent, PopStateEvent: BrowserEvent, innerWidth: 1200, innerHeight: 900 });
    const document = new Element(); document.createElement = () => new Element(); document.body = {}; document.defaultView = view;
    view.document = document;
    const root = new Element({ id: 'calendar' }); root.ownerDocument = document;
    const viewRoot = new Element({ id: 'calendar-view-root' }); root.appendChild(viewRoot);
    const anchor = new Element({ 'data-event-ref': 'one' }); viewRoot.appendChild(anchor);
    for (const [tag, attributes] of [['input', { id: 'courses-search-input' }], ['select', { id: 'courses-term-select' }], ['button', { id: 'courses-search-submit' }], ['button', { class: 'js-course-toggle', 'data-section-id': 'section-one' }], ['button', { class: 'js-course-info-toggle', 'data-section-id': 'section-one' }]]) {
        const node = new Element(attributes); node.tag = tag; node.id = attributes.id; node.value = tag === 'select' ? 'Fall' : ''; root.appendChild(node);
    }
    const dom = { window: { close() {} } };
    const context = vm.createContext({ window: view, document: view.document, console, AbortController });
    for (const [file, name] of [['lifecycle.js', 'Lifecycle'], ['integrations/course-controls.js', 'CourseControls'], ['events/hover-card.js', 'HoverCard']]) {
        vm.runInContext(calendarScript(readFileSync(new URL(`../../static/js/calendar/${file}`, import.meta.url), 'utf8'), `APStudy${name}`), context);
    }
    const timers = new Map(); let id = 0;
    view.setTimeout = fn => { timers.set(++id, fn); return id; };
    view.clearTimeout = key => timers.delete(key);
    const lifecycle = view.APStudyLifecycle.createCalendarLifecycle({ view });
    return { dom, view, root, lifecycle, timers };
}

test('course controls keep search, selection, details, history and profile events in their mounted feature', () => {
    const f = fixture();
    try {
        const calls = []; const state = { public: { readOnly: false }, courses: { modalOpen: false, expandedDetails: new Set(), searchQuery: '' } };
        const courses = {
            applyCourseFilters() { calls.push('filters'); },
            applyCoursesFiltersFromUrl() { state.courses.searchQuery = 'history'; calls.push('url'); },
            closeCoursesModal() { state.courses.modalOpen = false; calls.push('close'); },
            openCoursesModal() { state.courses.modalOpen = true; calls.push('open'); },
            renderCoursesModal() { calls.push('render'); }, submitCoursesSearch() { calls.push('search'); },
            toggleCourseSectionSelection(id) { calls.push(id); },
        };
        f.view.APStudyCourseControls.createCourseControls({ root: f.root, runtimeWindow: f.view, lifecycle: f.lifecycle, state, courses })();
        const input = f.root.querySelector('input'); input.value = 'Biology'; input.dispatchEvent(new f.view.Event('input', { bubbles: true }));
        assert.equal(state.courses.searchInput, 'Biology');
        input.dispatchEvent(new f.view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        f.root.querySelector('#courses-search-submit').click();
        f.root.querySelector('select').dispatchEvent(new f.view.Event('change', { bubbles: true }));
        assert.equal(state.courses.termFilter, 'Fall'); assert.equal(calls.filter(value => value === 'search').length, 3);
        f.root.querySelector('.js-course-toggle').click(); assert.ok(calls.includes('section-one'));
        f.root.querySelector('.js-course-info-toggle').click(); assert.equal(state.courses.expandedDetails.has('section-one'), true);
        f.view.document.dispatchEvent(new f.view.CustomEvent('profile-my-courses-click')); assert.equal(state.courses.modalOpen, true);
        f.view.dispatchEvent(new f.view.PopStateEvent('popstate')); assert.equal(state.courses.searchInput, 'history');
        f.view.dispatchEvent(new f.view.KeyboardEvent('keydown', { key: 'Escape' })); assert.equal(state.courses.modalOpen, false);
        f.lifecycle.dispose(); const count = calls.length;
        input.dispatchEvent(new f.view.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        f.view.document.dispatchEvent(new f.view.CustomEvent('profile-my-courses-click'));
        assert.equal(calls.length, count);
    } finally { f.lifecycle.dispose(); f.dom.window.close(); }
});

test('blocked session storage cannot prevent course controls wiring or expose private profile actions on shares', () => {
    const f = fixture();
    try {
        Object.defineProperty(f.view, 'sessionStorage', { get() { throw Error('SecurityError'); } });
        let opens = 0;
        const state = { public: { readOnly: false }, courses: { modalOpen: false, expandedDetails: new Set() } };
        const courses = { openCoursesModal() { opens++; }, closeCoursesModal() {}, applyCourseFilters() {}, applyCoursesFiltersFromUrl() {} };
        f.view.APStudyCourseControls.createCourseControls({ root: f.root, runtimeWindow: f.view, lifecycle: f.lifecycle, state, courses })();
        f.view.document.dispatchEvent(new f.view.CustomEvent('profile-my-courses-click')); assert.equal(opens, 1);
        f.lifecycle.dispose(); state.public.readOnly = true;
        const sharedLifecycle = f.view.APStudyLifecycle.createCalendarLifecycle({ view: f.view });
        f.view.APStudyCourseControls.createCourseControls({ root: f.root, runtimeWindow: f.view, lifecycle: sharedLifecycle, state, courses })();
        f.view.document.dispatchEvent(new f.view.CustomEvent('profile-my-courses-click')); assert.equal(opens, 1);
        sharedLifecycle.dispose();
    } finally { f.lifecycle.dispose(); f.dom.window.close(); }
});

test('hover card responds to pointer and keyboard focus, preserves escaped text, and disposes nodes and timers', () => {
    const f = fixture();
    try {
        const state = { ui: {} }; let lookups = 0;
        const hover = f.view.APStudyHoverCard.createCalendarHoverCard({ root: f.root, runtimeWindow: f.view, lifecycle: f.lifecycle, state,
            getCalendarEventByRef(ref) { lookups++; assert.equal(ref, 'one'); return { title: '<Review>', description: 'Details', isAllDay: false }; },
            getEventCalendarLabel: () => 'Personal',
            formatters: { escapeHtml: text => String(text).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), formatAllDayRange: () => 'All day', formatTimedEventRange: () => '10 AM', formatMultilineText: text => text },
        });
        hover.wire(); const anchor = f.root.querySelector('[data-event-ref]');
        anchor.dispatchEvent(new f.view.MouseEvent('pointerover', { bubbles: true }));
        assert.equal(state.ui.hoverCardEl.hidden, false); assert.equal(state.ui.hoverCardEl.getAttribute('role'), 'tooltip');
        assert.match(state.ui.hoverCardEl.innerHTML, /&lt;Review&gt;/);
        anchor.dispatchEvent(new f.view.MouseEvent('pointerout', { bubbles: true })); assert.equal(f.timers.size, 1);
        anchor.dispatchEvent(new f.view.FocusEvent('focusin', { bubbles: true })); assert.equal(f.timers.size, 0);
        hover.hide(); assert.equal(state.ui.hoverCardEl.hidden, true);
        anchor.dispatchEvent(new f.view.FocusEvent('focusin', { bubbles: true })); assert.equal(state.ui.hoverCardEl.hidden, false);
        anchor.dispatchEvent(new f.view.FocusEvent('focusout', { bubbles: true })); assert.equal(f.timers.size, 1);
        f.lifecycle.dispose(); assert.equal(f.timers.size, 0); assert.equal(f.root.querySelector('[role="tooltip"]'), null);
        const count = lookups; anchor.dispatchEvent(new f.view.FocusEvent('focusin', { bubbles: true })); assert.equal(lookups, count);
    } finally { f.lifecycle.dispose(); f.dom.window.close(); }
});
