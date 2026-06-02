(function () {
  function createCourseCalendar({
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
    utils,
  }) {
    const {
      escapeHtml,
      formatAtlasTime,
      formatDateRange,
      formatHourLabel,
      formatTermLabel,
      parseAtlasTimeToken,
    } = utils;

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
      if (
        state.hoveredSectionId
        && !state.savedCoursesBySection.has(state.hoveredSectionId)
        && !state.removedSelectedSections.has(state.hoveredSectionId)
      ) {
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
            detail: `${formatAtlasTime(meeting.start)}-${formatAtlasTime(meeting.end)}`,
            colorKey: section.color_key,
          };
        })
        .filter(Boolean);
    }

    function layoutEvents(events) {
      const sorted = events.slice().sort((a, b) => a.start - b.start || a.end - b.end);
      const groups = [];
      for (const event of sorted) {
        const activeGroup = groups[groups.length - 1];
        if (!activeGroup || event.start >= activeGroup.end) {
          groups.push({ end: event.end, events: [event] });
        } else {
          activeGroup.end = Math.max(activeGroup.end, event.end);
          activeGroup.events.push(event);
        }
      }

      return groups.flatMap((group) => layoutConflictGroup(group.events));
    }

    function layoutConflictGroup(events) {
      const lanes = [];
      for (const event of events) {
        let lane = 0;
        while (lane < lanes.length && lanes[lane] > event.start) lane += 1;
        if (lane === lanes.length) lanes.push(0);
        lanes[lane] = event.end;
        event.lane = lane;
      }
      const laneCount = Math.max(1, lanes.length);
      return events.map((event) => ({ ...event, laneCount }));
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

    return {
      isCompactCoursesViewport,
      renderCalendar,
      resetWeekScroll,
    };
  }

  window.APStudyCoursesCalendar = { create: createCourseCalendar };
})();
