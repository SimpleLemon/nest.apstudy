import { describe as describeTrackingPolicy } from './tracking-policy.js';
import { renderCourseInstructors } from './instructors.js';

function createCourseDetailView({ state, getSection, formatCampus, formatRequirement, utils }) {
  const { escapeHtml, formatDateRange, formatDateTime, formatSeats, formatTermLabel, normalizeScheduleDisplay } = utils;

  function buildDetailHtml(sectionId) {
    const section = getSection(sectionId);
    if (!section) return `<div class="courses-state">Course section not found.</div>`;
    const addedCourse = state.savedCoursesBySection.get(sectionId);
    const track = state.tracksBySection.get(sectionId);
    const trackEnabled = Boolean(track?.enabled);
    const trackingPolicy = describeTrackingPolicy(state.trackingTermPolicies?.[section.term] || track?.term_policy, trackEnabled);
    const saving = state.savingIds.has(sectionId);
    const tracking = state.trackingIds.has(sectionId);
    const status = section.enrollment_status || "Unknown";
    const statusClass = status.toLowerCase() === "open" ? "is-open" : status.toLowerCase() === "closed" ? "is-closed" : "";
    const liveText = state.detailLoading
      ? "Refreshing seats from Atlas..."
      : state.detailLiveError
        ? `Atlas live refresh unavailable. Showing saved catalog data.`
        : section.live_updated_at
          ? `Updated ${formatDateTime(section.live_updated_at)}`
          : "Showing local catalog data.";
    const description = section.course_description || section.description || "Description unavailable.";
    const selectedInterval = Number(track?.interval_minutes || state.allowedTrackIntervals[0] || 30);
    const trackLabel = section.is_cancelled ? "This section is cancelled."
      : trackingPolicy.state === "upcoming" ? "Track seats once term opens."
      : trackingPolicy.state === "open" ? "Track when seats open."
      : trackingPolicy.state === "closed" ? "Tracking has closed."
      : "Tracking unavailable.";
    const trackStatus = tracking ? "Updating…" : trackEnabled ? trackingPolicy.status : "";
    const waitlistTotal = section.waitlist_total !== null && section.waitlist_total !== undefined && Number.isFinite(Number(section.waitlist_total)) ? Number(section.waitlist_total) : null;
    const waitlistCapacity = section.waitlist_capacity !== null && section.waitlist_capacity !== undefined && Number.isFinite(Number(section.waitlist_capacity)) ? Number(section.waitlist_capacity) : null;
    const waitlistText = waitlistTotal === null || waitlistCapacity === null ? "Unavailable" : `${waitlistTotal} of ${waitlistCapacity} filled`;

    return `
      <article class="courses-detail">
        <div class="courses-detail-header">
          <div>
            <h2>${escapeHtml(section.course_code || "Course")}</h2>
            <p>${escapeHtml(section.course_title || "Untitled course")}</p>
            ${section.section_number ? `<span class="courses-section-kicker">Section ${escapeHtml(section.section_number)}</span>` : ""}
          </div>
          <button class="courses-detail-close" type="button" data-close-detail aria-label="Close course details">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        <div class="courses-detail-meta">
          <span class="course-chip">${escapeHtml(formatTermLabel(section.term))}</span>
          <span class="course-chip ${statusClass}">${escapeHtml(status)}</span>
        </div>
        <section class="track-control">
          <div class="track-control-main">
            <svg class="track-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4M12 2V1M3 4l-1-1M21 4l1-1"/></svg>
            <div class="track-control-text">
              <strong>${escapeHtml(trackLabel)}</strong>
              ${trackStatus ? `<span role="status">Status: ${escapeHtml(trackStatus)}</span>` : ""}
            </div>
            <button type="button" class="track-toggle" data-track-section-id="${escapeHtml(sectionId)}" aria-label="${trackEnabled ? "Turn off" : "Turn on"} availability tracking" aria-pressed="${trackEnabled ? "true" : "false"}" ${tracking || (!trackEnabled && (section.is_cancelled || !trackingPolicy?.canEnable)) ? "disabled" : ""}></button>
          </div>
          ${trackEnabled ? `
            <div class="track-settings">
              <label class="track-interval">
                <span>Every</span>
                <select data-track-interval-section-id="${escapeHtml(sectionId)}" aria-label="Check interval" ${tracking || !trackEnabled || !trackingPolicy?.canEnable ? "disabled" : ""}>
                  ${[5, 15, 30].map((minutes) => {
                    const allowed = state.allowedTrackIntervals.includes(minutes);
                    return `<option value="${minutes}" ${minutes === selectedInterval ? "selected" : ""} ${allowed ? "" : "disabled"}>${minutes} min${allowed ? "" : " · higher tier"}</option>`;
                  }).join("")}
                </select>
              </label>
              <span class="track-tier-note">${escapeHtml(state.trackingTier.label)} · ${state.trackingUsage}${state.trackingLimit === null ? "" : ` of ${state.trackingLimit}`} subscriptions</span>
              ${trackingPolicy?.active && track.cooldown_until_closed ? `<span class="track-cooldown"><span class="material-symbols-outlined" aria-hidden="true">schedule</span>Availability found; checking every 3 hours until it closes.</span>` : ""}
              <dl class="track-timing">
                <div><dt>Last checked</dt><dd>${escapeHtml(track.last_checked_at ? formatDateTime(track.last_checked_at) : "Pending")}</dd></div>
                <div><dt>Next check</dt><dd>${escapeHtml(trackingPolicy?.next || (track.next_check_at ? formatDateTime(track.next_check_at) : "Soon"))}</dd></div>
              </dl>
            </div>
          ` : ""}
        </section>
        <div class="courses-detail-actions">
          <button type="button" class="courses-secondary-action" data-refresh-section-id="${escapeHtml(sectionId)}" ${state.detailLoading ? "disabled" : ""}>
            <span class="material-symbols-outlined" aria-hidden="true">sync</span>
            <span>${state.detailLoading ? "Refreshing" : "Refresh"}</span>
          </button>
          ${addedCourse
            ? `
              <button type="button" class="courses-secondary-action" data-open-edit-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>
                <span class="material-symbols-outlined" aria-hidden="true">edit</span>
                <span>Edit</span>
              </button>
              <button type="button" class="courses-danger-action" data-remove-course-id="${escapeHtml(addedCourse.id)}" data-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>Remove Class</button>
            `
            : `<button type="button" class="courses-primary-action" data-add-section-id="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>Add Class</button>`
          }
        </div>
        <section class="courses-detail-card">
          <div class="courses-detail-row courses-instructor-row"><span>Instructor</span>${renderCourseInstructors(section)}</div>
          ${detailRow("Schedule", normalizeScheduleDisplay(section.schedule_display || "TBA"))}
          ${detailRow("CRN", section.crn || "N/A")}
          ${detailRow("Type", section.schedule_type || "N/A")}
          ${detailRow("Location", section.location || "TBA")}
          ${detailRow("Campus", formatCampus(section))}
          ${detailRow("Seats", formatSeats(section))}
          ${detailRow("Waitlist", waitlistText)}
          ${detailRow("Credits", section.credit_hours || "N/A")}
          ${detailRow("Grading Mode", section.grading_mode || "N/A")}
          ${detailRow("Instruction Method", section.instruction_method || "N/A")}
          ${detailRow("Requirement", formatRequirement(section))}
          ${detailRow("Dates", formatDateRange(section.date_range))}
          ${detailRow("Live Status", liveText)}
        </section>
        <section class="courses-description-card">
          <span class="material-symbols-outlined" aria-hidden="true">notes</span>
          <div>
            <h3>Description</h3>
            <p>${escapeHtml(description)}</p>
          </div>
        </section>
      </article>
    `;
  }

  function detailRow(label, value) {
    return `<div class="courses-detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "N/A")}</strong></div>`;
  }

  return { buildDetailHtml };
}

export { createCourseDetailView };
