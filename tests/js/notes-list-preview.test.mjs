import featureModules from './helpers/feature-modules.cjs';
const { loadFeatureModule } = featureModules;
import test from 'node:test';
import assert from 'node:assert/strict';

function loadUtils() {
    return loadFeatureModule('notes/list/utils.js');
}

test('notePreview prefers preview_text without parsing content', () => {
    const { notePreview } = loadUtils();
    const preview = notePreview({
        preview_text: 'From server',
        content: '[{"type":"paragraph","content":[{"text":"Ignored"}]}]',
    });
    assert.equal(preview, 'From server');
});

test('notePreview falls back to content parsing when preview_text missing', () => {
    const { notePreview } = loadUtils();
    const preview = notePreview({
        content: '[{"type":"paragraph","content":[{"text":"Legacy body"}]}]',
    });
    assert.equal(preview, 'Legacy body');
});
