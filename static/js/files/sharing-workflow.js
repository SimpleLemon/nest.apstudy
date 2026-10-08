// Owns sharing edits and the local projection of the saved file/folder metadata.
export function createSharingWorkflow({ state, els, expiry, manager, view, links, apiJson }) {
    const { allowedExpiry, defaultExpiry, expiryOptionForDate, formatExpiry, shareExpiryOptionsHtml } = expiry;
    const { loadFolder, renderManager } = manager;
    const { clearFormError, modalController, notify, showAlert } = view;
    const { copyText } = links;
    const acknowledgedShareVersions = new Map();
    let nextShareVersion = 0;
    function openShareModal(type, item) {
        state.shareContext = { type, item };
        clearFormError(els.shareError);
        renderShareModal();
        setShareBusy(false);
        modalController.open(els.shareModal, els.shareVisibility);
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
            const selected = expiryOptionForDate(item.expiresAt, {
                allowedExpiryOptions: allowedExpiry,
                defaultExpiryDays: defaultExpiry,
            });
            els.shareExpiry.innerHTML = shareExpiryOptionsHtml(allowedExpiry, selected);
        }
        const hasLink = Boolean(item.isPublic && item.shareUrl);
        if (els.shareLinkWrap) els.shareLinkWrap.hidden = !hasLink;
        if (els.shareLink) els.shareLink.value = hasLink ? item.shareUrl : "";
    }

    async function saveShareVisibility() {
        const context = state.shareContext;
        if (!context?.item || !els.shareVisibility) return;
        const version = ++nextShareVersion;
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
            updateSharedItem(context, updated, version);
            if (isCurrentShareSession(context)) {
                showAlert(visibility === "public" ? "Public link enabled." : "Link disabled.");
            }
        } catch (error) {
            if (isCurrentShareSession(context)) {
                notify(error.message || "Try again in a moment.", "error", { modalError: els.shareError, title: "Couldn’t update sharing" });
                renderShareModal();
            }
        } finally {
            if (isCurrentShareSession(context)) setShareBusy(false);
        }
    }

    async function saveShareExpiry() {
        const context = state.shareContext;
        if (context?.type !== "file" || !context.item || !els.shareExpiry) return;
        const version = ++nextShareVersion;
        const expiryDays = els.shareExpiry.value;
        setShareBusy(true);
        clearFormError(els.shareError);
        try {
            const updated = await apiJson(`/api/files/my/${encodeURIComponent(context.item.id)}`, {
                method: "PATCH",
                body: JSON.stringify({ expiryDays }),
            });
            updateSharedItem(context, updated, version);
            if (isCurrentShareSession(context)) showAlert("Expiration updated.");
        } catch (error) {
            if (isCurrentShareSession(context)) {
                notify(error.message || "Try again in a moment.", "error", { modalError: els.shareError, title: "Couldn’t update expiration" });
                renderShareModal();
            }
        } finally {
            if (isCurrentShareSession(context)) setShareBusy(false);
        }
    }

    async function copyCurrentShareLink() {
        const link = state.shareContext?.item?.shareUrl;
        if (!link) return;
        await copyShareLink(link);
    }

    function isCurrentShareSession(context) {
        return state.shareContext === context && !els.shareModal?.hidden;
    }

    function updateSharedItem(context, updated, version) {
        if (!updated?.id) return;
        const { type } = context;
        const entityKey = `${type}:${updated.id}`;
        // Visibility and expiry return full metadata. Keep the newest successful
        // invocation's projection when an older response arrives after it.
        if ((acknowledgedShareVersions.get(entityKey) || 0) > version) return;
        acknowledgedShareVersions.set(entityKey, version);
        if (type === "file") {
            state.files = state.files.map((file) => file.id === updated.id ? { ...file, ...updated } : file);
        } else {
            state.folders = state.folders.map((folder) => folder.id === updated.id ? { ...folder, ...updated } : folder);
            state.allFolders = state.allFolders.map((folder) => folder.id === updated.id ? { ...folder, ...updated } : folder);
        }
        renderManager();
        if (isCurrentShareSession(context)) {
            context.item = type === "file"
                ? state.files.find((file) => file.id === updated.id) || updated
                : state.folders.find((folder) => folder.id === updated.id)
                    || state.allFolders.find((folder) => folder.id === updated.id)
                    || updated;
            renderShareModal();
        }
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
            showAlert(error.message || "Try again in a moment.", "error", { title: "Couldn’t update folder sharing" });
        }
    }

    async function copyShareLink(url) {
        try {
            await copyText(url);
            showAlert("Link copied.");
        } catch {
            showAlert("Check your browser permissions and try again.", "error", { title: "Couldn’t copy link" });
        }
    }

    return { copyCurrentShareLink, openShareModal, saveShareExpiry, saveShareVisibility, setFolderVisibility };
}
