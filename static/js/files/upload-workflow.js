function firstUploadError(payload) {
    return payload?.errors?.[0]?.error || "";
}

function parseUploadResponse(xhr) {
    if (!xhr) return null;
    const responseType = String(xhr.responseType || "").toLowerCase();
    if (responseType === "json") {
        return xhr.response && typeof xhr.response === "object" ? xhr.response : null;
    }
    let contentType = "";
    try {
        contentType = xhr.getResponseHeader?.("Content-Type") || "";
    } catch {
        contentType = "";
    }
    if (!responseType && contentType.toLowerCase().includes("json") && xhr.response && typeof xhr.response === "object") {
        return xhr.response;
    }
    if (responseType && responseType !== "text") return null;
    let raw = "";
    try {
        raw = responseType === "text" && typeof xhr.response === "string"
            ? xhr.response
            : xhr.responseText;
    } catch {
        return null;
    }
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function uploadErrorMessage(xhr, payload) {
    if (payload?.error) return payload.error;
    const firstError = firstUploadError(payload);
    if (firstError) return firstError;
    const status = xhr?.status || 0;
    if (status === 413) return "File is too large for the server upload limit.";
    if (status === 401 || status === 403) return "Session expired. Please sign in again.";
    if (status === 502 || status === 504) return "Upload timed out. Try again or use a smaller file.";
    if (status === 0) return "Network error during upload. Check your connection.";
    if (status) return `Upload failed (HTTP ${status}).`;
    return "Upload failed.";
}

// Owns the upload queue, its form, and the lifetime of an upload request.
export function createUploadWorkflow({ state, els, limits, folders, view }) {
    const { allowedExpiry, defaultExpiry, maxFileSizeBytes, maxFileSizeLabel, maxUploadFiles } = limits;
    const { normalizeFolderId, getFolderName, loadFolder } = folders;
    const { clearFormError, modalController, notify, setButtonBusy, showAlert, uploadItemHtml } = view;
    const queueRemovalActions = new Set();
    let pendingUploadQueue = null;
    function openUploadModal(folderId = state.currentFolderId, files = []) {
        pendingUploadQueue = null;
        state.uploadTargetFolderId = normalizeFolderId(folderId);
        state.uploadTargetName = getFolderName(
            state.uploadTargetFolderId,
            state.currentFolder,
            state.allFolders,
        );
        state.uploadItems = [];
        for (const action of queueRemovalActions) action?.dismiss?.();
        queueRemovalActions.clear();
        if (els.uploadTarget) els.uploadTarget.textContent = state.uploadTargetName;
        clearFormError(els.uploadError);
        setButtonBusy(els.uploadButton, false);
        resetProgress();
        renderUploadItems();
        modalController.open(els.uploadModal, els.dropzone);
        if (files.length) addUploadFiles(files);
    }

    function addUploadFiles(files) {
        clearFormError(els.uploadError);
        const incoming = Array.from(files || []).filter(Boolean);
        if (!incoming.length) return;
        const remaining = maxUploadFiles - state.uploadItems.length;
        if (remaining <= 0) {
            notify(`You can upload up to ${maxUploadFiles} files at once.`, "error", { modalError: els.uploadError });
            return;
        }
        const accepted = incoming.slice(0, remaining);
        if (incoming.length > remaining) {
            notify(`Only ${remaining} more file${remaining === 1 ? "" : "s"} can be added.`, "warning", { modalError: els.uploadError });
        }
        accepted.forEach((file) => {
            state.uploadItems.push({
                id: `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                file,
                name: file.name,
                visibility: "private",
                expiryDays: String(defaultExpiry),
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
        els.selectedList.innerHTML = state.uploadItems
            .map((item) => uploadItemHtml(item, allowedExpiry))
            .join("");

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
                const queue = state.uploadItems;
                const index = queue.findIndex((candidate) => candidate.id === item.id);
                if (index < 0) return;
                const [removedItem] = queue.splice(index, 1);
                renderUploadItems();
                const action = window.APStudyUndo?.stage?.({
                    message: `${removedItem.name || removedItem.file?.name || "File"} removed from this upload.`,
                    restore: () => {
                        if (state.uploadItems !== queue) return;
                        queue.splice(Math.min(index, queue.length), 0, removedItem);
                        renderUploadItems();
                    },
                    onUndo: () => queueRemovalActions.delete(action),
                    onCommit: () => queueRemovalActions.delete(action),
                });
                if (action) queueRemovalActions.add(action);
            });
        });
    }

    async function uploadSelectedFiles() {
        const queue = state.uploadItems;
        if (pendingUploadQueue === queue) return;
        clearFormError(els.uploadError);
        if (!state.uploadItems.length) {
            notify("Select at least one file to upload.", "error", { modalError: els.uploadError });
            return;
        }
        for (const item of state.uploadItems) {
            if (!item.name.trim()) {
                const row = els.selectedList?.querySelector(`[data-upload-id="${item.id}"]`);
                const nameInput = row?.querySelector("[data-upload-name]");
                notify("Filename cannot be empty.", "error", { modalError: els.uploadError, field: nameInput });
                return;
            }
            if (item.file.size > maxFileSizeBytes) {
                notify(`${item.file.name} exceeds the ${maxFileSizeLabel} limit.`, "error", { modalError: els.uploadError });
                return;
            }
            if (item.file.size === 0) {
                notify(`${item.file.name} is empty.`, "error", { modalError: els.uploadError });
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

        pendingUploadQueue = queue;
        const ownsDialog = () => pendingUploadQueue === queue && state.uploadItems === queue;
        setButtonBusy(els.uploadButton, true);
        showProgress(0);
        let xhr = null;
        let cleanedUp = false;
        const cleanupUpload = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            if (!ownsDialog()) return;
            pendingUploadQueue = null;
            setButtonBusy(els.uploadButton, false);
            resetProgress();
        };
        const notifyUploadError = (message) => {
            notify(message, "error", { modalError: ownsDialog() ? els.uploadError : null });
        };
        const reportUploadError = (request, error = null) => {
            const message = error?.message || uploadErrorMessage(request, parseUploadResponse(request));
            notifyUploadError(message || "Upload failed. Try again in a moment.");
        };
        const onProgress = (event) => {
            if (cleanedUp || !ownsDialog() || !event.lengthComputable) return;
            showProgress(Math.round((event.loaded / event.total) * 100));
        };
        // This UI action resolves after feedback and cleanup, including handled
        // failures. Callers can await it without leaving rejected click handlers.
        try {
            xhr = await window.APStudyHttp.uploadXhr("/api/files/upload", {
                method: "POST",
                body: formData,
                responseType: "json",
                onProgress,
                pendingLabel: "file-upload",
            });

            const request = xhr;
            const payload = parseUploadResponse(request);
            if (!(request?.status >= 200 && request?.status < 300)) {
                const message = uploadErrorMessage(request, payload);
                notifyUploadError(message);
                return;
            }
            // A fulfilled transport is not an acknowledgment. The upload API
            // returns created shared-file records; keep the queue open for retry
            // when decoding failed or the required records are absent.
            const validFiles = Array.isArray(payload?.files) && payload.files.length > 0
                && payload.files.every((file) => file && typeof file.id === "string" && file.id.trim()
                    && typeof file.filename === "string" && file.filename.trim());
            const validErrors = payload?.errors === undefined || (Array.isArray(payload.errors)
                && payload.errors.every((error) => error && typeof error.error === "string" && error.error.trim()));
            if (!validFiles || !validErrors) {
                notifyUploadError("The server did not confirm the uploaded files. Try again.");
                return;
            }
            if (ownsDialog()) modalController.close(els.uploadModal);
            await loadFolder(state.currentFolderId);
            if (payload.errors?.length) {
                showAlert(firstUploadError(payload) || "Some files could not be uploaded.", "error");
            } else {
                showAlert("Upload complete.");
            }
        } catch (error) {
            if (error?.name !== "AbortError") {
                const request = error?.xhr || error?.request || error?.currentTarget || xhr;
                reportUploadError(request, error);
            }
        } finally {
            cleanupUpload();
        }
    }

    function showProgress(percent) {
        if (els.progressWrap) els.progressWrap.hidden = false;
        if (els.progressBar) els.progressBar.style.transform = `scaleX(${Math.max(0, Math.min(100, percent)) / 100})`;
    }

    function resetProgress() {
        if (els.progressWrap) els.progressWrap.hidden = true;
        if (els.progressBar) els.progressBar.style.transform = "scaleX(0)";
    }

    return { addUploadFiles, openUploadModal, uploadSelectedFiles };
}
