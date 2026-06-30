(function registerFilesEvents(global) {
    function bindFilesEvents({
        els,
        state,
        actions,
        callbacks,
    }) {
        const {
            addUploadFiles,
            closeModal,
            copyCurrentShareLink,
            downloadSelectedFiles,
            loadFolder,
            openBulkDeleteConfirm,
            openFolderModal,
            openMoveModal,
            openUploadModal,
            runConfirmAction,
            saveFolderModal,
            saveMoveModal,
            saveShareExpiry,
            saveShareVisibility,
            selectedTotal,
            uploadSelectedFiles,
        } = actions;
        const {
            closeActionMenu,
            closeNewMenu,
            hasFiles,
            toggleNewMenu,
        } = callbacks;

        els.refresh?.addEventListener("click", () => void loadFolder(state.currentFolderId));
        els.newButton?.addEventListener("click", (event) => {
            event.stopPropagation();
            toggleNewMenu(els.newMenu, els.newButton);
        });
        els.newFolder?.addEventListener("click", () => {
            closeNewMenu(els.newMenu, els.newButton);
            openFolderModal("folder-create");
        });
        els.fileUpload?.addEventListener("click", () => {
            closeNewMenu(els.newMenu, els.newButton);
            openUploadModal(state.currentFolderId);
        });

        els.selectionClear?.addEventListener("click", actions.clearSelection);
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
                closeNewMenu(els.newMenu, els.newButton);
            }
            if (
                state.actionMenu
                && !state.actionMenu.contains(event.target)
                && !state.actionMenuAnchor?.contains(event.target)
            ) {
                closeActionMenu(state);
            }
        });
        document.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            if (state.actionMenu) {
                closeActionMenu(state);
                return;
            }
            if (els.newMenu && !els.newMenu.hidden) {
                closeNewMenu(els.newMenu, els.newButton);
                els.newButton?.focus({ preventScroll: true });
                return;
            }
            if (state.activeModal) {
                closeModal(state.activeModal);
            }
        });
        global.addEventListener("resize", () => closeActionMenu(state));
        global.addEventListener("scroll", () => closeActionMenu(state), true);
    }

    global.APStudyFilesEvents = {
        bindFilesEvents,
    };
})(window);
