import * as React from 'react';
import { blockIconClass, filterBlockCatalog } from './block-catalog.js';

/**
 * Block actions target the menu's block. The composition in editor.js owns
 * selection, current permissions, document changes, and save notifications.
 * @typedef {object} NotesBlockActions
 * @property {function(object, boolean): void} select
 * @property {function(object, object): Promise<*>} addBelow
 * @property {function(object): Promise<*>} copy
 * @property {function(object): void} duplicate
 * @property {function(object): void} remove
 * @property {function(object, string): void} move
 * @property {function(object): void} toggleHeading
 * @property {function(object, object): void} turnInto
 * @property {(item: object, anchorRect?: DOMRect|null, editor?: import('@blocknote/core').BlockNoteEditor) => Promise<*>} insertCatalogItem
 */

/** @param {{ blockActions: NotesBlockActions }} options */
export function createNotesMenuComponents({ blockActions }) {
    function materialIcon(name, className = 'material-symbols-outlined') {
        return React.createElement('span', {
            className,
            'aria-hidden': 'true',
        }, name);
    }

    function NotesSlashMenu(props) {
        const { items, selectedIndex, onItemClick } = props;
        return React.createElement(
            'div',
            { className: 'notes-slash-menu', role: 'listbox' },
            items.map((item, index) => React.createElement(
                'button',
                {
                    key: item.key || item.label,
                    type: 'button',
                    className: `notes-slash-item${index === selectedIndex ? ' is-active' : ''}`,
                    role: 'option',
                    'aria-selected': String(index === selectedIndex),
                    onMouseDown: (event) => event.preventDefault(),
                    onClick: (event) => {
                        event.stopPropagation();
                        onItemClick?.(item);
                    },
                },
                React.createElement('span', { className: blockIconClass(item.icon), 'aria-hidden': 'true' }, item.icon || ''),
                React.createElement('span', null,
                    React.createElement('strong', null, item.label),
                    React.createElement('small', null, item.description)
                )
            ))
        );
    }

    function NotesSideMenu(props) {
        const { block, blockDragStart, blockDragEnd, freezeMenu, unfreezeMenu } = props;
        const [open, setOpen] = React.useState(false);
        const [turnIntoOpen, setTurnIntoOpen] = React.useState(false);
        const toolsRef = React.useRef(null);
        const closeMenu = React.useCallback(() => {
            setTurnIntoOpen(false);
            setOpen(false);
        }, []);

        React.useEffect(() => {
            if (!open) return undefined;

            freezeMenu?.();
            const handlePointerDown = (event) => {
                if (toolsRef.current?.contains(event.target)) return;
                closeMenu();
            };
            const handleKeyDown = (event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                closeMenu();
            };
            document.addEventListener('pointerdown', handlePointerDown);
            document.addEventListener('keydown', handleKeyDown);

            return () => {
                document.removeEventListener('pointerdown', handlePointerDown);
                document.removeEventListener('keydown', handleKeyDown);
                unfreezeMenu?.();
            };
        }, [closeMenu, freezeMenu, open, unfreezeMenu]);

        const select = (event) => {
            event.preventDefault();
            blockActions.select(block, event.shiftKey);
        };
        const addBelow = async (event) => {
            event.preventDefault();
            await blockActions.addBelow(block, event.currentTarget.getBoundingClientRect());
        };
        const duplicate = () => {
            blockActions.duplicate(block);
            closeMenu();
        };
        const remove = () => {
            blockActions.remove(block);
            closeMenu();
        };
        const turnIntoItems = filterBlockCatalog('', { includeAtoms: false, turnIntoOnly: true });
        const turnIntoMenu = turnIntoOpen ? React.createElement(
            'div',
            { className: 'notes-side-submenu' },
            turnIntoItems.map((item) => React.createElement(
                'button',
                {
                    key: item.key,
                    type: 'button',
                    onClick: () => {
                        blockActions.turnInto(block, item);
                        closeMenu();
                    },
                },
                React.createElement('span', { className: blockIconClass(item.icon), 'aria-hidden': 'true' }, item.icon || ''),
                React.createElement('span', null, item.label)
            ))
        ) : null;
        return React.createElement(
            'div',
            {
                ref: toolsRef,
                className: 'notes-side-tools',
                onClick: (event) => event.stopPropagation(),
            },
            React.createElement('button', {
                type: 'button',
                className: 'notes-side-button',
                title: 'Add block below',
                'aria-label': 'Add block below',
                onMouseDown: (event) => event.preventDefault(),
                onClick: addBelow,
            }, materialIcon('add')),
            React.createElement('button', {
                type: 'button',
                className: 'notes-side-button notes-block-select-handle',
                title: 'Select block',
                'aria-label': 'Select block',
                draggable: true,
                onDragStart: (event) => blockDragStart?.(event, block),
                onDragEnd: blockDragEnd,
                onClick: select,
            }, materialIcon('drag_indicator')),
            React.createElement('button', {
                type: 'button',
                className: 'notes-side-button',
                title: 'Block actions',
                'aria-label': 'Block actions',
                'aria-expanded': String(open),
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                    if (open) {
                        closeMenu();
                    } else {
                        setOpen(true);
                    }
                },
            }, materialIcon('more_vert')),
            open ? React.createElement(
            'div',
            {
                className: 'notes-side-menu',
                onMouseDown: (event) => event.preventDefault(),
            },
                React.createElement('button', { type: 'button', onClick: () => { void blockActions.copy(block); closeMenu(); } }, materialIcon('content_copy'), React.createElement('span', null, 'Copy')),
                React.createElement('button', { type: 'button', 'aria-expanded': String(turnIntoOpen), onClick: () => setTurnIntoOpen(!turnIntoOpen) }, materialIcon('swap_vert'), React.createElement('span', null, 'Turn into')),
                turnIntoMenu,
                React.createElement('button', { type: 'button', onClick: duplicate }, materialIcon('content_copy'), React.createElement('span', null, 'Duplicate')),
                React.createElement('button', { type: 'button', onClick: () => { blockActions.move(block, 'up'); closeMenu(); } }, materialIcon('arrow_upward'), React.createElement('span', null, 'Move up')),
                React.createElement('button', { type: 'button', onClick: () => { blockActions.move(block, 'down'); closeMenu(); } }, materialIcon('arrow_downward'), React.createElement('span', null, 'Move down')),
                block.type === 'heading'
                    ? React.createElement('button', { type: 'button', onClick: () => { blockActions.toggleHeading(block); closeMenu(); } }, materialIcon(block.props?.isCollapsed ? 'unfold_more' : 'unfold_less'), React.createElement('span', null, 'Collapse'))
                    : null,
                React.createElement('button', { type: 'button', className: 'is-danger', onClick: remove }, materialIcon('delete'), React.createElement('span', null, 'Delete'))
            ) : null
        );
    }

    async function getSlashItems(query, editor) {
        return filterBlockCatalog(query).map((item) => ({
            ...item,
            onItemClick: () => blockActions.insertCatalogItem(item, null, editor),
        }));
    }

    return { NotesSlashMenu, NotesSideMenu, getSlashItems };
}
