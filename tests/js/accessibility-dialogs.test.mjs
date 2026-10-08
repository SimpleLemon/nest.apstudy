import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createSettingsDOM } from './helpers/settings-dom.mjs';

const source = await readFile(new URL('../../static/js/core/accessibility.js', import.meta.url), 'utf8');

function fixture() {
    const { window } = createSettingsDOM('https://nest.example/calendar');
    const document = window.document;
    document.body.replaceChildren();
    document.activeElement = document.body;
    document.readyState = 'complete';
    let mutation;
    const matches = (element, selector) => selector.split(',').some(part => {
        const value = part.trim();
        if (value.startsWith('.')) return element.classList.contains(value.slice(1));
        if (value.startsWith('#')) return element.id === value.slice(1);
        const tag = value.match(/^[a-z]+/i)?.[0];
        if (tag && element.tagName.toLowerCase() !== tag) return false;
        if (value.includes(':not([disabled])') && element.disabled) return false;
        const attributes = value.replace(/:not\([^)]*\)/g, '');
        for (const [, name, operator, quoted, plain] of attributes.matchAll(/\[([\w-]+)(\*?=)?(?:['"]([^'"]*)['"]|([^\]]*))?\]/g)) {
            if (!element.attributes.has(name)) return false;
            const expected = quoted ?? plain;
            if (operator === '=' && element.getAttribute(name) !== expected) return false;
            if (operator === '*=' && !element.getAttribute(name).includes(expected)) return false;
        }
        return true;
    });
    function node(tag, attributes = {}, parent = document.body) {
        const element = document.createElement(tag);
        Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
        element.matches = selector => matches(element, selector);
        element.hasAttribute = name => element.attributes.has(name);
        element.focus = () => {
            if (!element.isConnected || element.closest('[inert]')) return;
            const relatedTarget = document.activeElement;
            document.activeElement = element;
            document.dispatchEvent(new window.Event('focusin', { target: element, relatedTarget }));
        };
        parent.appendChild(element);
        return element;
    }
    document.documentElement.matches = selector => matches(document.documentElement, selector);
    document.documentElement.hasAttribute = name => document.documentElement.attributes.has(name);
    document.body.matches = selector => matches(document.body, selector);
    document.body.hasAttribute = name => document.body.attributes.has(name);
    node('a', { class: 'apstudy-skip-link', href: '#main' });
    const main = node('main', { id: 'main' });
    const trigger = node('button', { id: 'trigger' }, main);
    const alreadyInert = node('div', { inert: '' });
    window.getComputedStyle = element => ({ display: element.hidden ? 'none' : 'block', visibility: 'visible' });
    class Observer {
        constructor(callback) { mutation = callback; }
        observe() {}
    }
    vm.runInNewContext(source, { window, MutationObserver: Observer });
    window.APStudyCoreServices.accessibility.installAccessibility({ window, document });
    function dialog(host = node('div')) {
        const panel = node('div', { role: 'dialog', 'aria-modal': 'true' }, host);
        const control = node('button', { 'aria-label': 'Close dialog' }, panel);
        return { host, panel, control };
    }
    function removeDialog(layer) {
        if (layer.panel.contains(document.activeElement)) document.activeElement = document.body;
        layer.panel.remove();
        mutation();
    }
    return { window, document, node, main, trigger, alreadyInert, dialog, mutate: () => mutation(), removeDialog };
}

test('closing a dialog releases managed inertness before restoring its trigger', () => {
    const f = fixture();
    f.trigger.focus();
    const layer = f.dialog(); layer.control.focus(); f.mutate();
    assert.equal(f.main.hasAttribute('inert'), true);
    f.removeDialog(layer);
    assert.equal(f.main.hasAttribute('inert'), false);
    assert.equal(f.alreadyInert.hasAttribute('inert'), true);
    assert.equal(f.document.activeElement, f.trigger);
});

test('dialog content replacement retains its original trigger through repeated re-renders', () => {
    const f = fixture();
    f.trigger.focus();
    let layer = f.dialog(); layer.control.focus(); f.mutate();
    for (let i = 0; i < 2; i += 1) {
        layer.host.replaceChildren(); f.document.activeElement = f.document.body;
        layer = f.dialog(layer.host); layer.control.focus(); f.mutate();
        assert.equal(f.document.activeElement, layer.control);
    }
    f.removeDialog(layer);
    assert.equal(f.document.activeElement, f.trigger);
});

test('closing stacked dialogs restores focus within the remaining dialog before the page', () => {
    const f = fixture();
    f.trigger.focus();
    const outer = f.dialog(); outer.control.focus(); f.mutate();
    const inner = f.dialog(); inner.control.focus(); f.mutate();
    assert.equal(outer.host.hasAttribute('inert'), true);
    f.removeDialog(inner);
    assert.equal(outer.host.hasAttribute('inert'), false);
    assert.equal(f.main.hasAttribute('inert'), true);
    assert.equal(f.document.activeElement, outer.control);
    f.removeDialog(outer);
    assert.equal(f.document.activeElement, f.trigger);
});
