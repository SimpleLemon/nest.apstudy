import * as courseUtils from './utils.js';
import { createCourseData } from './data.js';
import { meetingRemovalFocusPlan } from './edit.js';
import { createCourseDetails } from './details.js';
import { createCourseActions } from './actions.js';
import { create as createAvailabilityVerifier } from './verify.js';
import { createCourseFilters } from './filters.js';
import { createCoursePanel } from './panel.js';
import { createCourseCalendar } from './calendar.js';
import { createCourseControls } from './controls.js';

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
const COURSE_LIVE_HYDRATION_OVERSCAN = 5;
const COMPACT_COURSES_QUERY = window.matchMedia("(max-width: 640px)");
const BODY_SCROLLING_COURSES_QUERY = window.matchMedia("(max-width: 1024px)");
const COURSE_COLOR_PALETTE = Array.from({ length: 16 }, (_, index) => ({
  key: `course-color-${String(index + 1).padStart(2, "0")}`,
}));
const {
  parseCoursesSectionDeepLink,
} = courseUtils;
const availabilityVerifier = createAvailabilityVerifier({
  onStatusProgress: renderCourses,
});

const state = {
  loading: true,
  sectionsLoading: false,
  savingIds: new Set(),
  trackingIds: new Set(),
  terms: [],
  termMetadata: {},
  termDateRanges: {},
  selectedTerm: window.APSTUDY_COURSES_DEFAULT_TERM || "",
  sections: [],
  sectionsById: {},
  currentSectionsRequest: 0,
  savedCoursesBySection: new Map(),
  tracksBySection: new Map(),
  trackingTermPolicies: {},
  allowedTrackIntervals: [30],
  trackingTier: { key: "free", label: "Free" },
  trackingUsage: 0,
  trackingLimit: null,
  removedSelectedSections: new Map(),
  activeCourseView: "search",
  searchQuery: "",
  dayFilters: new Set(),
  campusFilter: window.APSTUDY_COURSES_DEFAULT_CAMPUS || "atlanta",
  requirementFilter: "all",
  statusFilters: new Set(),
  filtersOpen: false,
  timeEnabled: false,
  timeStart: "06:00",
  timeEnd: "23:59",
  hoveredSectionId: null,
  detailSectionId: null,
  detailReturnContext: null,
  editingSectionId: null,
  editingSaving: false,
  detailLoading: false,
  detailLiveError: "",
  liveHydrationTimer: null,
  error: "",
  weekScrollTop: null,
  weekScrollLeft: null,
  weekScrollResetPending: false,
  initialScrollDone: false,
};

const {
  loadTerms, loadSectionsForTerm, loadSavedCourses, applySavedCourse, loadTracks, rememberSection, getSection,
} = createCourseData({
  state, fetchJson, render, renderCourses,
  renderCalendarHeader: () => renderCalendarHeader(),
  timeInputToAtlasToken: (value) => timeInputToAtlasToken(value),
  scheduleVisibleLiveHydration, verifyCurrentAvailability,
});

const courseFilters = createCourseFilters({
  state,
  COURSE_START_MINUTES,
  COURSE_END_MINUTES,
  getSection,
  rememberSection,
  getEffectiveAvailability: (section) => availabilityVerifier.getEffectiveAvailability(section),
  utils: courseUtils,
});
const { getFilteredSections, isAvailabilityVerificationPending } = courseFilters;
const coursePanel = createCoursePanel({
  state,
  COURSE_COLOR_PALETTE,
  COURSE_DAYS,
  getFilteredSections,
  getSection,
  isTrackable,
  getEffectiveAvailability,
  utils: courseUtils,
});
const {
  getCourseColor,
  buildMeetingRowHtml,
  renderPanel,
  renderTermSelect,
  syncFilterControls,
  timeInputToAtlasToken,
} = coursePanel;
const courseCalendar = createCourseCalendar({
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
  utils: courseUtils,
});
const {
  isCompactCoursesViewport,
  renderCalendar,
  renderCalendarHeader,
  resetWeekScroll,
} = courseCalendar;
const { startEditingCourse, saveEditedCourse, openDetail, closeDetail, clearDetailReturnContext, refreshSectionStatus } = createCourseDetails({
  state, COURSE_COLOR_PALETTE, COURSE_DAYS, BODY_SCROLLING_COURSES_QUERY,
  applySavedCourse, fetchJson, rememberSection, render, renderCalendar, renderPanel,
  showToast, timeInputToAtlasToken, utils: courseUtils,
});
const { addCourse, removeCourse, setTrack, removeTrack } = createCourseActions({
  state, applySavedCourse, clearDetailReturnContext, fetchJson, getSection,
  rememberSection, render, renderPanel, showToast,
});
const { wireControls } = createCourseControls({
  state,
  addCourse,
  buildMeetingRowHtml,
  changeTermBy,
  clearDetailReturnContext,
  closeDetail,
  isCompactCoursesViewport,
  loadSectionsForTerm,
  openDetail,
  removeCourse,
  removeTrack,
  renderCalendar,
  renderCourses,
  renderPanel,
  resetWeekScroll,
  refreshSectionStatus,
  saveEditedCourse,
  setTrack,
  startEditingCourse,
  syncFilterControls,
  scheduleVisibleLiveHydration,
  verifyCurrentAvailability,
  meetingRemovalFocusPlan,
});

function startCourses() {
  wireControls();
  wireLiveHydrationControls();
  void bootstrap();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startCourses, { once: true });
} else {
  startCourses();
}

async function bootstrap() {
  try {
    await Promise.all([loadTerms(), loadSavedCourses(), loadTracks()]);
    if (state.selectedTerm) {
      await loadSectionsForTerm(state.selectedTerm);
    }
    await applyCoursesDeepLink();
  } catch (error) {
    console.error(error);
    state.error = error.message || "Unable to load courses.";
  } finally {
    state.loading = false;
    render();
  }
}

async function applyCoursesDeepLink() {
  const sectionId = parseCoursesSectionDeepLink(window.location);
  if (!sectionId) return;

  try {
    const payload = await fetchJson("/api/atlas/sections/by-id", {
      method: "POST",
      body: JSON.stringify({
        section_ids: [sectionId],
        include_cancelled: true,
      }),
    });
    const sections = Array.isArray(payload.sections) ? payload.sections : [];
    const section = sections.find((row) => String(row.id || "") === sectionId) || sections[0];
    if (!section) {
      showToast("Course section not found.", true);
      return;
    }

    rememberSection(section);
    const sectionTerm = section.term || state.selectedTerm;
    if (sectionTerm && state.terms.includes(sectionTerm)) {
      state.selectedTerm = sectionTerm;
      await loadSectionsForTerm(sectionTerm);
      rememberSection(section);
    }
    openDetail(String(section.id || sectionId));
    window.history.replaceState({}, "", window.location.pathname);
  } catch (error) {
    console.error(error);
    showToast(error.message || "Course section not found.", true);
  }
}

function fetchJson(url, options = {}) {
  return window.APStudyHttp.fetchJson(url, { pendingLabel: "courses-save", ...options });
}

function buildAvailabilityQueryInput() {
  return {
    term: state.selectedTerm,
    query: state.searchQuery.trim(),
    days: Array.from(state.dayFilters).sort(),
    timeEnabled: state.timeEnabled,
    timeStart: state.timeStart,
    timeEnd: state.timeEnd,
    campus: state.campusFilter,
    requirement: state.requirementFilter,
  };
}

function getAvailabilityCandidates() {
  const candidates = getFilteredSections({ ignoreStatus: true });
  const sectionIds = candidates
    .map((section) => String(section?.id || section?.section_id || ""))
    .filter(Boolean);
  return { candidates, sectionIds };
}

function renderCourses() {
  if (state.loading || state.error || state.editingSectionId || state.detailSectionId || state.sectionsLoading) {
    renderPanel();
    return;
  }
  const candidates = getFilteredSections({ ignoreStatus: true });
  if (state.statusFilters.size && isAvailabilityVerificationPending(candidates)) {
    renderAvailabilityPendingState();
    return;
  }
  renderPanel();
}

function renderAvailabilityPendingState() {
  const summary = document.getElementById("courses-result-summary");
  const content = document.getElementById("courses-panel-content");
  if (!content) return;
  if (summary) summary.textContent = "Verifying live availability…";
  content.innerHTML = `<div class="courses-state" role="status" aria-live="polite">Verifying live availability…</div>`;
}

async function verifyCurrentAvailability() {
  let settledState = null;
  try {
    const { sectionIds } = getAvailabilityCandidates();
    const queryPromise = availabilityVerifier.startQuery({
      queryInput: buildAvailabilityQueryInput(),
      sectionIds,
    });
    renderCourses();
    settledState = await queryPromise;
  } catch (error) {
    console.error(error);
    return;
  }
  const currentState = availabilityVerifier.getState();
  if (currentState.generation !== settledState.generation
    || currentState.querySignature !== settledState.querySignature) {
    return;
  }
  renderCourses();
}

function render() {
  renderTermSelect();
  renderCourses();
  renderCalendar();
  scheduleVisibleLiveHydration();
}

function changeTermBy(delta) {
  const currentIndex = state.terms.indexOf(state.selectedTerm);
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.terms.length) return;
  state.selectedTerm = state.terms[nextIndex];
  state.hoveredSectionId = null;
  clearDetailReturnContext();
  state.detailSectionId = null;
  state.editingSectionId = null;
  state.filtersOpen = false;
  state.removedSelectedSections.clear();
  resetWeekScroll();
  renderTermSelect();
  void loadSectionsForTerm(state.selectedTerm, { termChanged: true });
}

function isTrackable(section) {
  if (section?.is_cancelled) return false;
  const availability = availabilityVerifier.getEffectiveAvailability(section);
  if (!availability || availability.phase !== "verified" || availability.current !== true) return false;
  if (String(availability.status || "").toLowerCase() === "closed") return true;
  return availability.seatsAvailable === 0;
}

function getEffectiveAvailability(section) {
  return availabilityVerifier.getEffectiveAvailability(section);
}

function wireLiveHydrationControls() {
  const content = document.getElementById("courses-panel-content");
  content?.addEventListener("scroll", scheduleVisibleLiveHydration, { passive: true });
  window.addEventListener("resize", scheduleVisibleLiveHydration);
  window.addEventListener("scroll", scheduleVisibleLiveHydration, { passive: true });
}

function scheduleVisibleLiveHydration() {
  window.clearTimeout(state.liveHydrationTimer);
  state.liveHydrationTimer = window.setTimeout(hydrateVisibleLiveSections, 140);
}

function visibleHydrationSectionIds() {
  if (state.loading || state.sectionsLoading || state.detailSectionId || state.editingSectionId) return [];
  const content = document.getElementById("courses-panel-content");
  if (!content) return [];
  const cards = Array.from(content.querySelectorAll(".course-card[data-section-id]"));
  if (!cards.length) return [];

  const contentRect = content.getBoundingClientRect();
  const viewportTop = Math.max(0, contentRect.top);
  const viewportBottom = Math.min(window.innerHeight, contentRect.bottom);
  const selected = [];
  let lastVisibleIndex = -1;
  cards.forEach((card, index) => {
    const rect = card.getBoundingClientRect();
    const visible = rect.bottom >= viewportTop && rect.top <= viewportBottom;
    if (!visible) return;
    selected.push(card.dataset.sectionId);
    lastVisibleIndex = Math.max(lastVisibleIndex, index);
  });

  if (lastVisibleIndex < 0) {
    lastVisibleIndex = Math.min(cards.length - 1, COURSE_LIVE_HYDRATION_OVERSCAN - 1);
    for (let index = 0; index <= lastVisibleIndex; index += 1) {
      selected.push(cards[index].dataset.sectionId);
    }
  }

  for (
    let index = lastVisibleIndex + 1;
    index < cards.length && index <= lastVisibleIndex + COURSE_LIVE_HYDRATION_OVERSCAN;
    index += 1
  ) {
    selected.push(cards[index].dataset.sectionId);
  }

  return Array.from(new Set(selected));
}

async function hydrateVisibleLiveSections() {
  const sectionIds = visibleHydrationSectionIds();
  if (!sectionIds.length) return;
  const beforeState = availabilityVerifier.getState();
  let settledState = null;
  try {
    settledState = await availabilityVerifier.requestDetails(sectionIds);
  } catch (error) {
    console.error(error);
    return;
  }
  const currentState = availabilityVerifier.getState();
  if (!settledState
    || beforeState.generation !== currentState.generation
    || currentState.generation !== settledState.generation) {
    return;
  }
  const changed = currentState.detailedIds.size !== beforeState.detailedIds.size
    || currentState.detailErrors.size !== beforeState.detailErrors.size
    || currentState.errors.size !== beforeState.errors.size;
  if (!changed) return;
  rerenderAfterLiveHydration();
}

function rerenderAfterLiveHydration() {
  const before = document.getElementById("courses-panel-content")?.scrollTop || 0;
  renderCourses();
  const content = document.getElementById("courses-panel-content");
  if (content) content.scrollTop = before;
  scheduleVisibleLiveHydration();
}

function showToast(message, isError = false, options = {}) {
  if (!window.APStudyToast) return null;
  return window.APStudyToast.show({
    message,
    title: options.title,
    type: isError ? "error" : "success",
    action: options.action,
    duration: options.duration,
  });
}
