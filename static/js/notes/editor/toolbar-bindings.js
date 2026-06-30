import {
    editorState,
    pageSetupPopover,
    writingToolbar,
} from './runtime.js';
import {
    applyTextAlignment,
    closePageSetupDropdowns,
    closePageSetupPopover,
    openPageSetupPopover,
    setZoomIndex,
    updateCurrentPageSetup,
    updatePageSetupControls,
} from './page-setup.js';
import {
    closeToolbarMenus,
    createToolbarOverflowController,
    filterAddBlockMenu,
    openToolbarMenu,
    setActiveAddBlockItem,
    visibleAddBlockItems,
} from './toolbar-menus.js';
import {
    applyLinkFromMenu,
    focusEditorBody,
    insertBlockFromMenu,
    runHistoryAction,
    runIndentAction,
    setSelectedBlocks,
    toggleBasicStyle,
} from './editing.js';

export function bindWritingToolbar() {
    if (!writingToolbar) return;
    writingToolbar.hidden = false;
    editorState.toolbarOverflowController?.disconnect();
    editorState.toolbarOverflowController = createToolbarOverflowController(writingToolbar);

    writingToolbar.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-toolbar-menu-close]');
        if (closeButton) {
            event.preventDefault();
            closeToolbarMenus();
            return;
        }

        const menuTrigger = event.target.closest('[data-toolbar-menu-trigger]');
        if (menuTrigger && writingToolbar.contains(menuTrigger)) {
            event.preventDefault();
            openToolbarMenu(menuTrigger.dataset.toolbarMenuTrigger, menuTrigger);
            return;
        }

        const actionButton = event.target.closest('button[data-editor-action]');
        if (!actionButton || !writingToolbar.contains(actionButton)) return;
        event.preventDefault();

        const action = actionButton.dataset.editorAction;
        if (action === 'page-setup') {
            openPageSetupPopover(actionButton);
        } else if (action === 'focus-body') {
            focusEditorBody();
        } else if (action === 'insert-block') {
            insertBlockFromMenu(actionButton);
        } else if (action === 'undo' || action === 'redo') {
            runHistoryAction(action);
        } else if (action === 'zoom-out') {
            setZoomIndex(editorState.zoomIndex - 1);
        } else if (action === 'zoom-in') {
            setZoomIndex(editorState.zoomIndex + 1);
        } else if (action === 'basic-style') {
            toggleBasicStyle(actionButton.dataset.style);
        } else if (action === 'set-block') {
            const blockType = actionButton.dataset.blockType;
            const level = Number(actionButton.dataset.level);
            setSelectedBlocks(blockType, blockType === 'heading' ? { level: level || 1 } : undefined);
            closeToolbarMenus();
        } else if (action === 'align') {
            applyTextAlignment(actionButton.dataset.align || 'left');
            closeToolbarMenus();
        } else if (action === 'indent' || action === 'outdent') {
            runIndentAction(action);
        }
    });

    writingToolbar.addEventListener('input', (event) => {
        const input = event.target.closest('[data-add-block-search]');
        if (!input) return;
        filterAddBlockMenu(input.closest('[data-toolbar-menu="add-block"]'));
    });

    writingToolbar.addEventListener('keydown', (event) => {
        const menu = event.target.closest('[data-toolbar-menu="add-block"]');
        if (!menu || menu.hidden) return;
        const items = visibleAddBlockItems(menu);
        if (!items.length) return;

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveAddBlockItem(menu, editorState.addBlockActiveIndex + 1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveAddBlockItem(menu, editorState.addBlockActiveIndex - 1);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            insertBlockFromMenu(items[editorState.addBlockActiveIndex] || items[0]);
        }
    });

    writingToolbar.addEventListener('submit', (event) => {
        const menu = event.target.closest('[data-toolbar-menu="link"]');
        if (!menu) return;
        event.preventDefault();
        applyLinkFromMenu(menu);
    });

    document.addEventListener('click', (event) => {
        if (editorState.activeToolbarMenu && !writingToolbar.contains(event.target)) {
            closeToolbarMenus();
        }
        if (!pageSetupPopover || pageSetupPopover.hidden) return;
        const trigger = writingToolbar.querySelector('[data-editor-action="page-setup"]');
        if (pageSetupPopover.contains(event.target) || trigger?.contains(event.target)) return;
        closePageSetupDropdowns();
        closePageSetupPopover();
    });

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (editorState.activeToolbarMenu) closeToolbarMenus();
        if (pageSetupPopover && !pageSetupPopover.hidden) closePageSetupPopover();
    });

    pageSetupPopover?.addEventListener('click', (event) => {
        const closeButton = event.target.closest('[data-page-setup-close]');
        if (closeButton) {
            event.preventDefault();
            closePageSetupPopover();
            return;
        }

        const dropdownTrigger = event.target.closest('[data-page-setup-dropdown-trigger]');
        if (dropdownTrigger) {
            event.preventDefault();
            const dropdown = dropdownTrigger.closest('[data-page-setup-dropdown]');
            const menu = dropdown?.querySelector('[data-page-setup-options]');
            const opening = menu?.hasAttribute('hidden');
            closePageSetupDropdowns(dropdown);
            if (!menu) return;
            menu.toggleAttribute('hidden', !opening);
            dropdownTrigger.setAttribute('aria-expanded', String(opening));
            return;
        }

        const scopeOption = event.target.closest('[data-page-setup-scope-option]');
        if (scopeOption) {
            event.preventDefault();
            editorState.pageSetupScope = scopeOption.dataset.pageSetupScopeOption === 'global' ? 'global' : 'note';
            closePageSetupDropdowns();
            updatePageSetupControls();
            return;
        }

        const setupOption = event.target.closest('[data-page-setup-option]');
        if (!setupOption) return;
        event.preventDefault();
        const field = setupOption.dataset.pageSetupOption;
        const input = pageSetupPopover.querySelector(`[data-page-setup-input="${field}"]`);
        if (!field || !input) return;
        input.value = setupOption.dataset.value || '';
        closePageSetupDropdowns();
        updateCurrentPageSetup(input.dataset.pageSetupInput, input.value);
    });

    pageSetupPopover?.addEventListener('input', (event) => {
        const input = event.target.closest('[data-page-setup-input="sideMargins"]');
        if (!input) return;
        updateCurrentPageSetup('sideMargins', input.value);
    });

    editorState.toolbarOverflowController?.refresh();
}
