const COURSE_DAYS = [
  { key: "Mon", index: 1 },
  { key: "Tue", index: 2 },
  { key: "Wed", index: 3 },
  { key: "Thu", index: 4 },
  { key: "Fri", index: 5 },
];
const COURSE_START_HOUR = 6;
const COURSE_END_HOUR = 24;
const COURSE_START_MINUTES = COURSE_START_HOUR * 60;
const COURSE_END_MINUTES = COURSE_END_HOUR * 60;
const COURSE_HOUR_HEIGHT = 64;
const COURSE_RESULT_LIMIT = 100;

const state = {
  loading: true,
  sectionsLoading: false,
  savingIds: new Set(),
  trackingIds: new Set(),
  terms: [],
  selectedTerm: window.APSTUDY_COURSES_DEFAULT_TERM || "",
  sections: [],
  sectionsById: {},
  savedCoursesBySection: new Map(),
  tracksBySection: new Map(),
  searchQuery: "",
  dayFilters: new Set(),
  filtersOpen: false,
  timeEnabled: false,
  timeStart: "06:00",
  timeEnd: "23:59",
  hoveredSectionId: null,
  detailSectionId: null,
  detailLoading: false,
  detailLiveError: "",
  error: "",
  initialScrollDone: false,
};

document.addEventListener("DOMContentLoaded", () => {
  wireControls();
  void bootstrap();
});

async function bootstrap() {
  try {
    await Promise.all([loadTerms(), loadSavedCourses(), loadTracks()]);
    if (state.selectedTerm) {
      await loadSectionsForTerm(state.selectedTerm);
    }
  } catch (error) {
    console.error(error);
    state.error = error.message || "Unable to load courses.";
  } finally {
    state.loading = false;
    render();
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

async function loadTerms() {
  const payload = await fetchJson("/api/atlas/terms");
  state.terms = Array.isArray(payload.terms) ? payload.terms : [];
  if (!state.terms.length) {
    throw new Error("No Emory Atlas terms are available.");
  }
  if (!state.selectedTerm || !state.terms.includes(state.selectedTerm)) {
    state.selectedTerm = payload.default_term && state.terms.includes(payload.default_term)
      ? payload.default_term
      : state.terms[0];
  }
}

async function loadSectionsForTerm(term) {
  if (!term) return;
  state.sectionsLoading = true;
  state.error = "";
  render();
  try {
    const payload = await fetchJson(`/api/atlas/sections?term=${encodeURIComponent(term)}&include_cancelled=0`);
    state.sections = Array.isArray(payload.sections) ? payload.sections : [];
    state.sectionsById = {};
    for (const section of state.sections) {
      rememberSection(section);
    }
  } catch (error) {
    console.error(error);
    state.error = error.message || "Unable to load course sections.";
  } finally {
    state.sectionsLoading = false;
    render();
  }
}

async function loadSavedCourses() {
  const payload = await fetchJson("/api/courses/saved");
  state.savedCoursesBySection = new Map();
  for (const course of payload.courses || []) {
    if (course.section_id) {
      state.savedCoursesBySection.set(String(course.section_id), course);
      rememberSection(course);
    }
  }
}

async function loadTracks() {
  const payload = await fetchJson("/api/courses/tracks");
  state.tracksBySection = new Map();
  for (const track of payload.tracks || []) {
    if (track.section_id) {
      state.tracksBySection.set(String(track.section_id), track);
    }
  }
}

function rememberSection(section) {
  const id = String(section?.id || section?.section_id || "");
  if (!id) return;
  const searchBlob = [
    section.course_title,
    section.course_name,
    section.subject,
    section.course_code,
    section.instructor,
    section.instructor_name,
    section.crn,
    section.section_number,
  ].join(" ").toLowerCase();
  state.sectionsById[id] = { ...state.sectionsById[id], ...section, id, searchBlob };
}

function wireControls() {
  const filterButton = document.getElementById("courses-filter-button");
  filterButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.filtersOpen = !state.filtersOpen;
    syncFilterControls();
  });

  document.getElementById("courses-search-input")?.addEventListener("input", (event) => {
    state.searchQuery = event.target.value || "";
    state.detailSectionId = null;
    renderPanel();
  });

  document.getElementById("courses-term-select")?.addEventListener("change", (event) => {
    state.selectedTerm = event.target.value || "";
    state.detailSectionId = null;
    state.filtersOpen = false;
    state.initialScrollDone = false;
    void loadSectionsForTerm(state.selectedTerm);
  });

  document.getElementById("courses-day-toggle")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-day]");
    if (!button) return;
    const day = button.dataset.day || "";
    if (!day) return;
    if (state.dayFilters.has(day)) {
      state.dayFilters.delete(day);
    } else {
      state.dayFilters.add(day);
    }
    state.detailSectionId = null;
    renderPanel();
  });

  document.getElementById("courses-time-enabled")?.addEventListener("change", (event) => {
    state.timeEnabled = Boolean(event.target.checked);
    document.getElementById("courses-time-start").disabled = !state.timeEnabled;
    document.getElementById("courses-time-end").disabled = !state.timeEnabled;
    state.detailSectionId = null;
    renderPanel();
  });

  document.getElementById("courses-time-start")?.addEventListener("change", (event) => {
    state.timeStart = event.target.value || "06:00";
    renderPanel();
  });

  document.getElementById("courses-time-end")?.addEventListener("change", (event) => {
    state.timeEnd = event.target.value || "23:59";
    renderPanel();
  });

  document.getElementById("courses-prev-term")?.addEventListener("click", () => {
    changeTermBy(1);
  });

  document.getElementById("courses-next-term")?.addEventListener("click", () => {
    changeTermBy(-1);
  });

  document.addEventListener("click", (event) => {
    const popover = document.getElementById("courses-filter-popover");
    if (!state.filtersOpen || !popover || popover.contains(event.target) || filterButton?.contains(event.target)) {
      return;
    }
    state.filtersOpen = false;
    syncFilterControls();
  });

  document.addEventListener("pointerover", (event) => {
    const card = event.target.closest(".course-card[data-section-id]");
    if (!card) return;
    const id = card.dataset.sectionId;
    if (state.hoveredSectionId === id) return;
    state.hoveredSectionId = id;
    renderCalendar();
  });

  document.addEventListener("pointerout", (event) => {
    const card = event.target.closest(".course-card[data-section-id]");
    if (!card || card.contains(event.relatedTarget)) return;
    state.hoveredSectionId = null;
    renderCalendar();
  });

  document.addEventListener("click", (event) => {
    const closeDetail = event.target.closest("[data-close-detail]");
    if (closeDetail) {
      state.detailSectionId = null;
      state.detailLiveError = "";
      renderPanel();
      return;
    }

    const addButton = event.target.closest("[data-add-section-id]");
    if (addButton) {
      event.preventDefault();
      event.stopPropagation();
      void addCourse(addButton.dataset.addSectionId);
      return;
    }

    const removeButton = event.target.closest("[data-remove-course-id]");
    if (removeButton) {
      event.preventDefault();
      event.stopPropagation();
      const sectionId = removeButton.dataset.sectionId;
      void removeCourse(removeButton.dataset.removeCourseId, sectionId);
      return;
    }

    const trackButton = event.target.closest("[data-track-section-id]");
    if (trackButton) {
      event.preventDefault();
      event.stopPropagation();
      const sectionId = trackButton.dataset.trackSectionId;
      const enabled = trackButton.getAttribute("aria-pressed") !== "true";
      void setTrack(sectionId, enabled);
      return;
    }

    const eventBlock = event.target.closest(".courses-event[data-section-id]");
    if (eventBlock) {
      openDetail(eventBlock.dataset.sectionId);
      return;
    }

    const card = event.target.closest(".course-card[data-section-id]");
    if (card) {
      openDetail(card.dataset.sectionId);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.filtersOpen) {
      state.filtersOpen = false;
      syncFilterControls();
      return;
    }
    if (event.key === "Escape" && state.detailSectionId) {
      state.detailSectionId = null;
      state.detailLiveError = "";
      renderPanel();
    }
  });
}

function render() {
  renderTermSelect();
  renderPanel();
  renderCalendar();
}

function renderTermSelect() {
  const select = document.getElementById("courses-term-select");
  if (!select) return;
  select.innerHTML = state.terms
    .map((term) => `<option value="${escapeHtml(term)}" ${term === state.selectedTerm ? "selected" : ""}>${escapeHtml(formatTermLabel(term))}</option>`)
    .join("");
}

function changeTermBy(delta) {
  const currentIndex = state.terms.indexOf(state.selectedTerm);
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.terms.length) return;
  state.selectedTerm = state.terms[nextIndex];
  state.detailSectionId = null;
  state.filtersOpen = false;
  state.initialScrollDone = false;
  renderTermSelect();
  void loadSectionsForTerm(state.selectedTerm);
}

function renderPanel() {
  const summary = document.getElementById("courses-result-summary");
  const content = document.getElementById("courses-panel-content");
  if (!summary || !content) return;

  document.querySelector(".courses-panel")?.classList.toggle("is-detailing", Boolean(state.detailSectionId));
  syncFilterControls();

  if (state.loading) {
    summary.textContent = "Loading Emory Atlas...";
    content.innerHTML = `<div class="courses-state">Loading courses...</div>`;
    return;
  }
  if (state.error) {
    summary.textContent = "Course search unavailable";
    content.innerHTML = `<div class="courses-state">${escapeHtml(state.error)}</div>`;
    return;
  }
  if (state.detailSectionId) {
    summary.textContent = "Course details";
    content.innerHTML = buildDetailHtml(state.detailSectionId);
    return;
  }
  if (state.sectionsLoading) {
    summary.textContent = `Loading ${formatTermLabel(state.selectedTerm)}...`;
    content.innerHTML = `<div class="courses-state">Loading sections for ${escapeHtml(formatTermLabel(state.selectedTerm))}...</div>`;
    return;
  }

  const filtered = getFilteredSections();
  const visible = filtered.slice(0, COURSE_RESULT_LIMIT);
  summary.textContent = `${filtered.length.toLocaleString()} sections in ${formatTermLabel(state.selectedTerm)}`;
  if (!visible.length) {
    content.innerHTML = `<div class="courses-state">No sections match your filters.</div>`;
    return;
  }

  const capNote = filtered.length > COURSE_RESULT_LIMIT
    ? `<div class="courses-state">Showing first ${COURSE_RESULT_LIMIT.toLocaleString()} matches. Refine your search for more specific results.</div>`
    : "";
  content.innerHTML = visible.map(buildCourseCardHtml).join("") + capNote;
}

function syncFilterControls() {
  const filterButton = document.getElementById("courses-filter-button");
  const filterPopover = document.getElementById("courses-filter-popover");
  const filterCount = document.getElementById("courses-filter-count");
  const timeEnabled = document.getElementById("courses-time-enabled");
  const timeStart = document.getElementById("courses-time-start");
  const timeEnd = document.getElementById("courses-time-end");
  const activeFilterCount = state.dayFilters.size + (state.timeEnabled ? 1 : 0);
  if (filterButton) {
    filterButton.setAttribute("aria-expanded", state.filtersOpen ? "true" : "false");
    filterButton.classList.toggle("is-active", state.filtersOpen || activeFilterCount > 0);
  }
  if (filterPopover) filterPopover.hidden = !state.filtersOpen;
  if (filterCount) {
    filterCount.textContent = String(activeFilterCount);
    filterCount.hidden = activeFilterCount === 0;
  }
  if (timeEnabled) timeEnabled.checked = state.timeEnabled;
  if (timeStart) {
    timeStart.value = state.timeStart;
    timeStart.disabled = !state.timeEnabled;
  }
  if (timeEnd) {
    timeEnd.value = state.timeEnd;
    timeEnd.disabled = !state.timeEnabled;
  }
  document.querySelectorAll("#courses-day-toggle button[data-day]").forEach((button) => {
    button.classList.toggle("is-active", state.dayFilters.has(button.dataset.day));
  });
}

function buildCourseCardHtml(section) {
  const id = section.id;
  const addedCourse = state.savedCoursesBySection.get(id);
  const isAdded = Boolean(addedCourse);
  const status = section.enrollment_status || "Unknown";
  const statusClass = status.toLowerCase() === "open" ? "is-open" : status.toLowerCase() === "closed" ? "is-closed" : "";
  const seats = formatSeats(section);
  const saving = state.savingIds.has(id);
  return `
    <article class="course-card ${isAdded ? "is-added" : ""}" data-section-id="${escapeHtml(id)}" tabindex="0">
      <div class="course-card-top">
        <div class="course-card-title">
          <strong>${escapeHtml(section.course_code || "Course")} ${section.section_number ? `<span class="course-section-inline">Sec ${escapeHtml(section.section_number)}</span>` : ""}</strong>
          <span>${escapeHtml(section.course_title || "Untitled course")}</span>
        </div>
        <button type="button" class="course-card-action ${isAdded ? "is-added" : ""}" data-add-section-id="${escapeHtml(id)}" ${saving ? "disabled" : ""}>${isAdded ? "Added" : "Add"}</button>
      </div>
      <div class="course-card-meta">
        <span class="course-chip ${statusClass}">${escapeHtml(status)}</span>
        <span class="course-chip">${escapeHtml(seats)}</span>
        <span class="course-chip">${escapeHtml(section.schedule_type || "Type")}</span>
      </div>
      <div class="course-card-schedule">${escapeHtml(section.schedule_display || "TBA")}</div>
      <div class="course-card-schedule">${escapeHtml(section.instructor || "TBA")}</div>
    </article>
  `;
}

function buildDetailHtml(sectionId) {
  const section = getSection(sectionId);
  if (!section) return `<div class="courses-state">Course section not found.</div>`;
  const addedCourse = state.savedCoursesBySection.get(sectionId);
  const track = state.tracksBySection.get(sectionId);
  const trackEnabled = Boolean(track?.enabled);
  const canTrack = isTrackable(section);
  const saving = state.savingIds.has(sectionId);
  const tracking = state.trackingIds.has(sectionId);
  const status = section.enrollment_status || "Unknown";
  const statusClass = status.toLowerCase() === "open" ? "is-open" : status.toLowerCase() === "closed" ? "is-closed" : "";
  const liveText = state.detailLoading
    ? "Refreshing seats from Atlas..."
    : state.detailLiveError
      ? `Atlas live refresh unavailable. Showing saved catalog data.`
      : section.live_updated_at
        ? `Updated ${formatDateTime(section.live_updated_at)}`
        : "Waiting for Atlas refresh...";
  const description = section.course_description || section.description || "Description unavailable.";

  return `
    <article class="courses-detail">
      <div class="courses-detail-header">
        <div>
          <h2>${escapeHtml(section.course_code || "Course")}</h2>
          <p>${escapeHtml(section.course_title || "Untitled course")}</p>
          ${section.section_number ? `<span class="courses-section-kicker">Section ${escapeHtml(section.section_number)}</span>` : ""}
        </div>
        <button class="courses-detail-close" type="button" data-close-detail aria-label="Close course details">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
      <div class="courses-detail-meta">
        <span class="course-chip">${escapeHtml(formatTermLabel(section.term))}</span>
        <span class="course-chip ${statusClass}">${escapeHtml(status)}</span>
      </div>
      <section class="courses-detail-card">
        ${detailRow("Instructor", formatInstructors(section))}
        ${detailRow("Schedule", section.schedule_display || "TBA")}
        ${detailRow("CRN", section.crn || "N/A")}
        ${detailRow("Type", section.schedule_type || "N/A")}
        ${detailRow("Location", section.location || "TBA")}
        ${detailRow("Seats", formatSeats(section))}
        ${detailRow("Credits", section.credit_hours || "N/A")}
        ${detailRow("Requirement", formatRequirement(section))}
        ${detailRow("Dates", formatDateRange(section.date_range))}
        ${detailRow("Live Status", liveText)}
      </section>
      <div class="courses-detail-actions">
        ${addedCourse
          ? `<button type="button" class="courses-danger-action" data-remove-course-id="${escapeHtml(addedCourse.id)}" data-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>Remove Class</button>`
          : `<button type="button" class="courses-primary-action" data-add-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>Add Class</button>`
        }
      </div>
      ${canTrack || track ? `
        <section class="track-control">
          <div class="track-control-text">
            <strong>Track Class</strong>
            <span>${trackEnabled ? "Email notifications are on for this section." : "Email me when a seat opens."}</span>
          </div>
          <button type="button" class="track-toggle" data-track-section-id="${escapeHtml(sectionId)}" aria-label="Track class" aria-pressed="${trackEnabled ? "true" : "false"}" ${tracking || (!canTrack && !trackEnabled) ? "disabled" : ""}></button>
        </section>
      ` : ""}
      <section class="courses-description-card">
        <span class="material-symbols-outlined" aria-hidden="true">notes</span>
        <div>
          <h3>Description</h3>
          <p>${escapeHtml(description)}</p>
        </div>
      </section>
    </article>
  `;
}

function detailRow(label, value) {
  return `<div class="courses-detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "N/A")}</strong></div>`;
}

function formatInstructors(section) {
  const instructors = Array.isArray(section?.instructors) ? section.instructors : [];
  const names = instructors
    .map((instructor) => {
      if (typeof instructor === "string") return instructor;
      const email = instructor?.email ? ` (${instructor.email})` : "";
      return instructor?.name ? `${instructor.name}${email}` : "";
    })
    .filter(Boolean);
  return names.length ? names.join(", ") : section?.instructor || "TBA";
}

function formatRequirement(section) {
  const value = section?.requirement_designation || section?.requirement || section?.ger;
  if (Array.isArray(value)) return value.filter(Boolean).join(", ") || "N/A";
  return value || "N/A";
}

function renderCalendar() {
  const root = document.getElementById("courses-calendar-root");
  const title = document.getElementById("courses-week-title");
  const subtitle = document.getElementById("courses-term-dates");
  if (!root) return;
  if (title) {
    title.textContent = formatTermLabel(state.selectedTerm);
  }
  if (subtitle) {
    subtitle.textContent = getSelectedTermDateText();
  }
  syncTermControls();

  const header = `
    <div class="courses-week-header">
      <div class="courses-week-header-cell"></div>
      ${COURSE_DAYS.map((day) => `
        <div class="courses-week-header-cell">
          <div class="courses-week-day">
            <span>${day.key}</span>
            <span>${formatDayName(day.key)}</span>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  const timeAxis = `
    <div class="courses-time-axis">
      ${Array.from({ length: COURSE_END_HOUR - COURSE_START_HOUR }, (_, index) => {
        const hour = COURSE_START_HOUR + index;
        return `<div class="courses-time-cell"><span>${formatHourLabel(hour)}</span></div>`;
      }).join("")}
    </div>
  `;
  const columns = COURSE_DAYS.map((day) => buildDayColumn(day.key)).join("");
  root.innerHTML = `
    <div class="courses-week-frame">
      ${header}
      <div id="courses-week-scroller" class="courses-week-scroller">
        <div class="courses-week-grid">
          ${timeAxis}
          ${columns}
        </div>
      </div>
    </div>
  `;
  alignWeekHeader();
  scrollWeekIntoView();
}

function syncTermControls() {
  const currentIndex = state.terms.indexOf(state.selectedTerm);
  const prev = document.getElementById("courses-prev-term");
  const next = document.getElementById("courses-next-term");
  if (prev) prev.disabled = currentIndex < 0 || currentIndex >= state.terms.length - 1 || state.sectionsLoading;
  if (next) next.disabled = currentIndex <= 0 || state.sectionsLoading;
}

function getSelectedTermDateText() {
  if (state.sectionsLoading) return `Loading ${formatTermLabel(state.selectedTerm)} dates...`;
  const range = state.sections.find((section) => {
    return section.term === state.selectedTerm && section.date_range?.start && section.date_range?.end;
  })?.date_range;
  if (range?.start && range?.end) return formatDateRange(range);
  return "Monday-Friday, 6 AM-midnight";
}

function formatDayName(key) {
  return {
    Mon: "Monday",
    Tue: "Tuesday",
    Wed: "Wednesday",
    Thu: "Thursday",
    Fri: "Friday",
  }[key] || key;
}

function buildDayColumn(dayKey) {
  const events = layoutEvents(getCalendarEventsForDay(dayKey));
  const lines = Array.from(
    { length: COURSE_END_HOUR - COURSE_START_HOUR },
    () => `<div class="courses-grid-line"></div>`
  ).join("");
  return `
    <div class="courses-day-column" data-day="${escapeHtml(dayKey)}">
      <div class="courses-grid-lines">${lines}</div>
      <div class="courses-events-layer">
        ${events.map(renderCourseEvent).join("")}
      </div>
    </div>
  `;
}

function getCalendarEventsForDay(dayKey) {
  const events = [];
  for (const [sectionId, course] of state.savedCoursesBySection.entries()) {
    if (course.term !== state.selectedTerm) continue;
    const section = getSection(sectionId) || course;
    events.push(...meetingEventsForSection(section, false, course.id));
  }
  if (state.hoveredSectionId && !state.savedCoursesBySection.has(state.hoveredSectionId)) {
    const section = getSection(state.hoveredSectionId);
    events.push(...meetingEventsForSection(section, true, null));
  }
  return events.filter((event) => event.day === dayKey);
}

function meetingEventsForSection(section, preview, savedCourseId) {
  if (!section) return [];
  return (section.meetings || [])
    .filter((meeting) => COURSE_DAYS.some((day) => day.key === meeting.day))
    .map((meeting) => {
      const start = parseAtlasTimeToken(meeting.start);
      const end = parseAtlasTimeToken(meeting.end);
      if (start === null || end === null || end <= COURSE_START_MINUTES || start >= COURSE_END_MINUTES) {
        return null;
      }
      return {
        sectionId: section.id || section.section_id,
        savedCourseId,
        preview,
        day: meeting.day,
        start: Math.max(start, COURSE_START_MINUTES),
        end: Math.min(end, COURSE_END_MINUTES),
        title: section.course_code || "Course",
        detail: `${formatAtlasTime(meeting.start)}-${formatAtlasTime(meeting.end)}${section.section_number ? ` | Sec ${section.section_number}` : ""}`,
      };
    })
    .filter(Boolean);
}

function layoutEvents(events) {
  const sorted = events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  const lanes = [];
  for (const event of sorted) {
    let lane = 0;
    while (lane < lanes.length && lanes[lane] > event.start) lane += 1;
    if (lane === lanes.length) lanes.push(0);
    lanes[lane] = event.end;
    event.lane = lane;
  }
  const laneCount = Math.max(1, lanes.length);
  return sorted.map((event) => ({ ...event, laneCount }));
}

function renderCourseEvent(event) {
  const top = ((event.start - COURSE_START_MINUTES) / 60) * COURSE_HOUR_HEIGHT;
  const height = Math.max(((event.end - event.start) / 60) * COURSE_HOUR_HEIGHT, 26);
  const left = (event.lane / event.laneCount) * 100;
  const width = 100 / event.laneCount;
  return `
    <div class="courses-event ${event.preview ? "is-preview" : ""}" data-section-id="${escapeHtml(event.sectionId)}" style="top:${top}px; height:${height}px; left:${left}%; width:calc(${width}% - 2px);">
      ${event.savedCourseId ? `
        <button type="button" class="course-remove-button" data-remove-course-id="${escapeHtml(event.savedCourseId)}" data-section-id="${escapeHtml(event.sectionId)}" aria-label="Remove class">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      ` : ""}
      <div class="courses-event-card">
        <div class="courses-event-title">${escapeHtml(event.title)}</div>
        <div class="courses-event-detail">${escapeHtml(event.detail)}</div>
      </div>
    </div>
  `;
}

function getFilteredSections() {
  const query = state.searchQuery.trim().toLowerCase();
  return state.sections.filter((section) => {
    if (query && !section.searchBlob.includes(query)) return false;
    if (!sectionMatchesDay(section)) return false;
    if (!sectionMatchesTime(section)) return false;
    return true;
  });
}

function sectionMatchesDay(section) {
  if (!state.dayFilters.size) return true;
  return (section.meetings || []).some((meeting) => state.dayFilters.has(meeting.day));
}

function sectionMatchesTime(section) {
  if (!state.timeEnabled) return true;
  const start = parseTimeInput(state.timeStart) ?? COURSE_START_MINUTES;
  const end = parseTimeInput(state.timeEnd) ?? COURSE_END_MINUTES;
  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);
  return (section.meetings || []).some((meeting) => {
    if (state.dayFilters.size && !state.dayFilters.has(meeting.day)) return false;
    const meetingStart = parseAtlasTimeToken(meeting.start);
    const meetingEnd = parseAtlasTimeToken(meeting.end);
    if (meetingStart === null || meetingEnd === null) return false;
    return meetingStart < rangeEnd && meetingEnd > rangeStart;
  });
}

function openDetail(sectionId) {
  if (!sectionId) return;
  state.detailSectionId = sectionId;
  state.detailLiveError = "";
  state.filtersOpen = false;
  renderPanel();
  void refreshSectionStatus(sectionId);
}

async function refreshSectionStatus(sectionId) {
  state.detailLoading = true;
  renderPanel();
  try {
    const payload = await fetchJson("/api/courses/section-status", {
      method: "POST",
      body: JSON.stringify({ section_id: sectionId }),
    });
    if (payload.section) {
      payload.section.live_updated_at = payload.last_updated_at || new Date().toISOString();
      rememberSection(payload.section);
    }
    state.detailLiveError = payload.live_error || "";
  } catch (error) {
    console.error(error);
    state.detailLiveError = error.message || "Live status unavailable.";
  } finally {
    state.detailLoading = false;
    renderPanel();
    renderCalendar();
  }
}

async function addCourse(sectionId) {
  if (!sectionId || state.savedCoursesBySection.has(sectionId)) return;
  state.savingIds.add(sectionId);
  render();
  try {
    const payload = await fetchJson("/api/courses/saved", {
      method: "POST",
      body: JSON.stringify({ section_id: sectionId }),
    });
    if (payload.course?.section_id) {
      state.savedCoursesBySection.set(String(payload.course.section_id), payload.course);
      rememberSection(payload.course);
    }
    showToast("Class added.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to add class.", true);
  } finally {
    state.savingIds.delete(sectionId);
    render();
  }
}

async function removeCourse(courseId, sectionId) {
  if (!courseId) return;
  if (!window.confirm("Remove this class from your weekly view?")) return;
  if (sectionId) state.savingIds.add(sectionId);
  render();
  try {
    await fetchJson(`/api/courses/saved/${encodeURIComponent(courseId)}`, { method: "DELETE" });
    if (sectionId) state.savedCoursesBySection.delete(sectionId);
    if (state.detailSectionId === sectionId) {
      state.detailSectionId = null;
    }
    showToast("Class removed.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to remove class.", true);
  } finally {
    if (sectionId) state.savingIds.delete(sectionId);
    render();
  }
}

async function setTrack(sectionId, enabled) {
  if (!sectionId) return;
  state.trackingIds.add(sectionId);
  renderPanel();
  try {
    const payload = await fetchJson("/api/courses/tracks", {
      method: "POST",
      body: JSON.stringify({ section_id: sectionId, enabled }),
    });
    if (payload.section) rememberSection(payload.section);
    if (payload.track?.section_id) {
      state.tracksBySection.set(String(payload.track.section_id), payload.track);
    }
    showToast(enabled ? "Tracking enabled." : "Tracking disabled.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to update tracking.", true);
  } finally {
    state.trackingIds.delete(sectionId);
    render();
  }
}

function getSection(sectionId) {
  return state.sectionsById[String(sectionId)] || state.savedCoursesBySection.get(String(sectionId));
}

function isTrackable(section) {
  const status = String(section?.enrollment_status || "").toLowerCase();
  const seats = Number.parseInt(section?.seats_available, 10);
  return status === "closed" && seats === 0;
}

function formatSeats(section) {
  const seats = section?.seats_available;
  if (seats === null || typeof seats === "undefined" || seats === "") {
    return "Seats unknown";
  }
  return `${seats} ${Number(seats) === 1 ? "seat" : "seats"}`;
}

function formatTermLabel(term) {
  const parts = String(term || "").split("_");
  if (parts.length !== 2) return term || "Term";
  return `${parts[0]} ${parts[1]}`;
}

function parseAtlasTimeToken(token) {
  const numeric = String(token || "").replace(/\D/g, "");
  if (!numeric) return null;
  const padded = numeric.length >= 4 ? numeric.slice(-4) : numeric.padStart(4, "0");
  const hour = Number.parseInt(padded.slice(0, 2), 10);
  const minute = Number.parseInt(padded.slice(2, 4), 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 24 || minute > 59) return null;
  return hour * 60 + minute;
}

function parseTimeInput(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function formatAtlasTime(token) {
  const minutes = parseAtlasTimeToken(token);
  if (minutes === null) return "TBA";
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour24 >= 12 ? "p" : "a";
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, "0")}${suffix}`;
}

function formatHourLabel(hour) {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

function formatDateRange(range) {
  if (!range?.start || !range?.end) return "N/A";
  return `${formatDate(range.start)} - ${formatDate(range.end)}`;
}

function formatDate(value) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(value) {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function alignWeekHeader() {
  const scroller = document.getElementById("courses-week-scroller");
  const frame = scroller?.closest(".courses-week-frame");
  if (!scroller || !frame) return;
  const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
  frame.style.setProperty("--courses-scrollbar-offset", `${scrollbarWidth}px`);
}

function scrollWeekIntoView() {
  if (state.initialScrollDone) return;
  const scroller = document.getElementById("courses-week-scroller");
  if (!scroller) return;
  scroller.scrollTop = Math.round(1.5 * COURSE_HOUR_HEIGHT);
  state.initialScrollDone = true;
}

function showToast(message, isError = false) {
  const existing = document.querySelector(".courses-toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = `courses-toast ${isError ? "is-error" : ""}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 2600);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
