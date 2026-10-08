import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createOnboardingDOM } from "./helpers/onboarding-dom.mjs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const moduleSource = await readFile(
    path.join(repoRoot, "static/js/onboarding/theme-selector.js"),
    "utf8",
);
const { createThemeSelector } = await import(
    `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

class FakeClassList {
    constructor(classes = []) {
        this.classes = new Set(classes);
    }

    contains(name) {
        return this.classes.has(name);
    }

    toggle(name, force) {
        if (force) this.classes.add(name);
        else this.classes.delete(name);
    }
}

function themeFixture(values) {
    const listeners = new Map();
    const inputs = values.map((value) => {
        const check = { classList: new FakeClassList(["hidden"]) };
        const card = {
            classList: new FakeClassList(["theme-card"]),
            querySelector(selector) {
                return selector === ".theme-check" ? check : null;
            },
        };
        return {
            value,
            checked: false,
            focused: false,
            check,
            card,
            closest(selector) {
                if (selector === "[data-theme-input]") return this;
                if (selector === ".theme-card") return card;
                return null;
            },
            focus() {
                inputs.forEach((candidate) => {
                    candidate.focused = false;
                });
                this.focused = true;
            },
        };
    });
    const root = {
        querySelectorAll(selector) {
            return selector === "[data-theme-input]" ? inputs : [];
        },
        contains(input) {
            return inputs.includes(input);
        },
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        removeEventListener(type, listener) {
            if (listeners.get(type) === listener) listeners.delete(type);
        },
    };

    return {
        inputs,
        root,
        dispatch(type, target, key) {
            let prevented = false;
            listeners.get(type)?.({
                target,
                key,
                preventDefault() {
                    prevented = true;
                },
            });
            return prevented;
        },
        hasListener(type) {
            return listeners.has(type);
        },
    };
}

test("onboarding theme markup uses one labelled native radio group", async () => {
    const template = await readFile(path.join(repoRoot, "templates/onboarding.html"), "utf8");
    const styles = await readFile(path.join(repoRoot, "static/css/onboarding.css"), "utf8");
    const themeInputs = template.match(/type="radio" name="interface-theme"/g) || [];

    assert.match(template, /<fieldset id="onboarding-theme-cards"/);
    assert.match(template, /<legend[^>]*>Interface Theme<\/legend>/);
    assert.equal(themeInputs.length, 5);
    assert.doesNotMatch(template, /data-theme-value|aria-selected/);
    assert.match(styles, /theme-card-input:focus-visible/);
    assert.match(styles, /outline:\s*3px solid/);
});

test("initial theme selection synchronizes radios and visual state", () => {
    const fixture = themeFixture(["obsidian-dark", "parchment-light", "system-match"]);
    const selector = createThemeSelector(fixture.root, { initialTheme: "parchment-light" });

    assert.equal(selector.value(), "parchment-light");
    assert.deepEqual(fixture.inputs.map((input) => input.checked), [false, true, false]);
    assert.deepEqual(
        fixture.inputs.map((input) => input.card.classList.contains("is-selected")),
        [false, true, false],
    );
    assert.deepEqual(
        fixture.inputs.map((input) => input.check.classList.contains("hidden")),
        [true, false, true],
    );
});

test("arrow, Home, and End keys move focus, select, wrap, and persist", () => {
    const fixture = themeFixture(["obsidian-dark", "parchment-light", "system-match"]);
    const persisted = [];
    const selector = createThemeSelector(fixture.root, {
        initialTheme: "obsidian-dark",
        onSelect(value) {
            persisted.push(value);
        },
    });

    assert.equal(fixture.dispatch("keydown", fixture.inputs[0], "ArrowRight"), true);
    assert.equal(fixture.inputs[1].focused, true);
    assert.equal(selector.value(), "parchment-light");

    fixture.dispatch("keydown", fixture.inputs[1], "End");
    assert.equal(fixture.inputs[2].focused, true);
    assert.equal(selector.value(), "system-match");

    fixture.dispatch("keydown", fixture.inputs[2], "ArrowRight");
    assert.equal(fixture.inputs[0].focused, true);
    assert.equal(selector.value(), "obsidian-dark");

    fixture.dispatch("keydown", fixture.inputs[0], "ArrowLeft");
    assert.equal(fixture.inputs[2].focused, true);
    fixture.dispatch("keydown", fixture.inputs[2], "Home");
    assert.equal(fixture.inputs[0].focused, true);
    assert.deepEqual(persisted, [
        "parchment-light",
        "system-match",
        "obsidian-dark",
        "system-match",
        "obsidian-dark",
    ]);
});

test("Space and native radio changes select once and call the persistence hook", () => {
    const fixture = themeFixture(["obsidian-dark", "parchment-light"]);
    const persisted = [];
    const selector = createThemeSelector(fixture.root, {
        initialTheme: "obsidian-dark",
        onSelect(value) {
            persisted.push(value);
        },
    });

    assert.equal(fixture.dispatch("keydown", fixture.inputs[1], " "), true);
    assert.equal(selector.value(), "parchment-light");
    assert.equal(fixture.inputs[1].checked, true);

    fixture.inputs[0].checked = true;
    fixture.dispatch("change", fixture.inputs[0]);
    assert.equal(selector.value(), "obsidian-dark");
    assert.deepEqual(persisted, ["parchment-light", "obsidian-dark"]);

    selector.destroy();
    assert.equal(fixture.hasListener("change"), false);
    assert.equal(fixture.hasListener("keydown"), false);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
async function withWizard(emoryStudent, run) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nest-onboarding-test-'));
    const dom = createOnboardingDOM({ emoryStudent });
    const { window, document } = dom;
    const requests = [];
    const invalid = [];
    window.APStudyFormField = { clearAll() {}, clearInvalid() {}, bindAutoClear() {}, markInvalid: (input) => invalid.push(input) };
    window.APStudyHttp = { async fetchJson(url, options = {}) {
        requests.push({ url, options });
        if (url === '/terms') return { terms: ['Fall_2026'] };
        if (url === '/saved-courses') return { courses: [] };
        return {};
    } };
    const globals = { window, document, localStorage: window.localStorage };
    const previous = new Map();
    Object.entries(globals).forEach(([name, value]) => {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    });
    try {
        await cp(new URL('../../static/js/onboarding/', import.meta.url), path.join(directory, 'onboarding'), { recursive: true });
        await cp(new URL('../../static/js/calendar/feed-links.js', import.meta.url), path.join(directory, 'calendar/feed-links.js'), { recursive: true });
        await cp(new URL('../../static/js/core/profile-policy.js', import.meta.url), path.join(directory, 'core/profile-policy.js'), { recursive: true });
        await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
        await import(pathToFileURL(path.join(directory, 'onboarding/index.js')));
        await settle();
        await run({ ...dom, requests, invalid });
    } finally {
        window.close();
        previous.forEach((descriptor, name) => {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        });
        await rm(directory, { recursive: true, force: true });
    }
}

for (const emoryStudent of [false, true]) {
    test(`real onboarding Continue/Finish persists the ${emoryStudent ? 'Emory' : 'non-Emory'} journey`, async () => {
        await withWizard(emoryStudent, async ({ window, document, requests }) => {
            const next = (step) => document.querySelector(`[data-step="${step}"]`).querySelector('.btn-next').click();
            const step = () => Number(document.getElementById('active-step').value);
            const assertProgress = (current, fraction) => {
                assert.equal(document.getElementById('step-label').textContent, `Step ${current} of 5`);
                assert.equal(document.getElementById('progress-bar').style['--onboarding-progress'], fraction);
                assert.equal(document.querySelector(`[data-onboarding-stage="${current}"]`).getAttribute('aria-current'), 'step');
                assert.equal(document.querySelector(`[data-step="${current}"]`).hidden, false);
            };
            assertProgress(1, '0.2');
            const name = document.getElementById('onboarding-display-name');
            name.value = 'Taylor Updated';
            name.dispatchEvent(new window.Event('input', { bubbles: true }));
            document.getElementById('onboarding-username').value = 'TAYLOR_UPDATED';
            next(1); await settle();
            assert.equal(step(), 2);
            assertProgress(2, '0.4');
            assert.deepEqual(JSON.parse(requests.find(({ url }) => url === '/onboarding').options.body), { step: 1, display_name: 'Taylor Updated', username: 'taylor_updated' });
            next(2); await settle();
            const education = requests.filter(({ url }) => url === '/onboarding')[1];
            assert.deepEqual(JSON.parse(education.options.body), { step: 2, education_level: 'Undergraduate', class_year: '2028', school: emoryStudent ? 'Emory University' : 'Other University', major: 'Biology', emory_student: emoryStudent, emory_email: emoryStudent ? 'taylor@emory.edu' : null });
            assert.equal(step(), emoryStudent ? 3 : 4);
            assertProgress(emoryStudent ? 3 : 4, emoryStudent ? '0.6' : '0.8');
            assert.equal(document.querySelector('[data-onboarding-stage="3"]').dataset.state, emoryStudent ? 'current' : 'skipped');
            if (emoryStudent) {
                next(3); await settle();
                assert.deepEqual(JSON.parse(requests.filter(({ url }) => url === '/onboarding')[2].options.body), { step: 3, action: 'advance' });
            }
            assert.equal(step(), 4);
            assertProgress(4, '0.8');
            document.getElementById('canvas-feed-url').value = ' canvas.example/feed ';
            document.getElementById('add-other-calendar').click();
            const optional = document.querySelector('input[data-other-calendar-url]');
            optional.value = ' webcal://calendar.example/feed ';
            const theme = document.querySelectorAll('[data-theme-input]').find(input => input.value === 'nest-light');
            theme.checked = true;
            theme.dispatchEvent(new window.Event('change', { bubbles: true }));
            next(4); await settle();
            assert.equal(step(), 5);
            assertProgress(5, '1');
            const saves = requests.filter(({ options }) => options.method === 'POST');
            assert.deepEqual(saves.slice(-3).map(({ url }) => url), ['/feed-url', '/interface-preferences', '/onboarding']);
            assert.deepEqual(JSON.parse(saves.at(-3).options.body), { canvas_ical_url: 'canvas.example/feed', other_ical_urls: ['webcal://calendar.example/feed'] });
            assert.deepEqual(JSON.parse(saves.at(-2).options.body), { interface_theme: 'nest-light' });
            assert.deepEqual(JSON.parse(saves.at(-1).options.body), { step: 4 });
            assert.equal(window.localStorage.getItem('apstudy-theme'), 'nest-light');
            document.getElementById('finish-button').click(); await settle();
            assert.deepEqual(JSON.parse(requests.at(-1).options.body), { step: 5 });
            assert.equal(window.location.href, 'https://nest.example/dashboard');
        });
    });
}

test('onboarding failed saves retain the current step, inputs and recovery before completion', async () => {
    await withWizard(false, async ({ window, document, requests }) => {
        const original = window.APStudyHttp.fetchJson;
        let failedUrl = '/onboarding';
        window.APStudyHttp.fetchJson = async (url, options) => {
            if (url === failedUrl) { requests.push({ url, options }); throw new Error('Reconnect and retry'); }
            return original(url, options);
        };
        const next = (step) => document.querySelector(`[data-step="${step}"]`).querySelector('.btn-next').click();
        const step = () => Number(document.getElementById('active-step').value);
        const name = document.getElementById('onboarding-display-name');
        name.value = 'Unsaved Taylor'; name.dispatchEvent(new window.Event('input', { bubbles: true }));
        next(1); await settle();
        assert.equal(step(), 1); assert.equal(name.value, 'Unsaved Taylor');
        assert.equal(document.getElementById('wizard-status').textContent, 'Reconnect and retry');
        const unload = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
        assert.equal(unload.defaultPrevented, true);
        failedUrl = ''; next(1); await settle(); next(2); await settle();
        document.getElementById('add-other-calendar').click();
        const link = document.querySelector('input[data-other-calendar-url]'); link.value = 'https://calendar.example/draft';
        failedUrl = '/interface-preferences'; next(4); await settle();
        assert.equal(step(), 4); assert.equal(link.value, 'https://calendar.example/draft');
        assert.notEqual(JSON.parse(requests.at(-1).options.body).step, 4, 'failed theme save must not advance persisted progress');
        failedUrl = ''; next(4); await settle();
        assert.equal(step(), 5);
        failedUrl = '/onboarding'; document.getElementById('finish-button').click(); await settle();
        assert.equal(step(), 5); assert.equal(window.location.href, 'https://nest.example/onboarding');
        assert.equal(link.value, 'https://calendar.example/draft');
        failedUrl = ''; document.getElementById('finish-button').click(); await settle();
        assert.equal(window.location.href, 'https://nest.example/dashboard');
    });
});

test('onboarding feed errors mark the exact input without posting or leaving preferences', async () => {
    await withWizard(false, async ({ document, requests, invalid }) => {
        const next = step => document.querySelector(`[data-step="${step}"]`).querySelector('.btn-next').click();
        next(1); await settle(); next(2); await settle();
        document.getElementById('canvas-feed-url').value = 'CANVAS.example/feed/';
        document.getElementById('add-other-calendar').click();
        document.getElementById('add-other-calendar').click();
        const inputs = document.querySelectorAll('input[data-other-calendar-url]');
        inputs[1].value = 'webcal://canvas.example/feed#view';
        next(4); await settle();
        assert.equal(Number(document.getElementById('active-step').value), 4);
        assert.deepEqual(invalid, [inputs[1]]);
        assert.match(document.getElementById('wizard-status').textContent, /Nest Canvas calendar/);
        assert.equal(requests.some(({ url }) => url === '/feed-url'), false);
        inputs[1].value = 'calendar.example/feed';
        next(4); await settle();
        assert.equal(invalid.at(-1), inputs[1]);
        assert.match(document.getElementById('wizard-status').textContent, /valid http/);
        inputs[0].value = 'https://calendar.example/feed';
        inputs[1].value = 'webcal://calendar.example/feed/';
        next(4); await settle();
        assert.equal(invalid.at(-1), inputs[1]);
        assert.match(document.getElementById('wizard-status').textContent, /Duplicate/);
        assert.equal(requests.some(({ url }) => url === '/feed-url'), false);
    });
});

test('onboarding follows the accepted education response next_step', async () => {
    await withWizard(true, async ({ window, document }) => {
        const original = window.APStudyHttp.fetchJson;
        window.APStudyHttp.fetchJson = async (url, options = {}) => {
            if (url === '/onboarding' && JSON.parse(options.body).step === 2) return { next_step: 4 };
            return original(url, options);
        };
        document.querySelector('[data-step="1"]').querySelector('.btn-next').click(); await settle();
        document.querySelector('[data-step="2"]').querySelector('.btn-next').click(); await settle();
        assert.equal(Number(document.getElementById('active-step').value), 4);
        assert.equal(document.querySelector('[data-step="4"]').hidden, false);
        assert.equal(document.querySelector('[data-step="3"]').hidden, true);
    });
});

test('onboarding account controls apply shared username errors and normalize accepted bounds before saving', async () => {
    await withWizard(false, async ({ document, requests, invalid }) => {
        const username = document.getElementById('onboarding-username');
        const next = document.querySelector('[data-step="1"]').querySelector('.btn-next');
        const rejected = [
            [' ', 'Username is required.'],
            ['ab', 'Username must be between 3 and 20 characters.'],
            ['u', 'Username must be between 3 and 20 characters.'],
            ['a'.repeat(21), 'Username must be between 3 and 20 characters.'],
            ['first last', 'Please only use numbers, letters, dashes -, or underscores _.'],
            ['éclair', 'Please only use numbers, letters, dashes -, or underscores _.'],
            ...['account', 'admin', 'api', 'auth', 'calendar', 'dashboard', 'data', 'files', 'login', 'logout', 'notes', 'onboarding', 'preferences', 'profile', 'settings', 'signup', 'user', 'users'].map(value => [` ${value.toUpperCase()} `, 'That username is reserved.']),
        ];
        for (const [value, message] of rejected) {
            username.value = value; next.click(); await settle();
            assert.equal(document.getElementById('wizard-status').textContent, message);
            assert.equal(invalid.at(-1), username);
            assert.equal(Number(document.getElementById('active-step').value), 1);
            assert.equal(requests.some(({ options }) => options.method === 'POST'), false);
            assert.equal(username.value, value);
        }
        for (const value of [' ABC ', ` ${'A'.repeat(20)} `]) {
            username.value = value; next.click(); await settle();
            assert.equal(username.value, value.trim().toLowerCase());
            assert.equal(JSON.parse(requests.at(-1).options.body).username, value.trim().toLowerCase());
            assert.equal(Number(document.getElementById('active-step').value), 2);
            document.querySelector('[data-step="2"]').querySelector('.btn-back').click();
        }
    });
});

test('onboarding profile controls retain local error rendering and Unicode limits through Continue saves', async () => {
    await withWizard(false, async ({ window, document, requests, node }) => {
        for (const field of ['display-name', 'school', 'major']) {
            node('span', { id: `onboarding-${field}-counter` });
            node('span', { id: `onboarding-${field}-error`, class: 'hidden' });
        }
        const change = (id, value) => {
            const input = document.getElementById(id); input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); return input;
        };
        const next = step => document.querySelector(`[data-step="${step}"]`).querySelector('.btn-next').click();
        const name = change('onboarding-display-name', '  ');
        next(1); await settle();
        assert.equal(name.validationMessage, 'Display name is required.');
        assert.equal(requests.some(({ options }) => options.method === 'POST'), false);
        change('onboarding-display-name', ` ${'😀'.repeat(81)} `); next(1); await settle();
        assert.equal(name.validationMessage, 'Display name must be 80 characters or fewer.');
        assert.equal(document.getElementById('onboarding-display-name-counter').textContent, '81 / 80 characters');
        assert.equal(document.getElementById('onboarding-display-name-error').classList.contains('hidden'), false);
        change('onboarding-display-name', ` ${'😀'.repeat(80)} `); next(1); await settle();
        assert.equal(name.validationMessage, ''); assert.equal(name.getAttribute('aria-invalid'), 'false');
        assert.equal(document.getElementById('onboarding-display-name-error').classList.contains('hidden'), true);
        assert.equal(JSON.parse(requests.at(-1).options.body).display_name, '😀'.repeat(80));
        const postCount = () => requests.filter(({ options }) => options.method === 'POST').length;
        for (const [id, field, label, maximum] of [['university-school', 'school', 'School', 160], ['onboarding-major', 'major', 'Major', 120]]) {
            const input = change(id, ` ${'😀'.repeat(maximum + 1)} `);
            next(2); await settle();
            assert.equal(input.validationMessage, `${label} must be ${maximum} characters or fewer.`);
            assert.equal(input.getAttribute('aria-invalid'), 'true');
            assert.equal(document.getElementById(`onboarding-${field}-counter`).textContent, `${maximum + 1} / ${maximum} characters`);
            assert.equal(postCount(), 1);
            change(id, ` ${'😀'.repeat(maximum)} `);
            assert.equal(input.validationMessage, '');
        }
        next(2); await settle();
        const payload = JSON.parse(requests.at(-1).options.body);
        assert.equal(payload.school, ` ${'😀'.repeat(160)} `); assert.equal(payload.major, ` ${'😀'.repeat(120)} `); // Education drafts retain the existing wire format; validation trims for counting.
        assert.equal(Number(document.getElementById('active-step').value), 4);
    });
});
