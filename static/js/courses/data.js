(function () {
  function create({ state, buildSectionSearchBlob, timeInputToAtlasToken, render }) {
  async function fetchJson(url, options = {}) {
    if (window.APStudyHttp?.fetchJson) {
      return window.APStudyHttp.fetchJson(url, options);
    }
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
      "requirements",
      "campus",
      "campus_description",
      "course_description",
      "description",
      "enrollment_status",
      "enrollment_count",
      "seats_available",
      "enrollment_capacity",
      "waitlist_total",
      "waitlist_capacity",
      "grading_mode",
      "grading_mode_options",
      "instruction_method",
      "atlas_key",
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

    return {
      fetchJson,
      loadTerms,
      loadSectionsForTerm,
      loadSavedCourses,
      applySavedCourse,
      loadTracks,
      rememberSection,
      getDisplayCourse,
    };
  }

  window.APStudyCoursesData = { create };
}());
