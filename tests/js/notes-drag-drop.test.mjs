import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(path.join(root, 'static/js/notes/list/drag-drop.js'), 'utf8');

function loadDragDrop() {
    const context = { window: {}, setTimeout };
    context.window = context;
    vm.runInNewContext(source, context);
    return context.APStudyNotesListDragDrop;
}

test('note dragging is enabled for larger tablet and laptop contexts', () => {
    const { canUseNoteDrag } = loadDragDrop();
    const tablet = {
        navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet)' },
        matchMedia: () => ({ matches: true }),
    };
    const laptop = {
        navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        matchMedia: () => ({ matches: true }),
    };

    assert.equal(canUseNoteDrag(tablet), true);
    assert.equal(canUseNoteDrag(laptop), true);
});

test('note dragging stays disabled on phone user agents even when emulated wide', () => {
    const { canUseNoteDrag } = loadDragDrop();
    const phone = {
        navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile)' },
        matchMedia: () => ({ matches: true }),
    };

    assert.equal(canUseNoteDrag(phone), false);
});
