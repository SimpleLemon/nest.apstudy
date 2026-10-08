import { createCalendarStorage } from "../storage.js?v=4bd55bdec787c1375e384d2ce38fa1ce06e0119c269ef091fc0fbc93438a8079";

// Course dialog interactions belong to the course feature rather than calendar navigation.
export function createCourseControls({ root, runtimeWindow: view, lifecycle, state, courses }) {
    const doc = root.ownerDocument || root;
    const session = createCalendarStorage(view, "sessionStorage");
    const { applyCourseFilters, applyCoursesFiltersFromUrl, closeCoursesModal,
        openCoursesModal, renderCoursesModal, submitCoursesSearch, toggleCourseSectionSelection } = courses;
    const listen = (target, type, handler) => lifecycle?.addEventListener
        ? lifecycle.addEventListener(target, type, handler)
        : target?.addEventListener(type, handler);
    return function wireCourseControls() {
        if (!state.public.readOnly && session?.getItem("openCoursesPanelOnLoad") === "true") {
            session.removeItem("openCoursesPanelOnLoad");
            const schedule = lifecycle?.setTimeout || view.setTimeout.bind(view);
            schedule(() => {
                if (!state.courses.modalOpen) {
                    openCoursesModal(null);
                }
            }, 100);
        }
        if (!state.public.readOnly) {
            listen(doc, "profile-my-courses-click", (event) => {
                if (state.courses.modalOpen) {
                    closeCoursesModal();
                    return;
                }
                openCoursesModal(event.detail?.trigger || doc.activeElement);
            });
        }
        listen(root, "click", (event) => {
            const closeBtn = event.target.closest("#courses-modal-close");
            if (closeBtn) {
                closeCoursesModal();
                return;
            }
            if (event.target.id === "courses-modal-overlay") {
                closeCoursesModal();
                return;
            }
            const infoBtn = event.target.closest(".js-course-info-toggle");
            if (infoBtn) {
                event.preventDefault();
                const sectionId = infoBtn.getAttribute("data-section-id");
                if (!sectionId) return;
                if (state.courses.expandedDetails.has(sectionId)) {
                    state.courses.expandedDetails.delete(sectionId);
                } else {
                    state.courses.expandedDetails.add(sectionId);
                }
                renderCoursesModal();
                return;
            }
            const addBtn = event.target.closest(".js-course-toggle");
            if (addBtn) {
                event.preventDefault();
                const sectionId = addBtn.getAttribute("data-section-id");
                if (!sectionId) return;
                toggleCourseSectionSelection(sectionId);
                return;
            }
            const searchSubmitBtn = event.target.closest("#courses-search-submit");
            if (searchSubmitBtn) {
                event.preventDefault();
                submitCoursesSearch();
            }
        });
        listen(root, "input", (event) => {
            const searchInput = event.target.closest("#courses-search-input");
            if (!searchInput) return;
            state.courses.searchInput = searchInput.value || "";
        });
        listen(root, "keydown", (event) => {
            if (event.key !== "Enter") return;
            const searchInput = event.target.closest("#courses-search-input");
            if (!searchInput) return;
            event.preventDefault();
            submitCoursesSearch();
        });
        listen(root, "change", (event) => {
            const termSelect = event.target.closest("#courses-term-select");
            if (!termSelect) return;
            state.courses.termFilter = termSelect.value || "";
            submitCoursesSearch();
        });
        listen(view, "popstate", () => {
            applyCoursesFiltersFromUrl();
            state.courses.searchInput = state.courses.searchQuery;
            applyCourseFilters();
            if (state.courses.modalOpen) {
                renderCoursesModal();
            }
        });
        listen(view, "keydown", (event) => {
            if (event.key === "Escape" && state.courses.modalOpen) closeCoursesModal();
        });
    };
}
