import { validateCalendarFeedLinks } from '../calendar/feed-links.js';
import { fetchJson, showToast } from './utils.js';
const SETTINGS_MAX_OTHER_CALENDARS = 10;
const maxOtherCalendars = SETTINGS_MAX_OTHER_CALENDARS;
const endpoints = { feedUrl: '/settings/api/feed-url' };
export function createSettingsCalendar(state, preferences) {
  const elements = {
    addOtherCalendar: document.getElementById('settings-add-other-calendar'),
    canvasFeedUrl: document.getElementById('settings-canvas-feed-url'),
    otherCalendarCount: document.getElementById('settings-other-calendar-count'),
    otherCalendarLinks: document.getElementById('settings-other-calendar-links'),
    saveCalendarLinks: document.getElementById('settings-save-calendar-links'),
  };
  let canvasRevision = 0;
  let otherCalendarsRevision = 0;

  function bindCalendarControls() {
    elements.saveCalendarLinks?.addEventListener('click', () => void saveCalendarLinks());
    window.APStudyFormField?.bindAutoClear?.(elements.canvasFeedUrl);
    elements.canvasFeedUrl?.addEventListener('input', () => { canvasRevision += 1; });
    elements.canvasFeedUrl?.addEventListener('change', () => { canvasRevision += 1; });
    elements.addOtherCalendar?.addEventListener('click', () => {
      const currentRows = getOtherCalendarInputValues({ includeBlank: true });
      if (currentRows.length >= maxOtherCalendars) {
        showToast(`You can add up to ${maxOtherCalendars} calendar links.`, 'error');
        return;
      }
      addOtherCalendarRow('');
      otherCalendarsRevision += 1;
      updateOtherCalendarCount();
    });
  }

  function renderOtherCalendarRows(urls) {
    if (!elements.otherCalendarLinks) {
      return;
    }
    elements.otherCalendarLinks.innerHTML = '';
    const safeUrls = Array.isArray(urls) ? urls.slice(0, maxOtherCalendars) : [];
    safeUrls.forEach((url) => addOtherCalendarRow(url));
    updateOtherCalendarCount();
  }

  function addOtherCalendarRow(value, options = {}) {
    if (!elements.otherCalendarLinks) {
      return null;
    }

    const row = document.createElement('div');
    row.className = 'settings-calendar-row';
    row.innerHTML = `
      <label class="settings-field settings-calendar-row-field">
        <span class="sr-only">Other calendar link</span>
        <span class="settings-icon-input">
          <span class="material-symbols-outlined" aria-hidden="true">event</span>
          <input data-other-calendar-url name="other_calendar_url" type="url" inputmode="url" autocomplete="off" placeholder="https://calendar.google.com/..." />
        </span>
      </label>
      <button type="button" class="settings-calendar-remove" aria-label="Remove calendar link">
        <span class="material-symbols-outlined" aria-hidden="true">close</span>
      </button>
    `;

    const input = row.querySelector('[data-other-calendar-url]');
    if (input) {
      input.value = value || '';
      input.addEventListener('input', () => {
        otherCalendarsRevision += 1;
        updateOtherCalendarCount();
      });
      input.addEventListener('change', () => { otherCalendarsRevision += 1; });
      window.APStudyFormField?.bindAutoClear?.(input);
    }
    row.querySelector('.settings-calendar-remove')?.addEventListener('click', () => {
      const rowIndex = Array.from(elements.otherCalendarLinks.children).indexOf(row);
      const removedUrl = input?.value.trim() || '';
      row.remove();
      otherCalendarsRevision += 1;
      updateOtherCalendarCount();
      showToast('Save to apply this change.', 'success', {
        title: 'Calendar link removed',
        duration: 10000,
        action: {
          label: 'Undo',
          onClick: () => {
            const currentRows = getOtherCalendarInputValues({ includeBlank: true });
            if (currentRows.length >= maxOtherCalendars) {
              showToast('Remove another row before restoring this link.', 'error');
              return false;
            }
            const referenceRow = elements.otherCalendarLinks.children[rowIndex] || null;
            addOtherCalendarRow(removedUrl, { before: referenceRow });
            otherCalendarsRevision += 1;
            updateOtherCalendarCount();
            showToast('Calendar link restored.', 'success');
            return false;
          },
        },
      });
    });
    if (options.before) {
      elements.otherCalendarLinks.insertBefore(row, options.before);
    } else {
      elements.otherCalendarLinks.appendChild(row);
    }
    return row;
  }

  function updateOtherCalendarCount() {
    if (!elements.otherCalendarCount) {
      return;
    }
    const rowCount = getOtherCalendarInputValues({ includeBlank: true }).length;
    elements.otherCalendarCount.textContent = `${rowCount} / ${maxOtherCalendars} added`;
  }

  function getOtherCalendarInputValues(options = {}) {
    const includeBlank = Boolean(options.includeBlank);
    if (!elements.otherCalendarLinks) {
      return [];
    }
    return Array.from(elements.otherCalendarLinks.querySelectorAll('[data-other-calendar-url]'))
      .map((input) => input.value.trim())
      .filter((value) => includeBlank || value);
  }

  function collectCalendarPayload() {
    return validateCalendarFeedLinks(
      elements.canvasFeedUrl?.value || '',
      getOtherCalendarInputValues({ includeBlank: true }),
      { maxOtherCalendars },
    );
  }

  async function saveCalendarLinks() {
    let payload;
    try {
      payload = collectCalendarPayload();
    } catch (error) {
      const formField = window.APStudyFormField;
      formField?.clearAll(elements.otherCalendarLinks || document);
      formField?.clearInvalid(elements.canvasFeedUrl);
      const inputs = elements.otherCalendarLinks?.querySelectorAll('[data-other-calendar-url]') || [];
      if (Number.isInteger(error.inputIndex)) formField?.markInvalid(inputs[error.inputIndex]);
      showToast(error.message || 'Check your calendar links.', 'error');
      return;
    }

    window.APStudyFormField?.clearAll(elements.otherCalendarLinks || document);
    window.APStudyFormField?.clearInvalid(elements.canvasFeedUrl);

    const submittedCanvasRevision = canvasRevision;
    const submittedOtherRevision = otherCalendarsRevision;
    const submittedCanvasValue = elements.canvasFeedUrl?.value || '';
    const submittedOtherValues = JSON.stringify(getOtherCalendarInputValues({ includeBlank: true }));
    const previousLabel = elements.saveCalendarLinks?.textContent || 'Save';
    if (elements.saveCalendarLinks) {
      elements.saveCalendarLinks.disabled = true;
      elements.saveCalendarLinks.textContent = 'Saving...';
    }

    try {
      const response = await fetchJson(endpoints.feedUrl, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const savedCanvasUrl = response.canvas_ical_url ?? payload.canvas_ical_url;
      const savedOtherUrls = Array.isArray(response.other_ical_urls)
        ? response.other_ical_urls
        : payload.other_ical_urls;
      preferences.settings = {
        ...(preferences.settings || {}),
        canvas_ical_url: savedCanvasUrl,
        other_calendar_urls: savedOtherUrls,
      };
      state.otherCalendarUrls = savedOtherUrls;
      const canvasUnchanged = canvasRevision === submittedCanvasRevision
        && (elements.canvasFeedUrl?.value || '') === submittedCanvasValue;
      const otherCalendarsUnchanged = otherCalendarsRevision === submittedOtherRevision
        && JSON.stringify(getOtherCalendarInputValues({ includeBlank: true })) === submittedOtherValues;
      if (elements.canvasFeedUrl && canvasUnchanged) {
        elements.canvasFeedUrl.value = savedCanvasUrl || '';
      }
      if (otherCalendarsUnchanged) renderOtherCalendarRows(savedOtherUrls);
      showToast('Calendar links saved.', 'success');
    } catch (error) {
      showToast(error.message || 'Check the links and try again.', 'error', { title: 'Couldn’t save calendar links' });
    } finally {
      if (elements.saveCalendarLinks) {
        elements.saveCalendarLinks.disabled = false;
        elements.saveCalendarLinks.textContent = previousLabel;
      }
    }
  }

  function hydrate() {
    if (elements.canvasFeedUrl) elements.canvasFeedUrl.value = preferences.settings?.canvas_ical_url || '';
    renderOtherCalendarRows(state.otherCalendarUrls);
  }
  return {
    hydrate,
    mount: bindCalendarControls,
  };
}
