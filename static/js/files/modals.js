(function registerFilesModals(global) {
    function createFilesModals({
        state,
        els,
        callbacks,
    }) {
        const {
            apiJson,
            clearFormError,
            clearSelection,
            escapeHtml,
            flattenFolders,
            formatCount,
            isDescendantFolder,
            loadFolder,
            normalizeFolderId,
            setButtonBusy,
            showAlert,
            showFormError,
            notify,
        } = callbacks;

        function openFolderModal(mode, item = null) {
            state.folderModalMode = { mode, item };
            clearFormError(els.folderError, els.folderName);
            window.APStudyFormField?.clearInvalid?.(els.folderName);
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
                notify("Name cannot be empty.", "error", { modalError: els.folderError, field: els.folderName });
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
                notify(error.message || "Try again in a moment.", "error", { modalError: els.folderError, title: "Couldn’t save changes" });
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
            const options = flattenFolders(state.allFolders).filter((folder) => !excludeIds.has(folder.id));
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
                notify(error.message || "Try again in a moment.", "error", { modalError: els.moveError, title: "Couldn’t move item" });
            } finally {
                setButtonBusy(els.moveSave, false);
            }
        }

        function openConfirm(options) {
            state.confirmContext = options;
            if (els.confirmTitle) els.confirmTitle.textContent = options.title || "Confirm action";
            if (els.confirmMessage) els.confirmMessage.textContent = options.message || "";
            if (els.confirmSubmit) els.confirmSubmit.textContent = options.submitLabel || "Confirm";
            clearFormError(els.confirmError);
            window.APStudyFormField?.clearInvalid?.(els.confirmInput);
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
                notify("Confirmation text does not match.", "error", { modalError: els.confirmError, field: els.confirmInput });
                return;
            }
            setButtonBusy(els.confirmSubmit, true);
            try {
                await options.onConfirm?.();
                closeModal(els.confirmModal);
            } catch (error) {
                notify(error.message || "Try again in a moment.", "error", { modalError: els.confirmError, title: "Couldn’t complete action" });
            } finally {
                setButtonBusy(els.confirmSubmit, false);
            }
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

        return {
            closeModal,
            openConfirm,
            openFolderModal,
            openModal,
            openMoveModal,
            runConfirmAction,
            saveFolderModal,
            saveMoveModal,
        };
    }

    global.APStudyFilesModals = {
        createFilesModals,
    };
})(window);
