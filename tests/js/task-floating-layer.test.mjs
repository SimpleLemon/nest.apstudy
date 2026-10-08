import assert from 'node:assert/strict';
import test from 'node:test';
import { createHooks, findElements, loadTaskModule } from './helpers/tasks-app.mjs';

function eventHost() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(type, callback, capture = false) {
            const entries = listeners.get(type) || [];
            entries.push({ callback, capture }); listeners.set(type, entries);
        },
        removeEventListener(type, callback, capture = false) {
            listeners.set(type, (listeners.get(type) || []).filter((entry) => entry.callback !== callback || entry.capture !== capture));
        },
        emit(type, event = {}) { for (const entry of [...(listeners.get(type) || [])]) entry.callback(event); },
        count(type) { return (listeners.get(type) || []).length; },
    };
}

async function withControl(name, props, run) {
    const saved = new Map(['window', 'document', 'ResizeObserver', '__taskHooks'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const hooks = createHooks();
    const window = Object.assign(eventHost(), { innerWidth: 390, innerHeight: 844, visualViewport: eventHost() });
    const document = Object.assign(eventHost(), { body: {}, documentElement: { clientWidth: 390, clientHeight: 844 } });
    const observers = [];
    const focus = [];
    class ResizeObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(node) { this.node = node; }
        disconnect() { this.disconnected = true; }
    }
    const nodes = new Map();
    const anchor = { top: 100, right: 260, bottom: 140, left: 100, width: 160 };
    let tree;
    Object.assign(globalThis, { window, document, ResizeObserver, __taskHooks: hooks });
    try {
        const Component = (await loadTaskModule('task-form-controls.js'))[name];
        const renderOnce = () => {
            hooks.begin(); tree = Component(props);
            for (const element of findElements(tree, (element) => element.props?.ref)) {
                const ref = element.props.ref;
                if (!nodes.has(ref)) nodes.set(ref, {
                    style: {},
                    getBoundingClientRect() { return element.props.role === 'combobox' || element.type === 'button' ? anchor : { width: parseFloat(this.style.width), height: 200 }; },
                    querySelector(selector) { return { focus: () => focus.push(selector) }; },
                    focus: () => focus.push('trigger'),
                });
                ref.current = nodes.get(ref);
            }
            hooks.commit();
        };
        const flush = () => { for (let pass = 0; hooks.dirty && pass < 10; pass++) renderOnce(); };
        const find = (predicate) => findElements(tree, predicate)[0];
        const trigger = () => find((element) => element.props.ref && element.type === 'button');
        const layer = () => find((element) => element.props['data-task-floating-layer']);
        const open = () => { trigger().props.onClick(); flush(); };
        flush();
        await run({ window, document, observers, anchor, focus, open, flush, trigger, layer, find,
            change(next) { props = { ...props, ...next }; renderOnce(); flush(); },
            dispose: () => hooks.dispose(),
        });
    } finally {
        hooks.dispose();
        for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key];
    }
}

for (const name of ['TaskListbox', 'TaskDatePicker']) {
    test(`${name} shares floating subscriptions, keeps sizing, and releases close/unmount resources`, async () => {
        await withControl(name, { value: '2026-10-06', options: [{ value: '2026-10-06', label: 'One' }], onChange() {}, label: 'Control' }, async (view) => {
            assert.equal(view.document.count('pointerdown'), 0);
            view.open();
            const { window, document, observers } = view;
            assert.equal(view.layer().props.style.width, name === 'TaskListbox' ? '190px' : '318px');
            assert.equal(view.layer().props.style.visibility, 'visible');
            assert.equal(view.layer().props.style.top, '145px');
            assert.equal(document.count('pointerdown'), 1);
            assert.equal(window.count('scroll'), 1);
            assert.equal(window.listeners.get('scroll')[0].capture, true);
            assert.equal(window.count('resize'), 1);
            assert.equal(window.visualViewport.count('resize'), 1);
            assert.equal(observers[0].node, view.layer().props.ref.current);
            if (name === 'TaskListbox') assert.ok(view.focus.includes('[data-option-index="0"]'));
            document.emit('pointerdown', { composedPath: () => [view.trigger().props.ref.current, view.find((element) => element.props.ref && element.type === 'div' && !element.props['data-task-floating-layer']).props.ref.current] }); view.flush();
            assert.ok(view.layer(), 'inside trigger keeps the layer open');
            document.emit('pointerdown', { composedPath: () => [view.layer().props.ref.current] }); view.flush();
            assert.ok(view.layer(), 'portal layer keeps itself open');
            window.innerWidth = 250; window.emit('resize'); view.flush();
            assert.equal(view.layer().props.style.width, name === 'TaskListbox' ? '190px' : '230px');
            view.anchor.width = 240; window.emit('scroll'); view.flush();
            assert.equal(view.layer().props.style.width, '230px');
            view.anchor.bottom = 180; window.visualViewport.emit('resize'); view.flush();
            assert.equal(view.layer().props.style.top, '185px');
            view.anchor.bottom = 190; observers.at(-1).callback(); view.flush();
            assert.equal(view.layer().props.style.top, '195px');
            view.anchor.bottom = 200;
            if (name === 'TaskListbox') view.change({ options: [{ value: '2026-10-06', label: 'One' }, { value: 'two', label: 'Two' }], value: 'two' });
            else view.change({ value: '2026-10-07' });
            assert.equal(view.layer().props.style.top, '205px', 'content dependency repositions');
            assert.equal(observers[0].disconnected, true);
            assert.equal(document.count('pointerdown'), 1, 'dependency update replaces subscriptions');
            document.emit('pointerdown', { composedPath: () => [{}] }); view.flush();
            assert.equal(view.layer(), undefined);
            assert.equal(document.count('pointerdown'), 0);
            assert.equal(window.count('scroll'), 0);
            assert.equal(window.count('resize'), 0);
            assert.equal(window.visualViewport.count('resize'), 0);
            assert.equal(observers.at(-1).disconnected, true);
            view.open();
            window.innerWidth = 10; window.emit('resize'); view.flush();
            assert.equal(view.layer().props.style.width, name === 'TaskListbox' ? '1px' : '0px');
            view.dispose();
            assert.equal(document.count('pointerdown'), 0);
            assert.equal(window.count('resize'), 0);
            assert.equal(observers.at(-1).disconnected, true);
        });
    });
}
