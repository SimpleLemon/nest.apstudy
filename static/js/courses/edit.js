function collectMeetingOverrides(rows, { COURSE_DAYS, parseAtlasTimeToken, timeInputToAtlasToken }) {
  const validDays = new Set(COURSE_DAYS.map((day) => day.key));
  return (rows || []).flatMap((row) => {
    const day = String(row?.day || "");
    const start = timeInputToAtlasToken(row?.start);
    const end = timeInputToAtlasToken(row?.end);
    if (!validDays.has(day) || !start || !end || parseAtlasTimeToken(end) <= parseAtlasTimeToken(start)) {
      return [];
    }
    return [{ day, start, end }];
  });
}

function meetingRemovalFocusPlan(rowIndex, rowCount) {
  if (rowIndex >= 0 && rowIndex < rowCount - 1) return { rowIndex: rowIndex + 1 };
  if (rowIndex > 0) return { rowIndex: rowIndex - 1 };
  return { focusAddButton: true };
}

function createCourseEditor({ state, COURSE_COLOR_PALETTE, COURSE_DAYS, getSection, getCourseColor, formatCampus, formatRequirement, utils }) {
  const { escapeHtml, parseAtlasTimeToken, parseTimeInput } = utils;

  function buildEditHtml(sectionId) {
    const section = getSection(sectionId);
    const savedCourse = state.savedCoursesBySection.get(String(sectionId));
    if (!section || !savedCourse) return `<div class="courses-state">Saved course not found.</div>`;
    const selectedColorKey = getCourseColor(savedCourse).key;
    const meetings = normalizeMeetingsForEdit(section.meetings);
    const saving = state.editingSaving || state.savingIds.has(sectionId);

    return `
      <article class="courses-edit" data-editing-section-id="${escapeHtml(sectionId)}">
        <div class="courses-detail-header">
          <div>
            <h2>Edit Class</h2>
            <p>${escapeHtml(section.course_code || "Course")} ${section.section_number ? `Section ${escapeHtml(section.section_number)}` : ""}</p>
          </div>
          <button class="courses-detail-close" type="button" data-edit-cancel aria-label="Close edit class">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>

        <section class="courses-edit-card courses-edit-color-card">
          <div class="courses-edit-section-heading">
            <h3>Color</h3>
            <span>Choose how this class appears on your week.</span>
          </div>
          <div class="courses-color-grid" role="group" aria-label="Course color">
            ${COURSE_COLOR_PALETTE.map((color) => {
              const isSelected = selectedColorKey === color.key;
              return `
                <button
                  type="button"
                  class="courses-color-swatch ${escapeHtml(color.key)} ${isSelected ? "is-selected" : ""}"
                  data-course-color-key="${escapeHtml(color.key)}"
                  aria-label="${escapeHtml(color.key.replace("course-color-", "Color "))}"
                  aria-pressed="${isSelected ? "true" : "false"}"
                >
                  <span class="material-symbols-outlined" aria-hidden="true">check</span>
                </button>
              `;
            }).join("")}
          </div>
        </section>

        <section class="courses-edit-card">
          <div class="courses-edit-grid">
            ${editField("course_code", "Course Code", section.course_code || "")}
            ${editField("section_number", "Section", section.section_number || "")}
            ${editField("course_title", "Title", section.course_title || "", "wide")}
            ${editField("instructor", "Instructor", section.instructor || section.instructor_name || "", "wide")}
            ${editField("schedule_type", "Type", section.schedule_type || "")}
            ${editField("credit_hours", "Credits", section.credit_hours || "")}
            ${editField("location", "Location", section.location || "")}
            ${editField("campus", "Campus", formatCampus(section))}
            ${editField("requirement_designation", "Requirement", formatRequirement(section) === "N/A" ? "" : formatRequirement(section))}
            ${editField("schedule_display", "Schedule Text", section.schedule_display || "", "wide")}
          </div>
        </section>

        <section class="courses-edit-card">
          <div class="courses-edit-section-heading">
            <h3>Meeting Times</h3>
            <span>Each row appears on your weekly view. Add a row for another meeting on the same day.</span>
          </div>
          <div class="courses-meeting-editor" data-meeting-editor>
            ${meetings.length ? meetings.map(buildMeetingRowHtml).join("") : buildMeetingRowHtml()}
          </div>
          <button type="button" class="courses-secondary-action courses-add-meeting" data-add-meeting>
            <span class="material-symbols-outlined" aria-hidden="true">add</span>
            <span>Add meeting</span>
          </button>
        </section>

        <section class="courses-edit-card">
          ${editTextarea("course_description", "Description", section.course_description || section.description || "")}
          ${editTextarea("course_notes", "Notes", section.course_notes || "")}
        </section>

        <div class="courses-detail-actions courses-edit-actions">
          <button type="button" class="courses-primary-action" data-edit-save="${escapeHtml(sectionId)}" ${saving ? "disabled" : ""}>${saving ? "Saving..." : "Save"}</button>
          <button type="button" class="courses-secondary-action" data-edit-cancel ${saving ? "disabled" : ""}>Cancel</button>
        </div>
      </article>
    `;
  }

  function editField(name, label, value, className = "") {
    return `
      <label class="courses-edit-field ${className}">
        <span>${escapeHtml(label)}</span>
        <input type="text" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />
      </label>
    `;
  }

  function editTextarea(name, label, value) {
    return `
      <label class="courses-edit-field wide">
        <span>${escapeHtml(label)}</span>
        <textarea name="${escapeHtml(name)}" rows="5">${escapeHtml(value)}</textarea>
      </label>
    `;
  }

  function normalizeMeetingsForEdit(meetings) {
    return (meetings || [])
      .map((meeting) => ({
        day: meeting.day,
        start: meeting.start,
        end: meeting.end,
        startInput: atlasTokenToTimeInput(meeting.start),
        endInput: atlasTokenToTimeInput(meeting.end),
      }))
      .filter((meeting) => COURSE_DAYS.some((day) => day.key === meeting.day));
  }

  function buildMeetingRowHtml(meeting = {}) {
    const day = COURSE_DAYS.some((option) => option.key === meeting.day) ? meeting.day : COURSE_DAYS[0].key;
    return `
      <div class="courses-meeting-row">
        <select data-meeting-day aria-label="Meeting day">
          ${COURSE_DAYS.map((option) => `<option value="${escapeHtml(option.key)}" ${option.key === day ? "selected" : ""}>${escapeHtml(option.key)}</option>`).join("")}
        </select>
        <input type="time" data-meeting-start aria-label="Meeting start time" value="${escapeHtml(meeting.startInput || "09:00")}" min="06:00" max="23:59" />
        <input type="time" data-meeting-end aria-label="Meeting end time" value="${escapeHtml(meeting.endInput || "09:50")}" min="06:00" max="23:59" />
        <button type="button" class="courses-meeting-remove" data-remove-meeting aria-label="Remove meeting">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
    `;
  }

  function atlasTokenToTimeInput(token) {
    const minutes = parseAtlasTimeToken(token);
    if (minutes === null) return "";
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function timeInputToAtlasToken(value) {
    const minutes = parseTimeInput(value);
    if (minutes === null) return "";
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    return `${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`;
  }

  return { buildEditHtml, buildMeetingRowHtml, timeInputToAtlasToken };
}

export { collectMeetingOverrides, meetingRemovalFocusPlan, createCourseEditor };
