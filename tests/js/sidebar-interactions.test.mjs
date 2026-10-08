import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const sidebarSource = await readFile(new URL("../../static/js/core/sidebar.js", import.meta.url), "utf8");
const sidebarInitSource = await readFile(new URL("../../static/js/core/sidebar-init.js", import.meta.url), "utf8");

class HarnessElement extends EventTarget {
    constructor(document, classes = []) {
        super();
        this.document = document;
        this.attributes = new Map();
        this.classes = new Set(classes);
        this.dataset = {};
        this.hidden = false;
        this.isConnected = true;
        this.classList = {
            contains: name => this.classes.has(name),
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            toggle: (name, enabled = !this.classes.has(name)) => {
                if (enabled) this.classes.add(name);
                else this.classes.delete(name);
                return enabled;
            },
        };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, enabled) {
        if (enabled) this.setAttribute(name, "");
        else this.removeAttribute(name);
    }
    focus() { this.document.activeElement = this; }
    querySelector(selector) { return this.selectors?.[selector] ?? null; }
    querySelectorAll() { return []; }
    click() { this.dispatchEvent(new Event("click", { cancelable: true })); }
}

class HarnessCustomEvent extends Event {
    constructor(type, { detail } = {}) { super(type); this.detail = detail; }
}

function createSidebarHarness({ mobile = false, stored = null, sidebarDefault = "expanded" } = {}) {
    const document = new EventTarget();
    document.readyState = "complete";
    document.documentElement = new HarnessElement(document);
    document.body = new HarnessElement(document);
    const sidebar = new HarnessElement(document, ["sidebar-container"]);
    sidebar.dataset.sidebarDefault = sidebarDefault;
    const item = new HarnessElement(document, ["sidebar-item"]);
    const menu = new HarnessElement(document);
    const toggle = new HarnessElement(document);
    const tooltip = new HarnessElement(document);
    const backdrop = new HarnessElement(document);
    sidebar.selectors = { ".sidebar-item, button, a[href]": item };
    const byId = {
        "navbar-menu-btn": menu,
        "sidebar-toggle-handle": toggle,
        "sidebar-tooltip": tooltip,
        "sidebar-mobile-backdrop": backdrop,
    };
    document.getElementById = id => byId[id] ?? null;
    document.querySelector = selector => selector === ".sidebar-container" ? sidebar : null;
    document.querySelectorAll = selector => selector === ".sidebar-item" ? [item] : [];
    const media = new EventTarget();
    media.matches = mobile;
    const storage = new Map(stored === null ? [] : [["sidebar-collapsed", stored]]);
    const window = new EventTarget();
    window.APSTUDY_SIDEBAR_DEFAULT = sidebarDefault;
    window.matchMedia = query => query === "(max-width: 1024px)" ? media : { matches: true };
    const context = {
        window, document, console, CustomEvent: HarnessCustomEvent,
        requestAnimationFrame: callback => callback(),
        localStorage: {
            getItem: key => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, String(value)),
        },
    };
    vm.runInNewContext(sidebarInitSource, context);
    vm.runInNewContext(sidebarSource, context);
    // The browser spec verifies that the real navbar delegates this public API.
    menu.addEventListener("click", () => window.APSTUDY_TOGGLE_MOBILE_SIDEBAR());
    return {
        document, window, sidebar, item, menu, toggle, backdrop, storage,
        resize(matches) { media.matches = matches; media.dispatchEvent(new Event("change")); },
        escape() { const event = new Event("keydown"); event.key = "Escape"; document.dispatchEvent(event); },
    };
}

test("sidebar handlers expose mobile dialog state and restore toggle focus after dismissal", () => {
    const harness = createSidebarHarness({ mobile: true });
    const { sidebar, menu, item, document, backdrop } = harness;
    assert.equal(sidebar.getAttribute("aria-hidden"), "true");
    assert.equal(sidebar.hasAttribute("inert"), true);
    for (const dismiss of [() => harness.escape(), () => backdrop.click()]) {
        menu.click();
        assert.equal(sidebar.getAttribute("aria-hidden"), "false");
        assert.equal(sidebar.hasAttribute("inert"), false);
        assert.equal(sidebar.getAttribute("role"), "dialog");
        assert.equal(sidebar.getAttribute("aria-modal"), "true");
        assert.equal(menu.getAttribute("aria-expanded"), "true");
        assert.equal(document.activeElement, item);
        assert.equal(backdrop.hidden, false);
        dismiss();
        assert.equal(sidebar.getAttribute("aria-hidden"), "true");
        assert.equal(sidebar.hasAttribute("inert"), true);
        assert.equal(sidebar.hasAttribute("role"), false);
        assert.equal(sidebar.hasAttribute("aria-modal"), false);
        assert.equal(menu.getAttribute("aria-expanded"), "false");
        assert.equal(document.activeElement, menu);
        assert.equal(backdrop.hidden, true);
    }
});

test("real media change handlers make closed mobile navigation inert and clean desktop modal state", () => {
    const harness = createSidebarHarness();
    const { sidebar, menu, document, backdrop } = harness;
    assert.equal(sidebar.hasAttribute("inert"), false);
    harness.resize(true);
    assert.equal(sidebar.getAttribute("aria-hidden"), "true");
    assert.equal(sidebar.hasAttribute("inert"), true);
    menu.click();
    harness.resize(false);
    assert.equal(sidebar.getAttribute("aria-hidden"), "false");
    assert.equal(sidebar.hasAttribute("inert"), false);
    assert.equal(sidebar.hasAttribute("role"), false);
    assert.equal(sidebar.hasAttribute("aria-modal"), false);
    assert.equal(sidebar.classList.contains("mobile-open"), false);
    assert.equal(document.body.classList.contains("mobile-sidebar-open"), false);
    assert.equal(backdrop.hidden, true);
    harness.resize(true);
    assert.equal(sidebar.hasAttribute("inert"), true);
});

test("desktop collapse handlers persist state and mobile opening preserves that preference", () => {
    const harness = createSidebarHarness();
    harness.toggle.click();
    assert.equal(harness.toggle.getAttribute("aria-label"), "Expand sidebar");
    assert.equal(harness.toggle.getAttribute("aria-expanded"), "false");
    assert.equal(harness.storage.get("sidebar-collapsed"), "true");
    const reloaded = createSidebarHarness({ stored: harness.storage.get("sidebar-collapsed") });
    assert.equal(reloaded.sidebar.classList.contains("collapsed"), true);
    harness.resize(true);
    harness.menu.click();
    harness.escape();
    assert.equal(harness.storage.get("sidebar-collapsed"), "true");
    harness.resize(false);
    harness.toggle.click();
    assert.equal(harness.storage.get("sidebar-collapsed"), "false");
    assert.equal(harness.toggle.getAttribute("aria-label"), "Collapse sidebar");
});

test("preference events and focus mode collapse keep explicit persistence contracts", () => {
    const harness = createSidebarHarness({ sidebarDefault: "collapsed", stored: "false" });
    assert.equal(harness.sidebar.classList.contains("collapsed"), false);
    const stateChanges = [];
    harness.document.addEventListener("apstudy-sidebar-state-change", event => stateChanges.push(event.detail));
    harness.document.dispatchEvent(new HarnessCustomEvent("apstudy-sidebar-default-change", { detail: { collapsed: true } }));
    assert.equal(harness.sidebar.classList.contains("collapsed"), true);
    assert.equal(harness.storage.get("sidebar-collapsed"), "true");
    assert.equal(stateChanges[0].collapsed, true);
    assert.equal(stateChanges[0].persisted, true);
    harness.document.body.classList.add("focus-mode-active");
    harness.toggle.click();
    assert.equal(harness.sidebar.classList.contains("collapsed"), false);
    assert.equal(harness.storage.get("sidebar-collapsed"), "true");
    assert.equal(stateChanges[1].persisted, false);
});
