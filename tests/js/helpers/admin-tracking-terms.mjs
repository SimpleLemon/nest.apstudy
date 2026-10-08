import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const decode = (value) => value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));

// A small DOM for this feature's generated forms. Rendered HTML is parsed into
// nodes so replacements, named form controls, focus, and delegated events use
// the same public interface as the browser, without another DOM dependency.
export class Element {
  constructor(tagName, document, attributes = {}) {
    this.tagName = tagName;
    this.document = document;
    this.attributes = attributes;
    this.children = [];
    this.listeners = new Map();
    this.dataset = Object.fromEntries(Object.entries(attributes).filter(([key]) => key.startsWith('data-')).map(([key, value]) => [key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    this.disabled = 'disabled' in attributes;
    this.hidden = 'hidden' in attributes;
    this.name = attributes.name || '';
    this._value = attributes.value;
    this._text = '';
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains: (name) => classes.has(name),
    };
  }

  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this._text = value; this.children = []; }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'select') return (this.options.find((option) => 'selected' in option.attributes) || this.options[0])?.value || '';
    return this.tagName === 'option' ? this.textContent.trim() : '';
  }
  set value(value) { this._value = String(value); }
  get options() { return this.children.filter((child) => child.tagName === 'option'); }
  add(option) { option.document = this.document; option.parent = this; this.children.push(option); }
  get elements() {
    const elements = this.querySelectorAll('input,select,button');
    for (const element of elements) if (element.name) elements[element.name] = element;
    return elements;
  }
  get innerHTML() {
    return this._text + this.children.map((child) => {
      const attrs = Object.entries(child.attributes).map(([key, value]) => ` ${key}="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
      return `<${child.tagName}${attrs}>${child.innerHTML}${['input', 'br', 'hr'].includes(child.tagName) ? '' : `</${child.tagName}>`}`;
    }).join('');
  }
  set innerHTML(html) {
    this._html = html;
    this.children = [];
    this._text = '';
    this._value = undefined;
    const stack = [this];
    for (const token of html.match(/<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      const parent = stack.at(-1);
      if (!token.startsWith('<')) { parent._text += decode(token); continue; }
      const [, tagName, rawAttributes] = token.match(/^<([\w-]+)(.*?)>$/s);
      const attributes = {};
      for (const match of rawAttributes.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attributes[match[1]] = decode(match[2] || '');
      const node = new Element(tagName, this.document, attributes);
      node.parent = parent;
      parent.children.push(node);
      if (!['input', 'br', 'hr'].includes(tagName)) stack.push(node);
    }
  }
  set outerHTML(html) {
    const container = new Element('div', this.document);
    container.innerHTML = html;
    const siblings = this.parent.children;
    for (const child of container.children) child.parent = this.parent;
    siblings.splice(siblings.indexOf(this), 1, ...container.children);
    this.parent = null;
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      if (part.trim().startsWith('#')) return this.attributes.id === part.trim().slice(1);
      const match = part.trim().match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
      if (!match) throw new Error(`Unsupported fixture selector: ${part}`);
      return (!match[1] || this.tagName === match[1]) && (!match[2] || (match[2] in this.attributes && (match[3] === undefined || this.attributes[match[2]] === match[3])));
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  focus() { this.document.activeElement = this; }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter((item) => item !== listener)); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of this.listeners.get(event.type) || []) listener(event);
    if (event.bubbles) this.parent?.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, json: async () => payload });

export async function trackingTermsRuntime(terms) {
  const document = { activeElement: null };
  const root = new Element('section', document);
  root.innerHTML = `<input id="admin-csrf-token" value="fixture-csrf">
    <section data-tracking-terms>
      <select data-term-year><option selected>2026</option></select>
      <p data-term-timezone></p><p data-terms-notice></p>
      <button data-terms-reload></button>
      <form data-add-year><input type="number"></form>
      <div data-term-rows></div>
    </section>`;
  document.getElementById = (id) => root.querySelector(`[id="${id}"]`);
  const requests = [];
  const savedEvents = [];
  root.addEventListener('admin-tracking:policy-saved', (event) => savedEvents.push(event));
  const window = { fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) };
  vm.runInNewContext(await readFile(new URL('../../../static/js/core/http.js', import.meta.url), 'utf8'), { window, URL });
  window.APStudyHttp = window.APStudyCoreServices.http.createHttpService({ window });
  vm.runInNewContext(await readFile(new URL('../../../static/js/admin-course-tracking-terms.js', import.meta.url), 'utf8'), {
    window, document, Date, Intl,
    Option: class extends Element {
      constructor(text, value) { super('option', document, { value }); this.textContent = text; }
    },
    CustomEvent: class {
      constructor(type, options) { this.type = type; Object.assign(this, options); }
    },
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  }, { filename: 'static/js/admin-course-tracking-terms.js' });
  window.initAdminTrackingTerms(root);
  requests[0].resolve(response({ terms }));
  await settle();
  return {
    root, document, requests, savedEvents, initialize: () => window.initAdminTrackingTerms(root),
    form: (term = 'Fall_2026') => root.querySelector(`[data-term="${term}"]`),
    emit(target, type) {
      const event = { type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      target.dispatchEvent(event);
      return event;
    },
  };
}
