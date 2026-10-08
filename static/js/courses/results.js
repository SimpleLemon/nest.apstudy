const COURSE_RESULT_PAGE_SIZE = 100;

function resultQueryKey(state) {
  return JSON.stringify([
    state.selectedTerm, state.activeCourseView, state.searchQuery,
    [...state.dayFilters].sort(), [...state.statusFilters].sort(),
    state.campusFilter, state.requirementFilter, state.timeEnabled,
    state.timeStart, state.timeEnd,
  ]);
}

function visibleCourseResults(state, sections) {
  const key = resultQueryKey(state);
  if (state.resultsQueryKey !== key) {
    state.resultsQueryKey = key;
    state.visibleResultCount = COURSE_RESULT_PAGE_SIZE;
  }
  return sections.slice(0, state.visibleResultCount || COURSE_RESULT_PAGE_SIZE);
}

function showMoreCourseResults(state) {
  state.visibleResultCount = (state.visibleResultCount || COURSE_RESULT_PAGE_SIZE) + COURSE_RESULT_PAGE_SIZE;
}

// Replacing cards during live updates must not discard a keyboard user's place.
function preserveCourseListPosition(content, render) {
  const active = document.activeElement;
  const card = active?.closest?.('.course-card[data-section-id]');
  const sectionId = card && content.contains?.(card) ? card.dataset.sectionId : null;
  const controlIndex = sectionId && active !== card
    ? Array.from(card.querySelectorAll('a, button, input, select, textarea')).indexOf(active)
    : -1;
  const hasCards = Boolean(content.querySelector?.('.course-card[data-section-id]'));
  const scrollTop = content.scrollTop;
  const scrollLeft = content.scrollLeft;
  const documentScroll = { left: window.scrollX || 0, top: window.scrollY || 0 };
  render();
  if (!hasCards || !content.querySelector?.('.course-card[data-section-id]')) return;
  content.scrollTop = scrollTop;
  content.scrollLeft = scrollLeft;
  if (sectionId) {
    const nextCard = Array.from(content.querySelectorAll('.course-card[data-section-id]'))
      .find((element) => element.dataset.sectionId === sectionId);
    const target = controlIndex >= 0 ? nextCard?.querySelectorAll('a, button, input, select, textarea')[controlIndex] : nextCard;
    target?.focus?.({ preventScroll: true });
  }
  if (window.scrollX !== documentScroll.left || window.scrollY !== documentScroll.top) {
    window.scrollTo?.({ ...documentScroll, behavior: 'auto' });
  }
}

export { COURSE_RESULT_PAGE_SIZE, visibleCourseResults, showMoreCourseResults, preserveCourseListPosition };
