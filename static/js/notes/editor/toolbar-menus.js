import {
    editorPage,
    editorState,
    writingToolbar,
} from './runtime.js';
import {
    closePageSetupPopover,
} from './page-setup.js';

export function closeToolbarMenus() {
    if (!writingToolbar) return;
    editorState.activeToolbarMenu = null;
    writingToolbar.querySelectorAll('[data-toolbar-menu]').forEach((menu) => {
        menu.hidden = true;
    });
    writingToolbar.querySelectorAll('[data-toolbar-menu-trigger]').forEach((trigger) => {
        trigger.setAttribute('aria-expanded', 'false');
    });
}

export function positionToolbarMenu(trigger, menu, triggerRectOverride = null) {
    if (!trigger || !menu) return;
    const triggerRect = triggerRectOverride || trigger.getBoundingClientRect();
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.minWidth = `${Math.max(triggerRect.width, 150)}px`;

    const editorRect = editorPage?.getBoundingClientRect();
    const viewportRight = window.innerWidth - 8;
    const boundaryRight = Math.min(viewportRight, editorRect ? editorRect.right - 8 : viewportRight);
    const menuRect = menu.getBoundingClientRect();
    let left = triggerRect.left;

    if (left + menuRect.width > boundaryRight) {
        left = triggerRect.right - menuRect.width;
    }

    left = Math.max(8, left);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(triggerRect.bottom + 6)}px`;
}

export function openToolbarMenu(name, trigger) {
    if (!writingToolbar) return;
    const menu = writingToolbar.querySelector(`[data-toolbar-menu="${name}"]`);
    if (!menu) return;

    const openingSameMenu = editorState.activeToolbarMenu === name && !menu.hidden;
    const triggerRect = trigger?.getBoundingClientRect() || null;
    closePageSetupPopover();
    closeToolbarMenus();
    if (openingSameMenu) return;

    editorState.activeToolbarMenu = name;
    menu.hidden = false;
    trigger?.setAttribute('aria-expanded', 'true');

    if (name === 'link') {
        const input = menu.querySelector('[data-link-url]');
        if (input) {
            input.value = editorState.editorInstance?.getSelectedLinkUrl?.() || '';
            window.setTimeout(() => input.focus(), 0);
        }
    } else if (name === 'add-block') {
        prepareAddBlockMenu(menu);
    }

    positionToolbarMenu(trigger, menu, triggerRect);
}

export function visibleAddBlockItems(menu) {
    return Array.from(menu?.querySelectorAll('.notes-add-block-item:not([hidden])') || []);
}

export function setActiveAddBlockItem(menu, index) {
    const items = visibleAddBlockItems(menu);
    if (!items.length) return;
    editorState.addBlockActiveIndex = Math.min(items.length - 1, Math.max(0, index));
    items.forEach((item, itemIndex) => {
        const active = itemIndex === editorState.addBlockActiveIndex;
        item.classList.toggle('is-active', active);
        item.setAttribute('aria-selected', String(active));
        if (active) item.scrollIntoView({ block: 'nearest' });
    });
}

export function filterAddBlockMenu(menu) {
    const input = menu?.querySelector('[data-add-block-search]');
    const query = (input?.value || '').trim().toLowerCase();
    menu?.querySelectorAll('.notes-add-block-item').forEach((item) => {
        const text = item.textContent.toLowerCase();
        item.hidden = Boolean(query && !text.includes(query));
    });
    setActiveAddBlockItem(menu, 0);
}

export function prepareAddBlockMenu(menu) {
    const input = menu?.querySelector('[data-add-block-search]');
    if (input) {
        input.value = '';
        window.setTimeout(() => input.focus(), 0);
    }
    filterAddBlockMenu(menu);
}

export function createToolbarOverflowController(toolbar) {
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
