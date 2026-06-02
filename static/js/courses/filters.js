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
