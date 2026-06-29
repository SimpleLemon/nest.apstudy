import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function importPrintModule() {
    const source = await readFile(path.join(repoRoot, 'static/js/notes/editor/print.js'), 'utf8');
    const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
    return import(url);
}

test('print title and keyboard shortcut helpers are conservative', async () => {
    const { isNotePrintShortcut, normalizePrintTitle } = await importPrintModule();

    assert.equal(normalizePrintTitle('  Lab notes  '), 'Lab notes');
    assert.equal(normalizePrintTitle('   '), 'Untitled');
    assert.equal(isNotePrintShortcut({ key: 'p', metaKey: true }), true);
    assert.equal(isNotePrintShortcut({ key: 'P', ctrlKey: true }), true);
    assert.equal(isNotePrintShortcut({ key: 'p', ctrlKey: true, shiftKey: true }), false);
    assert.equal(isNotePrintShortcut({ key: 'p', ctrlKey: true, defaultPrevented: true }), false);
});

test('printable blocks match collapsed visibility and simplify media', async () => {
    const { printableBlocksForCurrentView } = await importPrintModule();
    const blocks = [
        { id: 'heading', type: 'heading', props: { level: 1, isCollapsed: true }, content: [{ type: 'text', text: 'Visible', styles: {} }] },
        { id: 'hidden', type: 'paragraph', content: [{ type: 'text', text: 'Hidden', styles: {} }] },
        { id: 'bookmark', type: 'bookmark', props: { url: 'https://example.com/read', title: 'Reading' } },
        { id: 'video', type: 'video', props: { url: 'https://example.com/video', name: 'Lecture' } },
        { id: 'empty-image', type: 'image', props: { url: '' } },
        { id: 'image', type: 'image', props: { url: 'https://example.com/image.png', caption: 'Diagram' } },
        {
            id: 'parent',
            type: 'paragraph',
            content: [{ type: 'text', text: 'Parent', styles: {} }],
            children: [
                { id: 'nested-hidden', type: 'paragraph', content: [{ type: 'text', text: 'Nested hidden', styles: {} }] },
                { id: 'nested-visible', type: 'paragraph', content: [{ type: 'text', text: 'Nested visible', styles: {} }] },
            ],
        },
    ];

    const printable = printableBlocksForCurrentView(blocks, ['hidden', 'nested-hidden']);

    assert.deepEqual(printable.map((block) => block.id || block.type), [
        'heading',
        'paragraph',
        'paragraph',
        'image',
        'parent',
    ]);
    assert.equal(printable[1].content[0].href, 'https://example.com/read');
    assert.equal(printable[1].content[0].content[0].text, 'Reading');
    assert.equal(printable[2].content[0].content[0].text, 'Video: Lecture');
    assert.deepEqual(printable[4].children.map((block) => block.id), ['nested-visible']);
});

test('print palettes use paper-safe contrast colors', async () => {
    const { printColorFor } = await importPrintModule();

    assert.equal(printColorFor('yellow'), '#854d0e');
    assert.equal(printColorFor('yellow', { highlight: true }), '#fef3c7');
    assert.equal(printColorFor('default'), '');
});

test('failed print images receive a useful link fallback', async () => {
    const { waitForPrintableImages } = await importPrintModule();
    let replacement = null;
    const ownerDocument = {
        createElement(tagName) {
            return { tagName, className: '', textContent: '', href: '', rel: '' };
        },
    };
    const image = {
        complete: true,
        naturalWidth: 0,
        alt: 'Course diagram',
        src: 'https://example.com/diagram.png',
        ownerDocument,
        replaceWith(value) { replacement = value; },
    };

    await waitForPrintableImages({ querySelectorAll: () => [image] });

    assert.equal(replacement.tagName, 'a');
    assert.equal(replacement.href, 'https://example.com/diagram.png');
    assert.equal(replacement.textContent, 'Image: Course diagram');
});

function fakeElement(tagName, documentRef) {
    return {
        tagName: tagName.toUpperCase(),
        ownerDocument: documentRef,
        className: '',
        textContent: '',
        innerHTML: '',
        attributes: [],
        children: [],
        style: { setProperty() {} },
        setAttribute() {},
        removeAttribute() {},
        querySelectorAll() { return []; },
        append(...children) { this.children.push(...children); },
        remove() {
            const index = documentRef.body.children.indexOf(this);
            if (index >= 0) documentRef.body.children.splice(index, 1);
        },
    };
}

test('print lifecycle restores the document title and cleans up after printing', async () => {
    const { printNote } = await importPrintModule();
    const classes = new Set();
    const documentRef = {
        title: 'Note Editor - APStudy Nest',
        createElement(tagName) { return fakeElement(tagName, documentRef); },
        body: {
            children: [],
            append(element) { this.children.push(element); },
            classList: {
                add(value) { classes.add(value); },
                remove(value) { classes.delete(value); },
            },
        },
    };
    const listeners = new Map();
    let printedTitle = '';
    const windowRef = {
        addEventListener(type, handler) { listeners.set(type, handler); },
        removeEventListener(type, handler) {
            if (listeners.get(type) === handler) listeners.delete(type);
        },
        requestAnimationFrame(callback) { callback(); },
        setTimeout,
        clearTimeout,
        print() { printedTitle = documentRef.title; },
    };
    const editor = {
        async blocksToHTMLLossy() { return '<p>Current unsaved text</p>'; },
    };

    await printNote({
        editor,
        blocks: [{ id: 'one', type: 'paragraph' }],
        title: '  Current title  ',
        fontFamily: 'Georgia, serif',
        sideMargins: 12,
        documentRef,
        windowRef,
    });

    assert.equal(printedTitle, 'Current title');
    assert.equal(documentRef.title, 'Note Editor - APStudy Nest');
    assert.equal(documentRef.body.children.length, 1);
    assert.equal(classes.has('notes-print-prepared'), true);

    listeners.get('afterprint')();
    assert.equal(documentRef.body.children.length, 0);
    assert.equal(classes.has('notes-print-prepared'), false);
});
