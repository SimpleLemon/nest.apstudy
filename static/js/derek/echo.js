const PLAYLIST_ID = "PLRuGynt4aVsqpyBgcw7Yorrque_ZVmz4x";
const VIDEO_ID = "BybOGhyJO5M";
const DEFAULT_COLOR = "#6366f1";
const HOUR_HEIGHT_PX = 36;
const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

let cachedEvents = [];
let ytPlayer = null;
let ytApiPromise = null;
let playlistIds = [];
let playlistTitles = {};
let activePlaylistIndex = 0;

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function parseEventDate(dateStr, isAllDay) {
  if (!dateStr) return new Date();
  if (isAllDay && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [year, month, day] = dateStr.split("-").map((part) => parseInt(part, 10));
    return new Date(year, month - 1, day, 0, 0, 0, 0);
  }
  return new Date(dateStr);
}

function formatTimeOnly(date) {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatHourLabel(hour) {
  if (hour === 0) return "12a";
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return "12p";
  return `${hour - 12}p`;
}

function formatEventTime(event) {
  if (event.isAllDay) return "All day";
  const start = event.startDate;
  const end = event.endDate || event.startDate;
  return `${formatTimeOnly(start)} – ${formatTimeOnly(end)}`;
}

function resolveColor(event, sourcesById) {
  if (event.color) return event.color;
  const source = sourcesById.get(String(event.calendar_id || ""));
  return source?.color_hex || DEFAULT_COLOR;
}

function mixHex(accent, surface, amount) {
  const parse = (hex) => {
    const clean = String(hex || "").replace("#", "");
    if (clean.length !== 6) return null;
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  };
  const a = parse(accent);
  const s = parse(surface);
  if (!a || !s) return accent || DEFAULT_COLOR;
  const mix = (x, y) => Math.round(x + (y - x) * amount);
  const toHex = (n) => n.toString(16).padStart(2, "0");
  return `#${toHex(mix(s.r, a.r))}${toHex(mix(s.g, a.g))}${toHex(mix(s.b, a.b))}`;
}

function fitDateText(node) {
  if (!node) return;
  node.style.fontSize = "";
  const parent = node.parentElement;
  if (!parent) return;
  const maxSize = Math.min(parent.clientWidth * 0.12, parent.clientHeight * 0.22, 30);
  const minSize = 14;
  let size = Math.max(minSize, maxSize);
  node.style.fontSize = `${size}px`;
  while (size > minSize && node.scrollWidth > parent.clientWidth) {
    size -= 1;
    node.style.fontSize = `${size}px`;
  }
}

function updateClock() {
  const now = new Date();
  let hours = now.getHours() % 12;
  if (hours === 0) hours = 12;
  const hourStr = String(hours).padStart(2, "0");
  const minuteStr = String(now.getMinutes()).padStart(2, "0");

  const map = {
    h1: hourStr[0],
    h2: hourStr[1],
    m1: minuteStr[0],
    m2: minuteStr[1],
  };
  for (const [key, value] of Object.entries(map)) {
    const node = document.querySelector(`[data-echo-digit="${key}"]`);
    if (node) node.textContent = value;
  }

  const dateNode = $("[data-echo-date]");
  if (dateNode) {
    dateNode.textContent = `${WEEKDAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
    fitDateText(dateNode);
  }
}

function normalizeEvents(payload) {
  const sourcesById = new Map(
    (payload?.calendar_sources || []).map((source) => [String(source.id), source]),
  );
  return (payload?.events || [])
    .filter((event) => event?.start)
    .map((event) => {
      const isAllDay = Boolean(event.is_all_day);
      const startDate = parseEventDate(event.start, isAllDay);
      let endDate = event.end
        ? parseEventDate(event.end, isAllDay)
        : new Date(startDate);
      if (isAllDay && endDate <= startDate) {
        endDate = addDays(startDate, 1);
      }
      return {
        ...event,
        isAllDay,
        startDate,
        endDate,
        color: resolveColor(event, sourcesById),
      };
    })
    .sort((a, b) => a.startDate - b.startDate || String(a.title || "").localeCompare(String(b.title || "")));
}

function eventOverlapsDay(event, day) {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  return event.startDate <= dayEnd && event.endDate > dayStart;
}

function pickNextEvent(events, now = new Date()) {
  const today = startOfDay(now);
  const candidates = events.filter((event) => {
    if (event.isAllDay) {
      return event.endDate > today && event.startDate <= endOfDay(now);
    }
    return event.endDate > now;
  });
  return candidates[0] || null;
}

function layoutTimedEvents(events) {
  const items = events.map((event, originalIndex) => {
    const startMin = event.startDate.getHours() * 60 + event.startDate.getMinutes();
    const endDate = event.endDate || event.startDate;
    const durMin = Math.max(30, Math.ceil((endDate - event.startDate) / 60000));
    return {
      ...event,
      layoutOriginalIndex: originalIndex,
      layoutStartMinutes: startMin,
      layoutDurationMinutes: durMin,
      layoutLane: 0,
      layoutLaneCount: 1,
    };
  }).sort((a, b) => (
    a.layoutStartMinutes - b.layoutStartMinutes
    || b.layoutDurationMinutes - a.layoutDurationMinutes
    || a.layoutOriginalIndex - b.layoutOriginalIndex
  ));

  function assignGroupLanes(group) {
    const laneEnds = [];
    for (const item of group) {
      let lane = laneEnds.findIndex((end) => end <= item.layoutStartMinutes);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = item.layoutStartMinutes + item.layoutDurationMinutes;
      item.layoutLane = lane;
    }
    const laneCount = Math.max(1, laneEnds.length);
    group.forEach((item) => { item.layoutLaneCount = laneCount; });
  }

  let groupStart = 0;
  let groupEnd = -Infinity;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (index > groupStart && item.layoutStartMinutes >= groupEnd) {
      assignGroupLanes(items.slice(groupStart, index));
      groupStart = index;
      groupEnd = -Infinity;
    }
    groupEnd = Math.max(groupEnd, item.layoutStartMinutes + item.layoutDurationMinutes);
  }
  if (items.length) assignGroupLanes(items.slice(groupStart));
  return items;
}

function renderNextEvent(event) {
  const root = $("[data-echo-next]");
  if (!root) return;
  if (!event) {
    root.innerHTML = `<p class="echo-empty">No upcoming events</p>`;
    return;
  }
  root.innerHTML = `
    <article class="echo-next-row">
      <span class="echo-next-color" style="background-color:${escapeHtml(event.color)}"></span>
      <p class="echo-next-time">${escapeHtml(formatEventTime(event))}</p>
      <h3 class="echo-next-title">${escapeHtml(event.title || "Untitled")}</h3>
    </article>
  `;
}

function renderDayGroup(label, events, { isToday = false } = {}) {
  if (!events.length) return "";
  const chips = events.map((event) => {
    const accent = event.color || DEFAULT_COLOR;
    const background = mixHex(accent, "#1a1a1a", 0.28);
    const border = mixHex(accent, "#ffffff", 0.35);
    return `
      <article class="echo-chip" style="background:${escapeHtml(background)};color:#fff;border-color:${escapeHtml(border)}">
        <span class="echo-chip-bar" style="background:${escapeHtml(accent)}"></span>
        <div class="echo-chip-copy">
          <p class="echo-chip-title">${escapeHtml(event.title || "Untitled")}</p>
          <p class="echo-chip-time">${escapeHtml(formatEventTime(event))}</p>
        </div>
      </article>
    `;
  }).join("");
  return `
    <section class="echo-day">
      <h3 class="echo-day-label${isToday ? " is-today" : ""}">${escapeHtml(label)}</h3>
      ${chips}
    </section>
  `;
}

function renderAgendaList(events) {
  const root = $("[data-echo-agenda]");
  if (!root) return;
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const todayEvents = events.filter((event) => eventOverlapsDay(event, today));
  const tomorrowEvents = events.filter((event) => eventOverlapsDay(event, tomorrow));

  if (!todayEvents.length && !tomorrowEvents.length) {
    root.innerHTML = `<p class="echo-empty">Nothing on the calendar for today or tomorrow.</p>`;
    return;
  }

  root.innerHTML = [
    renderDayGroup("Today", todayEvents, { isToday: true }),
    renderDayGroup("Tomorrow", tomorrowEvents),
  ].join("");
}

function renderTimedEvent(event) {
  const topPx = (event.layoutStartMinutes / 60) * HOUR_HEIGHT_PX;
  const heightPx = Math.max((event.layoutDurationMinutes / 60) * HOUR_HEIGHT_PX, 20);
  const leftPct = (event.layoutLane / event.layoutLaneCount) * 100;
  const widthPct = 100 / event.layoutLaneCount;
  const accent = event.color || DEFAULT_COLOR;
  const background = mixHex(accent, "#1a1a1a", 0.32);
  const border = mixHex(accent, "#ffffff", 0.35);
  const showTime = heightPx >= 36;
  return `
    <div class="echo-week-event" style="top:${topPx}px;left:${leftPct}%;width:calc(${widthPct}% - 0.15rem);height:${heightPx}px">
      <div class="echo-week-event-inner" style="background:${escapeHtml(background)};border-color:${escapeHtml(border)}">
        <p class="echo-week-event-title">${escapeHtml(event.title || "Untitled")}</p>
        ${showTime ? `<p class="echo-week-event-time">${escapeHtml(formatEventTime(event))}</p>` : ""}
      </div>
    </div>
  `;
}

function renderTwoDayWeek(events) {
  const root = $("[data-echo-calendar]");
  if (!root) return;

  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const days = [today, tomorrow];

  const headers = days.map((day, index) => {
    const isCurrent = index === 0;
    const label = isCurrent
      ? `${WEEKDAYS[day.getDay()]} (Today)`
      : WEEKDAYS[day.getDay()];
    return `
      <div class="echo-week-dayhead${isCurrent ? " is-today" : ""}">
        <span class="echo-week-weekday">${escapeHtml(label)}</span>
      </div>
    `;
  }).join("");

  const allDayBlocks = days.map((day) => {
    const dayEvents = events.filter((event) => event.isAllDay && eventOverlapsDay(event, day));
    if (!dayEvents.length) return `<div></div>`;
    const chips = dayEvents.map((event) => {
      const accent = event.color || DEFAULT_COLOR;
      const background = mixHex(accent, "#1a1a1a", 0.28);
      const border = mixHex(accent, "#ffffff", 0.35);
      return `<div class="echo-week-allday-chip" style="background:${escapeHtml(background)};border-color:${escapeHtml(border)}">${escapeHtml(event.title || "Untitled")}</div>`;
    }).join("");
    return `<div>${chips}</div>`;
  }).join("");

  const hasAllDay = days.some((day) => events.some((event) => event.isAllDay && eventOverlapsDay(event, day)));

  const axisHours = Array.from({ length: 24 }, (_, hour) => `
    <div class="echo-week-hour">
      ${hour === 0 ? "" : `<span class="echo-week-hour-label">${formatHourLabel(hour)}</span>`}
    </div>
  `).join("");

  const columns = days.map((day, index) => {
    const timed = layoutTimedEvents(
      events.filter((event) => !event.isAllDay && eventOverlapsDay(event, day)),
    );
    const lines = Array.from({ length: 24 }, () => `<div class="echo-week-hour"></div>`).join("");
    return `
      <div class="echo-week-col${index === 0 ? " is-today" : ""}">
        <div class="echo-week-events" aria-hidden="true">${lines}</div>
        <div class="echo-week-events">${timed.map(renderTimedEvent).join("")}</div>
      </div>
    `;
  }).join("");

  root.innerHTML = `
    <div class="echo-week-shell">
      <div class="echo-week-header">
        <div class="echo-week-corner"></div>
        ${headers}
      </div>
      ${hasAllDay ? `
        <div class="echo-week-allday">
          <div class="echo-week-allday-label">All day</div>
          ${allDayBlocks}
        </div>
      ` : ""}
      <div class="echo-week-scroll" data-echo-week-scroll>
        <div class="echo-week-grid">
          <div class="echo-week-axis">${axisHours}</div>
          ${columns}
        </div>
      </div>
    </div>
  `;

  const scroller = root.querySelector("[data-echo-week-scroll]");
  if (scroller) {
    const targetMinutes = Math.max(0, now.getHours() * 60 + now.getMinutes() - 60);
    scroller.scrollTop = Math.round((targetMinutes / 60) * HOUR_HEIGHT_PX);
  }
}

async function loadCalendar() {
  const now = new Date();
  const start = startOfDay(now);
  const end = endOfDay(addDays(start, 1));
  const url = `/api/calendar/events?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Calendar request failed (${response.status})`);
    const payload = await response.json();
    cachedEvents = normalizeEvents(payload);
    renderNextEvent(pickNextEvent(cachedEvents, now));
    renderTwoDayWeek(cachedEvents);
    renderAgendaList(cachedEvents);
  } catch (error) {
    console.error(error);
    const next = $("[data-echo-next]");
    const calendar = $("[data-echo-calendar]");
    const agenda = $("[data-echo-agenda]");
    if (next) next.innerHTML = `<p class="echo-empty">Couldn’t load next event</p>`;
    if (calendar) calendar.innerHTML = `<p class="echo-empty">Couldn’t load calendar</p>`;
    if (agenda) agenda.innerHTML = `<p class="echo-empty">Couldn’t load calendar</p>`;
  }
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve(window.YT);
    };
    const existing = document.querySelector("script[data-echo-youtube-api]");
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.dataset.echoYoutubeApi = "true";
    script.onerror = () => reject(new Error("Failed to load YouTube API"));
    document.head.appendChild(script);
  });

  return ytApiPromise;
}

async function fetchVideoTitle(videoId) {
  if (playlistTitles[videoId]) return playlistTitles[videoId];
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`,
    );
    if (!response.ok) throw new Error("oEmbed failed");
    const payload = await response.json();
    playlistTitles[videoId] = payload.title || `Video ${videoId}`;
  } catch {
    playlistTitles[videoId] = `Video ${videoId}`;
  }
  return playlistTitles[videoId];
}

function renderPlaylistList() {
  const root = $("[data-echo-playlist-list]");
  if (!root) return;
  if (!playlistIds.length) {
    root.innerHTML = `<p class="echo-empty">Playlist is still loading…</p>`;
    return;
  }

  root.innerHTML = playlistIds.map((videoId, index) => {
    const title = playlistTitles[videoId] || `Track ${index + 1}`;
    const active = index === activePlaylistIndex ? " is-active" : "";
    return `
      <button type="button" class="echo-playlist-item${active}" data-echo-playlist-index="${index}">
        <span class="echo-playlist-index">${index + 1}</span>
        <p class="echo-playlist-title">${escapeHtml(title)}</p>
      </button>
    `;
  }).join("");
}

async function refreshPlaylistMetadata(ids) {
  playlistIds = ids.slice();
  renderPlaylistList();
  await Promise.all(playlistIds.map((id) => fetchVideoTitle(id)));
  renderPlaylistList();
}

function ensureYouTubePlayer() {
  return loadYouTubeApi().then((YT) => {
    if (ytPlayer) return ytPlayer;

    return new Promise((resolve) => {
      ytPlayer = new YT.Player("echo-yt-player", {
        width: "100%",
        height: "100%",
        videoId: VIDEO_ID,
        playerVars: {
          listType: "playlist",
          list: PLAYLIST_ID,
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          controls: 1,
          fs: 1,
        },
        events: {
          onReady: (event) => {
            const loadIds = (attempt = 0) => {
              const ids = event.target.getPlaylist?.() || [];
              if (ids.length) {
                refreshPlaylistMetadata(ids);
                return;
              }
              if (attempt < 6) {
                window.setTimeout(() => loadIds(attempt + 1), 400);
                return;
              }
              refreshPlaylistMetadata([VIDEO_ID]);
            };
            loadIds();
            try {
              event.target.setPlaybackQuality?.("hd720");
            } catch {
              /* best-effort */
            }
            resolve(ytPlayer);
          },
          onStateChange: (event) => {
            const index = event.target.getPlaylistIndex?.();
            if (typeof index === "number" && index >= 0) {
              activePlaylistIndex = index;
              renderPlaylistList();
            }
          },
        },
      });
    });
  });
}

function openMusic() {
  const dash = $("[data-echo-dash]");
  const frame = $("[data-echo-music-frame]");
  const playlistBtn = $("[data-echo-playlist-open]");
  if (!dash || !frame) return;

  frame.hidden = false;
  playlistBtn?.removeAttribute("hidden");
  dash.dataset.mode = "music";

  const clock = $("[data-echo-clock]");
  if (clock) {
    clock.setAttribute("role", "button");
    clock.setAttribute("tabindex", "0");
    clock.setAttribute("aria-label", "Return to home view");
  }

  fitDateText($("[data-echo-date]"));
  ensureYouTubePlayer().catch((error) => {
    console.error(error);
    frame.innerHTML = `<p class="echo-empty">Couldn’t load YouTube player</p>`;
  });
}

function openPlaylistModal() {
  const modal = $("[data-echo-playlist-modal]");
  if (!modal) return;
  renderPlaylistList();
  modal.hidden = false;

  if (ytPlayer?.getPlaylist) {
    const ids = ytPlayer.getPlaylist() || [];
    if (ids.length) refreshPlaylistMetadata(ids);
    const index = ytPlayer.getPlaylistIndex?.();
    if (typeof index === "number" && index >= 0) activePlaylistIndex = index;
  }
}

function closePlaylistModal() {
  const modal = $("[data-echo-playlist-modal]");
  if (!modal) return;
  modal.hidden = true;
}

function playPlaylistIndex(index) {
  if (!ytPlayer?.playVideoAt) return;
  activePlaylistIndex = index;
  ytPlayer.playVideoAt(index);
  renderPlaylistList();
  closePlaylistModal();
}

function openAgendaModal() {
  const modal = $("[data-echo-agenda-modal]");
  if (!modal) return;
  renderAgendaList(cachedEvents);
  modal.hidden = false;
}

function closeAgendaModal() {
  const modal = $("[data-echo-agenda-modal]");
  if (!modal) return;
  modal.hidden = true;
}

function bindInteractions() {
  $("[data-echo-music-open]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMusic();
  });

  $("[data-echo-playlist-open]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openPlaylistModal();
  });

  $("[data-echo-playlist-list]")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-echo-playlist-index]");
    if (!button) return;
    event.preventDefault();
    playPlaylistIndex(Number(button.dataset.echoPlaylistIndex));
  });

  $("[data-echo-agenda-open]")?.addEventListener("click", (event) => {
    event.preventDefault();
    openAgendaModal();
  });

  document.querySelectorAll("[data-echo-agenda-close]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      closeAgendaModal();
    });
  });

  document.querySelectorAll("[data-echo-playlist-close]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.preventDefault();
      closePlaylistModal();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeAgendaModal();
    closePlaylistModal();
  });

  const clock = $("[data-echo-clock]");
  const reloadHome = () => {
    const dash = $("[data-echo-dash]");
    if (dash?.dataset.mode !== "music") return;
    window.location.reload();
  };
  clock?.addEventListener("click", reloadHome);
  clock?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      reloadHome();
    }
  });

  window.addEventListener("resize", () => fitDateText($("[data-echo-date]")), { passive: true });
}

function startClock() {
  updateClock();
  const tick = () => {
    updateClock();
    const delay = 60000 - (Date.now() % 60000) + 50;
    window.setTimeout(tick, delay);
  };
  const delay = 60000 - (Date.now() % 60000) + 50;
  window.setTimeout(tick, delay);
}

startClock();
bindInteractions();
loadCalendar();
