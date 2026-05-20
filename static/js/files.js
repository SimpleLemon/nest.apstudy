/* files.js - APStudy File Share manager */
(() => {
    const CONFIG = window.FILE_SHARE_CONFIG || {};
    const MAX_FILE_SIZE_BYTES = Number(CONFIG.maxFileSize) || (50 * 1024 * 1024);
    const MAX_UPLOAD_FILES = Number(CONFIG.maxUploadFiles) || 5;
    const ALLOWED_EXPIRY = Array.isArray(CONFIG.allowedExpiryOptions) && CONFIG.allowedExpiryOptions.length
        ? CONFIG.allowedExpiryOptions
        : [1, 3, 7, 14, 30];
    const DEFAULT_EXPIRY = Number(CONFIG.defaultExpiryDays) || ALLOWED_EXPIRY[0] || 1;

    const state = {
        currentFolderId: null,
        currentFolder: null,
        breadcrumbs: [],
        folders: [],
        files: [],
        allFolders: [],
        selectedFileIds: new Set(),
        selectedFolderIds: new Set(),
        uploadItems: [],
        uploadTargetFolderId: null,
        uploadTargetName: "My Files",
        folderModalMode: null,
        moveContext: null,
        confirmContext: null,
        shareContext: null,
        activeModal: null,
        lastFocusedElement: null,
        actionMenu: null,
        actionMenuAnchor: null,
        dragDepth: 0,
    };

    let els = {};

    document.addEventListener("DOMContentLoaded", () => {
        els = getElements();
        bindGlobalEvents();
        void loadFolder(null);
    });

    function getElements() {
        return {
            refresh: document.getElementById("file-share-refresh"),
            newButton: document.getElementById("file-share-new-button"),
            newMenu: document.getElementById("file-share-new-menu"),
            newFolder: document.querySelector("[data-new-folder]"),
            fileUpload: document.querySelector("[data-file-upload]"),
            breadcrumbs: document.getElementById("file-share-breadcrumbs"),
            dropSurface: document.getElementById("file-share-drop-surface"),
            folderTitle: document.getElementById("file-share-folder-title"),
            folderMeta: document.getElementById("file-share-folder-meta"),
            folderZip: document.getElementById("file-share-folder-zip"),
            alert: document.getElementById("file-share-alert"),
            loading: document.getElementById("file-share-loading"),
            foldersSection: document.getElementById("file-share-folders-section"),
            foldersRoot: document.getElementById("file-share-folders"),
            filesSection: document.getElementById("file-share-files-section"),
            filesRoot: document.getElementById("file-share-files"),
            empty: document.getElementById("file-share-empty"),
            uploadModal: document.getElementById("file-share-upload-modal"),
            uploadTarget: document.getElementById("file-share-upload-target"),
            input: document.getElementById("file-share-input"),
            pick: document.getElementById("file-share-pick"),
            dropzone: document.getElementById("file-share-dropzone"),
            selectedList: document.getElementById("file-share-selected-list"),
            uploadButton: document.getElementById("file-share-upload"),
            progressWrap: document.getElementById("file-share-progress-wrap"),
            progressBar: document.getElementById("file-share-progress-bar"),
            uploadError: document.getElementById("file-share-error"),
            folderModal: document.getElementById("file-share-folder-modal"),
            folderForm: document.getElementById("file-share-folder-form"),
            folderModalTitle: document.getElementById("file-share-folder-modal-title"),
            folderModalSubtitle: document.getElementById("file-share-folder-modal-subtitle"),
            folderName: document.getElementById("file-share-folder-name"),
            folderSave: document.getElementById("file-share-folder-save"),
            folderError: document.getElementById("file-share-folder-error"),
            moveModal: document.getElementById("file-share-move-modal"),
            moveForm: document.getElementById("file-share-move-form"),
            moveTitle: document.getElementById("file-share-move-title"),
            moveSubtitle: document.getElementById("file-share-move-subtitle"),
            moveDestination: document.getElementById("file-share-move-destination"),
            moveError: document.getElementById("file-share-move-error"),
            moveSave: document.getElementById("file-share-move-save"),
            shareModal: document.getElementById("file-share-share-modal"),
            shareTitle: document.getElementById("file-share-share-title"),
            shareSubtitle: document.getElementById("file-share-share-subtitle"),
            shareName: document.getElementById("file-share-share-name"),
            shareStatus: document.getElementById("file-share-share-status"),
            shareVisibility: document.getElementById("file-share-share-visibility"),
            shareExpiryField: document.getElementById("file-share-expiry-field"),
            shareExpiry: document.getElementById("file-share-share-expiry"),
            folderShareNote: document.getElementById("file-share-folder-note"),
            shareLinkWrap: document.getElementById("file-share-link-wrap"),
            shareLink: document.getElementById("file-share-share-link"),
            copyShareButton: document.getElementById("file-share-copy-link"),
            shareError: document.getElementById("file-share-share-error"),
            confirmModal: document.getElementById("file-share-confirm-modal"),
            confirmForm: document.getElementById("file-share-confirm-form"),
            confirmTitle: document.getElementById("file-share-confirm-title"),
            confirmMessage: document.getElementById("file-share-confirm-message"),
            confirmField: document.getElementById("file-share-confirm-field"),
            confirmFieldLabel: document.getElementById("file-share-confirm-field-label"),
            confirmInput: document.getElementById("file-share-confirm-input"),
            confirmError: document.getElementById("file-share-confirm-error"),
            confirmSubmit: document.getElementById("file-share-confirm-submit"),
            selectionBar: document.getElementById("file-share-selection-bar"),
            selectionCount: document.getElementById("file-share-selection-count"),
            selectionClear: document.getElementById("file-share-selection-clear"),
            bulkMove: document.getElementById("file-share-bulk-move"),
            bulkDownload: document.getElementById("file-share-bulk-download"),
            bulkDelete: document.getElementById("file-share-bulk-delete"),
        };
    }

    function bindGlobalEvents() {
        els.refresh?.addEventListener("click", () => void loadFolder(state.currentFolderId));
        els.newButton?.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleNewMenu();
        });
        els.newFolder?.addEventListener("click", () => {
            closeNewMenu();
            openFolderModal("folder-create");
        });
        els.fileUpload?.addEventListener("click", () => {
            closeNewMenu();
            openUploadModal(state.currentFolderId);
        });

        els.selectionClear?.addEventListener("click", clearSelection);
        els.bulkMove?.addEventListener("click", () => {
            if (!selectedTotal()) return;
            openMoveModal({
                type: "bulk",
                fileIds: Array.from(state.selectedFileIds),
                folderIds: Array.from(state.selectedFolderIds),
            });
        });
        els.bulkDownload?.addEventListener("click", () => void downloadSelectedFiles());
        els.bulkDelete?.addEventListener("click", () => openBulkDeleteConfirm());

        document.querySelectorAll("[data-close-modal]").forEach((button) => {
            button.addEventListener("click", () => closeModal(button.closest(".files-modal")));
        });
        document.querySelectorAll(".files-modal").forEach((modal) => {
            modal.addEventListener("mousedown", (event) => {
                if (event.target === modal) closeModal(modal);
            });
        });

        els.pick?.addEventListener("click", (event) => {
            event.stopPropagation();
            els.input?.click();
        });
        els.input?.addEventListener("change", () => {
            addUploadFiles(Array.from(els.input?.files || []));
            if (els.input) els.input.value = "";
        });
        els.dropzone?.addEventListener("click", () => els.input?.click());
        els.dropzone?.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                els.input?.click();
            }
        });
        els.dropzone?.addEventListener("dragover", (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            els.dropzone.classList.add("is-active");
        });
        els.dropzone?.addEventListener("dragleave", () => {
            els.dropzone.classList.remove("is-active");
        });
        els.dropzone?.addEventListener("drop", (event) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            els.dropzone.classList.remove("is-active");
            addUploadFiles(Array.from(event.dataTransfer?.files || []));
        });

        els.uploadButton?.addEventListener("click", () => void uploadSelectedFiles());
        els.folderForm?.addEventListener("submit", (event) => {
            event.preventDefault();
            void saveFolderModal();
        });
        els.moveForm?.addEventListener("submit", (event) => {
            event.preventDefault();
            void saveMoveModal();
        });
        els.shareVisibility?.addEventListener("change", () => void saveShareVisibility());
        els.shareExpiry?.addEventListener("change", () => void saveShareExpiry());
        els.copyShareButton?.addEventListener("click", () => void copyCurrentShareLink());
        els.confirmForm?.addEventListener("submit", (event) => {
            event.preventDefault();
            void runConfirmAction();
        });

        els.dropSurface?.addEventListener("dragenter", (event) => {
            if (!hasFiles(event) || state.activeModal) return;
            event.preventDefault();
            state.dragDepth += 1;
            els.dropSurface.classList.add("is-dragging");
        });
        els.dropSurface?.addEventListener("dragover", (event) => {
            if (!hasFiles(event) || state.activeModal) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        });
        els.dropSurface?.addEventListener("dragleave", (event) => {
            if (!hasFiles(event) || state.activeModal) return;
            event.preventDefault();
            state.dragDepth = Math.max(0, state.dragDepth - 1);
            if (state.dragDepth === 0) els.dropSurface.classList.remove("is-dragging");
        });
        els.dropSurface?.addEventListener("drop", (event) => {
            if (!hasFiles(event) || state.activeModal) return;
            event.preventDefault();
            state.dragDepth = 0;
            els.dropSurface.classList.remove("is-dragging");
            openUploadModal(state.currentFolderId, Array.from(event.dataTransfer?.files || []));
        });

        document.addEventListener("click", (event) => {
            if (els.newMenu && !els.newMenu.hidden && !event.target.closest(".files-new-menu-wrap")) {
                closeNewMenu();
            }
            if (
                state.actionMenu
                && !state.actionMenu.contains(event.target)
                && !state.actionMenuAnchor?.contains(event.target)
            ) {
                closeActionMenu();
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            if (state.actionMenu) {
                closeActionMenu();
                return;
            }
            if (els.newMenu && !els.newMenu.hidden) {
                closeNewMenu();
                return;
            }
            if (state.activeModal) {
                closeModal(state.activeModal);
            }
        });
        window.addEventListener("resize", closeActionMenu);
        window.addEventListener("scroll", closeActionMenu, true);
    }

    async function loadFolder(folderId) {
        state.currentFolderId = normalizeFolderId(folderId);
        clearAlert();
        closeActionMenu();
        setLoading(true);
        clearSelection();

        try {
            const query = state.currentFolderId ? `?folderId=${encodeURIComponent(state.currentFolderId)}` : "";
            const payload = await apiJson(`/api/files/my${query}`);
            state.currentFolder = payload.currentFolder || null;
            state.breadcrumbs = Array.isArray(payload.breadcrumbs) ? payload.breadcrumbs : [];
            state.folders = Array.isArray(payload.folders) ? payload.folders : [];
            state.files = Array.isArray(payload.files) ? payload.files : [];
            state.allFolders = Array.isArray(payload.allFolders) ? payload.allFolders : [];
            renderManager();
        } catch (error) {
            console.error(error);
            state.folders = [];
            state.files = [];
            renderManager();
            showAlert(error.message || "Unable to load files right now.", "error");
        } finally {
            setLoading(false);
            renderEmptyState();
        }
    }

    function renderManager() {
        renderHeader();
        renderBreadcrumbs();
        renderFolders();
        renderFiles();
        renderEmptyState();
        updateSelectionBar();
    }

    function renderHeader() {
        const title = state.currentFolder?.name || "My Files";
        const folderCount = state.folders.length;
        const fileCount = state.files.length;
        if (els.folderTitle) els.folderTitle.textContent = title;
        if (els.folderMeta) {
            els.folderMeta.textContent = `${formatCount(folderCount, "folder")} / ${formatCount(fileCount, "file")}`;
        }
        if (els.folderZip) {
            els.folderZip.href = `/api/files/folders/${encodeURIComponent(state.currentFolderId || "root")}/download.zip`;
        }
    }

    function renderBreadcrumbs() {
        if (!els.breadcrumbs) return;
        const crumbs = state.breadcrumbs.length
            ? state.breadcrumbs
            : [{ id: null, name: "My Files" }];
        els.breadcrumbs.innerHTML = crumbs.map((crumb, index) => {
            const separator = index === 0
                ? ""
                : `<span class="material-symbols-outlined" aria-hidden="true">chevron_right</span>`;
            return `${separator}<button type="button" data-folder-id="${escapeHtml(crumb.id || "root")}">${escapeHtml(crumb.name || "My Files")}</button>`;
        }).join("");
        els.breadcrumbs.querySelectorAll("button[data-folder-id]").forEach((button) => {
            button.addEventListener("click", () => void loadFolder(button.dataset.folderId));
        });
    }

    function renderFolders() {
        if (!els.foldersRoot || !els.foldersSection) return;
        els.foldersSection.hidden = state.folders.length === 0;
        els.foldersRoot.innerHTML = state.folders.map((folder) => {
            const selected = state.selectedFolderIds.has(folder.id);
            return `
                <article class="files-row files-folder-card ${selected ? "is-selected" : ""}" data-folder-id="${escapeHtml(folder.id)}" tabindex="0">
                    <label class="files-row-check" aria-label="Select ${escapeHtml(folder.name)}">
                        <input type="checkbox" data-select-folder="${escapeHtml(folder.id)}" ${selected ? "checked" : ""}>
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
        }).join("");

        els.foldersRoot.querySelectorAll(".files-folder-card").forEach((row) => {
            const folder = state.folders.find((item) => item.id === row.dataset.folderId);
            if (!folder) return;
            row.addEventListener("click", (event) => {
                if (isInteractiveTarget(event.target)) return;
                void loadFolder(folder.id);
            });
            row.addEventListener("keydown", (event) => {
                if (event.key === "Enter" && !isInteractiveTarget(event.target)) {
                    event.preventDefault();
                    void loadFolder(folder.id);
                }
            });
            row.addEventListener("dragover", (event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                event.stopPropagation();
                row.classList.add("is-folder-drag-target");
            });
            row.addEventListener("dragleave", () => row.classList.remove("is-folder-drag-target"));
            row.addEventListener("drop", (event) => {
                if (!hasFiles(event)) return;
                event.preventDefault();
                event.stopPropagation();
                row.classList.remove("is-folder-drag-target");
                openUploadModal(folder.id, Array.from(event.dataTransfer?.files || []));
            });
        });
        els.foldersRoot.querySelectorAll("[data-select-folder]").forEach((checkbox) => {
            checkbox.addEventListener("change", () => {
                setSelection("folder", checkbox.dataset.selectFolder, checkbox.checked);
            });
        });
        els.foldersRoot.querySelectorAll("[data-folder-menu]").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const folder = state.folders.find((item) => item.id === button.dataset.folderMenu);
                if (folder) openFolderMenu(button, folder);
            });
        });
    }

    function renderFiles() {
        if (!els.filesRoot || !els.filesSection) return;
        els.filesSection.hidden = state.files.length === 0;
        els.filesRoot.innerHTML = state.files.map((file) => {
            const selected = state.selectedFileIds.has(file.id);
            return `
                <article class="files-row files-file-card ${selected ? "is-selected" : ""}" data-file-id="${escapeHtml(file.id)}">
                    <label class="files-row-check" aria-label="Select ${escapeHtml(file.filename)}">
                        <input type="checkbox" data-select-file="${escapeHtml(file.id)}" ${selected ? "checked" : ""}>
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
        }).join("");

        els.filesRoot.querySelectorAll("[data-select-file]").forEach((checkbox) => {
            checkbox.addEventListener("change", () => {
                setSelection("file", checkbox.dataset.selectFile, checkbox.checked);
            });
        });
        els.filesRoot.querySelectorAll("[data-file-menu]").forEach((button) => {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const file = state.files.find((item) => item.id === button.dataset.fileMenu);
                if (file) openFileMenu(button, file);
            });
        });
    }

    function renderEmptyState() {
        if (!els.empty) return;
        const hasContent = state.folders.length > 0 || state.files.length > 0;
        els.empty.hidden = hasContent || !els.loading?.hidden;
    }

    function setLoading(isLoading) {
        if (els.loading) els.loading.hidden = !isLoading;
        if (isLoading) {
            if (els.foldersSection) els.foldersSection.hidden = true;
            if (els.filesSection) els.filesSection.hidden = true;
            if (els.empty) els.empty.hidden = true;
        }
    }

    function toggleNewMenu() {
        if (!els.newMenu) return;
        const nextHidden = !els.newMenu.hidden ? true : false;
        els.newMenu.hidden = nextHidden;
        els.newButton?.setAttribute("aria-expanded", String(!nextHidden));
    }

    function closeNewMenu() {
        if (!els.newMenu) return;
        els.newMenu.hidden = true;
        els.newButton?.setAttribute("aria-expanded", "false");
    }

    function openFileMenu(anchor, file) {
        const items = [
            {
                label: "Download",
                icon: "download",
                onClick: () => downloadFile(file.id),
            },
            {
                label: "Share/Expiry",
                icon: "group_add",
                onClick: () => openShareModal("file", file),
            },
            {
                label: "Rename",
                icon: "edit",
                onClick: () => openFolderModal("file-rename", file),
            },
            {
                label: "Move",
                icon: "drive_file_move",
                onClick: () => openMoveModal({ type: "file", fileIds: [file.id], folderIds: [] }),
            },
        ];
        items.push({
            label: "Delete",
            icon: "delete",
            danger: true,
            onClick: () => openFileDeleteConfirm(file),
        });
        openActionMenu(anchor, items);
    }

    function openFolderMenu(anchor, folder) {
        const items = [
            {
                label: "Share",
                icon: "group_add",
                onClick: () => openShareModal("folder", folder),
            },
            {
                label: "Rename",
                icon: "edit",
                onClick: () => openFolderModal("folder-rename", folder),
            },
            {
                label: "Move",
                icon: "drive_file_move",
                onClick: () => openMoveModal({ type: "folder", fileIds: [], folderIds: [folder.id] }),
            },
            {
                label: "Download folder",
                icon: "folder_zip",
                onClick: () => { window.location.href = `/api/files/folders/${encodeURIComponent(folder.id)}/download.zip`; },
            },
        ];
        items.push({
            label: "Delete",
            icon: "delete",
            danger: true,
            onClick: () => openFolderDeleteConfirm(folder),
        });
        openActionMenu(anchor, items);
    }

    function openActionMenu(anchor, items) {
        closeActionMenu();
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
                closeActionMenu();
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

    function closeActionMenu() {
        state.actionMenu?.remove();
        state.actionMenu = null;
        state.actionMenuAnchor = null;
    }

    function openFolderModal(mode, item = null) {
        state.folderModalMode = { mode, item };
        clearFormError(els.folderError);
        const label = els.folderName?.closest(".files-field")?.querySelector("span");
        if (mode === "folder-create") {
            if (els.folderModalTitle) els.folderModalTitle.textContent = "New folder";
            if (els.folderModalSubtitle) els.folderModalSubtitle.textContent = `Create a folder in ${state.currentFolder?.name || "My Files"}.`;
            if (els.folderSave) els.folderSave.textContent = "Create folder";
            if (els.folderName) els.folderName.value = "";
            if (label) label.textContent = "Folder name";
        } else if (mode === "folder-rename") {
            if (els.folderModalTitle) els.folderModalTitle.textContent = "Rename folder";
            if (els.folderModalSubtitle) els.folderModalSubtitle.textContent = "Update this folder name.";
            if (els.folderSave) els.folderSave.textContent = "Save";
            if (els.folderName) els.folderName.value = item?.name || "";
            if (label) label.textContent = "Folder name";
        } else {
            if (els.folderModalTitle) els.folderModalTitle.textContent = "Rename file";
            if (els.folderModalSubtitle) els.folderModalSubtitle.textContent = "Update this file name.";
            if (els.folderSave) els.folderSave.textContent = "Save";
            if (els.folderName) els.folderName.value = item?.filename || "";
            if (label) label.textContent = "File name";
        }
        openModal(els.folderModal, els.folderName);
    }

    async function saveFolderModal() {
        const name = (els.folderName?.value || "").trim();
        if (!name) {
            showFormError(els.folderError, "Name cannot be empty.");
            return;
        }
        const mode = state.folderModalMode?.mode;
        const item = state.folderModalMode?.item;
        setButtonBusy(els.folderSave, true);
        try {
            if (mode === "folder-create") {
                await apiJson("/api/files/folders", {
                    method: "POST",
                    body: JSON.stringify({ name, parentFolderId: state.currentFolderId }),
                });
            } else if (mode === "folder-rename") {
                await apiJson(`/api/files/folders/${encodeURIComponent(item.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ name }),
                });
            } else {
                await apiJson(`/api/files/my/${encodeURIComponent(item.id)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ filename: name }),
                });
            }
            closeModal(els.folderModal);
            await loadFolder(state.currentFolderId);
            showAlert(mode === "folder-create" ? "Folder created." : mode === "folder-rename" ? "Folder renamed." : "File renamed.");
        } catch (error) {
            showFormError(els.folderError, error.message || "Unable to save.");
        } finally {
            setButtonBusy(els.folderSave, false);
        }
    }

    function openMoveModal(context) {
        state.moveContext = context;
        clearFormError(els.moveError);
        const total = (context.fileIds?.length || 0) + (context.folderIds?.length || 0);
        const title = total > 1 ? "Move items" : "Move item";
        if (els.moveTitle) els.moveTitle.textContent = title;
        if (els.moveSubtitle) els.moveSubtitle.textContent = "Choose a destination folder.";
        renderMoveDestinations(context);
        openModal(els.moveModal, els.moveDestination);
    }

    function renderMoveDestinations(context) {
        if (!els.moveDestination) return;
        const excludeIds = new Set(context.folderIds || []);
        const allFoldersById = new Map(state.allFolders.map((folder) => [folder.id, folder]));
        for (const folderId of Array.from(excludeIds)) {
            for (const folder of state.allFolders) {
                if (isDescendantFolder(allFoldersById, folderId, folder.id)) {
                    excludeIds.add(folder.id);
                }
            }
        }
        const options = flattenFolders().filter((folder) => !excludeIds.has(folder.id));
        els.moveDestination.innerHTML = [
            `<option value="root">My Files</option>`,
            ...options.map((folder) => `<option value="${escapeHtml(folder.id)}">${escapeHtml(`${"  ".repeat(folder.depth)}${folder.name}`)}</option>`),
        ].join("");
    }

    async function saveMoveModal() {
        const destination = normalizeFolderId(els.moveDestination?.value);
        const context = state.moveContext;
        if (!context) return;
        setButtonBusy(els.moveSave, true);
        try {
            for (const fileId of context.fileIds || []) {
                await apiJson(`/api/files/my/${encodeURIComponent(fileId)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ folderId: destination }),
                });
            }
            for (const folderId of context.folderIds || []) {
                await apiJson(`/api/files/folders/${encodeURIComponent(folderId)}`, {
                    method: "PATCH",
                    body: JSON.stringify({ parentFolderId: destination }),
                });
            }
            closeModal(els.moveModal);
            clearSelection();
            await loadFolder(state.currentFolderId);
            showAlert("Moved.");
        } catch (error) {
            showFormError(els.moveError, error.message || "Unable to move item.");
        } finally {
            setButtonBusy(els.moveSave, false);
        }
    }

    function openUploadModal(folderId = state.currentFolderId, files = []) {
        state.uploadTargetFolderId = normalizeFolderId(folderId);
        state.uploadTargetName = getFolderName(state.uploadTargetFolderId);
        state.uploadItems = [];
        if (els.uploadTarget) els.uploadTarget.textContent = state.uploadTargetName;
        clearFormError(els.uploadError);
        resetProgress();
        renderUploadItems();
        openModal(els.uploadModal, els.dropzone);
        if (files.length) addUploadFiles(files);
    }

    function addUploadFiles(files) {
        clearFormError(els.uploadError);
        const incoming = Array.from(files || []).filter(Boolean);
        if (!incoming.length) return;
        const remaining = MAX_UPLOAD_FILES - state.uploadItems.length;
        if (remaining <= 0) {
            showFormError(els.uploadError, `You can upload up to ${MAX_UPLOAD_FILES} files at once.`);
            return;
        }
        const accepted = incoming.slice(0, remaining);
        if (incoming.length > remaining) {
            showFormError(els.uploadError, `Only ${remaining} more file${remaining === 1 ? "" : "s"} can be added.`);
        }
        accepted.forEach((file) => {
            state.uploadItems.push({
                id: `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                file,
                name: file.name,
                visibility: "private",
                expiryDays: String(DEFAULT_EXPIRY),
            });
        });
        renderUploadItems();
    }

    function renderUploadItems() {
        if (!els.selectedList) return;
        if (!state.uploadItems.length) {
            els.selectedList.innerHTML = "";
            return;
        }
        els.selectedList.innerHTML = state.uploadItems.map((item) => `
            <article class="files-selected-item" data-upload-id="${escapeHtml(item.id)}">
                <label class="files-field">
                    <span>Filename</span>
                    <input type="text" data-upload-name value="${escapeHtml(item.name)}" maxlength="255">
                </label>
                <span class="files-upload-size">${escapeHtml(formatBytes(item.file.size))}</span>
                <div class="files-selected-controls">
                    <label class="files-field">
                        <span>Visibility</span>
                        <select data-upload-visibility>
                            <option value="private" ${item.visibility === "private" ? "selected" : ""}>Private</option>
                            <option value="public" ${item.visibility === "public" ? "selected" : ""}>Public link</option>
                        </select>
                    </label>
                    <label class="files-field">
                        <span>Expires</span>
                        <select data-upload-expiry>
                            ${ALLOWED_EXPIRY.map((days) => `<option value="${days}" ${String(days) === String(item.expiryDays) ? "selected" : ""}>${days} day${Number(days) === 1 ? "" : "s"}</option>`).join("")}
                        </select>
                    </label>
                    <button class="files-icon-button" type="button" data-upload-remove aria-label="Remove ${escapeHtml(item.name)}">
                        <span class="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </div>
            </article>
        `).join("");

        els.selectedList.querySelectorAll(".files-selected-item").forEach((row) => {
            const item = state.uploadItems.find((candidate) => candidate.id === row.dataset.uploadId);
            if (!item) return;
            row.querySelector("[data-upload-name]")?.addEventListener("input", (event) => {
                item.name = event.target.value;
            });
            row.querySelector("[data-upload-visibility]")?.addEventListener("change", (event) => {
                item.visibility = event.target.value;
            });
            row.querySelector("[data-upload-expiry]")?.addEventListener("change", (event) => {
                item.expiryDays = event.target.value;
            });
            row.querySelector("[data-upload-remove]")?.addEventListener("click", () => {
                state.uploadItems = state.uploadItems.filter((candidate) => candidate.id !== item.id);
                renderUploadItems();
            });
        });
    }

    async function uploadSelectedFiles() {
        clearFormError(els.uploadError);
        if (!state.uploadItems.length) {
            showFormError(els.uploadError, "Select at least one file to upload.");
            return;
        }
        for (const item of state.uploadItems) {
            if (!item.name.trim()) {
                showFormError(els.uploadError, "Filename cannot be empty.");
                return;
            }
            if (item.file.size > MAX_FILE_SIZE_BYTES) {
                showFormError(els.uploadError, `${item.file.name} exceeds the 50 MB limit.`);
                return;
            }
            if (item.file.size === 0) {
                showFormError(els.uploadError, `${item.file.name} is empty.`);
                return;
            }
        }

        const formData = new FormData();
        formData.append("folderId", state.uploadTargetFolderId || "root");
        state.uploadItems.forEach((item) => {
            formData.append("file", item.file);
            formData.append("filename", item.name.trim());
            formData.append("visibility", item.visibility);
            formData.append("expiryDays", item.expiryDays);
        });

        setButtonBusy(els.uploadButton, true);
        showProgress(0);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/files/upload", true);
        xhr.responseType = "json";
        xhr.upload.onprogress = (event) => {
            if (!event.lengthComputable) return;
            showProgress(Math.round((event.loaded / event.total) * 100));
        };
        xhr.onload = async () => {
            setButtonBusy(els.uploadButton, false);
            resetProgress();
            const payload = xhr.response || {};
            if (xhr.status < 200 || xhr.status >= 300) {
                showFormError(els.uploadError, payload.error || firstUploadError(payload) || "Upload failed.");
                return;
            }
            closeModal(els.uploadModal);
            await loadFolder(state.currentFolderId);
            if (payload.errors?.length) {
                showAlert(firstUploadError(payload) || "Some files could not be uploaded.", "error");
            } else {
                showAlert("Upload complete.");
            }
        };
        xhr.onerror = () => {
            setButtonBusy(els.uploadButton, false);
            resetProgress();
            showFormError(els.uploadError, "Upload failed.");
        };
        xhr.send(formData);
    }

    function openFileDeleteConfirm(file) {
        openConfirm({
            title: "Delete file?",
            message: `${file.filename} will be permanently deleted.`,
            submitLabel: "Delete",
            onConfirm: async () => {
                await apiJson(`/api/files/my/${encodeURIComponent(file.id)}`, { method: "DELETE" });
                state.selectedFileIds.delete(file.id);
                await loadFolder(state.currentFolderId);
                showAlert("File deleted.");
            },
        });
    }

    function openFolderDeleteConfirm(folder) {
        openConfirm({
            title: "Delete folder?",
            message: `${folder.name} and everything inside it will be permanently deleted. Type the folder name to confirm.`,
            submitLabel: "Delete",
            requiredText: folder.name,
            requiredLabel: "Type the folder name",
            onConfirm: async () => {
                await apiJson(`/api/files/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" });
                state.selectedFolderIds.delete(folder.id);
                await loadFolder(state.currentFolderId);
                showAlert("Folder deleted.");
            },
        });
    }

    function openBulkDeleteConfirm() {
        const fileIds = Array.from(state.selectedFileIds);
        const folderIds = Array.from(state.selectedFolderIds);
        if (!fileIds.length && !folderIds.length) return;
        const requiresText = folderIds.length > 0;
        openConfirm({
            title: "Delete selected items?",
            message: requiresText
                ? "Selected folders and files will be permanently deleted. Type DELETE to confirm."
                : "Selected files will be permanently deleted.",
            submitLabel: "Delete",
            requiredText: requiresText ? "DELETE" : "",
            requiredLabel: "Type DELETE",
            onConfirm: async () => {
                for (const fileId of fileIds) {
                    await apiJson(`/api/files/my/${encodeURIComponent(fileId)}`, { method: "DELETE" });
                }
                for (const folderId of folderIds) {
                    await apiJson(`/api/files/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" });
                }
                clearSelection();
                await loadFolder(state.currentFolderId);
                showAlert("Selected items deleted.");
            },
        });
    }

    function openConfirm(options) {
        state.confirmContext = options;
        if (els.confirmTitle) els.confirmTitle.textContent = options.title || "Confirm action";
        if (els.confirmMessage) els.confirmMessage.textContent = options.message || "";
        if (els.confirmSubmit) els.confirmSubmit.textContent = options.submitLabel || "Confirm";
        clearFormError(els.confirmError);
        if (options.requiredText) {
            if (els.confirmField) els.confirmField.hidden = false;
            if (els.confirmFieldLabel) els.confirmFieldLabel.textContent = options.requiredLabel || "Type to confirm";
            if (els.confirmInput) els.confirmInput.value = "";
        } else {
            if (els.confirmField) els.confirmField.hidden = true;
        }
        openModal(els.confirmModal, options.requiredText ? els.confirmInput : els.confirmSubmit);
    }

    async function runConfirmAction() {
        const options = state.confirmContext;
        if (!options) return;
        if (options.requiredText && (els.confirmInput?.value || "") !== options.requiredText) {
            showFormError(els.confirmError, "Confirmation text does not match.");
            return;
        }
        setButtonBusy(els.confirmSubmit, true);
        try {
            await options.onConfirm?.();
            closeModal(els.confirmModal);
        } catch (error) {
            showFormError(els.confirmError, error.message || "Unable to complete action.");
        } finally {
            setButtonBusy(els.confirmSubmit, false);
        }
    }

    function openShareModal(type, item) {
        state.shareContext = { type, item };
        clearFormError(els.shareError);
        renderShareModal();
        openModal(els.shareModal, els.shareVisibility);
    }

    function renderShareModal() {
        const context = state.shareContext;
        if (!context?.item) return;
        const { type, item } = context;
        const isFile = type === "file";
        const name = isFile ? item.filename : item.name;
        if (els.shareTitle) els.shareTitle.textContent = isFile ? "Share/Expiry" : "Share";
        if (els.shareSubtitle) {
            els.shareSubtitle.textContent = isFile
                ? "Manage public link access and expiration for this file."
                : "Manage public link access for this folder.";
        }
        if (els.shareName) els.shareName.textContent = name || "Selected item";
        if (els.shareStatus) {
            els.shareStatus.textContent = item.isPublic
                ? `Public link active${isFile ? ` / ${formatExpiry(item.expiresAt)}` : ""}`
                : `${isFile ? "File" : "Folder"} is private`;
        }
        if (els.shareVisibility) {
            els.shareVisibility.checked = Boolean(item.isPublic);
            els.shareVisibility.setAttribute("aria-label", item.isPublic ? "Make private" : "Create public link");
        }
        if (els.shareExpiryField) els.shareExpiryField.hidden = !isFile;
        if (els.folderShareNote) els.folderShareNote.hidden = isFile;
        if (els.shareExpiry && isFile) {
            const selected = expiryOptionForDate(item.expiresAt);
            els.shareExpiry.innerHTML = ALLOWED_EXPIRY.map((days) => {
                const value = String(days);
                return `<option value="${value}" ${value === selected ? "selected" : ""}>${days} day${Number(days) === 1 ? "" : "s"} from now</option>`;
            }).join("");
        }
        const hasLink = Boolean(item.isPublic && item.shareUrl);
        if (els.shareLinkWrap) els.shareLinkWrap.hidden = !hasLink;
        if (els.shareLink) els.shareLink.value = hasLink ? item.shareUrl : "";
    }

    async function saveShareVisibility() {
        const context = state.shareContext;
        if (!context?.item || !els.shareVisibility) return;
        const visibility = els.shareVisibility.checked ? "public" : "private";
        const endpoint = context.type === "file"
            ? `/api/files/my/${encodeURIComponent(context.item.id)}/visibility`
            : `/api/files/folders/${encodeURIComponent(context.item.id)}/visibility`;
        setShareBusy(true);
        clearFormError(els.shareError);
        try {
            const updated = await apiJson(endpoint, {
                method: "POST",
                body: JSON.stringify({ visibility }),
            });
            updateSharedItem(context.type, updated);
            showAlert(visibility === "public" ? "Public link enabled." : "Link disabled.");
        } catch (error) {
            showFormError(els.shareError, error.message || "Unable to update sharing.");
            renderShareModal();
        } finally {
            setShareBusy(false);
        }
    }

    async function saveShareExpiry() {
        const context = state.shareContext;
        if (context?.type !== "file" || !context.item || !els.shareExpiry) return;
        const expiryDays = els.shareExpiry.value;
        setShareBusy(true);
        clearFormError(els.shareError);
        try {
            const updated = await apiJson(`/api/files/my/${encodeURIComponent(context.item.id)}`, {
                method: "PATCH",
                body: JSON.stringify({ expiryDays }),
            });
            updateSharedItem("file", updated);
            showAlert("Expiration updated.");
        } catch (error) {
            showFormError(els.shareError, error.message || "Unable to update expiration.");
            renderShareModal();
        } finally {
            setShareBusy(false);
        }
    }

    async function copyCurrentShareLink() {
        const link = state.shareContext?.item?.shareUrl;
        if (!link) return;
        await copyShareLink(link);
    }

    function updateSharedItem(type, updated) {
        if (!updated?.id || !state.shareContext) return;
        if (type === "file") {
            state.files = state.files.map((file) => file.id === updated.id ? { ...file, ...updated } : file);
        } else {
            state.folders = state.folders.map((folder) => folder.id === updated.id ? { ...folder, ...updated } : folder);
            state.allFolders = state.allFolders.map((folder) => folder.id === updated.id ? { ...folder, ...updated } : folder);
        }
        state.shareContext.item = type === "file"
            ? state.files.find((file) => file.id === updated.id) || updated
            : state.folders.find((folder) => folder.id === updated.id)
                || state.allFolders.find((folder) => folder.id === updated.id)
                || updated;
        renderManager();
        renderShareModal();
    }

    function setShareBusy(busy) {
        if (els.shareVisibility) els.shareVisibility.disabled = busy;
        if (els.shareExpiry) els.shareExpiry.disabled = busy;
        if (els.copyShareButton) els.copyShareButton.disabled = busy || !state.shareContext?.item?.shareUrl;
    }

    async function setFolderVisibility(folder, visibility, copyAfter = false) {
        try {
            const updated = await apiJson(`/api/files/folders/${encodeURIComponent(folder.id)}/visibility`, {
                method: "POST",
                body: JSON.stringify({ visibility }),
            });
            if (copyAfter && updated.shareUrl) {
                await copyText(updated.shareUrl);
                await loadFolder(state.currentFolderId);
                showAlert("Folder link copied.");
            } else {
                await loadFolder(state.currentFolderId);
                showAlert(visibility === "public" ? "Folder link created." : "Folder made private.");
            }
        } catch (error) {
            showAlert(error.message || "Unable to update folder sharing.", "error");
        }
    }

    async function copyShareLink(url) {
        try {
            await copyText(url);
            showAlert("Link copied.");
        } catch (error) {
            showAlert("Unable to copy link.", "error");
        }
    }

    function downloadFile(fileId) {
        window.location.href = `/api/files/my/${encodeURIComponent(fileId)}/download`;
    }

    async function downloadSelectedFiles() {
        const fileIds = Array.from(state.selectedFileIds);
        if (!fileIds.length) {
            showAlert("Select at least one file to download.", "error");
            return;
        }
        if (fileIds.length === 1) {
            downloadFile(fileIds[0]);
            return;
        }
        try {
            setButtonBusy(els.bulkDownload, true);
            const response = await fetch("/api/files/bulk-download.zip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fileIds }),
            });
            if (!response.ok) {
                let message = "Unable to download selected files.";
                try {
                    const payload = await response.json();
                    message = payload.error || message;
                } catch (_error) {
                    message = response.statusText || message;
                }
                throw new Error(message);
            }
            const blob = await response.blob();
            downloadBlob(blob, filenameFromDisposition(response.headers.get("Content-Disposition")) || "file-share-selected.zip");
        } catch (error) {
            showAlert(error.message || "Unable to download selected files.", "error");
        } finally {
            setButtonBusy(els.bulkDownload, false);
        }
    }

    function setSelection(type, id, selected) {
        if (!id) return;
        const target = type === "file" ? state.selectedFileIds : state.selectedFolderIds;
        if (selected) target.add(id);
        else target.delete(id);
        updateRowSelection(type, id, selected);
        updateSelectionBar();
    }

    function updateRowSelection(type, id, selected) {
        const selector = type === "file" ? `[data-file-id="${cssEscape(id)}"]` : `[data-folder-id="${cssEscape(id)}"]`;
        document.querySelector(selector)?.classList.toggle("is-selected", selected);
    }

    function clearSelection() {
        state.selectedFileIds.clear();
        state.selectedFolderIds.clear();
        document.querySelectorAll("[data-select-file], [data-select-folder]").forEach((checkbox) => {
            checkbox.checked = false;
        });
        document.querySelectorAll(".files-row.is-selected").forEach((row) => row.classList.remove("is-selected"));
        updateSelectionBar();
    }

    function updateSelectionBar() {
        const total = selectedTotal();
        if (els.selectionBar) els.selectionBar.hidden = total === 0;
        if (els.selectionCount) els.selectionCount.textContent = `${formatCount(total, "item")} selected`;
        if (els.bulkMove) els.bulkMove.disabled = total === 0;
        if (els.bulkDelete) els.bulkDelete.disabled = total === 0;
        if (els.bulkDownload) {
            els.bulkDownload.disabled = state.selectedFileIds.size === 0;
            els.bulkDownload.title = state.selectedFileIds.size === 0 ? "Select at least one file to download" : "";
        }
    }

    function selectedTotal() {
        return state.selectedFileIds.size + state.selectedFolderIds.size;
    }

    function openModal(modal, focusTarget = null) {
        if (!modal) return;
        state.lastFocusedElement = document.activeElement;
        modal.hidden = false;
        state.activeModal = modal;
        document.body.classList.add("files-modal-open");
        requestAnimationFrame(() => {
            const target = focusTarget || modal.querySelector("input, select, button, [tabindex]:not([tabindex='-1'])");
            target?.focus({ preventScroll: true });
        });
    }

    function closeModal(modal) {
        if (!modal) return;
        modal.hidden = true;
        if (state.activeModal === modal) state.activeModal = null;
        if (!document.querySelector(".files-modal:not([hidden])")) {
            document.body.classList.remove("files-modal-open");
        }
        state.lastFocusedElement?.focus?.({ preventScroll: true });
    }

    function showAlert(message, type = "info") {
        if (!els.alert) return;
        els.alert.textContent = message;
        els.alert.hidden = false;
        els.alert.classList.toggle("files-alert-error", type === "error");
    }

    function clearAlert() {
        if (!els.alert) return;
        els.alert.hidden = true;
        els.alert.textContent = "";
        els.alert.classList.remove("files-alert-error");
    }

    function showFormError(element, message) {
        if (!element) return;
        element.textContent = message;
        element.hidden = false;
    }

    function clearFormError(element) {
        if (!element) return;
        element.textContent = "";
        element.hidden = true;
    }

    function setButtonBusy(button, busy) {
        if (!button) return;
        button.disabled = busy;
        button.classList.toggle("is-busy", busy);
    }

    function showProgress(percent) {
        if (els.progressWrap) els.progressWrap.hidden = false;
        if (els.progressBar) els.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    }

    function resetProgress() {
        if (els.progressWrap) els.progressWrap.hidden = true;
        if (els.progressBar) els.progressBar.style.width = "0%";
    }

    async function apiJson(url, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
            headers["Content-Type"] = "application/json";
        }
        const response = await fetch(url, {
            ...options,
            headers,
        });
        const contentType = response.headers.get("Content-Type") || "";
        const payload = contentType.includes("application/json") ? await response.json() : null;
        if (!response.ok) {
            throw new Error(payload?.error || payload?.message || response.statusText || "Request failed.");
        }
        return payload || {};
    }

    function flattenFolders() {
        const childrenByParent = new Map();
        state.allFolders.forEach((folder) => {
            const parent = normalizeFolderId(folder.parentFolderId);
            if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
            childrenByParent.get(parent).push(folder);
        });
        const flattened = [];
        const visit = (parentId, depth) => {
            const children = childrenByParent.get(parentId) || [];
            children.forEach((folder) => {
                flattened.push({ ...folder, depth });
                visit(folder.id, depth + 1);
            });
        };
        visit(null, 0);
        return flattened;
    }

    function isDescendantFolder(foldersById, folderId, possibleDescendantId) {
        let currentId = normalizeFolderId(possibleDescendantId);
        const targetId = normalizeFolderId(folderId);
        const seen = new Set();
        while (currentId && !seen.has(currentId)) {
            if (currentId === targetId) return true;
            seen.add(currentId);
            currentId = normalizeFolderId(foldersById.get(currentId)?.parentFolderId);
        }
        return false;
    }

    function getFolderName(folderId) {
        const normalized = normalizeFolderId(folderId);
        if (!normalized) return "My Files";
        if (state.currentFolder?.id === normalized) return state.currentFolder.name;
        return state.allFolders.find((folder) => folder.id === normalized)?.name || "Selected folder";
    }

    function normalizeFolderId(value) {
        if (value === null || value === undefined) return null;
        const text = String(value).trim();
        if (!text || ["root", "none", "null", "undefined"].includes(text.toLowerCase())) return null;
        return text;
    }

    function hasFiles(event) {
        return Array.from(event.dataTransfer?.types || []).includes("Files");
    }

    function isInteractiveTarget(target) {
        return Boolean(target.closest("button, a, input, select, textarea, label"));
    }

    function fileIcon(file) {
        const mime = file.mimeType || "";
        if (mime.startsWith("image/")) return "image";
        if (mime.includes("pdf")) return "picture_as_pdf";
        if (mime.includes("zip") || mime.includes("compressed")) return "folder_zip";
        return "description";
    }

    function formatFolderStatus(folder) {
        return `${folder.isPublic ? "Shared" : "Private"} / No folder expiry`;
    }

    function formatFileStatus(file) {
        return `${file.isPublic ? "Shared" : "Private"} / ${formatExpiry(file.expiresAt)}`;
    }

    function formatFolderCounts(folder) {
        const folders = Number(folder.folderCount) || 0;
        const files = Number(folder.fileCount) || 0;
        if (!folders && !files) return "Empty folder";
        return `${formatCount(folders, "folder")} / ${formatCount(files, "file")}`;
    }

    function formatCount(count, label) {
        const number = Number(count) || 0;
        return `${number.toLocaleString()} ${label}${number === 1 ? "" : "s"}`;
    }

    function formatBytes(bytes) {
        const number = Number(bytes) || 0;
        if (number < 1024) return `${number} B`;
        const units = ["KB", "MB", "GB"];
        let value = number / 1024;
        for (const unit of units) {
            if (value < 1024 || unit === units[units.length - 1]) {
                return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
            }
            value /= 1024;
        }
        return `${number} B`;
    }

    function formatDateTime(value) {
        if (!value) return "Unknown";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Unknown";
        return date.toLocaleString([], {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
        });
    }

    function formatExpiry(value) {
        if (!value) return "No expiry";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "Expiry unknown";
        return `Expires ${date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
    }

    function expiryOptionForDate(value) {
        const fallback = String(DEFAULT_EXPIRY);
        if (!value) return fallback;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return fallback;
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysRemaining = Math.max(1, Math.ceil((date.getTime() - Date.now()) / msPerDay));
        if (ALLOWED_EXPIRY.includes(daysRemaining)) return String(daysRemaining);
        const closest = ALLOWED_EXPIRY.reduce((best, days) => (
            Math.abs(days - daysRemaining) < Math.abs(best - daysRemaining) ? days : best
        ), Number(DEFAULT_EXPIRY) || ALLOWED_EXPIRY[0]);
        return String(closest);
    }

    function formatRelative(value) {
        if (!value) return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "";
        const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (diffSeconds < 60) return "less than a minute ago";
        const diffMinutes = Math.floor(diffSeconds / 60);
        if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
        const diffHours = Math.floor(diffMinutes / 60);
        if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
        return formatDateTime(value);
    }

    function firstUploadError(payload) {
        return payload?.errors?.[0]?.error || "";
    }

    async function copyText(text) {
        if (!text) return;
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const input = document.createElement("input");
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function filenameFromDisposition(header) {
        if (!header) return "";
        const utfMatch = header.match(/filename\*=UTF-8''([^;]+)/i);
        if (utfMatch) return decodeURIComponent(utfMatch[1].replace(/"/g, ""));
        const asciiMatch = header.match(/filename="?([^";]+)"?/i);
        return asciiMatch ? asciiMatch[1] : "";
    }

    function cssEscape(value) {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/["\\]/g, "\\$&");
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
    }
})();
