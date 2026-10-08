import { collectMeetingOverrides } from './edit.js';

function createCourseDetails({
  state, COURSE_COLOR_PALETTE, COURSE_DAYS, BODY_SCROLLING_COURSES_QUERY,
  applySavedCourse, fetchJson, rememberSection, render, renderCalendar, renderPanel,
  showToast, timeInputToAtlasToken, utils,
}) {
  const { cssEscape, parseAtlasTimeToken } = utils;

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
      showToast(error.message || "Try again in a moment.", true, { title: "Couldn’t update class" });
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

    overrides.meetings = collectMeetingOverrides(
      Array.from(form.querySelectorAll(".courses-meeting-row")).map((row) => ({
        day: row.querySelector("[data-meeting-day]")?.value,
        start: row.querySelector("[data-meeting-start]")?.value,
        end: row.querySelector("[data-meeting-end]")?.value,
      })),
      { COURSE_DAYS, parseAtlasTimeToken, timeInputToAtlasToken },
    );

    return overrides;
  }

  function openDetail(sectionId, opener = null) {
    if (!sectionId) return;
    captureDetailReturnContext(sectionId, opener);
    state.detailSectionId = sectionId;
    state.editingSectionId = null;
    state.detailLiveError = "";
    state.filtersOpen = false;
    renderPanel();
    scrollPanelContentToTop();
    void refreshSectionStatus(sectionId, { force: false });
  }

  function captureDetailReturnContext(sectionId, opener) {
    const normalizedSectionId = String(sectionId);
    if (state.detailReturnContext?.sectionId === normalizedSectionId) return;
    clearDetailReturnContext();
    const content = document.getElementById("courses-panel-content");
    const hasListOrigin = opener instanceof HTMLElement
      && content?.contains(opener)
      && opener.matches(".course-card[data-section-id]")
      && String(opener.dataset.sectionId) === normalizedSectionId;
    if (!hasListOrigin) return;
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    state.detailReturnContext = {
      sectionId: normalizedSectionId,
      panelScrollTop: content?.scrollTop || 0,
      documentScroll: BODY_SCROLLING_COURSES_QUERY.matches
        ? { left: window.scrollX || 0, top: window.scrollY || 0 }
        : null,
      opener: opener instanceof HTMLElement ? opener : focusedElement,
    };
  }

  function clearDetailReturnContext() {
    state.detailReturnContext = null;
  }

  function closeDetail() {
    const closingSectionId = String(state.detailSectionId || state.editingSectionId || "");
    const returnContext = state.detailReturnContext?.sectionId === closingSectionId
      ? state.detailReturnContext
      : null;
    state.detailSectionId = null;
    state.editingSectionId = null;
    state.detailLiveError = "";
    clearDetailReturnContext();
    renderPanel();
    if (returnContext) restoreDetailReturnContext(returnContext);
  }

  function restoreDetailReturnContext(returnContext) {
    const restoreScroll = () => {
      const content = document.getElementById("courses-panel-content");
      if (content) content.scrollTop = returnContext.panelScrollTop;
      if (returnContext.documentScroll && BODY_SCROLLING_COURSES_QUERY.matches) {
        window.scrollTo({
          left: returnContext.documentScroll.left,
          top: returnContext.documentScroll.top,
          behavior: "auto",
        });
      }
    };

    restoreScroll();
    window.requestAnimationFrame?.(restoreScroll);

    const fallback = document.getElementById("courses-search-input") || document.getElementById("courses-result-summary");
    const focusTarget = focusCourseCard(returnContext.sectionId) || getConnectedFocusTarget(returnContext.opener) || fallback;
    if (focusTarget === document.getElementById("courses-result-summary")) {
      focusTarget.tabIndex = -1;
    }
    if (focusTarget !== document.activeElement) focusTarget?.focus?.({ preventScroll: true });
  }

  function focusCourseCard(sectionId) {
    const content = document.getElementById("courses-panel-content");
    const card = content?.querySelector(`.course-card[data-section-id="${cssEscape(sectionId)}"]`);
    card?.focus?.({ preventScroll: true });
    return card || null;
  }

  function getConnectedFocusTarget(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.matches(":disabled")) return null;
    if (element.tabIndex >= 0 || element.matches("a[href], button, input, select, textarea, [contenteditable='true']")) {
      return element;
    }
    return null;
  }

  async function refreshSectionStatus(sectionId, options = {}) {
    state.detailLoading = true;
    renderPanel();
    try {
      const payload = await fetchJson("/api/courses/section-status", {
        method: "POST",
        body: JSON.stringify({
          section_id: sectionId,
          force: options.force !== false,
        }),
      });
      if (payload.section) {
        payload.section.live_updated_at = payload.last_updated_at || new Date().toISOString();
        rememberSection(payload.section);
      }
      state.detailLiveError = payload.live_error || "";
      if (payload.live_error) {
        showToast(payload.live_error || "Live Atlas status unavailable.", true);
      }
    } catch (error) {
      console.error(error);
      state.detailLiveError = error.message || "Live status unavailable.";
      showToast(state.detailLiveError, true);
    } finally {
      state.detailLoading = false;
      const focusedCardId = state.detailSectionId
        ? null
        : document.activeElement?.closest?.(".course-card[data-section-id]")?.dataset.sectionId;
      renderPanel();
      if (focusedCardId) focusCourseCard(focusedCardId);
      renderCalendar();
    }
  }

  function scrollPanelContentToTop() {
    const content = document.getElementById("courses-panel-content");
    if (!content) return;
    content.scrollTop = 0;
    window.requestAnimationFrame?.(() => {
      content.scrollTop = 0;
    });
  }

  return { startEditingCourse, saveEditedCourse, openDetail, closeDetail, clearDetailReturnContext, refreshSectionStatus };
}

export { createCourseDetails };
