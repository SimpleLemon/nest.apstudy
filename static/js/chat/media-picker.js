import { escapeHtml } from "../core/ui-primitives-module.js";

const EMOJI_GROUPS = {
  Recent: [],
  Faces: ["😀", "😃", "😄", "😁", "😂", "🥹", "😊", "😍", "🥰", "😘", "😎", "🤓", "🧐", "🤔", "🫡", "😴", "😭", "😤", "😱", "🥳", "🤯", "🫠", "🙃", "😉"],
  Gestures: ["👍", "👎", "👏", "🙌", "🫶", "🤝", "🙏", "✌️", "🤞", "💪", "👀", "🧠", "🫂", "💯"],
  Study: ["📚", "📖", "📝", "✏️", "📌", "📎", "🧪", "🔬", "🧬", "📐", "📊", "🎓", "💡", "⏰"],
  Symbols: ["❤️", "🧡", "💛", "💚", "💙", "💜", "✨", "⭐", "🔥", "✅", "❌", "⚠️", "🎉", "🚀"],
};
const EMOJI_GROUP_ICONS = {
  Recent: "schedule",
  Faces: "sentiment_satisfied",
  Gestures: "waving_hand",
  Study: "school",
  Symbols: "emoji_symbols",
};
const EMOJI_NAMES = {
  "😀": "grinning face happy", "😂": "tears joy laugh", "🥹": "holding back tears", "😊": "smile blush", "😍": "heart eyes",
  "🤔": "thinking", "😭": "crying", "🥳": "party", "👍": "thumbs up yes", "👎": "thumbs down no", "👏": "clap",
  "🙏": "please thanks pray", "💯": "hundred", "📚": "books study", "📝": "memo notes", "🎓": "graduation school",
  "💡": "idea light", "❤️": "heart love", "🔥": "fire", "✅": "check done", "⚠️": "warning", "🎉": "celebrate", "🚀": "rocket",
};
const RECENT_KEY = "apstudy-chat-recent-emoji";
const HOVER_SMILES = ["😀", "😄", "😊", "🤩", "🥳"];

function recentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 18); } catch { return []; }
}

function saveRecent(emoji) {
  const next = [emoji, ...recentEmoji().filter((value) => value !== emoji)].slice(0, 18);
  localStorage.setItem(RECENT_KEY, JSON.stringify(next));
}

export function createMediaPicker() {
  const els = {};
  let capabilities = {};
  let selectedGif = null;
  let activeTab = "emoji";
  let searchTimer;
  let onComposerChange;
  let lastHoverSmile = -1;
  let returnFocusEl = null;
  let paused = false;
  let disposed = false;
  let gifController = null;
  const trackingControllers = new Set();
  const listeners = [];

  function listen(target, name, callback) {
    const handler = (event) => { if (!paused && !disposed) callback(event); };
    target?.addEventListener(name, handler);
    listeners.push(() => target?.removeEventListener(name, handler));
  }

  function cancelGifWork() {
    clearTimeout(searchTimer);
    searchTimer = null;
    gifController?.abort();
    gifController = null;
  }

  function showHoverSmile() {
    const icon = els.button?.querySelector(".material-symbols-outlined, .chat-hover-smile");
    if (!icon || icon.classList.contains("chat-hover-smile")) return;
    let next = Math.floor(Math.random() * HOVER_SMILES.length);
    if (next === lastHoverSmile) next = (next + 1) % HOVER_SMILES.length;
    lastHoverSmile = next;
    icon.classList.remove("material-symbols-outlined");
    icon.classList.add("chat-hover-smile");
    icon.textContent = HOVER_SMILES[next];
  }

  function restoreHoverSmile() {
    const icon = els.button?.querySelector(".chat-hover-smile");
    if (!icon) return;
    icon.classList.remove("chat-hover-smile");
    icon.classList.add("material-symbols-outlined");
    icon.textContent = "sentiment_satisfied";
  }

  function close({ restoreFocus = true, focusComposer = false } = {}) {
    if (!els.picker) return;
    els.picker.hidden = true;
    els.button?.setAttribute("aria-expanded", "false");
    if (!restoreFocus) return;
    const target = focusComposer ? els.input : returnFocusEl;
    if (target?.isConnected) target.focus();
    else if (els.button?.isConnected) els.button.focus();
  }

  function open() {
    if (paused || disposed || !els.picker) return;
    returnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : els.button;
    els.picker.hidden = false;
    els.button?.setAttribute("aria-expanded", "true");
    positionPicker();
    els.search?.focus();
  }

  function positionPicker() {
    if (els.picker?.hidden || !els.button) return;
    const anchor = els.button.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 24);
    els.picker.style.width = `${width}px`;
    els.picker.style.left = `${Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12))}px`;
    els.picker.style.bottom = `${Math.max(12, window.innerHeight - anchor.top + 8)}px`;
  }

  function insertEmoji(emoji) {
    const input = els.input;
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.setRangeText(emoji, start, end, "end");
    saveRecent(emoji);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function renderEmoji(query = "") {
    const normalized = query.trim().toLowerCase();
    EMOJI_GROUPS.Recent = recentEmoji();
    const visibleGroups = Object.entries(EMOJI_GROUPS).map(([group, values]) => ({
      group,
      values: values.filter((emoji) => !normalized || `${emoji} ${EMOJI_NAMES[emoji] || ""}`.includes(normalized)),
    })).filter(({ values }) => values.length);
    els.categories.innerHTML = Object.entries(EMOJI_GROUPS).map(([group, values]) => `
      <button type="button" data-emoji-group="${group}" aria-label="${group}" title="${group}" ${values.length ? "" : "disabled"}>
        <span class="material-symbols-outlined" aria-hidden="true">${EMOJI_GROUP_ICONS[group]}</span>
      </button>
    `).join("");
    els.emoji.innerHTML = visibleGroups.map(({ group, values }) => {
      return `<section class="chat-emoji-group" data-emoji-section="${group}"><h3>${group === "Recent" ? "Frequently used" : group}</h3><div class="chat-emoji-grid">${values.map((emoji) => `<button type="button" data-emoji="${emoji}" aria-label="${escapeHtml(EMOJI_NAMES[emoji] || group)}">${emoji}</button>`).join("")}</div></section>`;
    }).join("") || `<p class="chat-picker-empty">No emoji found.</p>`;
  }

  function track(url) {
    if (paused || disposed || !url) return;
    const controller = new AbortController();
    trackingControllers.add(controller);
    fetch(url, { mode: "no-cors", keepalive: true, signal: controller.signal })
      .catch(() => {}).finally(() => trackingControllers.delete(controller));
  }

  async function loadGifs(query = "") {
    if (paused || disposed) return;
    gifController?.abort();
    const controller = new AbortController();
    gifController = controller;
    const isCurrent = () => !paused && !disposed && !controller.signal.aborted && gifController === controller;
    if (!capabilities.giphy?.available) {
      els.gifResults.innerHTML = `<p class="chat-picker-empty">GIF search is unavailable because it has not been configured.</p>`;
      return;
    }
    els.gifResults.innerHTML = `<p class="chat-picker-empty">Loading GIFs…</p>`;
    const endpoint = query.trim() ? "search" : "trending";
    const params = new URLSearchParams({ api_key: capabilities.giphy.api_key, rating: "pg", limit: "24" });
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params}`, { signal: controller.signal });
      if (!isCurrent()) return;
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (!isCurrent()) return;
      els.gifResults.innerHTML = (payload.data || []).map((gif) => {
        const preview = gif.images?.fixed_width?.webp || gif.images?.fixed_width?.url;
        if (!preview) return "";
        return `<button type="button" class="chat-gif-tile" data-gif-id="${escapeHtml(gif.id)}" data-gif-title="${escapeHtml(gif.title || "GIF")}" data-gif-preview="${escapeHtml(preview)}" data-gif-sent="${escapeHtml(gif.analytics?.onsent?.url || "")}" aria-label="Choose ${escapeHtml(gif.title || "GIF")}"><img src="${escapeHtml(preview)}" alt="" loading="lazy" decoding="async"></button>`;
      }).join("") || `<p class="chat-picker-empty">No GIFs found.</p>`;
    } catch {
      if (!isCurrent()) return;
      els.gifResults.innerHTML = `<p class="chat-picker-empty">GIFs could not be loaded. Try again.</p>`;
    } finally {
      if (gifController === controller) gifController = null;
    }
  }

  function renderSelection() {
    if (paused || disposed || !els.selection) return;
    els.selection.innerHTML = selectedGif ? `<article id="chat-selected-gif" class="chat-selected-gif"><img src="${escapeHtml(selectedGif.preview)}" alt="${escapeHtml(selectedGif.title)}"><span><strong>GIF</strong><small>${escapeHtml(selectedGif.title)}</small></span><button type="button" aria-label="Remove GIF"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></article>` : "";
    onComposerChange?.();
  }

  function removeSelection() {
    const removedGif = selectedGif;
    selectedGif = null;
    renderSelection();
    window.APStudyUndo?.stage?.({
      message: "GIF removed from this message.",
      restore: () => {
        if (disposed) return;
        selectedGif = removedGif;
        renderSelection();
      },
    });
  }

  function isTabAvailable(tab) {
    return tab !== "gif" || Boolean(capabilities.giphy?.available);
  }

  function setTab(tab, { focus = false } = {}) {
    if (paused || disposed || !isTabAvailable(tab)) return false;
    cancelGifWork();
    activeTab = tab;
    const gif = tab === "gif";
    els.emojiTab.setAttribute("aria-selected", String(!gif));
    els.gifTab.setAttribute("aria-selected", String(gif));
    els.emojiTab.tabIndex = gif ? -1 : 0;
    els.gifTab.tabIndex = gif ? 0 : -1;
    els.categories.hidden = gif;
    els.emoji.hidden = gif;
    els.gif.hidden = !gif;
    els.search.placeholder = gif ? "Search GIFs" : "Search emoji";
    els.search.setAttribute("aria-label", gif ? "Search GIFs" : "Search emoji");
    els.search.value = "";
    if (gif) void loadGifs(); else renderEmoji();
    if (focus) (gif ? els.gifTab : els.emojiTab).focus();
    return true;
  }

  function handleTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [els.emojiTab, els.gifTab];
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
    let targetIndex;
    if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = tabs.length - 1;
    else targetIndex = (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    const target = tabs[targetIndex];
    if (target.getAttribute("aria-disabled") === "true") target.focus();
    else setTab(target === els.gifTab ? "gif" : "emoji", { focus: true });
  }

  function pause() {
    if (paused || disposed) return;
    paused = true;
    cancelGifWork();
    trackingControllers.forEach((controller) => controller.abort());
    trackingControllers.clear();
    close({ restoreFocus: false });
    restoreHoverSmile();
  }

  return {
    init(context = {}) {
      onComposerChange = context.onComposerChange;
      els.button = document.getElementById("chat-media-button");
      els.picker = document.getElementById("chat-media-picker");
      els.search = document.getElementById("chat-media-search");
      els.emojiTab = document.getElementById("chat-emoji-tab");
      els.gifTab = document.getElementById("chat-gif-tab");
      els.categories = document.getElementById("chat-emoji-categories");
      els.emoji = document.getElementById("chat-emoji-panel");
      els.gif = document.getElementById("chat-gif-panel");
      els.gifResults = document.getElementById("chat-gif-results");
      els.input = document.getElementById("chat-message-input");
      els.selection = document.getElementById("chat-gif-selection");
      renderEmoji();
      setTab("emoji");
      listen(els.button, "click", () => els.picker.hidden ? open() : close());
      listen(els.button, "pointerenter", showHoverSmile);
      listen(els.button, "pointerleave", restoreHoverSmile);
      listen(els.emojiTab, "click", () => setTab("emoji"));
      listen(els.gifTab, "click", () => setTab("gif"));
      listen(els.emojiTab?.parentElement, "keydown", handleTabKeydown);
      listen(els.categories, "click", (event) => {
        const button = event.target.closest("[data-emoji-group]");
        if (!button || button.disabled) return;
        els.emoji.querySelector(`[data-emoji-section="${button.dataset.emojiGroup}"]`)?.scrollIntoView({ block: "start" });
      });
      listen(els.search, "input", () => {
        gifController?.abort();
        gifController = null;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          searchTimer = null;
          if (paused || disposed) return;
          if (activeTab === "gif") void loadGifs(els.search.value); else renderEmoji(els.search.value);
        }, 180);
      });
      listen(els.emoji, "click", (event) => {
        const button = event.target.closest("[data-emoji]");
        if (button) insertEmoji(button.dataset.emoji);
      });
      listen(els.gifResults, "click", (event) => {
        const tile = event.target.closest("[data-gif-id]");
        if (!tile) return;
        selectedGif = { id: tile.dataset.gifId, title: tile.dataset.gifTitle, preview: tile.dataset.gifPreview, query: els.search.value, sent: tile.dataset.gifSent };
        renderSelection();
        close();
        els.input?.focus();
      });
      listen(els.selection, "click", (event) => {
        if (event.target.closest("#chat-selected-gif button")) removeSelection();
      });
      listen(els.picker, "keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        const buttons = Array.from(els.picker.querySelectorAll(".chat-emoji-grid button, .chat-gif-tile"));
        const index = buttons.indexOf(document.activeElement);
        if (index < 0 || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const columns = activeTab === "emoji" ? 9 : 3;
        const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
        buttons[Math.max(0, Math.min(buttons.length - 1, index + delta))]?.focus();
      });
      listen(document, "pointerdown", (event) => {
        if (!els.picker?.hidden && !els.picker.contains(event.target) && !els.button.contains(event.target)) close({ restoreFocus: false });
      });
      listen(window, "resize", positionPicker);
    },
    configure(value) {
      capabilities = value || {};
      const gifAvailable = Boolean(capabilities.giphy?.available);
      els.gifTab.setAttribute("aria-disabled", String(!gifAvailable));
      els.gifTab.title = gifAvailable ? "" : "GIF search is not configured";
      document.getElementById("chat-gif-unavailable")?.toggleAttribute("hidden", gifAvailable);
      if (!gifAvailable && activeTab === "gif") setTab("emoji");
    },
    selection() { return selectedGif ? { gif_id: selectedGif.id, gif_query: selectedGif.query } : {}; },
    hasSelection() { return Boolean(selectedGif); },
    clear(sent = false) { if (sent && selectedGif?.sent) track(selectedGif.sent); selectedGif = null; renderSelection(); close({ restoreFocus: false }); },
    pause,
    resume() {
      if (disposed || !paused) return;
      paused = false;
      renderSelection();
      if (activeTab === "gif") void loadGifs(els.search.value); else renderEmoji(els.search.value);
    },
    dispose() {
      if (disposed) return;
      pause();
      disposed = true;
      listeners.splice(0).forEach((removeListener) => removeListener());
    },
    close,
  };
}
