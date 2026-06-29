import { getBlockInfoFromSelection } from '@blocknote/core';
import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { insertListHardBreak } from './keyboard-shortcuts-helpers.js';

export const preserveRangeSelectionShortcuts = Extension.create({
    name: 'preserveRangeSelectionShortcuts',
    priority: 1000,
    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    handleDOMEvents: {
                        keydown(view, event) {
                            const isRangeVerticalArrow = event.shiftKey
                                && (event.metaKey || event.ctrlKey)
                                && !event.altKey
                                && (event.key === 'ArrowUp' || event.key === 'ArrowDown');
                            if (!isRangeVerticalArrow) return false;
                            return true;
                        },
                    },
                },
            }),
        ];
    },
});

export const listItemHardBreakShortcuts = Extension.create({
    name: 'listItemHardBreakShortcuts',
    priority: 1100,
    addKeyboardShortcuts() {
        return {
            'Shift-Enter': () => {
                let blockType;
                try {
                    blockType = getBlockInfoFromSelection(this.editor.state).blockNoteType;
                } catch (error) {
                    return false;
                }
                return insertListHardBreak(
                    this.editor.state,
                    blockType,
                    (transaction) => this.editor.view.dispatch(transaction),
                );
            },
        };
    },
});
