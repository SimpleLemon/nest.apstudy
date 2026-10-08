// Small DOM port for public Calendar controllers. It parses their real markup,
// bubbles user events, honors disabled controls, and implements form selection.
class BrowserEvent {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
}
class EventHost {
    listeners = new Map();
    addEventListener(type, handler, options = {}) {
        if (options.signal?.aborted) return;
        const entry = { handler, once: options.once };
        const entries = this.listeners.get(type) || new Set();
        entries.add(entry); this.listeners.set(type, entries);
        options.signal?.addEventListener('abort', () => entries.delete(entry), { once: true });
    }
    removeEventListener(type, handler) { for (const entry of this.listeners.get(type) || []) if (entry.handler === handler) this.listeners.get(type).delete(entry); }
    dispatchEvent(event) {
        event.target ||= this;
        for (const entry of [...this.listeners.get(event.type) || []]) {
            if (entry.once) this.listeners.get(event.type).delete(entry);
            entry.handler(event);
        }
        if (event.bubbles && !event.stopped) this.parentNode?.dispatchEvent(event);
        return !event.defaultPrevented;
    }
}
class Element extends EventHost {
    constructor(document, tag) {
        super(); this.ownerDocument = document; this.tagName = tag.toUpperCase(); this.nodeType = 1;
        this.children = []; this.attrs = new Map(); this.dataset = {}; this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this._value = ''; this._text = '';
        const classes = new Set();
        this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, force = !classes.has(name)) => { if (force) classes.add(name); else classes.delete(name); return force; } };
    }
    setAttribute(key, value) {
        this.attrs.set(key, String(value));
        if (key === 'class') String(value).split(/\s+/).forEach(name => this.classList.add(name));
        if (key === 'value') this.value = String(value);
        if (['checked', 'disabled', 'hidden', 'selected'].includes(key)) this[key] = true;
        if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
    getAttribute(key) { return this.attrs.get(key) ?? null; }
    hasAttribute(key) { return this.attrs.has(key); }
    removeAttribute(key) { this.attrs.delete(key); }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') || ''; }
    set id(value) { this.setAttribute('id', value); }
    get value() { return this.tagName === 'SELECT' && !this._value ? (this.children.find(node => node.selected) || this.children[0])?.value || '' : this._value; }
    set value(value) { this._value = String(value); }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get innerHTML() { return this._html || ''; }
    set innerHTML(value) {
        this.replaceChildren(); this._html = value;
        const stack = [this];
        for (const token of value.match(/<[^>]+>|[^<]+/g) || []) {
            if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
            if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
            const tag = token.match(/^<([\w-]+)/)?.[1]; if (!tag) continue;
            const node = this.ownerDocument.createElement(tag);
            for (const [, key, quoted, bare] of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:=(?:"([^"]*)"|([^\s>]+)))?/g)) node.setAttribute(key, quoted ?? bare ?? '');
            stack.at(-1).append(node);
            if (!['input', 'br', 'hr', 'img', 'meta', 'link'].includes(tag)) stack.push(node);
        }
    }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    prepend(node) { node.parentNode = this; this.children.unshift(node); }
    appendChild(node) {
        if (node.tagName === '#FRAGMENT') { [...node.children].forEach(child => this.appendChild(child)); return node; }
        node.parentNode = this; this.children.push(node); return node;
    }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    get isConnected() { return this.ownerDocument.body.contains(this); }
    matches(selector) {
        return selector.split(',').some(part => {
            part = part.trim(); const tag = part.match(/^[\w-]+/)?.[0];
            if (tag && tag.toUpperCase() !== this.tagName) return false;
            const id = part.match(/#([\w-]+)/)?.[1]; if (id && this.getAttribute('id') !== id) return false;
            for (const [, name] of part.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
            for (const [, key, value] of part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) if (!this.hasAttribute(key) || value !== undefined && this.getAttribute(key) !== value) return false;
            return true;
        });
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
    focus() { this.ownerDocument.activeElement = this; }
    click() { if (!this.disabled) this.dispatchEvent(new BrowserEvent('click', { bubbles: true })); }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; this.ownerDocument.queueDialogClose(() => this.dispatchEvent(new BrowserEvent('close'))); } }
    getBoundingClientRect() { return { left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 }; }
}
export function createCalendarDOM({ deferDialogCloseEvents = false } = {}) {
    const document = new EventHost(); document.readyState = 'loading'; document.nodeType = 9;
    const closeEvents = [];
    document.queueDialogClose = callback => { if (deferDialogCloseEvents) closeEvents.push(callback); else callback(); };
    document.createElement = tag => new Element(document, tag);
    document.createDocumentFragment = () => document.createElement('#fragment');
    document.body = document.createElement('body'); document.documentElement = document.body;
    document.querySelector = selector => document.body.querySelector(selector);
    document.querySelectorAll = selector => document.body.querySelectorAll(selector);
    document.getElementById = id => document.querySelector(`#${id}`);
    const window = new EventHost(); document.defaultView = window;
    Object.assign(window, { document, AbortController, location: new URL('https://nest.example/calendar'), crypto: { randomUUID: () => crypto.randomUUID() } });
    const storage = new Map();
    window.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
    const timers = new Map(), controllers = new Set(), cleanups = []; let next = 0;
    const lifecycle = {
        trackAbortController() { const controller = new AbortController(); controllers.add(controller); return controller; },
        releaseAbortController: controller => controllers.delete(controller),
        setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
        addCleanup: fn => cleanups.push(fn),
        addEventListener(target, type, callback) { target.addEventListener(type, callback); cleanups.push(() => target.removeEventListener(type, callback)); },
        dispose() { cleanups.forEach(fn => fn()); controllers.forEach(controller => controller.abort()); timers.clear(); },
    };
    class FormData {
        constructor(form) { this.form = form; }
        getAll(name) { return this.form.querySelectorAll('[name]').filter(node => node.getAttribute('name') === name && !node.disabled && (!['checkbox', 'radio'].includes(node.getAttribute('type')) || node.checked)).map(node => node.value); }
        get(name) { return this.getAll(name)[0] ?? null; }
        has(name) { return this.getAll(name).length > 0; }
    }
    const context = { window, document, AbortController, DOMException: globalThis.DOMException, URL, URLSearchParams, FormData, CustomEvent: BrowserEvent, console };
    return { window, document, lifecycle, timers, controllers, context, closeEvents, flushCloseEvents: () => closeEvents.splice(0).forEach(callback => callback()), event: (type, options) => new BrowserEvent(type, options) };
}
export const settle = async () => { for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve)); };
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
