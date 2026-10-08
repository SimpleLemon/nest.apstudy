// Focused settings DOM fixture: enough browser behavior to exercise controller
// hydration, events, forms, and undo without installing a DOM runtime.
class SettingsEvent {
  constructor(type, options = {}) { this.type = type; this.cancelable = Boolean(options.cancelable); this.defaultPrevented = false; Object.assign(this, options); }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  stopPropagation() {}
}
class EventHost {
  listeners = new Map();
  addEventListener(type, callback) { const listeners = this.listeners.get(type) || []; listeners.push(callback); this.listeners.set(type, listeners); }
  dispatchEvent(event) { event.target ||= this; for (const callback of this.listeners.get(event.type) || []) callback(event); return !event.defaultPrevented; }
}
export class SettingsElement extends EventHost {
  constructor(tag = 'div', attributes = {}) {
    super(); this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.textContent = ''; this.dataset = {};
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach((value) => classes.add(value)), remove: (...values) => values.forEach((value) => classes.delete(value)), contains: (value) => classes.has(value), toggle(value, force = !classes.has(value)) { if (force) classes.add(value); else classes.delete(value); return force; } };
    this.style = { setProperty(name, value) { this[name] = value; } };
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value); if (name === 'class') String(value).split(/\s+/).forEach((value) => this.classList.add(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value) { this.setAttribute('src', value); }
  get srcset() { return this.getAttribute('srcset') || ''; }
  set srcset(value) { this.setAttribute('srcset', value); }
  get innerHTML() { return this.html || this.textContent.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
  set innerHTML(value) {
    this.html = value; this.children = [];
    if (value.includes('data-other-calendar-url')) {
      this.appendChild(new SettingsElement('input', { 'data-other-calendar-url': '' }));
      this.appendChild(new SettingsElement('button', { class: 'settings-calendar-remove' }));
    }
  }
  get childNodes() { return this.children; }
  get parentElement() { return this.parentNode || null; }
  get isConnected() { return Boolean(this.ownerDocument?.documentElement.contains(this)); }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  toggleAttribute(name, force = !this.attributes.has(name)) { if (force) this.setAttribute(name, ''); else this.removeAttribute(name); return force; }
  replaceChildren(...nodes) { this.children.forEach((child) => { child.parentNode = null; }); this.children = []; this.append(...nodes); }
  dispatchEvent(event) { const result = super.dispatchEvent(event); if (event.bubbles) this.parentNode?.dispatchEvent(event); return result; }
  appendChild(node) { node.parentNode = this; node.ownerDocument = this.ownerDocument; if (node.tagName === '#FRAGMENT') { node.children.forEach((child) => this.appendChild(child)); return node; } this.children.push(node); return node; }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  insertBefore(node, before) { node.parentNode = this; this.children.splice(this.children.indexOf(before), 0, node); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); }
  matches(selector) {
    const compound = selector.match(/^([a-z]+)(\[.+\])$/);
    if (compound) return this.tagName.toLowerCase() === compound[1] && this.matches(compound[2]);
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const data = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (data) return this.attributes.has(data[1]) && (data[2] === undefined || this.getAttribute(data[1]) === data[2]);
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {
    const space = selector.indexOf(' ');
    if (space !== -1 && !selector.includes('="')) return this.querySelectorAll(selector.slice(0, space)).flatMap((node) => node.querySelectorAll(selector.slice(space + 1)));
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  setCustomValidity(value) { this.validationMessage = value; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new SettingsEvent('click', { cancelable: true })); }
}
export function createSettingsDOM(url) {
  const document = new EventHost();
  document.documentElement = new SettingsElement('html'); document.body = new SettingsElement('body'); document.documentElement.ownerDocument = document; document.documentElement.appendChild(document.body);
  document.querySelectorAll = (selector) => document.documentElement.querySelectorAll(selector);
  document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null;
  document.getElementById = (id) => document.querySelector(`#${id}`);
  document.createElement = (tag) => { const node = new SettingsElement(tag); node.ownerDocument = document; return node; };
  document.createDocumentFragment = () => document.createElement('#fragment');
  document.hidden = false;
  const node = (tag, attributes) => document.body.appendChild(new SettingsElement(tag, attributes));
  for (const id of ['account', 'tier', 'data', 'preferences', 'notifications']) {
    node('section', { id, class: 'settings-section' });
    node('a', { 'data-tab': id, href: `#${id}`, class: 'settings-tab' });
  }
  for (const name of ['display-name', 'username-input', 'email', 'school', 'major', 'graduation-year', 'banner-color-picker', 'user-id', 'username', 'account-created', 'account-created-data', 'theme', 'sidebar-default', 'language', 'timezone', 'canvas-feed-url']) node('input', { id: `settings-${name}` });
  for (const name of ['save-profile', 'save-appearance', 'save-region', 'save-notifications', 'save-calendar-links', 'add-other-calendar', 'delete-account', 'change-password', 'open-profile', 'share-profile', 'export-data', 'discord-button', 'discord-unlink', 'discord-relink', 'avatar-upload-button', 'avatar-file-button']) node('button', { id: `settings-${name}` });
  for (const name of ['skeleton', 'preview-name', 'preview-handle', 'profile-tile', 'banner-swatch', 'other-calendar-links', 'other-calendar-count', 'discord-modal', 'avatar-modal', 'avatar-dropzone', 'avatar-modal-status']) node('div', { id: `settings-${name}` });
  node('input', { id: 'settings-avatar-upload' }); node('img', { id: 'settings-avatar-preview' });
  node('div', { class: 'settings-sections' });
  for (const theme of ['obsidian-dark', 'parchment-light', 'system-match', 'nest-light', 'nest-dark']) node('button', { 'data-theme': theme, class: 'settings-theme-choice' });
  for (const field of ['email_notifications', 'product_updates', 'task_sound_enabled', 'chat_sound_enabled']) node('button', { 'data-toggle-field': field });
  for (const key of ['tier-label', 'tier-storage', 'tier-storage-percent', 'tier-storage-progress', 'tier-warning', 'tier-status', 'storage-used', 'storage-details']) node('div', { [`data-${key}`]: '' });
  for (const id of ['notification-permission-status', 'notification-enable', 'notification-test', 'notification-recovery', 'notification-devices']) node('div', { id });
  const window = new EventHost();
  window.document = document; window.location = new URL(url); window.navigator = { userAgent: 'Settings test', platform: '', maxTouchPoints: 0 };
  window.history = { replaceState(_, __, url) { window.location = new URL(url, window.location); }, pushState(_, __, url) { window.location = new URL(url, window.location); } };
  const storage = new Map(); window.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  window.matchMedia = () => ({ matches: false }); window.Event = SettingsEvent; window.HashChangeEvent = SettingsEvent; window.CustomEvent = SettingsEvent;
  const timers = new Set(); window.setTimeout = (callback, delay) => { const id = setTimeout(callback, delay); timers.add(id); return id; }; window.clearTimeout = clearTimeout;
  window.close = () => { timers.forEach(clearTimeout); };
  return { window };
}
