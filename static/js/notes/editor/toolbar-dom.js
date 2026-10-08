import {
    BLOCK_CATALOG,
    FONT_SIZE_PRESETS,
    FORMAT_COLORS,
    blockIconClass,
    filterBlockCatalog,
} from './block-catalog.js';
import { claimElementBinding, handlePageSetupToolbarClick, positionFloatingElement } from './utils.js';

export function createToolbarDom({
    writingToolbar,
    pageSetupPopover,
    editorPage,
    getCanEdit,
    getEditor,
    getSelectedBlocks,
    getSelectedTextAlignment,
    isBlockStyleSelected,
    canRunHistoryAction,
    canRunIndentAction,
    getZoomIndex,
    getZoomLevels,
    pageSetup,
    actions,
}) {
    let activeToolbarMenu = null;
    let toolbarOverflowController = null;
    let addBlockActiveIndex = 0;

    // Paired history/indent commands share their existing action-aware owners.
    const historyCommand = {
        run: (data, button, action) => actions.runHistoryAction(action),
        disabled: (state, action) => !canRunHistoryAction(action),
    };
    const indentCommand = {
        run: (data, button, action) => actions.runIndentAction(action),
        disabled: (state, action) => !canRunIndentAction(action),
    };
    // Each command owns its execution, selection state and menu behavior.
    const commands = {
        'focus-body': { run: () => actions.focusEditorBody() },
        'insert-block': { run: (data, button) => actions.insertBlockFromMenu(button) },
        undo: historyCommand,
        redo: historyCommand,
        'zoom-out': { run: () => pageSetup?.setZoomIndex(getZoomIndex() - 1), disabled: () => getZoomIndex() === 0 },
        'zoom-in': { run: () => pageSetup?.setZoomIndex(getZoomIndex() + 1), disabled: () => getZoomIndex() === getZoomLevels().length - 1 },
        'basic-style': { run: (data) => actions.toggleBasicStyle(data.style), active: (data, state) => Boolean(state.styles?.[data.style]), pressed: true },
        'text-color': { run: (data) => actions.applyTextColor(data.color || 'default'), active: (data, state) => (state.styles?.textColor || 'default') === data.color, close: true },
        'highlight-color': { run: (data) => actions.applyHighlightColor(data.color || 'default'), active: (data, state) => (state.styles?.backgroundColor || 'default') === data.color, close: true },
        'font-size': { run: (data) => actions.applyFontSizePreset(data.fontSize || 'default'), active: (data, state) => state.fontPreset.value === data.fontSize, close: true },
        'remove-link': { run: () => actions.removeSelectedLink() },
        'set-block': {
            run: (data) => actions.setSelectedBlockType(data.blockType, data.blockType === 'heading' ? { level: Number(data.level) || 1 } : undefined),
            active: (data, state) => state.block?.type === data.blockType && (data.blockType !== 'heading' || Number(state.block?.props?.level) === Number(data.level)),
            close: true,
        },
        align: { run: (data) => actions.applyTextAlignment(data.align || 'left'), active: (data, state) => data.align === state.alignment, close: true },
        indent: indentCommand,
        outdent: indentCommand,
        'copy-blocks': { run: () => actions.copySelectedBlocks(), disabled: noBlocks, close: true },
        'cut-blocks': { run: () => actions.copySelectedBlocks({ cut: true }), disabled: noBlocks, close: true },
        'duplicate-blocks': { run: () => actions.duplicateSelectedBlocks(), disabled: noBlocks, close: true },
        'delete-blocks': { run: () => actions.deleteSelectedBlocks(), disabled: noBlocks, close: true },
        'move-blocks-up': { run: () => actions.moveSelectedBlocks('up'), disabled: noBlocks, close: true },
        'move-blocks-down': { run: () => actions.moveSelectedBlocks('down'), disabled: noBlocks, close: true },
        'toggle-heading-collapse': { run: () => actions.toggleHeadingCollapse(), disabled: (state) => state.block?.type !== 'heading', close: true },
    };

    function noBlocks(state) { return state.blocks.length === 0; }

    function executeCommand(action, button) {
        const command = commands[action];
        if (!command || !getCanEdit()) return;
        const blocks = getSelectedBlocks();
        if (command.disabled?.({ blocks, block: blocks[0] }, action)) return;
        command.run(button?.dataset || {}, button, action);
        if (command.close) closeToolbarMenus();
    }

    function closeToolbarMenus() {
        if (!writingToolbar) return;
        activeToolbarMenu = null;
        writingToolbar.querySelectorAll('[data-toolbar-menu]').forEach((menu) => {
            menu.hidden = true;
        });
        writingToolbar.querySelectorAll('[data-toolbar-menu-trigger]').forEach((trigger) => {
            trigger.setAttribute('aria-expanded', 'false');
        });
    }

    function positionToolbarMenu(trigger, menu, triggerRectOverride = null) {
        if (!trigger || !menu) return;
        const triggerRect = triggerRectOverride || trigger.getBoundingClientRect();
        const isOverflowToolbar = menu.classList.contains('notes-toolbar-overflow-menu');
        menu.style.minWidth = isOverflowToolbar ? '0px' : `${Math.max(triggerRect.width, 150)}px`;

        const editorRect = editorPage?.getBoundingClientRect();
        menu.style.maxWidth = isOverflowToolbar
            ? `${Math.max(0, Math.min(window.innerWidth, editorRect?.width || window.innerWidth) - 16)}px`
            : '';
        positionFloatingElement(trigger, menu, {
            triggerRectOverride: triggerRect,
            boundaryRect: editorRect,
        });
    }

    function renderFontSizeMenu(menu) {
        if (!menu || menu.dataset.rendered === 'font-size') return;
        menu.dataset.rendered = 'font-size';
        menu.innerHTML = FONT_SIZE_PRESETS.map((item) => `
        <button type="button" class="notes-toolbar-menu-item" data-editor-action="font-size" data-font-size="${item.value}" data-menu-check="font-size-${item.value}">
            <span class="material-symbols-outlined" aria-hidden="true">format_size</span>
            <span>${item.label}</span>
        </button>
    `).join('');
    }

    function renderColorMenu(menu, style) {
        if (!menu || menu.dataset.rendered === style) return;
        menu.dataset.rendered = style;
        const action = style === 'backgroundColor' ? 'highlight-color' : 'text-color';
        menu.innerHTML = FORMAT_COLORS.map((item) => `
        <button type="button" class="notes-toolbar-menu-item notes-color-menu-item" data-editor-action="${action}" data-color="${item.value}" data-menu-check="${action}-${item.value}">
            <span class="notes-format-swatch" data-${style === 'backgroundColor' ? 'background' : 'text'}-color="${item.value}" aria-hidden="true"></span>
            <span>${item.label}</span>
        </button>
    `).join('');
    }

    function visibleAddBlockItems(menu) {
        return Array.from(menu?.querySelectorAll('.notes-add-block-item:not([hidden])') || []);
    }

    function setActiveAddBlockItem(menu, index) {
        const items = visibleAddBlockItems(menu);
        if (!items.length) return;
        addBlockActiveIndex = Math.min(items.length - 1, Math.max(0, index));
        items.forEach((item, itemIndex) => {
            const active = itemIndex === addBlockActiveIndex;
            item.classList.toggle('is-active', active);
            item.setAttribute('aria-selected', String(active));
            if (active) item.scrollIntoView({ block: 'nearest' });
        });
    }

    function filterAddBlockMenu(menu) {
        const input = menu?.querySelector('[data-add-block-search]');
        const query = (input?.value || '').trim().toLowerCase();
        const items = filterBlockCatalog(query);
        const visibleKeys = new Set(items.map((item) => item.key));
        menu?.querySelectorAll('.notes-add-block-item').forEach((item) => {
            item.hidden = !visibleKeys.has(item.dataset.blockKey);
        });
        setActiveAddBlockItem(menu, 0);
    }

    function renderAddBlockMenu(menu) {
        const list = menu?.querySelector('[data-add-block-list]');
        if (!list || list.dataset.rendered === 'catalog') return;
        list.dataset.rendered = 'catalog';
        list.innerHTML = BLOCK_CATALOG.map((item) => `
        <button type="button" class="notes-add-block-item" data-editor-action="insert-block" data-block-key="${item.key}" data-block-type="${item.type}">
            <span class="${blockIconClass(item.icon)}" aria-hidden="true">${item.icon || ''}</span>
            <span><strong>${item.label}</strong><small>${item.description}</small></span>
        </button>
    `).join('');
    }

    function prepareAddBlockMenu(menu) {
        renderAddBlockMenu(menu);
        const input = menu?.querySelector('[data-add-block-search]');
        if (input) {
            input.value = '';
            window.setTimeout(() => input.focus(), 0);
        }
        filterAddBlockMenu(menu);
    }

    function openToolbarMenu(name, trigger) {
        if (!writingToolbar) return;
        const menu = writingToolbar.querySelector(`[data-toolbar-menu="${name}"]`);
        if (!menu) return;

        const openingSameMenu = activeToolbarMenu === name && !menu.hidden;
        const triggerRect = trigger?.getBoundingClientRect() || null;
        pageSetup?.closePageSetupPopover?.();
        closeToolbarMenus();
        if (openingSameMenu) return;

        activeToolbarMenu = name;
        menu.hidden = false;
        trigger?.setAttribute('aria-expanded', 'true');

        if (name === 'link') {
            const input = menu.querySelector('[data-link-url]');
            if (input) {
                input.value = getEditor()?.getSelectedLinkUrl?.() || '';
                window.setTimeout(() => input.focus(), 0);
            }
        } else if (name === 'add-block') {
            prepareAddBlockMenu(menu);
        } else if (name === 'font-size') {
            renderFontSizeMenu(menu);
        } else if (name === 'text-color' || name === 'highlight-color') {
            renderColorMenu(menu, name === 'highlight-color' ? 'backgroundColor' : 'textColor');
        }

        positionToolbarMenu(trigger, menu, triggerRect);
    }

    function createToolbarOverflowController(toolbar) {
        const main = toolbar?.querySelector('[data-toolbar-main]');
        const more = toolbar?.querySelector('[data-toolbar-more]');
        const menu = toolbar?.querySelector('[data-toolbar-menu="overflow"]');
        if (!main || !more || !menu) return null;

        const items = Array.from(main.querySelectorAll('[data-toolbar-item]')).map((element, index) => ({
            element,
            index,
            priority: Number(element.dataset.overflowPriority || 100),
        }));

        const restoreItems = () => {
            items
                .slice()
                .sort((a, b) => a.index - b.index)
                .forEach(({ element }) => {
                    main.insertBefore(element, more);
                });
        };

        const refresh = () => {
            restoreItems();
            more.hidden = true;
            menu.hidden = true;
            closeToolbarMenus();

            window.requestAnimationFrame(() => {
                restoreItems();
                const moved = [];
                const ordered = items.slice().sort((a, b) => b.priority - a.priority || b.index - a.index);

                more.hidden = false;
                for (const item of ordered) {
                    if (main.scrollWidth <= main.clientWidth + 1) break;
                    menu.insertBefore(item.element, menu.firstChild);
                    moved.push(item);
                }

                more.hidden = moved.length === 0;
                if (!moved.length) menu.hidden = true;
            });
        };

        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(refresh) : null;
        observer?.observe(main);
        window.addEventListener('resize', refresh);

        return {
            refresh,
            disconnect() {
                observer?.disconnect();
                window.removeEventListener('resize', refresh);
            },
        };
    }

    function updateToolbarState() {
        if (!writingToolbar || !getEditor()) return;
        const blocks = getSelectedBlocks();
        const block = blocks[0];
        const activeStyles = typeof getEditor().getActiveStyles === 'function'
            ? getEditor().getActiveStyles()
            : {};
        const activeFontPreset = FONT_SIZE_PRESETS.find((item) => item.cssValue && item.cssValue === activeStyles?.fontSize) || FONT_SIZE_PRESETS[0];
        const blockStyleOptions = BLOCK_CATALOG.filter((item) => item.turnInto).map((item) => ({
            ...item,
            // Existing template checks use block types except for numbered headings.
            key: item.type === 'heading' ? item.key : item.type,
            // Selection ignores catalog creation defaults such as checked/collapsed state.
            props: item.type === 'heading' ? { level: item.props.level } : undefined,
        }));
        const textBlockOptions = blockStyleOptions.filter((item) => item.group !== 'Lists');
        const listStyleOptions = blockStyleOptions.filter((item) => item.group === 'Lists');
        const activeBlockOption = textBlockOptions.find((option) => isBlockStyleSelected(block, option)) || textBlockOptions[0];
        const activeListOption = listStyleOptions.find((option) => isBlockStyleSelected(block, option));
        const currentAlignment = getSelectedTextAlignment();
        const displayAlignment = ['left', 'center', 'right', 'justify'].includes(currentAlignment) ? currentAlignment : 'left';

        const blockIcon = writingToolbar.querySelector('[data-current-block-icon]');
        const blockLabel = writingToolbar.querySelector('[data-current-block-label]');
        if (blockIcon) {
            blockIcon.classList.toggle('notes-toolbar-text-icon', activeBlockOption.icon.startsWith('H'));
            blockIcon.classList.toggle('material-symbols-outlined', !activeBlockOption.icon.startsWith('H'));
            blockIcon.textContent = activeBlockOption.icon || '';
        }
        if (blockLabel) blockLabel.textContent = activeBlockOption.label;

        const listIcon = writingToolbar.querySelector('[data-current-list-icon]');
        if (listIcon) listIcon.textContent = activeListOption?.icon || 'format_list_bulleted';

        const alignIcon = writingToolbar.querySelector('[data-current-align-icon]');
        if (alignIcon) alignIcon.textContent = `format_align_${displayAlignment}`;

        const collapseIcon = writingToolbar.querySelector('[data-heading-collapse-icon]');
        const collapseLabel = writingToolbar.querySelector('[data-heading-collapse-label]');
        if (collapseIcon) collapseIcon.textContent = block?.props?.isCollapsed ? 'unfold_more' : 'unfold_less';
        if (collapseLabel) collapseLabel.textContent = block?.props?.isCollapsed ? 'Expand heading' : 'Collapse heading';

        const state = { blocks, block, styles: activeStyles, fontPreset: activeFontPreset, alignment: currentAlignment };
        writingToolbar.querySelectorAll('button[data-editor-action]').forEach((button) => {
            const action = button.dataset.editorAction;
            const command = commands[action];
            const active = command?.active?.(button.dataset, state) || false;
            const disabled = command?.disabled?.(state, action) || false;
            button.classList.toggle('is-active', active);
            if (command?.pressed) {
                button.setAttribute('aria-pressed', String(active));
            } else {
                button.removeAttribute('aria-pressed');
            }
            button.disabled = disabled;
            button.setAttribute('aria-disabled', String(disabled));
        });

        writingToolbar.querySelectorAll('[data-menu-check]').forEach((item) => {
            const key = item.dataset.menuCheck;
            const checked = key === activeBlockOption.key
                || key === activeListOption?.key
                || key === `align-${displayAlignment}`
                || key === `text-color-${activeStyles?.textColor || 'default'}`
                || key === `highlight-color-${activeStyles?.backgroundColor || 'default'}`
                || key === `font-size-${activeFontPreset.value}`;
            item.classList.toggle('is-active', checked);
            item.setAttribute('aria-checked', String(checked));
        });
    }

    function bindWritingToolbar() {
        if (!getCanEdit() || !writingToolbar) return;
        if (!claimElementBinding(writingToolbar, 'notesEditorToolbarBound')) {
            toolbarOverflowController?.refresh();
            return;
        }
        pageSetup?.bind?.();
        writingToolbar.hidden = false;
        toolbarOverflowController?.disconnect();
        toolbarOverflowController = createToolbarOverflowController(writingToolbar);

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

            if (handlePageSetupToolbarClick(
                event,
                writingToolbar,
                pageSetupPopover,
                pageSetup?.openPageSetupPopover,
                pageSetup?.closePageSetupPopover
            )) return;

            const actionButton = event.target.closest('button[data-editor-action]');
            if (!actionButton || !writingToolbar.contains(actionButton)) return;
            event.preventDefault();

            executeCommand(actionButton.dataset.editorAction, actionButton);
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
                setActiveAddBlockItem(menu, addBlockActiveIndex + 1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveAddBlockItem(menu, addBlockActiveIndex - 1);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                executeCommand('insert-block', items[addBlockActiveIndex] || items[0]);
            }
        });

        writingToolbar.addEventListener('submit', (event) => {
            const menu = event.target.closest('[data-toolbar-menu="link"]');
            if (!menu) return;
            event.preventDefault();
            actions.applyLinkFromMenu(menu);
        });

        document.addEventListener('click', (event) => {
            if (activeToolbarMenu && !writingToolbar.contains(event.target)) {
                closeToolbarMenus();
            }
            if (actions.hasUrlBlockPopover() && !actions.getUrlBlockPopover().contains(event.target) && !writingToolbar?.contains(event.target)) {
                actions.removeUrlBlockPopover('');
            }
            if (!pageSetupPopover || pageSetupPopover.hidden) return;
            if (pageSetupPopover.contains(event.target) || actions.getActivePageSetupTrigger()?.contains(event.target)) return;
            pageSetup?.clearPageSetupDropdowns?.();
            pageSetup?.closePageSetupPopover?.();
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                if (activeToolbarMenu) closeToolbarMenus();
                if (pageSetupPopover && !pageSetupPopover.hidden) pageSetup?.closePageSetupPopover?.({ restoreFocus: true });
                if (actions.hasUrlBlockPopover()) {
                    actions.removeUrlBlockPopover('');
                }
                return;
            }
            if (!getEditor()) return;
            const mod = event.metaKey || event.ctrlKey;
            if (mod && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                const trigger = writingToolbar.querySelector('[data-toolbar-menu-trigger="link"]');
                openToolbarMenu('link', trigger);
            } else if (mod && event.shiftKey && event.key.toLowerCase() === 'l') {
                event.preventDefault();
                const trigger = writingToolbar.querySelector('[data-toolbar-menu-trigger="text-color"]');
                openToolbarMenu('text-color', trigger);
            } else if (mod && event.shiftKey && event.key.toLowerCase() === 'h') {
                event.preventDefault();
                const trigger = writingToolbar.querySelector('[data-toolbar-menu-trigger="highlight-color"]');
                openToolbarMenu('highlight-color', trigger);
            } else if (mod && event.altKey && event.key.toLowerCase() === 'h') {
                event.preventDefault();
                executeCommand('toggle-heading-collapse');
            } else if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowUp') {
                event.preventDefault();
                executeCommand('move-blocks-up');
            } else if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && event.key === 'ArrowDown') {
                event.preventDefault();
                executeCommand('move-blocks-down');
            } else if ((event.key === 'Delete' || event.key === 'Backspace') && getSelectedBlocks().length > 1) {
                event.preventDefault();
                executeCommand('delete-blocks');
            }
        });

        toolbarOverflowController?.refresh();
    }

    return {
        bindWritingToolbar,
        closeToolbarMenus,
        disconnect() {
            toolbarOverflowController?.disconnect();
            toolbarOverflowController = null;
        },
        refresh() {
            toolbarOverflowController?.refresh();
        },
        updateToolbarState,
    };
}
