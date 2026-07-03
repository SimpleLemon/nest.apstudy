import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = await readFile(path.join(repoRoot, "static/js/core/cookie-consent.js"), "utf8");

class FakeElement {
    constructor(tagName, document) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = document;
        this.children = [];
        this.dataset = {};
        this.hidden = false;
        this.innerHTML = "";
        this.attributes = new Map();
        this.classList = { add() {}, remove() {} };
    }

    appendChild(child) {
        this.children.push(child);
        if (child.id) this.ownerDocument.elements.set(child.id, child);
        return child;
    }

    addEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    focus() {}

    remove() {
        if (this.id) this.ownerDocument.elements.delete(this.id);
        const parent = this.tagName === "SCRIPT" ? this.ownerDocument.head : this.ownerDocument.body;
        parent.children = parent.children.filter((child) => child !== this);
    }
}

function createHarness({ stored = null, cookie = "", dnt = "0", measurementId = "G-0NT330ZX5L" } = {}) {
    const values = new Map();
    if (stored !== null) values.set("apstudy_cookie_consent", stored);
    const cookieWrites = [];
    const elements = new Map();
    const document = {
        readyState: "complete",
        elements,
        activeElement: null,
        createElement(tagName) { return new FakeElement(tagName, document); },
        getElementById(id) { return elements.get(id) || null; },
        querySelectorAll() { return []; },
        addEventListener() {},
    };
    document.head = new FakeElement("head", document);
    document.body = new FakeElement("body", document);
    document.body.dataset.analyticsMeasurementId = measurementId;
    Object.defineProperty(document, "cookie", {
        get: () => cookie,
        set: (value) => cookieWrites.push(value),
    });

    const listeners = new Map();
    let reloads = 0;
    const window = {
        document,
        navigator: { doNotTrack: dnt, globalPrivacyControl: false },
        localStorage: {
            getItem: (key) => values.get(key) ?? null,
            setItem: (key, value) => values.set(key, value),
        },
        location: {
            hostname: "nest.apstudy.org",
            reload: () => { reloads += 1; },
        },
        addEventListener: (name, handler) => listeners.set(name, handler),
        dispatchEvent() {},
    };
    const context = vm.createContext({
        window,
        document,
        navigator: window.navigator,
        console,
        Date,
        JSON,
        Number,
        CustomEvent: class CustomEvent { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    });
    vm.runInContext(source, context);
    return { window, document, values, cookieWrites, listeners, reloads: () => reloads };
}

function decision(choice, ageMs = 0) {
    return JSON.stringify({
        version: 1,
        choice,
        decidedAt: new Date(Date.now() - ageMs).toISOString(),
    });
}

test("analytics is denied by default and when consent data is malformed or expired", () => {
    const defaultHarness = createHarness();
    const malformedHarness = createHarness({ stored: "not-json" });
    const expiredHarness = createHarness({ stored: decision("accepted", 184 * 24 * 60 * 60 * 1000) });

    assert.equal(defaultHarness.document.head.children.length, 0);
    assert.equal(malformedHarness.document.head.children.length, 0);
    assert.equal(expiredHarness.document.head.children.length, 0);
    assert.equal(defaultHarness.window.APStudyCookieConsent.getDecision(), null);
});

test("acceptance persists and injects Google Analytics only once", () => {
    const harness = createHarness();
    harness.window.APStudyCookieConsent.setChoice("accepted");
    harness.window.APStudyCookieConsent.loadAnalytics();

    const saved = JSON.parse(harness.values.get("apstudy_cookie_consent"));
    assert.equal(saved.choice, "accepted");
    assert.equal(harness.document.head.children.length, 1);
    assert.equal(harness.document.head.children[0].id, "apstudy-google-analytics");
    assert.match(harness.document.head.children[0].src, /googletagmanager\.com\/gtag\/js/);
    assert.equal(harness.window.dataLayer.length, 3);
    assert.equal(harness.window.dataLayer[0][2].ad_storage, "denied");
    assert.equal(harness.window.dataLayer[2][2].allow_google_signals, false);
    assert.equal(harness.window.dataLayer[2][2].allow_ad_personalization_signals, false);
});

test("a saved acceptance loads analytics while rejection keeps it disabled", () => {
    const acceptedHarness = createHarness({ stored: decision("accepted") });
    const rejectedHarness = createHarness({ stored: decision("rejected") });

    assert.equal(acceptedHarness.document.head.children.length, 1);
    assert.equal(rejectedHarness.document.head.children.length, 0);
});

test("rejection persists, clears legacy Google cookies, and reloads after withdrawal", () => {
    const harness = createHarness({ cookie: "_ga=one; _ga_ABC=two; _gid=three; session=keep" });
    harness.window.APStudyCookieConsent.setChoice("accepted");
    harness.window.APStudyCookieConsent.setChoice("rejected");

    assert.equal(JSON.parse(harness.values.get("apstudy_cookie_consent")).choice, "rejected");
    assert.equal(harness.document.head.children.length, 0);
    assert.equal(harness.reloads(), 1);
    assert.ok(harness.cookieWrites.some((value) => value.startsWith("_ga=")));
    assert.ok(harness.cookieWrites.some((value) => value.startsWith("_ga_ABC=")));
    assert.ok(harness.cookieWrites.some((value) => value.startsWith("_gid=")));
    assert.ok(harness.cookieWrites.every((value) => !value.startsWith("session=")));
});

test("privacy signals never start analytics without explicit acceptance", () => {
    const harness = createHarness({ dnt: "1" });
    assert.equal(harness.document.head.children.length, 0);
    assert.match(harness.document.body.children[0].innerHTML, /privacy signal/);

    harness.window.APStudyCookieConsent.setChoice("accepted");
    assert.equal(harness.document.head.children.length, 1);
});

test("accept and reject controls use the same action class and prominence", () => {
    assert.equal((source.match(/data-apstudy-consent-choice="accepted"/g) || []).length, 2);
    assert.equal((source.match(/data-apstudy-consent-choice="rejected"/g) || []).length, 2);
    assert.match(source, /class="apstudy-consent-actions"/);
    assert.match(source, /keepDialogFocus/);
});

test("only the previously tracked templates opt into consent-gated analytics", async () => {
    const eligibleTemplates = [
        "landing.html",
        "settings.html",
        "files.html",
        "calendar.html",
        "file_share_download.html",
    ];
    const templateDirectory = path.join(repoRoot, "templates");
    const { readdir } = await import("node:fs/promises");
    const templateNames = (await readdir(templateDirectory)).filter((name) => name.endsWith(".html"));

    for (const name of templateNames) {
        const templateSource = await readFile(path.join(templateDirectory, name), "utf8");
        assert.doesNotMatch(templateSource, /googletagmanager\.com\/gtag/, `${name} must not load GA directly`);
        const isEligible = templateSource.includes('data-analytics-measurement-id="G-0NT330ZX5L"');
        assert.equal(isEligible, eligibleTemplates.includes(name), `${name} analytics eligibility changed unexpectedly`);
    }
});
