/* files/renderers.js - File Share markup and menu helpers */
(() => {
    const {
        escapeHtml,
        fileExtensionBadgeTone,
        fileExtensionLabel,
        fileIcon,
        fileIconForUpload,
        formatBytes,
        formatDateTime,
        formatFileStatus,
        formatFolderCounts,
        formatFolderStatus,
        formatRelative,
    } = window.APStudyFilesUtils || {};

    function folderCardHtml(folder, selected) {
        return `
            <article class="files-row files-folder-card ${selected ? "is-selected" : ""}" data-folder-id="${escapeHtml(folder.id)}" tabindex="0">
                <label class="files-row-check" aria-label="Select ${escapeHtml(folder.name)}">
                    <input type="checkbox" data-native-control data-select-folder="${escapeHtml(folder.id)}" ${selected ? "checked" : ""}>
                </label>
                <span class="files-row-icon files-row-icon-folder material-symbols-outlined" aria-hidden="true">folder</span>
                <div class="files-row-main">
                    <span class="files-row-name">${escapeHtml(folder.name)}</span>
                    <span class="files-row-sub">${escapeHtml(formatFolderStatus(folder))}</span>
                </div>
                <span class="files-row-size">${escapeHtml(formatFolderCounts(folder))}</span>
                <span class="files-row-date">${escapeHtml(formatRelative(folder.updatedAt || folder.createdAt))}</span>
                <button class="files-card-action" type="button" data-folder-menu="${escapeHtml(folder.id)}" aria-label="More actions for ${escapeHtml(folder.name)}">
                    <span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>
                </button>
            </article>
        `;
    }

    function fileCardHtml(file, selected) {
        return `
            <article class="files-row files-file-card ${selected ? "is-selected" : ""}" data-file-id="${escapeHtml(file.id)}">
                <label class="files-row-check" aria-label="Select ${escapeHtml(file.filename)}">
                    <input type="checkbox" data-native-control data-select-file="${escapeHtml(file.id)}" ${selected ? "checked" : ""}>
                </label>
                <span class="files-row-icon files-row-icon-file material-symbols-outlined" aria-hidden="true">${escapeHtml(fileIcon(file))}</span>
                <div class="files-row-main">
                    <span class="files-row-name">${escapeHtml(file.filename)}</span>
                    <span class="files-row-sub">${escapeHtml(formatFileStatus(file))}</span>
                </div>
                <span class="files-row-size">${escapeHtml(formatBytes(file.fileSizeBytes))}</span>
                <span class="files-row-date">${escapeHtml(formatDateTime(file.updatedAt || file.createdAt || file.expiresAt))}</span>
                <button class="files-card-action" type="button" data-file-menu="${escapeHtml(file.id)}" aria-label="More actions for ${escapeHtml(file.filename)}">
                    <span class="material-symbols-outlined" aria-hidden="true">more_horiz</span>
                </button>
            </article>
        `;
    }

    function uploadItemHtml(item, allowedExpiry) {
        const badgeTone = fileExtensionBadgeTone(item.file);
        const badgeLabel = fileExtensionLabel(item.file);
        const iconName = fileIconForUpload(item.file);
        return `
            <article class="files-selected-item" data-upload-id="${escapeHtml(item.id)}">
                <div class="files-upload-file-row">
                    <div class="files-upload-file-preview">
                        <span class="material-symbols-outlined files-upload-file-icon" aria-hidden="true">${escapeHtml(iconName)}</span>
                        <span class="files-upload-file-badge files-upload-file-badge--${escapeHtml(badgeTone)}">${escapeHtml(badgeLabel)}</span>
                    </div>
                    <div class="files-upload-file-main">
                        <input type="text" class="files-upload-filename" data-upload-name value="${escapeHtml(item.name)}" maxlength="255" aria-label="Filename">
                        <span class="files-upload-size">${escapeHtml(formatBytes(item.file.size))}</span>
                    </div>
                    <button class="files-upload-remove" type="button" data-upload-remove aria-label="Remove ${escapeHtml(item.name)}">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </div>
                <div class="files-selected-controls">
                    <label class="files-field files-field-compact">
                        <span>Visibility</span>
                        <select data-upload-visibility>
                            <option value="private" ${item.visibility === "private" ? "selected" : ""}>Private</option>
                            <option value="public" ${item.visibility === "public" ? "selected" : ""}>Public link</option>
                        </select>
                    </label>
                    <label class="files-field files-field-compact">
                        <span>Expires</span>
                        <select data-upload-expiry>
                            ${allowedExpiry.map((days) => `<option value="${days}" ${String(days) === String(item.expiryDays) ? "selected" : ""}>${days} day${Number(days) === 1 ? "" : "s"}</option>`).join("")}
                        </select>
                    </label>
                </div>
            </article>
        `;
    }

    function shareExpiryOptionsHtml(allowedExpiry, selected) {
        return allowedExpiry.map((days) => {
            const value = String(days);
            return `<option value="${value}" ${value === selected ? "selected" : ""}>${days} day${Number(days) === 1 ? "" : "s"} from now</option>`;
        }).join("");
    }

    function fileMenuItems(file, actions) {
        return [
            { label: "Download", icon: "download", onClick: () => actions.downloadFile(file.id) },
            { label: "Share/Expiry", icon: "group_add", onClick: () => actions.openShareModal("file", file) },
            { label: "Rename", icon: "edit", onClick: () => actions.openFolderModal("file-rename", file) },
            { label: "Move", icon: "drive_file_move", onClick: () => actions.openMoveModal({ type: "file", fileIds: [file.id], folderIds: [] }) },
            { label: "Delete", icon: "delete", danger: true, onClick: () => actions.openFileDeleteConfirm(file) },
        ];
    }

    function folderMenuItems(folder, actions) {
        return [
            { label: "Share", icon: "group_add", onClick: () => actions.openShareModal("folder", folder) },
            { label: "Rename", icon: "edit", onClick: () => actions.openFolderModal("folder-rename", folder) },
            { label: "Move", icon: "drive_file_move", onClick: () => actions.openMoveModal({ type: "folder", fileIds: [], folderIds: [folder.id] }) },
            { label: "Download folder", icon: "folder_zip", onClick: () => { window.location.href = `/api/files/folders/${encodeURIComponent(folder.id)}/download.zip`; } },
            { label: "Delete", icon: "delete", danger: true, onClick: () => actions.openFolderDeleteConfirm(folder) },
        ];
    }

    function renderEmptyState(empty, loading, folders, files) {
        if (!empty) return;
        const hasContent = folders.length > 0 || files.length > 0;
        empty.hidden = hasContent || !loading?.hidden;
    }

    function setLoading(els, isLoading) {
        if (els.loading) els.loading.hidden = !isLoading;
        if (isLoading) {
            if (els.foldersSection) els.foldersSection.hidden = true;
            if (els.filesSection) els.filesSection.hidden = true;
            if (els.empty) els.empty.hidden = true;
        }
    }

    function toggleNewMenu(menu, button) {
        if (!menu) return;
        const nextHidden = !menu.hidden ? true : false;
        menu.hidden = nextHidden;
        button?.setAttribute("aria-expanded", String(!nextHidden));
        if (!nextHidden) requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus({ preventScroll: true }));
    }

    function closeNewMenu(menu, button) {
        if (!menu) return;
        menu.hidden = true;
        button?.setAttribute("aria-expanded", "false");
    }

    function openActionMenu(anchor, items, state) {
        closeActionMenu(state);
        const menu = document.createElement("div");
        menu.className = "files-action-menu";
        menu.setAttribute("role", "menu");
        menu.innerHTML = items.map((item, index) => `
            <button type="button" role="menuitem" class="${item.danger ? "files-menu-danger" : ""}" data-menu-index="${index}">
                <span class="material-symbols-outlined" aria-hidden="true">${escapeHtml(item.icon)}</span>
                <span>${escapeHtml(item.label)}</span>
            </button>
        `).join("");
        document.body.appendChild(menu);
        state.actionMenu = menu;
        state.actionMenuAnchor = anchor;
        menu.querySelectorAll("[data-menu-index]").forEach((button) => {
            button.addEventListener("click", () => {
                const item = items[Number(button.dataset.menuIndex)];
                closeActionMenu(state);
                item?.onClick?.();
            });
        });
        positionActionMenu(anchor, menu);
        menu.querySelector("button")?.focus({ preventScroll: true });
    }

    function positionActionMenu(anchor, menu) {
        const rect = anchor.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const gap = 8;
        let top = rect.bottom + gap;
        let left = rect.right - menuRect.width;
        if (top + menuRect.height > window.innerHeight - gap) {
            top = Math.max(gap, rect.top - menuRect.height - gap);
        }
        if (left + menuRect.width > window.innerWidth - gap) {
            left = window.innerWidth - menuRect.width - gap;
        }
        if (left < gap) left = gap;
        menu.style.top = `${top}px`;
        menu.style.left = `${left}px`;
    }

    function closeActionMenu(state) {
        const menu = state.actionMenu;
        const anchor = state.actionMenuAnchor;
        const shouldRestoreFocus = Boolean(menu?.contains(document.activeElement));
        menu?.remove();
        state.actionMenu = null;
        state.actionMenuAnchor = null;
        if (shouldRestoreFocus) anchor?.focus?.({ preventScroll: true });
    }

    window.APStudyFilesRenderers = {
        folderCardHtml,
        fileCardHtml,
        uploadItemHtml,
        shareExpiryOptionsHtml,
        fileMenuItems,
        folderMenuItems,
        renderEmptyState,
        setLoading,
        toggleNewMenu,
        closeNewMenu,
        openActionMenu,
        closeActionMenu,
    };
})();
