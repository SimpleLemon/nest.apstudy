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
const COURSE_COLOR_PALETTE = Array.from({ length: 16 }, (_, index) => ({
  key: `course-color-${String(index + 1).padStart(2, "0")}`,
}));
const {
  buildSectionSearchBlob,
  cssEscape,
  parseAtlasTimeToken,
} = window.APStudyCoursesUtils;

const state = {
  loading: true,
  sectionsLoading: false,
  savingIds: new Set(),
  trackingIds: new Set(),
  terms: [],
  selectedTerm: window.APSTUDY_COURSES_DEFAULT_TERM || "",
  sections: [],
  sectionsById: {},
  currentSectionsRequest: 0,
  savedCoursesBySection: new Map(),
  tracksBySection: new Map(),
  removedSelectedSections: new Map(),
  activeCourseView: "search",
  searchQuery: "",
  dayFilters: new Set(),
  campusFilter: window.APSTUDY_COURSES_DEFAULT_CAMPUS || "atlanta",
  requirementFilter: "all",
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

const courseFilters = window.APStudyCoursesFilters.create({
  state,
  COURSE_START_MINUTES,
  COURSE_END_MINUTES,
  getSection,
  rememberSection,
  utils: window.APStudyCoursesUtils,
});
const { getFilteredSections } = courseFilters;
const coursePanel = window.APStudyCoursesPanel.create({
  state,
  COURSE_COLOR_PALETTE,
  COURSE_DAYS,
  COURSE_RESULT_LIMIT,
  getFilteredSections,
  getSection,
  isTrackable,
  utils: window.APStudyCoursesUtils,
});
const {
  getCourseColor,
  renderPanel,
  renderTermSelect,
  syncFilterControls,
  timeInputToAtlasToken,
} = coursePanel;
const courseCalendar = window.APStudyCoursesCalendar.create({
  state,
  COURSE_DAYS,
  COURSE_START_HOUR,
  COURSE_END_HOUR,
  COURSE_START_MINUTES,
  COURSE_END_MINUTES,
  COURSE_HOUR_HEIGHT,
  COMPACT_COURSES_QUERY,
  getCourseColor,
  getSection,
  utils: window.APStudyCoursesUtils,
});
const {
  isCompactCoursesViewport,
  renderCalendar,
  resetWeekScroll,
} = courseCalendar;
const { wireControls } = window.APStudyCoursesControls.create({
  state,
  addCourse,
  changeTermBy,
  isCompactCoursesViewport,
  loadSectionsForTerm,
  openDetail,
  removeCourse,
  renderCalendar,
  renderPanel,
  resetWeekScroll,
  saveEditedCourse,
  setTrack,
  startEditingCourse,
  syncFilterControls,
});

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
  const requestId = state.currentSectionsRequest + 1;
  state.currentSectionsRequest = requestId;
  state.sectionsLoading = true;
  state.error = "";
  render();
  try {
    const params = new URLSearchParams({
      term,
      include_cancelled: "0",
    });
    const query = state.searchQuery.trim();
    if (query) {
      params.set("q", query);
      params.set("limit", "500");
    }
    if (state.dayFilters.size) {
      params.set("days", Array.from(state.dayFilters).join(","));
    }
    if (state.timeEnabled) {
      params.set("time_start", timeInputToAtlasToken(state.timeStart) || "0600");
      params.set("time_end", timeInputToAtlasToken(state.timeEnd) || "2359");
    }
    if (state.campusFilter && state.campusFilter !== "all") {
      params.set("campus", state.campusFilter);
    }
    if (state.requirementFilter && state.requirementFilter !== "all") {
      params.set("requirement", state.requirementFilter);
    }
    const payload = await fetchJson(`/api/atlas/sections?${params.toString()}`);
    if (requestId !== state.currentSectionsRequest) return;
    state.sectionsById = Object.fromEntries(
      Object.entries(state.sectionsById).filter(([id]) => (
        state.savedCoursesBySection.has(id) || state.tracksBySection.has(id)
      ))
    );
    const rawSections = Array.isArray(payload.sections) ? payload.sections : [];
    state.sections = rawSections.map((section) => rememberSection(section)).filter(Boolean);
  } catch (error) {
    if (requestId !== state.currentSectionsRequest) return;
    console.error(error);
    state.error = error.message || "Unable to load course sections.";
  } finally {
    if (requestId !== state.currentSectionsRequest) return;
    state.sectionsLoading = false;
    render();
  }
}

async function loadSavedCourses() {
  const payload = await fetchJson("/api/courses/saved");
  state.savedCoursesBySection = new Map();
  state.removedSelectedSections.clear();
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
    "campus",
    "campus_description",
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

function render() {
  renderTermSelect();
  renderPanel();
  renderCalendar();
}

function changeTermBy(delta) {
  const currentIndex = state.terms.indexOf(state.selectedTerm);
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.terms.length) return;
  state.selectedTerm = state.terms[nextIndex];
  state.detailSectionId = null;
  state.editingSectionId = null;
  state.filtersOpen = false;
  state.removedSelectedSections.clear();
  resetWeekScroll();
  renderTermSelect();
  void loadSectionsForTerm(state.selectedTerm);
}

function startEditingCourse(sectionId) {
  if (!sectionId || !state.savedCoursesBySection.has(String(sectionId))) return;
  state.detailSectionId = sectionId;
  state.editingSectionId = sectionId;
  state.filtersOpen = false;
  renderPanel();
  scrollPanelContentToTop();
}

async function saveEditedCourse(sectionId) {
  const savedCourse = state.savedCoursesBySection.get(String(sectionId));
  if (!savedCourse?.id || state.editingSaving) return;
  const form = document.querySelector(`.courses-edit[data-editing-section-id="${cssEscape(sectionId)}"]`);
  if (!form) return;

  const selectedColor = form.querySelector("[data-course-color-key].is-selected")?.dataset.courseColorKey
    || savedCourse.color_key
    || COURSE_COLOR_PALETTE[0].key;
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
    campus: valueFor("campus"),
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
  scrollPanelContentToTop();
  void refreshSectionStatus(sectionId);
}

async function refreshSectionStatus(sectionId) {
  state.detailLoading = true;
  renderPanel();
  const section = getSection(sectionId);
  let liveSection = null;
  let liveError = "";
  if (section && window.APStudyAtlasLive?.fetchSectionStatus) {
    try {
      liveSection = await window.APStudyAtlasLive.fetchSectionStatus(section);
    } catch (error) {
      console.warn("Browser Atlas live refresh failed:", error);
      liveError = error.message || "Live Atlas status unavailable from this browser.";
    }
  } else {
    liveError = "Live Atlas status unavailable from this browser.";
  }
  try {
    const payload = await fetchJson("/api/courses/section-status", {
      method: "POST",
      body: JSON.stringify({
        section_id: sectionId,
        live_section: liveSection,
        live_error: liveError,
      }),
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
      state.removedSelectedSections.delete(String(payload.course.section_id));
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
    const removedSection = sectionId ? getSection(sectionId) : null;
    await fetchJson(`/api/courses/saved/${encodeURIComponent(courseId)}`, { method: "DELETE" });
    if (sectionId) state.savedCoursesBySection.delete(sectionId);
    if (sectionId && state.activeCourseView === "selected" && removedSection) {
      state.removedSelectedSections.set(String(sectionId), { ...removedSection, id: String(sectionId) });
    }
    if (state.detailSectionId === sectionId) {
      state.detailSectionId = null;
    }
    if (state.editingSectionId === sectionId) {
      state.editingSectionId = null;
    }
    showToast("Class removed.", false, {
      action: sectionId ? { label: "Undo", onClick: () => addCourse(sectionId) } : undefined,
    });
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
  const section = getSection(sectionId);
  let liveSection = null;
  let liveError = "";
  if (enabled && section && window.APStudyAtlasLive?.fetchSectionStatus) {
    try {
      liveSection = await window.APStudyAtlasLive.fetchSectionStatus(section);
      rememberSection(liveSection);
    } catch (error) {
      console.warn("Browser Atlas live refresh failed:", error);
      liveError = error.message || "Live Atlas status unavailable from this browser.";
    }
  }
  try {
    const payload = await fetchJson("/api/courses/tracks", {
      method: "POST",
      body: JSON.stringify({
        section_id: sectionId,
        enabled,
        live_section: liveSection,
        live_error: liveError,
      }),
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
  if (section?.is_cancelled) return false;
  const status = String(section?.enrollment_status || "").toLowerCase();
  const seats = Number.parseInt(section?.seats_available, 10);
  if (seats === 0) return true;
  return status === "closed" && Number.isNaN(seats);
}

function scrollPanelContentToTop() {
  const content = document.getElementById("courses-panel-content");
  if (!content) return;
  content.scrollTop = 0;
  window.requestAnimationFrame?.(() => {
    content.scrollTop = 0;
  });
}

function showToast(message, isError = false, options = {}) {
  if (!window.APStudyToast) return null;
  return window.APStudyToast.show({
    message,
    type: isError ? "error" : "success",
    action: options.action,
  });
}
