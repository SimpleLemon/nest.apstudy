import { describe as describeTrackingPolicy } from './tracking-policy.js';
import { renderCourseCardSchedule } from './ratings.js';
import { createCourseDetailView } from './detail-view.js';
import { createCourseEditor } from './edit.js';
import { visibleCourseResults, preserveCourseListPosition } from './results.js';

const AVAILABILITY_PHASES = {
  UNVERIFIED: "unverified",
  PENDING: "pending",
  VERIFIED: "verified",
  UNAVAILABLE: "unavailable",
};
const STATUS_CHIP_CLASSES = { open: "is-open", closed: "is-closed" };
const UNAVAILABLE_SEATS_TITLE = "Live availability could not be verified from Atlas just now.";

function createCoursePanel({
  state,
  COURSE_COLOR_PALETTE,
  COURSE_DAYS,
  getFilteredSections,
  getSection,
  getEffectiveAvailability,
  utils,
}) {
  const {
    cssEscape,
    escapeHtml,
    formatTermLabel,
  } = utils;

  const { buildDetailHtml } = createCourseDetailView({
    state, getSection, formatCampus, formatRequirement, utils,
  });
  const { buildEditHtml, buildMeetingRowHtml, timeInputToAtlasToken } = createCourseEditor({
    state, COURSE_COLOR_PALETTE, COURSE_DAYS, getSection, getCourseColor, formatCampus, formatRequirement, utils,
  });

  function buildCourseResultsSkeletonHtml(label = "Loading courses...") {
    const block = (className) => window.APStudySkeleton?.block?.(className)
      || `<div data-slot="skeleton" class="bg-muted rounded-md animate-pulse ${className}"></div>`;
    return `
      <div class="courses-results-skeleton apstudy-skeleton" role="status" aria-live="polite" aria-busy="true">
        <span class="sr-only">${escapeHtml(label)}</span>
        <div class="contents" aria-hidden="true">
          ${Array.from({ length: 4 }, (_, index) => `
            <article class="course-card course-skeleton-card">
              <div class="course-card-top">
                <div class="course-card-title">
                  ${block(index % 2 ? "h-4 w-28" : "h-4 w-36")}
                  ${block(index % 2 ? "h-3 w-4/5" : "h-3 w-full")}
                </div>
                ${block("h-8 w-[72px]")}
              </div>
              <div class="course-card-schedule">${block("h-3 w-3/4")}</div>
              <div class="course-card-meta">${block("h-6 w-14 rounded-full")} ${block("h-6 w-16 rounded-full")} ${block("h-6 w-12 rounded-full")}</div>
            </article>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderTermSelect() {
    const select = document.getElementById("courses-term-select");
    if (!select) return;
    select.innerHTML = state.terms
      .map((term) => `<option value="${escapeHtml(term)}" ${term === state.selectedTerm ? "selected" : ""}>${escapeHtml(formatTermLabel(term))}</option>`)
      .join("");
    const searchInput = document.getElementById("courses-search-input");
    if (searchInput) {
      const termLabel = formatTermLabel(state.selectedTerm);
      searchInput.placeholder = termLabel ? `Search ${termLabel} classes` : "Search classes";
    }
  }

  function renderPanel() {
    const content = document.getElementById("courses-panel-content");
    if (content) preserveCourseListPosition(content, renderPanelContent);
  }

  function renderPanelContent() {
    const summary = document.getElementById("courses-result-summary");
    const content = document.getElementById("courses-panel-content");
    if (!summary || !content) return;

    document.querySelector(".courses-panel")?.classList.toggle("is-detailing", Boolean(state.detailSectionId || state.editingSectionId));
    syncViewControls();
    syncFilterControls();

    if (state.loading) {
      summary.textContent = "Loading Emory Atlas...";
      content.innerHTML = buildCourseResultsSkeletonHtml();
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
      content.innerHTML = buildCourseResultsSkeletonHtml(`Loading sections for ${formatTermLabel(state.selectedTerm)}...`);
      return;
    }

    const filtered = getFilteredSections();
    const visible = visibleCourseResults(state, filtered);
    summary.textContent = getPanelSummaryText(filtered.length);
    if (!visible.length) {
      content.innerHTML = buildEmptyStateHtml();
      return;
    }

    const more = visible.length < filtered.length
      ? `<div class="courses-results-more"><span>Showing ${visible.length.toLocaleString()} of ${filtered.length.toLocaleString()} sections</span><button type="button" class="courses-secondary-action" data-show-more-courses>Show more</button></div>`
      : "";
    content.innerHTML = visible.map(buildCourseCardHtml).join("") + more;
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

  function statusFilterAvailabilityState() {
    if (!state.statusFilters.size) return "matched";
    const candidates = getFilteredSections({ ignoreStatus: true });
    if (!candidates.length) return "matched";
    let pending = false;
    let incomplete = false;
    candidates.forEach((section) => {
      const availability = resolveCardAvailability(section);
      const phase = availability && typeof availability === "object"
        ? availability.phase
        : null;
      if (phase === AVAILABILITY_PHASES.PENDING) {
        pending = true;
      } else if (phase !== AVAILABILITY_PHASES.VERIFIED) {
        incomplete = true;
      }
    });
    if (pending) return "pending";
    if (incomplete) return "unavailable";
    return "matched";
  }

  function buildEmptyStateHtml() {
    const availabilityState = statusFilterAvailabilityState();
    if (availabilityState === "pending" || availabilityState === "unavailable") {
      const text = availabilityState === "pending"
        ? "Live availability is still verifying. Status filters will apply once checks finish."
        : "Live availability couldn't be verified, so status filters can't be applied yet.";
      return `<div class="courses-state" role="status" aria-live="polite">${escapeHtml(text)}</div>`;
    }
    return `<div class="courses-state">${escapeHtml(getEmptyStateText())}</div>`;
  }

  function syncFilterControls() {
    const filterButton = document.getElementById("courses-filter-button");
    const filterPopover = document.getElementById("courses-filter-popover");
    const filterCount = document.getElementById("courses-filter-count");
    const timeEnabled = document.getElementById("courses-time-enabled");
    const timeStart = document.getElementById("courses-time-start");
    const timeEnd = document.getElementById("courses-time-end");
    const campusFilter = document.getElementById("courses-campus-filter");
    const requirementFilter = document.getElementById("courses-requirement-filter");
    const availabilityFilter = document.getElementById("courses-availability-filter");
    const activeFilterCount = state.dayFilters.size
      + (state.timeEnabled ? 1 : 0)
      + (state.campusFilter && state.campusFilter !== "all" ? 1 : 0)
      + (state.requirementFilter && state.requirementFilter !== "all" ? 1 : 0)
      + state.statusFilters.size;
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
    if (campusFilter) campusFilter.value = state.campusFilter || "all";
    if (requirementFilter) requirementFilter.value = state.requirementFilter || "all";
    availabilityFilter?.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.checked = state.statusFilters.has(String(input.value || "").toLowerCase());
    });
    document.querySelectorAll("#courses-day-toggle button[data-day]").forEach((button) => {
      button.classList.toggle("is-active", state.dayFilters.has(button.dataset.day));
    });
  }

  function defaultGetEffectiveAvailability(section) {
    const raw = section && typeof section === "object"
      ? String(section.enrollment_status || "").trim().toLowerCase()
      : "";
    return {
      phase: AVAILABILITY_PHASES.UNVERIFIED,
      status: raw === "open" ? "Open" : raw === "closed" ? "Closed" : raw === "waitlist" ? "Waitlist" : null,
      seatsAvailable: null,
      current: false,
    };
  }

  function resolveCardAvailability(section) {
    const resolved = typeof getEffectiveAvailability === "function"
      ? getEffectiveAvailability(section)
      : null;
    return resolved && typeof resolved === "object"
      ? resolved
      : defaultGetEffectiveAvailability(section);
  }

  function statusChipClass(status) {
    const key = String(status || "").trim().toLowerCase();
    return STATUS_CHIP_CLASSES[key] || "";
  }

  function enrollmentCapacity(section) {
    const parsed = Number.parseInt(section?.enrollment_capacity, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatLiveSeats(seats, capacity) {
    if (capacity !== null) return `${seats} of ${capacity} seats`;
    return `${seats} ${seats === 1 ? "seat" : "seats"}`;
  }

  function getCardAvailabilityDisplay(section) {
    const availability = resolveCardAvailability(section);
    const phase = availability.phase;

    if (phase === AVAILABILITY_PHASES.PENDING) {
      return {
        status: "Checking",
        statusClass: "is-loading",
        seats: "Checking live seats",
        seatsClass: "is-loading",
        seatsTitle: "",
      };
    }

    if (phase === AVAILABILITY_PHASES.UNAVAILABLE) {
      return {
        status: "Unavailable",
        statusClass: "",
        seats: "Unavailable",
        seatsClass: "",
        seatsTitle: UNAVAILABLE_SEATS_TITLE,
      };
    }

    const status = availability.status || "Unknown";
    const statusClass = statusChipClass(status);

    if (phase === AVAILABILITY_PHASES.VERIFIED) {
      if (String(status).toLowerCase() === "closed") {
        const capacity = enrollmentCapacity(section);
        return {
          status,
          statusClass,
          seats: capacity !== null ? `0 of ${capacity} seats` : "0 seats available",
          seatsClass: "",
          seatsTitle: "",
        };
      }
      const seats = availability.seatsAvailable;
      if (seats === null || typeof seats === "undefined" || seats === "") {
        if (availability.detailsPending) {
          return {
            status,
            statusClass,
            seats: "Loading seats",
            seatsClass: "is-loading",
            seatsTitle: "",
          };
        }
        const detailError = availability.error;
        return {
          status,
          statusClass,
          seats: "Seats unavailable",
          seatsClass: "",
          seatsTitle: detailError && detailError.message
            ? String(detailError.message)
            : "Live seat details are unavailable for this section.",
        };
      }
      return {
        status,
        statusClass,
        seats: formatLiveSeats(Number(seats), enrollmentCapacity(section)),
        seatsClass: "",
        seatsTitle: "",
      };
    }

    return {
      status,
      statusClass,
      seats: "Not verified",
      seatsClass: "",
      seatsTitle: "",
    };
  }

  function buildCourseCardHtml(section) {
    const id = section.id;
    const addedCourse = state.savedCoursesBySection.get(id);
    const isAdded = Boolean(addedCourse);
    const isTracked = Boolean(state.tracksBySection.get(id)?.enabled);
    const track = state.tracksBySection.get(id);
    const trackingPolicy = describeTrackingPolicy(state.trackingTermPolicies?.[section.term] || track?.term_policy, isTracked);
    const colorClass = isAdded ? getCourseColor(addedCourse).key : "";
    const availability = getCardAvailabilityDisplay(section);
    const seatsTitle = availability.seatsTitle
      ? ` title="${escapeHtml(availability.seatsTitle)}"`
      : "";
    const saving = state.savingIds.has(id);
    const sectionLabel = section.section_number ? ` <span class="course-section-inline">&middot; Sec ${escapeHtml(section.section_number)}</span>` : "";
    return `
      <article class="course-card ${isAdded ? `is-added ${escapeHtml(colorClass)}` : ""}" data-section-id="${escapeHtml(id)}" tabindex="0">
        <div class="course-card-top">
          <div class="course-card-title">
            <strong>${escapeHtml(section.course_code || "Course")}${sectionLabel}</strong>
            <span>${escapeHtml(section.course_title || "Untitled course")}</span>
          </div>
          <button type="button" class="course-card-action ${isAdded ? "is-added" : ""}" data-add-section-id="${escapeHtml(id)}" ${saving ? "disabled" : ""}>${isAdded ? "Added" : "Add"}</button>
        </div>
        <div class="course-card-schedule">${renderCourseCardSchedule(section)}</div>
        <div class="course-card-meta-row">
          <div class="course-card-meta">
            <span class="course-chip ${availability.statusClass}">${escapeHtml(availability.status)}</span>
            <span class="course-chip ${availability.seatsClass}"${seatsTitle}>${escapeHtml(availability.seats)}</span>
            <span class="course-chip">${escapeHtml(section.schedule_type || "Type")}</span>
            <span class="course-chip">${escapeHtml(formatCampus(section))}</span>
          </div>
          ${track ? `<span class="course-card-tracked ${trackingPolicy?.active ? "" : "is-paused"} material-symbols-outlined" aria-label="Tracking ${trackingPolicy?.status || "paused"}" title="Tracking ${trackingPolicy?.status || "paused"}">${trackingPolicy?.active ? "notifications_active" : "notifications_paused"}</span>` : ""}
        </div>
      </article>
    `;
  }

  function getCourseColor(course) {
    return COURSE_COLOR_PALETTE.find((color) => color.key === course?.color_key) || COURSE_COLOR_PALETTE[0];
  }

  function formatRequirement(section) {
    const value = section?.requirements || section?.requirement_designation || section?.requirement || section?.ger;
    if (Array.isArray(value)) return value.filter(Boolean).join(", ") || "N/A";
    return value || "N/A";
  }

  function formatCampus(section) {
    return section?.campus || section?.campus_description || "Atlanta";
  }

  return {
    cssEscape,
    getCourseColor,
    buildMeetingRowHtml,
    renderPanel,
    renderTermSelect,
    syncFilterControls,
    timeInputToAtlasToken,
  };
}

export { createCoursePanel };
