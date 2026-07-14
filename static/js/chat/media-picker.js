const EMOJI_GROUPS = {
  Recent: [],
  Faces: ["😀", "😃", "😄", "😁", "😂", "🥹", "😊", "😍", "🥰", "😘", "😎", "🤓", "🧐", "🤔", "🫡", "😴", "😭", "😤", "😱", "🥳", "🤯", "🫠", "🙃", "😉"],
  Gestures: ["👍", "👎", "👏", "🙌", "🫶", "🤝", "🙏", "✌️", "🤞", "💪", "👀", "🧠", "🫂", "💯"],
  Study: ["📚", "📖", "📝", "✏️", "📌", "📎", "🧪", "🔬", "🧬", "📐", "📊", "🎓", "💡", "⏰"],
  Symbols: ["❤️", "🧡", "💛", "💚", "💙", "💜", "✨", "⭐", "🔥", "✅", "❌", "⚠️", "🎉", "🚀"],
};
const EMOJI_NAMES = {
  "😀": "grinning face happy", "😂": "tears joy laugh", "🥹": "holding back tears", "😊": "smile blush", "😍": "heart eyes",
  "🤔": "thinking", "😭": "crying", "🥳": "party", "👍": "thumbs up yes", "👎": "thumbs down no", "👏": "clap",
  "🙏": "please thanks pray", "💯": "hundred", "📚": "books study", "📝": "memo notes", "🎓": "graduation school",
  "💡": "idea light", "❤️": "heart love", "🔥": "fire", "✅": "check done", "⚠️": "warning", "🎉": "celebrate", "🚀": "rocket",
};
const RECENT_KEY = "apstudy-chat-recent-emoji";

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function recentEmoji() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 18); } catch (_) { return []; }
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

  function close() {
    if (!els.picker) return;
    els.picker.hidden = true;
    els.button?.setAttribute("aria-expanded", "false");
  }

  function open() {
    if (!els.picker) return;
    els.picker.hidden = false;
    els.button?.setAttribute("aria-expanded", "true");
    positionPicker();
    els.search?.focus();
  }

  function positionPicker() {
    if (els.picker?.hidden || !els.button) return;
    const anchor = els.button.getBoundingClientRect();
    const width = Math.min(380, window.innerWidth - 24);
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
    els.emoji.innerHTML = Object.entries(EMOJI_GROUPS).map(([group, values]) => {
      const filtered = values.filter((emoji) => !normalized || `${emoji} ${EMOJI_NAMES[emoji] || ""}`.includes(normalized));
      if (!filtered.length) return "";
      return `<section class="chat-emoji-group"><h3>${group}</h3><div class="chat-emoji-grid">${filtered.map((emoji) => `<button type="button" data-emoji="${emoji}" aria-label="${escapeHtml(EMOJI_NAMES[emoji] || group)}">${emoji}</button>`).join("")}</div></section>`;
    }).join("") || `<p class="chat-picker-empty">No emoji found.</p>`;
  }

  function track(url) {
    if (!url) return;
    fetch(url, { mode: "no-cors", keepalive: true }).catch(() => {});
  }

  async function loadGifs(query = "") {
    if (!capabilities.giphy?.available) {
      els.gifResults.innerHTML = `<p class="chat-picker-empty">GIF search is unavailable because it has not been configured.</p>`;
      return;
    }
    els.gifResults.innerHTML = `<p class="chat-picker-empty">Loading GIFs…</p>`;
    const endpoint = query.trim() ? "search" : "trending";
    const params = new URLSearchParams({ api_key: capabilities.giphy.api_key, rating: "pg", limit: "24" });
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${params}`);
      if (!response.ok) throw new Error();
      const payload = await response.json();
      els.gifResults.innerHTML = (payload.data || []).map((gif) => {
        const preview = gif.images?.fixed_width?.webp || gif.images?.fixed_width?.url;
        if (!preview) return "";
        return `<button type="button" class="chat-gif-tile" data-gif-id="${escapeHtml(gif.id)}" data-gif-title="${escapeHtml(gif.title || "GIF")}" data-gif-preview="${escapeHtml(preview)}" data-gif-sent="${escapeHtml(gif.analytics?.onsent?.url || "")}" aria-label="Choose ${escapeHtml(gif.title || "GIF")}"><img src="${escapeHtml(preview)}" alt="" loading="lazy" decoding="async"></button>`;
      }).join("") || `<p class="chat-picker-empty">No GIFs found.</p>`;
    } catch (_) {
      els.gifResults.innerHTML = `<p class="chat-picker-empty">GIFs could not be loaded. Try again.</p>`;
    }
  }

  function renderSelection() {
    document.getElementById("chat-selected-gif")?.remove();
    const pending = document.getElementById("chat-pending-files");
    const selection = document.getElementById("chat-gif-selection");
    if (!pending || !selection) return;
    if (!selectedGif) {
      if (!document.getElementById("chat-upload-list")?.children.length) pending.hidden = true;
      return;
    }
    pending.hidden = false;
    selection.insertAdjacentHTML("beforeend", `<article id="chat-selected-gif" class="chat-selected-gif"><img src="${escapeHtml(selectedGif.preview)}" alt="${escapeHtml(selectedGif.title)}"><span><strong>GIF</strong><small>${escapeHtml(selectedGif.title)}</small></span><button type="button" aria-label="Remove GIF"><span class="material-symbols-outlined" aria-hidden="true">close</span></button></article>`);
    selection.querySelector("#chat-selected-gif button")?.addEventListener("click", () => {
      selectedGif = null;
      renderSelection();
      if (!document.getElementById("chat-upload-list")?.children.length) pending.hidden = true;
    });
  }

  function setTab(tab) {
    activeTab = tab;
    const gif = tab === "gif";
    els.emojiTab.setAttribute("aria-selected", String(!gif));
    els.gifTab.setAttribute("aria-selected", String(gif));
    els.emoji.hidden = gif;
    els.gif.hidden = !gif;
    els.search.placeholder = gif ? "Search GIFs" : "Search emoji";
    els.search.setAttribute("aria-label", gif ? "Search GIFs" : "Search emoji");
    els.search.value = "";
    if (gif) void loadGifs(); else renderEmoji();
  }

  return {
    init() {
      els.button = document.getElementById("chat-media-button");
      els.picker = document.getElementById("chat-media-picker");
      els.search = document.getElementById("chat-media-search");
      els.emojiTab = document.getElementById("chat-emoji-tab");
      els.gifTab = document.getElementById("chat-gif-tab");
      els.emoji = document.getElementById("chat-emoji-panel");
      els.gif = document.getElementById("chat-gif-panel");
      els.gifResults = document.getElementById("chat-gif-results");
      els.input = document.getElementById("chat-message-input");
      renderEmoji();
      els.button?.addEventListener("click", () => els.picker.hidden ? open() : close());
      els.emojiTab?.addEventListener("click", () => setTab("emoji"));
      els.gifTab?.addEventListener("click", () => setTab("gif"));
      els.search?.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => activeTab === "gif" ? void loadGifs(els.search.value) : renderEmoji(els.search.value), 180);
      });
      els.emoji?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-emoji]");
        if (button) insertEmoji(button.dataset.emoji);
      });
      els.gifResults?.addEventListener("click", (event) => {
        const tile = event.target.closest("[data-gif-id]");
        if (!tile) return;
        selectedGif = { id: tile.dataset.gifId, title: tile.dataset.gifTitle, preview: tile.dataset.gifPreview, query: els.search.value, sent: tile.dataset.gifSent };
        renderSelection();
        close();
        els.input?.focus();
      });
      els.picker?.addEventListener("keydown", (event) => {
        const buttons = Array.from(els.picker.querySelectorAll(".chat-emoji-grid button, .chat-gif-tile"));
        const index = buttons.indexOf(document.activeElement);
        if (index < 0 || !["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        const columns = activeTab === "emoji" ? 8 : 3;
        const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
        buttons[Math.max(0, Math.min(buttons.length - 1, index + delta))]?.focus();
      });
      document.addEventListener("pointerdown", (event) => {
        if (!els.picker?.hidden && !els.picker.contains(event.target) && !els.button.contains(event.target)) close();
      });
      window.addEventListener("resize", positionPicker);
    },
    configure(value) {
      capabilities = value || {};
      els.gifTab.disabled = !capabilities.giphy?.available;
      els.gifTab.title = capabilities.giphy?.available ? "" : "GIF search is not configured";
    },
    selection() { return selectedGif ? { gif_id: selectedGif.id, gif_query: selectedGif.query } : {}; },
    hasSelection() { return Boolean(selectedGif); },
    clear(sent = false) { if (sent && selectedGif?.sent) track(selectedGif.sent); selectedGif = null; renderSelection(); close(); },
    close,
  };
}
