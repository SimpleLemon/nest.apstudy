import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness, FakeElement } from './helpers/notes-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('toolbar labels, icons and template checks match every turn-into catalog block', () => {
    const h = createHarness();
    const catalog = h.load('block-catalog.js', ['BLOCK_CATALOG', 'FONT_SIZE_PRESETS', 'FORMAT_COLORS', 'blockIconClass', 'filterBlockCatalog']);
    Object.assign(h.context, catalog);
    const { createToolbarDom } = h.load('toolbar-dom.js', ['createToolbarDom']);
    const toolbar = new FakeElement();
    const blockLabel = new FakeElement();
    const blockIcon = new FakeElement();
    const listIcon = new FakeElement();
    toolbar.selectors.set('[data-current-block-label]', [blockLabel]);
    toolbar.selectors.set('[data-current-block-icon]', [blockIcon]);
    toolbar.selectors.set('[data-current-list-icon]', [listIcon]);
    const template = fs.readFileSync(path.join(root, 'templates/notes_editor.html'), 'utf8');
    const checkKeys = [...template.matchAll(/data-menu-check="([^"]+)"/g)].map((match) => match[1]);
    const checks = checkKeys.map((key) => new FakeElement({ menuCheck: key }));
    toolbar.selectors.set('[data-menu-check]', checks);
    let block;
    const runtime = createToolbarDom({
        writingToolbar: toolbar,
        getEditor: () => ({ getActiveStyles: () => ({}) }),
        getSelectedBlocks: () => [block], getSelectedTextAlignment: () => 'left',
        isBlockStyleSelected: (selected, option) => selected?.type === option.type
            && Object.entries(option.props || {}).every(([key, value]) => selected.props?.[key] === value),
    });
    for (const item of catalog.BLOCK_CATALOG.filter((item) => item.turnInto)) {
        block = { type: item.type, props: { ...item.props, isCollapsed: true, checked: true, tone: 'warning', icon: 'info' } };
        runtime.updateToolbarState();
        const key = item.type === 'heading' ? item.key : item.type;
        const check = checks.find((node) => node.dataset.menuCheck === key);
        assert.ok(check, `template exposes check for ${key}`);
        assert.equal(check.attributes.get('aria-checked'), 'true', `${key} is selected despite creation-only properties`);
        if (item.group === 'Lists') assert.equal(listIcon.textContent, item.icon);
        else {
            assert.equal(blockLabel.textContent, item.label);
            assert.equal(blockIcon.textContent, item.icon);
        }
    }
});
