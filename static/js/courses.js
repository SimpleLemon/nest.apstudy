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
const COMPACT_COURSES_QUERY = window.matchMedia("(max-width: 640px)");
const COURSE_COLOR_PALETTE = [
  { key: "course-color-01" },
  { key: "course-color-02" },
  { key: "course-color-03" },
  { key: "course-color-04" },
  { key: "course-color-05" },
  { key: "course-color-06" },
  { key: "course-color-07" },
  { key: "course-color-08" },
  { key: "course-color-09" },
  { key: "course-color-10" },
  { key: "course-color-11" },
  { key: "course-color-12" },
  { key: "course-color-13" },
  { key: "course-color-14" },
  { key: "course-color-15" },
  { key: "course-color-16" },
];
const COURSE_COLOR_KEYS = COURSE_COLOR_PALETTE.map((color) => color.key);

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
  activeCourseView: "search",
  searchQuery: "",
  dayFilters: new Set(),
  filtersOpen: false,
  timeEnabled: false,
  timeStart: "06:00",
  timeEnd: "23:59",
  hoveredSectionId: null,
  detailSectionId: null,
  editingSectionId: null,
  editingSaving: false,
  detailLoading: false,
  detailLiveError: "",
  error: "",
  weekScrollTop: null,
  weekScrollLeft: null,
  weekScrollResetPending: false,
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
    state.sectionsById = {};
    const rawSections = Array.isArray(payload.sections) ? payload.sections : [];
    state.sections = rawSections.map((section) => rememberSection(section)).filter(Boolean);
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
    applySavedCourse(course);
  }
}

function applySavedCourse(course) {
  if (!course?.section_id) return;
  const sectionId = String(course.section_id);
  state.savedCoursesBySection.set(sectionId, course);
  rememberSection(course);
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
  const id = String(section?.section_id || section?.id || "");
  if (!id) return null;
  const normalized = { ...state.sectionsById[id], ...section, id };
  if (state.savedCoursesBySection.has(id)) {
    Object.assign(normalized, getDisplayCourse(id));
  }
  normalized.searchBlob = buildSectionSearchBlob(normalized);
  state.sectionsById[id] = normalized;
  return normalized;
}

function getDisplayCourse(sectionId) {
  const savedCourse = state.savedCoursesBySection.get(String(sectionId));
  if (!savedCourse) return {};
  const display = {};
  [
    "term",
    "subject",
    "catalog",
    "crn",
    "course_code",
    "course_title",
    "course_name",
    "section_number",
    "instructor",
    "instructor_name",
    "instructors",
    "schedule_type",
    "schedule_display",
    "meetings",
    "date_range",
    "location",
    "credit_hours",
    "requirement_designation",
    "course_description",
    "description",
    "enrollment_status",
    "enrollment_count",
    "seats_available",
    "is_cancelled",
    "color_key",
    "overrides",
    "updated_at",
  ].forEach((key) => {
    if (typeof savedCourse[key] !== "undefined" && savedCourse[key] !== null) {
      display[key] = savedCourse[key];
    }
  });
  display.section_id = savedCourse.section_id || sectionId;
  return display;
}

function buildSectionSearchBlob(section) {
  const parts = [];
  const push = (value) => {
    if (value === null || typeof value === "undefined") return;
    if (Array.isArray(value)) {
      value.forEach(push);
      return;
    }
    if (typeof value === "object") {
      push(value.name);
      push(value.email);
      push(value.instructor);
      push(value.course_title);
      push(value.course_name);
      return;
    }
    const text = String(value).trim();
    if (text) parts.push(text);
  };

  push([
    section.course_title,
    section.course_name,
    section.subject,
    section.catalog,
    section.catalog_number,
    section.course_code,
    section.instructor,
    section.instructor_name,
    section.instructors,
    section.crn,
    section.section_number,
    section.requirement_designation,
    section.requirement,
    section.ger,
    section.credit_hours,
    section.course_description,
    section.description,
  ]);

  return parts.join(" ").toLowerCase();
}

function wireControls() {
  let lastCompactCourses = isCompactCoursesViewport();
  window.addEventListener("resize", () => {
    const nextCompactCourses = isCompactCoursesViewport();
    if (nextCompactCourses === lastCompactCourses) return;
    lastCompactCourses = nextCompactCourses;
    renderCalendar();
  });

  const filterButton = document.getElementById("courses-filter-button");
  document.querySelector(".courses-view-toggle")?.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-course-view]");
    if (!button) return;
    const nextView = button.dataset.courseView || "search";
    if (state.activeCourseView === nextView) return;
    state.activeCourseView = nextView;
    state.detailSectionId = null;
    state.editingSectionId = null;
    state.filtersOpen = false;
    renderPanel();
  });

  filterButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    state.filtersOpen = !state.filtersOpen;
    syncFilterControls();
  });

  document.getElementById("courses-search-input")?.addEventListener("input", (event) => {
    state.searchQuery = event.target.value || "";
    state.detailSectionId = null;
    state.editingSectionId = null;
    renderPanel();
  });

  document.getElementById("courses-term-select")?.addEventListener("change", (event) => {
    state.selectedTerm = event.target.value || "";
    state.detailSectionId = null;
    state.editingSectionId = null;
    state.filtersOpen = false;
    resetWeekScroll();
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
    state.editingSectionId = null;
    renderPanel();
  });

  document.getElementById("courses-time-enabled")?.addEventListener("change", (event) => {
    state.timeEnabled = Boolean(event.target.checked);
    document.getElementById("courses-time-start").disabled = !state.timeEnabled;
    document.getElementById("courses-time-end").disabled = !state.timeEnabled;
    state.detailSectionId = null;
    state.editingSectionId = null;
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
    changeTermBy(-1);
  });

  document.getElementById("courses-next-term")?.addEventListener("click", () => {
    changeTermBy(1);
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
      state.editingSectionId = null;
      state.detailLiveError = "";
      renderPanel();
      return;
    }

    const editButton = event.target.closest("[data-open-edit-section-id]");
    if (editButton) {
      event.preventDefault();
      event.stopPropagation();
      startEditingCourse(editButton.dataset.openEditSectionId);
      return;
    }

    const cancelEdit = event.target.closest("[data-edit-cancel]");
    if (cancelEdit) {
      event.preventDefault();
      event.stopPropagation();
      state.editingSectionId = null;
      renderPanel();
      return;
    }

    const saveEdit = event.target.closest("[data-edit-save]");
    if (saveEdit) {
      event.preventDefault();
      event.stopPropagation();
      void saveEditedCourse(saveEdit.dataset.editSave);
      return;
    }

    const colorButton = event.target.closest("[data-course-color-key]");
    if (colorButton && !colorButton.disabled) {
      event.preventDefault();
      event.stopPropagation();
      const form = colorButton.closest(".courses-edit");
      form?.querySelectorAll("[data-course-color-key]").forEach((button) => {
        const selected = button === colorButton;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      });
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

    const eventBlock = event.target.closest(".courses-event[data-section-id], .courses-mobile-event[data-section-id]");
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
    if (event.key === "Escape" && state.editingSectionId) {
      state.editingSectionId = null;
      renderPanel();
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
  resetWeekScroll();
  renderTermSelect();
  void loadSectionsForTerm(state.selectedTerm);
}

function renderPanel() {
  const summary = document.getElementById("courses-result-summary");
  const content = document.getElementById("courses-panel-content");
  if (!summary || !content) return;

  document.querySelector(".courses-panel")?.classList.toggle("is-detailing", Boolean(state.detailSectionId || state.editingSectionId));
  syncViewControls();
  syncFilterControls();

  if (state.loading) {
    summary.textContent = "Loading Emory Atlas...";
    content.innerHTML = `<div class="courses-state">${window.APStudyLoader.html(["Loading courses", "..."].join(""), { sizePx: 46, textToneClass: "text-on-surface" })}</div>`;
    return;
  }
  if (state.error) {
    summary.textContent = "Course search unavailable";
    content.innerHTML = `<div class="courses-state">${escapeHtml(state.error)}</div>`;
    return;
  }
  if (state.editingSectionId) {
    summary.textContent = "Edit class";
    content.innerHTML = buildEditHtml(state.editingSectionId);
    return;
  }
  if (state.detailSectionId) {
    summary.textContent = "Course details";
    content.innerHTML = buildDetailHtml(state.detailSectionId);
    return;
  }
  if (state.sectionsLoading) {
    summary.textContent = `Loading ${formatTermLabel(state.selectedTerm)}...`;
    content.innerHTML = `<div class="courses-state">${window.APStudyLoader.html(`Loading sections for ${formatTermLabel(state.selectedTerm)}...`, { sizePx: 46, textToneClass: "text-on-surface" })}</div>`;
    return;
  }

  const filtered = getFilteredSections();
  const visible = filtered.slice(0, COURSE_RESULT_LIMIT);
  summary.textContent = getPanelSummaryText(filtered.length);
  if (!visible.length) {
    content.innerHTML = `<div class="courses-state">${escapeHtml(getEmptyStateText())}</div>`;
    return;
  }

  const capNote = filtered.length > COURSE_RESULT_LIMIT
    ? `<div class="courses-state">Showing first ${COURSE_RESULT_LIMIT.toLocaleString()} matches. Refine your search for more specific results.</div>`
    : "";
  content.innerHTML = visible.map(buildCourseCardHtml).join("") + capNote;
}

function syncViewControls() {
  document.querySelectorAll("[data-course-view]").forEach((button) => {
    const selected = button.dataset.courseView === state.activeCourseView;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function getPanelSummaryText(count) {
  const term = formatTermLabel(state.selectedTerm);
  if (state.activeCourseView === "selected") {
    return `${count.toLocaleString()} selected ${count === 1 ? "course" : "courses"} in ${term}`;
  }
  if (state.activeCourseView === "tracked") {
    return `${count.toLocaleString()} tracked ${count === 1 ? "course" : "courses"} in ${term}`;
  }
  return `${count.toLocaleString()} sections in ${term}`;
}

function getEmptyStateText() {
  if (state.activeCourseView === "selected") return "No selected courses match your filters.";
  if (state.activeCourseView === "tracked") return "No tracked courses match your filters.";
  return "No sections match your filters.";
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
  const colorClass = isAdded ? getCourseColor(addedCourse).key : "";
  const status = section.enrollment_status || "Unknown";
  const statusClass = status.toLowerCase() === "open" ? "is-open" : status.toLowerCase() === "closed" ? "is-closed" : "";
  const seats = formatSeats(section);
  const saving = state.savingIds.has(id);
  const sectionLabel = section.section_number ? ` <span class="course-section-inline">&middot; Sec ${escapeHtml(section.section_number)}</span>` : "";
  const scheduleDetail = formatCourseCardSchedule(section);
  return `
    <article class="course-card ${isAdded ? `is-added ${escapeHtml(colorClass)}` : ""}" data-section-id="${escapeHtml(id)}" tabindex="0">
      <div class="course-card-top">
        <div class="course-card-title">
          <strong>${escapeHtml(section.course_code || "Course")}${sectionLabel}</strong>
          <span>${escapeHtml(section.course_title || "Untitled course")}</span>
        </div>
        <button type="button" class="course-card-action ${isAdded ? "is-added" : ""}" data-add-section-id="${escapeHtml(id)}" ${saving ? "disabled" : ""}>${isAdded ? "Added" : "Add"}</button>
      </div>
      <div class="course-card-schedule">${escapeHtml(scheduleDetail)}</div>
      <div class="course-card-meta">
        <span class="course-chip ${statusClass}">${escapeHtml(status)}</span>
        <span class="course-chip">${escapeHtml(seats)}</span>
        <span class="course-chip">${escapeHtml(section.schedule_type || "Type")}</span>
      </div>
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
      ${canTrack || track ? `
        <section class="track-control">
          <div class="track-control-text">
            <strong>Track Class</strong>
            <span>${trackEnabled ? "Email notifications are on for this section." : "Email me when a seat opens."}</span>
          </div>
          <button type="button" class="track-toggle" data-track-section-id="${escapeHtml(sectionId)}" aria-label="Track class" aria-pressed="${trackEnabled ? "true" : "false"}" ${tracking || (!canTrack && !trackEnabled) ? "disabled" : ""}></button>
        </section>
      ` : ""}
      <section class="courses-detail-card">
        ${detailRow("Instructor", formatInstructors(section))}
        ${detailRow("Schedule", normalizeScheduleDisplay(section.schedule_display || "TBA"))}
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
          ? `
            <button type="button" class="courses-secondary-action" data-open-edit-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>
              <span class="material-symbols-outlined" aria-hidden="true">edit</span>
              <span>Edit</span>
            </button>
            <button type="button" class="courses-danger-action" data-remove-course-id="${escapeHtml(addedCourse.id)}" data-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>Remove Class</button>
          `
          : `<button type="button" class="courses-primary-action" data-add-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>Add Class</button>`
        }
      </div>
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

function buildEditHtml(sectionId) {
  const section = getSection(sectionId);
  const savedCourse = state.savedCoursesBySection.get(String(sectionId));
  if (!section || !savedCourse) return `<div class="courses-state">Saved course not found.</div>`;
  const selectedColorKey = getCourseColor(savedCourse).key;
  const meetings = normalizeMeetingsForEdit(section.meetings);
  const saving = state.editingSaving || state.savingIds.has(sectionId);

  return `
    <article class="courses-edit" data-editing-section-id="${escapeHtml(sectionId)}">
      <div class="courses-detail-header">
        <div>
          <h2>Edit Class</h2>
          <p>${escapeHtml(section.course_code || "Course")} ${section.section_number ? `Section ${escapeHtml(section.section_number)}` : ""}</p>
        </div>
        <button class="courses-detail-close" type="button" data-edit-cancel aria-label="Close edit class">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>

      <section class="courses-edit-card courses-edit-color-card">
        <div class="courses-edit-section-heading">
          <h3>Color</h3>
          <span>Choose how this class appears on your week.</span>
        </div>
        <div class="courses-color-grid" role="group" aria-label="Course color">
          ${COURSE_COLOR_PALETTE.map((color) => {
            const isSelected = selectedColorKey === color.key;
            return `
              <button
                type="button"
                class="courses-color-swatch ${escapeHtml(color.key)} ${isSelected ? "is-selected" : ""}"
                data-course-color-key="${escapeHtml(color.key)}"
                aria-label="${escapeHtml(color.key.replace("course-color-", "Color "))}"
                aria-pressed="${isSelected ? "true" : "false"}"
              >
                <span class="material-symbols-outlined" aria-hidden="true">check</span>
              </button>
            `;
          }).join("")}
        </div>
      </section>

      <section class="courses-edit-card">
        <div class="courses-edit-grid">
          ${editField("course_code", "Course Code", section.course_code || "")}
          ${editField("section_number", "Section", section.section_number || "")}
          ${editField("course_title", "Title", section.course_title || "", "wide")}
          ${editField("instructor", "Instructor", section.instructor || section.instructor_name || "", "wide")}
          ${editField("schedule_type", "Type", section.schedule_type || "")}
          ${editField("credit_hours", "Credits", section.credit_hours || "")}
          ${editField("location", "Location", section.location || "")}
          ${editField("requirement_designation", "Requirement", formatRequirement(section) === "N/A" ? "" : formatRequirement(section))}
          ${editField("schedule_display", "Schedule Text", section.schedule_display || "", "wide")}
        </div>
      </section>

      <section class="courses-edit-card">
        <div class="courses-edit-section-heading">
          <h3>Meeting Times</h3>
          <span>Checked days appear in the weekly view.</span>
        </div>
        <div class="courses-meeting-editor">
          ${COURSE_DAYS.map((day) => {
            const meeting = meetings.find((item) => item.day === day.key);
            return `
              <label class="courses-meeting-row">
                <input type="checkbox" data-meeting-day="${escapeHtml(day.key)}" ${meeting ? "checked" : ""} />
                <span>${escapeHtml(day.key)}</span>
                <input type="time" data-meeting-start="${escapeHtml(day.key)}" value="${escapeHtml(meeting?.startInput || "09:00")}" min="06:00" max="23:59" />
                <input type="time" data-meeting-end="${escapeHtml(day.key)}" value="${escapeHtml(meeting?.endInput || "09:50")}" min="06:00" max="23:59" />
              </label>
            `;
          }).join("")}
        </div>
      </section>

      <section class="courses-edit-card">
        ${editTextarea("course_description", "Description", section.course_description || section.description || "")}
        ${editTextarea("course_notes", "Notes", section.course_notes || "")}
      </section>

      <div class="courses-detail-actions courses-edit-actions">
        <button type="button" class="courses-primary-action" data-edit-save="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>${saving ? "Saving..." : "Save"}</button>
        <button type="button" class="courses-secondary-action" data-edit-cancel ${saving ? "disabled" : ""}>Cancel</button>
      </div>
    </article>
  `;
}

function editField(name, label, value, className = "") {
  return `
    <label class="courses-edit-field ${className}">
      <span>${escapeHtml(label)}</span>
      <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />
    </label>
  `;
}

function editTextarea(name, label, value) {
  return `
    <label class="courses-edit-field wide">
      <span>${escapeHtml(label)}</span>
      <textarea name="${escapeHtml(name)}" rows="5">${escapeHtml(value)}</textarea>
    </label>
  `;
}

function getCourseColor(course) {
  return COURSE_COLOR_PALETTE.find((color) => color.key === course?.color_key) || COURSE_COLOR_PALETTE[0];
}

function normalizeMeetingsForEdit(meetings) {
  return (meetings || [])
    .map((meeting) => ({
      day: meeting.day,
      start: meeting.start,
      end: meeting.end,
      startInput: atlasTokenToTimeInput(meeting.start),
      endInput: atlasTokenToTimeInput(meeting.end),
    }))
    .filter((meeting) => COURSE_DAYS.some((day) => day.key === meeting.day));
}

function atlasTokenToTimeInput(token) {
  const minutes = parseAtlasTimeToken(token);
  if (minutes === null) return "";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function timeInputToAtlasToken(value) {
  const minutes = parseTimeInput(value);
  if (minutes === null) return "";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
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
  if (state.weekScrollResetPending) {
    state.weekScrollTop = null;
    state.weekScrollLeft = null;
    state.weekScrollResetPending = false;
  } else {
    rememberWeekScroll();
  }
  if (title) {
    const credits = computeCalendarCredits();
    title.innerHTML = `<strong>${escapeHtml(formatTermLabel(state.selectedTerm))}</strong> <span class="courses-term-credits">${escapeHtml(String(credits))} credits</span>`;
  }
  if (subtitle) {
    subtitle.textContent = getSelectedTermDateText();
  }
  syncTermControls();

  if (isCompactCoursesViewport()) {
    root.innerHTML = buildMobileCoursesAgenda();
    return;
  }

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
  applyEventLayoutStyles(root);
  alignWeekHeader();
  restoreWeekScroll();
}

function isCompactCoursesViewport() {
  return COMPACT_COURSES_QUERY.matches;
}

function buildMobileCoursesAgenda() {
  return `
    <div class="courses-mobile-agenda" aria-label="Weekly course agenda">
      ${COURSE_DAYS.map((day) => renderMobileCoursesDay(day)).join("")}
    </div>
  `;
}

function renderMobileCoursesDay(day) {
  const events = getCalendarEventsForDay(day.key)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end || (a.title || "").localeCompare(b.title || ""));
  return `
    <section class="courses-mobile-day">
      <header class="courses-mobile-day-header">
        <span>${escapeHtml(formatDayName(day.key))}</span>
        <strong>${events.length}</strong>
      </header>
      <div class="courses-mobile-event-list">
        ${events.length ? events.map(renderMobileCourseEvent).join("") : '<p class="courses-mobile-empty">No classes scheduled</p>'}
      </div>
    </section>
  `;
}

function renderMobileCourseEvent(event) {
  const colorClass = getCourseColor({ color_key: event.colorKey }).key;
  return `
    <article class="courses-mobile-event ${event.preview ? "is-preview" : ""} ${escapeHtml(colorClass)}" data-section-id="${escapeHtml(event.sectionId)}">
      <div class="courses-mobile-event-copy">
        <h3>${escapeHtml(event.title)}</h3>
        <p>${escapeHtml(event.detail)}</p>
      </div>
      ${event.savedCourseId ? `
        <button type="button" class="course-remove-button courses-mobile-remove" data-remove-course-id="${escapeHtml(event.savedCourseId)}" data-section-id="${escapeHtml(event.sectionId)}" aria-label="Remove class">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      ` : ""}
    </article>
  `;
}

function computeCalendarCredits() {
  let total = 0;
  for (const course of state.savedCoursesBySection.values()) {
    const c = Number(course?.credit_hours ?? course?.credits ?? 0);
    if (!Number.isNaN(c)) total += c;
  }
  if (state.hoveredSectionId && !state.savedCoursesBySection.has(state.hoveredSectionId)) {
    const s = getSection(state.hoveredSectionId);
    const c = Number(s?.credit_hours ?? s?.credits ?? 0);
    if (!Number.isNaN(c)) total += c;
  }
  return Math.round(total * 100) / 100;
}

function syncTermControls() {
  const currentIndex = state.terms.indexOf(state.selectedTerm);
  const prev = document.getElementById("courses-prev-term");
  const next = document.getElementById("courses-next-term");
  if (prev) prev.disabled = currentIndex <= 0 || state.sectionsLoading;
  if (next) next.disabled = currentIndex < 0 || currentIndex >= state.terms.length - 1 || state.sectionsLoading;
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
        sectionId: section.section_id || section.id,
        savedCourseId,
        preview,
        day: meeting.day,
        start: Math.max(start, COURSE_START_MINUTES),
        end: Math.min(end, COURSE_END_MINUTES),
        title: section.course_code || "Course",
        detail: `${formatAtlasTime(meeting.start)}-${formatAtlasTime(meeting.end)}${section.section_number ? ` | Sec ${section.section_number}` : ""}`,
        colorKey: section.color_key,
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
  const colorClass = getCourseColor({ color_key: event.colorKey }).key;
  return `
    <div class="courses-event ${event.preview ? "is-preview" : ""} ${escapeHtml(colorClass)}" data-section-id="${escapeHtml(event.sectionId)}" data-top="${escapeHtml(top)}" data-height="${escapeHtml(height)}" data-left="${escapeHtml(left)}" data-width="${escapeHtml(width)}">
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

function applyEventLayoutStyles(root) {
  root.querySelectorAll(".courses-event").forEach((eventNode) => {
    const top = Number(eventNode.dataset.top || 0);
    const height = Number(eventNode.dataset.height || 0);
    const left = Number(eventNode.dataset.left || 0);
    const width = Number(eventNode.dataset.width || 100);
    eventNode.style.top = `${top}px`;
    eventNode.style.height = `${height}px`;
    eventNode.style.left = `${left}%`;
    eventNode.style.width = `calc(${width}% - 2px)`;
  });
}

function getFilteredSections() {
  const query = state.searchQuery.trim().toLowerCase();
  return getSectionsForActiveView().filter((section) => {
    if (section.term && section.term !== state.selectedTerm) return false;
    const searchBlob = section.searchBlob || buildSectionSearchBlob(section);
    if (query && !searchBlob.includes(query)) return false;
    if (!sectionMatchesDay(section)) return false;
    if (!sectionMatchesTime(section)) return false;
    return true;
  });
}

function getSectionsForActiveView() {
  if (state.activeCourseView === "selected") {
    return Array.from(state.savedCoursesBySection.entries())
      .map(([sectionId, course]) => resolvePanelSection(sectionId, course))
      .filter(Boolean);
  }
  if (state.activeCourseView === "tracked") {
    return Array.from(state.tracksBySection.entries())
      .filter(([, track]) => Boolean(track?.enabled))
      .map(([sectionId, track]) => resolvePanelSection(sectionId, track))
      .filter(Boolean);
  }
  return state.sections;
}

function resolvePanelSection(sectionId, fallback) {
  const section = getSection(sectionId) || rememberSection(fallback);
  if (!section) return null;
  if (!section.searchBlob) section.searchBlob = buildSectionSearchBlob(section);
  return section;
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

function startEditingCourse(sectionId) {
  if (!sectionId || !state.savedCoursesBySection.has(String(sectionId))) return;
  state.detailSectionId = sectionId;
  state.editingSectionId = sectionId;
  state.filtersOpen = false;
  renderPanel();
}

async function saveEditedCourse(sectionId) {
  const savedCourse = state.savedCoursesBySection.get(String(sectionId));
  if (!savedCourse?.id || state.editingSaving) return;
  const form = document.querySelector(`.courses-edit[data-editing-section-id="${cssEscape(sectionId)}"]`);
  if (!form) return;

  const selectedColor = form.querySelector("[data-course-color-key].is-selected")?.dataset.courseColorKey
    || savedCourse.color_key
    || COURSE_COLOR_KEYS[0];
  const overrides = collectEditOverrides(form);

  state.editingSaving = true;
  state.savingIds.add(sectionId);
  renderPanel();
  try {
    const payload = await fetchJson(`/api/courses/saved/${encodeURIComponent(savedCourse.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ color_key: selectedColor, overrides }),
    });
    if (payload.course?.section_id) {
      applySavedCourse(payload.course);
      state.detailSectionId = String(payload.course.section_id);
      state.editingSectionId = null;
    }
    showToast("Class updated.");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Unable to update class.", true);
  } finally {
    state.editingSaving = false;
    state.savingIds.delete(sectionId);
    render();
  }
}

function collectEditOverrides(form) {
  const valueFor = (name) => form.querySelector(`[name="${name}"]`)?.value?.trim() || "";
  const overrides = {
    course_code: valueFor("course_code"),
    course_title: valueFor("course_title"),
    section_number: valueFor("section_number"),
    instructor: valueFor("instructor"),
    schedule_type: valueFor("schedule_type"),
    schedule_display: valueFor("schedule_display"),
    location: valueFor("location"),
    credit_hours: valueFor("credit_hours"),
    requirement_designation: valueFor("requirement_designation"),
    course_description: valueFor("course_description"),
    course_notes: valueFor("course_notes"),
    meetings: [],
  };

  COURSE_DAYS.forEach((day) => {
    const checked = form.querySelector(`[data-meeting-day="${day.key}"]`)?.checked;
    if (!checked) return;
    const startInput = form.querySelector(`[data-meeting-start="${day.key}"]`)?.value;
    const endInput = form.querySelector(`[data-meeting-end="${day.key}"]`)?.value;
    const start = timeInputToAtlasToken(startInput);
    const end = timeInputToAtlasToken(endInput);
    if (start && end && parseAtlasTimeToken(end) > parseAtlasTimeToken(start)) {
      overrides.meetings.push({ day: day.key, start, end });
    }
  });

  return overrides;
}

function openDetail(sectionId) {
  if (!sectionId) return;
  state.detailSectionId = sectionId;
  state.editingSectionId = null;
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
      applySavedCourse(payload.course);
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
  const accepted = await (window.APStudyConfirm?.request?.({
    title: "Remove class?",
    message: "This class will be removed from your weekly view.",
    acceptLabel: "Remove class",
    danger: true,
  }) ?? Promise.resolve(false));
  if (!accepted) return;
  if (sectionId) state.savingIds.add(sectionId);
  render();
  try {
    await fetchJson(`/api/courses/saved/${encodeURIComponent(courseId)}`, { method: "DELETE" });
    if (sectionId) state.savedCoursesBySection.delete(sectionId);
    if (state.detailSectionId === sectionId) {
      state.detailSectionId = null;
    }
    if (state.editingSectionId === sectionId) {
      state.editingSectionId = null;
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

function formatCourseCardSchedule(section) {
  const schedule = normalizeScheduleDisplay(section?.schedule_display || "");
  const instructor = section?.instructor || section?.instructor_name || "";
  const parts = [schedule, instructor].map((value) => String(value || "").trim()).filter(Boolean);
  return parts.length ? parts.join(" | ") : "TBA";
}

function normalizeScheduleDisplay(value) {
  return String(value || "").replace(/(\d(?::\d{2})?)\s*([ap])\b/gi, (_, time, suffix) => {
    return `${time} ${suffix.toLowerCase() === "a" ? "AM" : "PM"}`;
  });
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
  const suffix = hour24 >= 12 ? "PM" : "AM";
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
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

function rememberWeekScroll() {
  const scroller = document.getElementById("courses-week-scroller");
  if (!scroller) return;
  state.weekScrollTop = scroller.scrollTop;
  state.weekScrollLeft = scroller.scrollLeft;
}

function resetWeekScroll() {
  state.initialScrollDone = false;
  state.weekScrollTop = null;
  state.weekScrollLeft = null;
  state.weekScrollResetPending = true;
}

function restoreWeekScroll() {
  const scroller = document.getElementById("courses-week-scroller");
  if (!scroller) return;
  if (state.weekScrollTop !== null || state.weekScrollLeft !== null) {
    scroller.scrollTop = state.weekScrollTop || 0;
    scroller.scrollLeft = state.weekScrollLeft || 0;
    return;
  }
  if (!state.initialScrollDone) {
    scroller.scrollTop = Math.round(1.5 * COURSE_HOUR_HEIGHT);
    state.initialScrollDone = true;
  }
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

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}
