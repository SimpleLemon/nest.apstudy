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
    const asciiMatch = header.match(/filename="?([^";]+)"?/i);
    if (utfMatch) {
        const encodedFilename = utfMatch[1].replace(/"/g, "");
        try {
            return decodeURIComponent(encodedFilename);
        } catch {
            return asciiMatch ? asciiMatch[1] : encodedFilename;
        }
    }
    return asciiMatch ? asciiMatch[1] : "";
}

// Owns single-file navigation and selected-file archive downloads.
export function createDownloadWorkflow({ state, els, view }) {
    const { setButtonBusy, showAlert } = view;
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
                } catch {
                    message = response.statusText || message;
                }
                throw new Error(message);
            }
            const blob = await response.blob();
            downloadBlob(blob, filenameFromDisposition(response.headers.get("Content-Disposition")) || "file-share-selected.zip");
        } catch (error) {
            showAlert(error.message || "Try again in a moment.", "error", { title: "Couldn’t download files" });
        } finally {
            setButtonBusy(els.bulkDownload, false);
        }
    }

    return { downloadFile, downloadSelectedFiles };
}
