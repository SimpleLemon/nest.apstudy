import { escapeHtml } from "../core/ui-primitives-module.js";

const ALLOWED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "pdf", "txt", "md", "markdown", "csv", "json",
  "docx", "xlsx", "pptx", "odt", "ods", "odp", "zip",
]);
const COMPRESSIBLE_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json"]);

function formatBytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / 1024 ** 2).toFixed(1)} MiB`;
}

async function compressedUpload(file) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!("CompressionStream" in window) || !COMPRESSIBLE_EXTENSIONS.has(extension)) {
    return { body: file, encoding: "identity" };
  }
  try {
    const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = await new Response(stream).blob();
    return compressed.size < file.size ? { body: compressed, encoding: "gzip" } : { body: file, encoding: "identity" };
  } catch {
    return { body: file, encoding: "identity" };
  }
}

export function createAttachmentManager() {
  const items = [];
  let state;
  let setStatus;
  let onComposerChange;
  let capabilities = {};
  let paused = false;
  let disposed = false;
  const listeners = [];
  const els = {};

  function listen(target, name, callback) {
    const handler = (event) => { if (!paused && !disposed) callback(event); };
    target?.addEventListener(name, handler);
    listeners.push(() => target?.removeEventListener(name, handler));
  }

  function room() {
    return state?.activeRoom || null;
  }

  function render() {
    if (paused || disposed || !els.list) return;
    els.list.innerHTML = items.map((item) => `
      <article class="chat-upload-chip ${item.status === "error" ? "is-error" : ""}" data-upload-id="${item.localId}">
        <span class="material-symbols-outlined" aria-hidden="true">${item.status === "uploaded" ? "draft" : item.status === "error" ? "error" : "upload"}</span>
        <span class="chat-upload-copy">
          <strong>${escapeHtml(item.file.name)}</strong>
          <small>${item.status === "uploading" ? `Uploading ${item.progress}%` : item.status === "queued" ? "Waiting to upload" : item.status === "error" ? escapeHtml(item.error) : `${formatBytes(item.file.size)} · Ready`}</small>
          ${item.status === "uploading" ? `<span class="chat-upload-progress"><span style="--chat-upload-progress:${Math.max(0, Math.min(100, item.progress)) / 100}"></span></span>` : ""}
        </span>
        ${item.status === "error" ? `<button type="button" data-upload-retry="${item.localId}" aria-label="Retry ${escapeHtml(item.file.name)}"><span class="material-symbols-outlined" aria-hidden="true">refresh</span></button>` : ""}
        <button type="button" data-upload-remove="${item.localId}" aria-label="Remove ${escapeHtml(item.file.name)}"><span class="material-symbols-outlined" aria-hidden="true">close</span></button>
      </article>
    `).join("");
    onComposerChange?.();
  }

  function validate(file) {
    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    if (!ALLOWED_EXTENSIONS.has(extension)) return "This file type is not allowed in chat.";
    const limit = Number(capabilities.max_attachment_size_bytes || 0);
    if (limit && file.size > limit) return `This file exceeds your ${formatBytes(limit)} chat limit.`;
    return "";
  }

  async function upload(item) {
    const activeRoom = room();
    if (paused || disposed || !activeRoom) return;
    item.status = "uploading";
    item.error = "";
    item.progress = 0;
    item.uploadController?.abort();
    const controller = new AbortController();
    item.uploadController = controller;
    const isCurrent = () => !paused && !disposed && !controller.signal.aborted && items.includes(item) && item.uploadController === controller;
    render();
    const prepared = await compressedUpload(item.file);
    if (!isCurrent()) return;
    const form = new FormData();
    form.append("file", prepared.body, item.file.name);
    form.append("scope_type", activeRoom.type);
    form.append("scope_id", activeRoom.id);
    form.append("original_size_bytes", String(item.file.size));
    form.append("content_encoding", prepared.encoding);
    try {
      const xhr = await window.APStudyHttp.uploadXhr("/api/chat/attachments", {
        body: form,
        responseType: "json",
        signal: controller.signal,
        pendingLabel: "chat-attachment-upload",
        onProgress: (event) => {
          if (!event.lengthComputable || !isCurrent()) return;
          item.progress = Math.max(1, Math.round((event.loaded / event.total) * 100));
          render();
        },
      });
      if (!isCurrent()) return;
      const payload = xhr.response || {};
      if (xhr.status === 0) {
        item.status = "error";
        item.error = navigator.onLine ? "Upload failed. Try again." : "You are offline.";
      } else if (xhr.status < 200 || xhr.status >= 300 || !payload.attachment) {
        item.status = "error";
        item.error = payload.error || "Upload failed. Try again.";
      } else {
        item.status = "uploaded";
        item.attachment = payload.attachment;
        item.progress = 100;
      }
    } catch (error) {
      if (!isCurrent()) return;
      item.status = "error";
      item.error = error.name === "AbortError" ? "Upload cancelled." : error.message || "Upload failed. Try again.";
    }
    item.uploadController = null;
    render();
  }

  function addFiles(fileList) {
    if (paused || disposed) return;
    if (!capabilities.attachments) {
      setStatus?.("Attachments are not configured yet.", "error");
      return;
    }
    const available = Math.max(0, Number(capabilities.max_attachments_per_message || 5) - items.length);
    const incoming = Array.from(fileList || []).slice(0, available);
    if (Array.from(fileList || []).length > available) setStatus?.("A message can include at most five attachments.", "error");
    for (const file of incoming) {
      const error = validate(file);
      const item = { localId: crypto.randomUUID(), file, status: error ? "error" : "queued", error, progress: 0 };
      items.push(item);
      if (!error) void upload(item);
    }
    render();
  }

  async function remove(localId, options = {}) {
    const index = items.findIndex((item) => item.localId === localId);
    if (index < 0) return;
    const [item] = items.splice(index, 1);
    item.uploadController?.abort();
    render();
    const commit = ({ reason } = {}) => {
      if (!item.attachment?.id) return Promise.resolve();
      return fetch(`/api/chat/attachments/${encodeURIComponent(item.attachment.id)}`, {
        method: "DELETE",
        keepalive: reason === "pagehide",
      }).then((response) => {
        if (!response.ok) throw new Error("Unable to remove attachment.");
      });
    };
    if (options.notify !== false && window.APStudyUndo?.stage) {
      window.APStudyUndo.stage({
        message: `${item.file.name} removed from this message.`,
        commit,
        restore: () => {
          if (disposed) return;
          items.splice(Math.min(index, items.length), 0, item);
          if (!item.attachment && ["queued", "uploading"].includes(item.status)) {
            item.status = "queued";
            item.progress = 0;
            void upload(item);
          } else {
            render();
          }
        },
        errorTitle: "Couldn’t remove attachment",
      });
      return;
    }
    await commit();
  }

  function pause() {
    if (paused || disposed) return;
    paused = true;
    for (const item of items) {
      item.uploadController?.abort();
      item.uploadController = null;
      if (item.status === "uploading") {
        item.status = "queued";
        item.progress = 0;
      }
    }
    els.composer?.classList.remove("is-dragging");
  }

  return {
    init(context) {
      state = context.state;
      setStatus = context.setStatus;
      onComposerChange = context.onComposerChange;
      els.list = document.getElementById("chat-upload-list");
      els.fileInput = document.getElementById("chat-file-input");
      els.attach = document.getElementById("chat-attach-button");
      els.composer = document.getElementById("chat-composer");
      listen(els.attach, "click", () => {
        if (!capabilities.attachments) {
          setStatus?.("File attachments are temporarily unavailable. Try refreshing the page.", "error");
          return;
        }
        els.fileInput?.click();
      });
      listen(els.fileInput, "change", () => {
        addFiles(els.fileInput.files);
        els.fileInput.value = "";
      });
      listen(els.list, "click", (event) => {
        const removeButton = event.target.closest("[data-upload-remove]");
        if (removeButton) void remove(removeButton.dataset.uploadRemove);
        const retryButton = event.target.closest("[data-upload-retry]");
        if (retryButton) {
          const item = items.find((row) => row.localId === retryButton.dataset.uploadRetry);
          if (item) void upload(item);
        }
      });
      ["dragenter", "dragover"].forEach((name) => listen(els.composer, name, (event) => {
        event.preventDefault();
        els.composer.classList.add("is-dragging");
      }));
      ["dragleave", "drop"].forEach((name) => listen(els.composer, name, (event) => {
        event.preventDefault();
        els.composer.classList.remove("is-dragging");
        if (name === "drop") addFiles(event.dataTransfer?.files);
      }));
      listen(document.getElementById("chat-message-input"), "paste", (event) => {
        const files = Array.from(event.clipboardData?.files || []);
        if (files.length) addFiles(files);
      });
    },
    configure(value) {
      capabilities = value || {};
      if (els.attach) {
        els.attach.setAttribute("aria-disabled", String(!capabilities.attachments));
        els.attach.title = capabilities.attachments ? "Attach files" : "File attachments are temporarily unavailable";
      }
      onComposerChange?.();
    },
    readyIds() {
      return items.filter((item) => item.status === "uploaded").map((item) => item.attachment.id);
    },
    hasContent() { return items.length > 0; },
    isBusy() { return items.some((item) => item.status !== "uploaded"); },
    pause,
    resume() {
      if (disposed || !paused) return;
      paused = false;
      for (const item of items) if (item.status === "queued") void upload(item);
      render();
    },
    dispose() {
      if (disposed) return;
      pause();
      disposed = true;
      listeners.splice(0).forEach((removeListener) => removeListener());
    },
    clear() { items.splice(0).forEach((item) => item.uploadController?.abort()); render(); },
    resetForRoom() { items.slice().forEach((item) => void remove(item.localId, { notify: false })); },
  };
}
