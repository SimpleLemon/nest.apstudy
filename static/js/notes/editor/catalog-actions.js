import { blockPayloadForCatalogItem, catalogItemByKey, catalogItemByType } from './block-catalog.js';
import { ATOM_BLOCK_TYPES } from './block-properties.js';
import { blockOwnContentIsEmpty } from './utils.js';
import { insertInlineImageFile, insertInlineImageNode, requestImageSource } from './image-runtime.js';

export function createCatalogActions({
    getEditor,
    getCanEdit = () => true,
    noteId,
    editorPage,
    closeToolbarMenus,
    focusEditorBody,
    updateEditorChrome,
    triggerDebouncedSave,
}) {
    const GRAMMARLY_DISABLED_ATTRS = 'data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false" spellcheck="false"';
    let urlBlockPopover = null;
    let urlBlockResolve = null;
    let disposed = false;

    function noteUrl(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
            const parsed = new URL(raw);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
            return parsed.href;
        } catch {
            return '';
        }
    }

    function removeUrlBlockPopover(result = null) {
        if (!urlBlockPopover) return;
        const resolve = urlBlockResolve;
        urlBlockPopover.remove();
        urlBlockPopover = null;
        urlBlockResolve = null;
        resolve?.(result);
    }

    function positionUrlBlockPopover(anchorRect) {
        if (!urlBlockPopover) return;
        const rect = anchorRect || editorPage?.getBoundingClientRect() || { left: 16, bottom: 80 };
        const width = Math.min(360, window.innerWidth - 16);
        const left = Math.max(8, Math.min(rect.left || 8, window.innerWidth - width - 8));
        const top = Math.max(8, Math.min((rect.bottom || 80) + 8, window.innerHeight - 380));
        urlBlockPopover.style.width = `${width}px`;
        urlBlockPopover.style.left = `${Math.round(left)}px`;
        urlBlockPopover.style.top = `${Math.round(top)}px`;
    }

    function requestUrlForBlock(item, anchorRect = null) {
        removeUrlBlockPopover();
        return new Promise((resolve) => {
            urlBlockResolve = resolve;
            const label = item?.label || 'URL block';
            urlBlockPopover = document.createElement('form');
            urlBlockPopover.className = 'notes-url-block-popover';
            urlBlockPopover.setAttribute('data-gramm', 'false');
            urlBlockPopover.setAttribute('data-gramm_editor', 'false');
            urlBlockPopover.setAttribute('data-enable-grammarly', 'false');
            urlBlockPopover.setAttribute('spellcheck', 'false');
            urlBlockPopover.innerHTML = `
                <label class="notes-url-block-field">
                    <span>${label} URL</span>
                    <input type="url" name="url" placeholder="https://example.com" autocomplete="off" ${GRAMMARLY_DISABLED_ATTRS} required />
                </label>
                <div class="notes-url-block-error" role="alert" hidden></div>
                <div class="notes-url-block-actions">
                    <button type="button" data-url-block-cancel>Cancel</button>
                    <button type="submit">Insert</button>
                </div>
            `;
            document.body.appendChild(urlBlockPopover);
            positionUrlBlockPopover(anchorRect);
            const input = urlBlockPopover.querySelector('input[name="url"]');
            const error = urlBlockPopover.querySelector('.notes-url-block-error');
            input?.focus();

            urlBlockPopover.addEventListener('submit', (event) => {
                event.preventDefault();
                const url = noteUrl(input?.value);
                if (!url) {
                    if (error) {
                        error.hidden = false;
                        error.textContent = 'Enter a valid http or https URL.';
                    }
                    return;
                }
                removeUrlBlockPopover(url);
            });
            urlBlockPopover.querySelector('[data-url-block-cancel]')?.addEventListener('click', () => {
                removeUrlBlockPopover('');
            });
        });
    }

    async function insertImageFromDialog(anchorRect = null, editor = getEditor()) {
        if (disposed || !getCanEdit()) return null;
        const source = await requestImageSource(anchorRect, noteUrl);
        if (!source || disposed || !getCanEdit()) return null;
        closeToolbarMenus();
        if (source.file) return insertInlineImageFile(editor, source.file, { noteId, onChange: triggerDebouncedSave });
        return insertInlineImageNode(editor, { url: source.url, mediaId: '', clientId: `url-${Date.now()}`, alt: '', width: 240, layout: 'inline', alignment: 'left', status: 'ready', error: '' });
    }

    async function previewForBookmark(url) {
        try {
            const response = await fetch(`/api/notes/tools/link-preview?url=${encodeURIComponent(url)}`);
            if (!response.ok) throw new Error('Preview unavailable');
            return await response.json();
        } catch {
            let hostname = '';
            try {
                hostname = new URL(url).hostname;
            } catch {
                hostname = '';
            }
            return {
                url,
                title: hostname || url,
                description: '',
                image_url: '',
                site_name: hostname,
                content_type: '',
                preview_found: false,
            };
        }
    }

    async function payloadForCatalogItem(item, anchorRect = null) {
        if (!item) return blockPayloadForCatalogItem(catalogItemByKey('paragraph'));
        if (!item.requiresUrl) return blockPayloadForCatalogItem(item);
        const url = await requestUrlForBlock(item, anchorRect);
        if (!url) return null;
        if (item.type === 'bookmark') {
            const preview = await previewForBookmark(url);
            return blockPayloadForCatalogItem(item, {
                url: preview?.url || url,
                title: preview?.title || url,
                description: preview?.description || '',
                image_url: preview?.image_url || '',
                site_name: preview?.site_name || '',
                content_type: preview?.content_type || '',
            });
        }
        return blockPayloadForCatalogItem(item, { url });
    }

    function insertBlockPayload(block, editor = getEditor()) {
        if (disposed || !getCanEdit()) return null;
        if (!editor || !block) return null;
        const currentBlock = editor.getTextCursorPosition?.()?.block;
        if (!currentBlock) {
            editor.focus?.();
            return null;
        }
        let insertedOrUpdated = null;
        if (blockOwnContentIsEmpty(currentBlock)) {
            insertedOrUpdated = editor.updateBlock(currentBlock, block);
        } else {
            insertedOrUpdated = editor.insertBlocks?.([block], currentBlock, 'after')?.[0] || null;
        }

        if (!insertedOrUpdated) return null;

        if (ATOM_BLOCK_TYPES.has(insertedOrUpdated.type) || insertedOrUpdated.type === 'table') {
            const after = editor.insertBlocks?.([{ type: 'paragraph' }], insertedOrUpdated, 'after')?.[0];
            if (after) editor.setTextCursorPosition?.(after);
        } else {
            editor.setTextCursorPosition?.(insertedOrUpdated);
        }

        editor.focus?.();
        updateEditorChrome();
        triggerDebouncedSave();
        return insertedOrUpdated;
    }

    async function insertCatalogItem(item, anchorRect = null, editor = getEditor()) {
        if (disposed || !getCanEdit()) return null;
        if (item?.type === 'inlineImage') return insertImageFromDialog(anchorRect, editor);
        const payload = await payloadForCatalogItem(item, anchorRect);
        if (disposed || !getCanEdit()) return null;
        if (!payload) {
            focusEditorBody();
            return null;
        }
        closeToolbarMenus();
        return insertBlockPayload(payload, editor);
    }

    function insertBlockFromMenu(button) {
        const editorInstance = getEditor();
        if (!editorInstance) return;
        const item = catalogItemByKey(button?.dataset.blockKey) || catalogItemByType(button?.dataset.blockType, {
            level: Number(button?.dataset.level || 1),
        });
        void insertCatalogItem(item || catalogItemByKey('paragraph'), button?.getBoundingClientRect?.());
    }

    function dispose() {
        disposed = true;
        removeUrlBlockPopover();
    }

    return {
        insertImageFromDialog,
        insertCatalogItem,
        insertBlockFromMenu,
        removeUrlBlockPopover,
        hasUrlBlockPopover: () => Boolean(urlBlockPopover),
        getUrlBlockPopover: () => urlBlockPopover,
        dispose,
    };
}
