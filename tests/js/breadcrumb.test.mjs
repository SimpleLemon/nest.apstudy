import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function createDom() {
    class Element {
        constructor(tagName) {
            this.tagName = tagName.toUpperCase();
            this.children = [];
            this.attributes = {};
            this.style = {};
            this.dataset = {};
            this.className = "";
            this.innerHTML = "";
            this.hidden = false;
            this.parentNode = null;
        }

        setAttribute(name, value) {
            this.attributes[name] = String(value);
        }

        getAttribute(name) {
            return this.attributes[name] ?? null;
        }

        removeAttribute(name) {
            delete this.attributes[name];
        }

        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        }

        remove() {
            if (!this.parentNode) return;
            this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
            this.parentNode = null;
        }

        contains(node) {
            if (node === this) return true;
            return this.children.some((child) => child.contains?.(node));
        }

        querySelector(selector) {
            if (selector === ".breadcrumb-ellipsis") {
                return this.find((node) => node.className.includes("breadcrumb-ellipsis")) || null;
            }
            if (selector === ".breadcrumb-link[data-breadcrumb-id]") {
                return this.find((node) => (
                    node.className.includes("breadcrumb-link")
                    && node.attributes["data-breadcrumb-id"] !== undefined
                )) || null;
            }
            if (selector === "button") {
                return this.find((node) => node.tagName === "BUTTON") || null;
            }
            if (selector.startsWith("[data-breadcrumb-id]")) {
                return this.find((node) => node.attributes["data-breadcrumb-id"] !== undefined) || null;
            }
            return null;
        }

        querySelectorAll(selector) {
            if (selector === ".breadcrumb-link[data-breadcrumb-id]") {
                return this.findAll((node) => (
                    node.className.includes("breadcrumb-link")
                    && node.attributes["data-breadcrumb-id"] !== undefined
                ));
            }
            if (selector === "[data-breadcrumb-id]") {
                return this.findAll((node) => node.attributes["data-breadcrumb-id"] !== undefined);
            }
            return [];
        }

        find(predicate) {
            if (predicate(this)) return this;
            for (const child of this.children) {
                const match = child.find?.(predicate);
                if (match) return match;
            }
            return null;
        }

        findAll(predicate, matches = []) {
            if (predicate(this)) matches.push(this);
            for (const child of this.children) {
                child.findAll?.(predicate, matches);
            }
            return matches;
        }

        addEventListener() {}

        focus() {}
    }

    class Document {
        constructor() {
            this.body = new Element("body");
            this.eventListeners = {};
        }

        createElement(tagName) {
            return new Element(tagName);
        }

        addEventListener(type, listener) {
            this.eventListeners[type] = listener;
        }
    }

    const document = new Document();
    return { document, Element };
}

async function loadBreadcrumb() {
    const source = await readFile(path.join(repoRoot, "static/js/core/breadcrumb.js"), "utf8");
    const { document } = createDom();
    const window = {
        addEventListener() {},
        APStudyBreadcrumb: undefined,
    };
    vm.runInNewContext(source, { document, window });
    return { api: window.APStudyBreadcrumb, document };
}

test("breadcrumb renderer emits semantic list markup", async () => {
    const { api, document } = await loadBreadcrumb();
    const container = document.createElement("nav");
    api.renderBreadcrumb(container, [
        { label: "My Files", id: "root" },
        { label: "Documents", id: "docs" },
        { label: "Current", id: "current", current: true },
    ]);

    assert.match(container.innerHTML, /class="breadcrumb-list"/);
    assert.match(container.innerHTML, /aria-current="page">Current/);
    assert.match(container.innerHTML, /data-breadcrumb-id="docs"/);
    assert.match(container.innerHTML, /chevron_right/);
});

test("breadcrumb renderer collapses long paths with ellipsis", async () => {
    const { api, document } = await loadBreadcrumb();
    const container = document.createElement("nav");
    api.renderBreadcrumb(container, [
        { label: "My Files", id: "root" },
        { label: "A", id: "a" },
        { label: "B", id: "b" },
        { label: "C", id: "c" },
        { label: "Current", id: "current", current: true },
    ], { collapseAfter: 4 });

    assert.match(container.innerHTML, /breadcrumb-ellipsis/);
    assert.match(container.innerHTML, /data-breadcrumb-id="c"/);
    assert.doesNotMatch(container.innerHTML, /data-breadcrumb-id="a"/);
    assert.doesNotMatch(container.innerHTML, /data-breadcrumb-id="b"/);
});

test("files index delegates breadcrumb rendering to shared helper", async () => {
    const source = await readFile(path.join(repoRoot, "static/js/files/index.js"), "utf8");
    assert.match(source, /APStudyBreadcrumb\?\.renderBreadcrumb/);
    assert.match(source, /collapseAfter:\s*4/);
});
