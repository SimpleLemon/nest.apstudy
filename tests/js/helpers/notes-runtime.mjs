import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export class FakeElement {
    constructor(dataset = {}) {
        this.dataset = dataset;
        this.attributes = new Map();
        this.listeners = new Map();
        this.selectors = new Map();
        this.classes = new Set();
        this.classList = {
            add: (...values) => values.forEach((value) => this.classes.add(value)),
            remove: (...values) => values.forEach((value) => this.classes.delete(value)),
            contains: (value) => this.classes.has(value),
            toggle: (value, force) => force ? this.classes.add(value) : this.classes.delete(value),
        };
        this.properties = new Map();
        this.style = { setProperty: (name, value) => this.properties.set(name, value) };
        this.textContent = '';
        this.innerHTML = '';
        this.value = '';
        this.hidden = false;
    }
    addEventListener(type, handler, { signal } = {}) {
        if (signal?.aborted) return;
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(handler);
        signal?.addEventListener('abort', () => this.removeEventListener(type, handler), { once: true });
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    dispatch(type, event = {}) { for (const handler of this.listeners.get(type) || []) handler(event); }
    querySelector(selector) { return this.selectors.get(selector)?.[0] || null; }
    querySelectorAll(selector) { return this.selectors.get(selector) || []; }
    closest(selector) { return this.selectors.get(`closest:${selector}`)?.[0] || null; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() {}
}

export function createHarness() {
    const window = new FakeElement();
    const timers = new Map();
    let timerId = 0;
    window.setTimeout = (callback) => { timers.set(++timerId, callback); return timerId; };
    window.clearTimeout = (id) => timers.delete(id);
    window.setInterval = window.setTimeout;
    window.clearInterval = window.clearTimeout;
    window.requestAnimationFrame = window.setTimeout;
    window.cancelAnimationFrame = window.clearTimeout;
    window.localStorage = { getItem: () => null, setItem() {} };
    window.innerWidth = 1000;
    const requests = [];
    const errors = [];
    const context = vm.createContext({
        window, document: new FakeElement(), AbortController,
        setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
        setInterval: window.setInterval, clearInterval: window.clearInterval,
        requestAnimationFrame: window.requestAnimationFrame,
        getComputedStyle: () => ({ getPropertyValue: () => '10%' }),
        console: { error: (error) => errors.push(error) },
        fetch: (url, options = {}) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
        escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
        floatingPopoverPosition: () => ({ left: 0, top: 0 }),
    });
    const load = (name, exports) => {
        const source = fs.readFileSync(path.join(root, 'static/js/notes/editor', name), 'utf8')
            .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '')
            .replace(/export\s*\{[^}]*\};?/g, '')
            .replace(/export\s+(?=(function|const|class)\b)/g, '');
        return vm.runInContext(`(() => { ${source}\nreturn { ${exports.join(', ')} }; })()`, context, { filename: name });
    };
    const flushTimers = () => {
        const current = [...timers.entries()];
        for (const [id, callback] of current) { timers.delete(id); callback(); }
    };
    Object.assign(context, load('utils.js', ['positionFloatingElement', 'floatingPopoverPosition']));
    const unloadPrevented = () => {
        let prevented = false;
        window.dispatch('beforeunload', { preventDefault: () => { prevented = true; } });
        return prevented;
    };
    return { window, context, timers, requests, errors, load, flushTimers, unloadPrevented };
}

export const ok = (payload = {}) => ({ ok: true, status: 200, json: async () => payload });
export const settle = () => new Promise((resolve) => setImmediate(resolve));
