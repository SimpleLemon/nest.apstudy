import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
