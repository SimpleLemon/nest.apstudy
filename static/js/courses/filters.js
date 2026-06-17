(function () {
  function createCourseFilters({
    state,
    COURSE_START_MINUTES,
    COURSE_END_MINUTES,
    getSection,
    rememberSection,
    utils,
  }) {
    const {
      buildSectionSearchBlob,
      compareCourseSections,
      parseAtlasTimeToken,
      parseTimeInput,
    } = utils;

    function getFilteredSections() {
      const query = state.searchQuery.trim().toLowerCase();
      return getSectionsForActiveView().filter((section) => {
        if (section.term && section.term !== state.selectedTerm) return false;
        const searchBlob = section.searchBlob || buildSectionSearchBlob(section);
        if (query && !searchBlob.includes(query)) return false;
        if (!sectionMatchesCampus(section)) return false;
        if (!sectionMatchesRequirement(section)) return false;
        if (!sectionMatchesDay(section)) return false;
        if (!sectionMatchesTime(section)) return false;
        return true;
      });
    }

    function getSectionsForActiveView() {
      if (state.activeCourseView === "selected") {
        const sections = Array.from(state.savedCoursesBySection.entries())
          .map(([sectionId, course]) => resolvePanelSection(sectionId, course))
          .filter(Boolean);
        for (const [sectionId, section] of state.removedSelectedSections.entries()) {
          if (state.savedCoursesBySection.has(sectionId)) continue;
          const resolved = resolvePanelSection(sectionId, section);
          if (resolved) sections.push(resolved);
        }
        return sections.sort(compareCourseSections);
      }
      if (state.activeCourseView === "tracked") {
        return Array.from(state.tracksBySection.entries())
          .filter(([, track]) => Boolean(track?.enabled))
          .map(([sectionId, track]) => resolvePanelSection(sectionId, track))
          .filter(Boolean)
          .sort(compareCourseSections);
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

    function sectionMatchesCampus(section) {
      const campus = String(state.campusFilter || "all").toLowerCase();
      if (!campus || campus === "all") return true;
      const value = String(section.campus || section.campus_description || "").toLowerCase();
      if (!value) return campus === "atlanta";
      if (campus === "oxford") return value.includes("oxford");
      if (campus === "atlanta") return value.includes("atlanta") || value.includes("main") || value === "emory";
      return value.includes(campus);
    }

    function sectionMatchesRequirement(section) {
      const requirement = String(state.requirementFilter || "all").toLowerCase();
      if (!requirement || requirement === "all") return true;
      const values = [
        section.requirement_designation,
        section.requirements,
        section.requirement,
        section.ger,
        section.attributes,
      ].flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value || "").toLowerCase());
      if (requirement === "starred") return values.some((value) => value.includes("*"));
      const normalizedRequirement = normalizeRequirement(requirement);
      return values.some((value) => normalizeRequirement(value) === normalizedRequirement || normalizeRequirement(value).includes(normalizedRequirement));
    }

    function normalizeRequirement(value) {
      return String(value || "").toLowerCase().replace(/[^a-z0-9*]+/g, "");
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

    return { getFilteredSections };
  }

  window.APStudyCoursesFilters = { create: createCourseFilters };
})();
