import { mountSettingsCombobox } from './combobox.js';
import { showToast } from './utils.js';

const FALLBACK_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Australia/Sydney',
];
export function resolveLocalTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

export function formatTimezoneLabel(timezone) {
  const value = String(timezone || '').trim();
  if (!value) {
    return '';
  }
  try {
    const formatter = new Intl.DateTimeFormat(undefined, {
      timeZone: value,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(new Date());
    const offset = parts.find((part) => part.type === 'timeZoneName')?.value || '';
    const readable = value.replace(/_/g, ' ');
    return offset ? `${readable} (${offset})` : readable;
  } catch {
    return value.replace(/_/g, ' ');
  }
}

export function listSupportedTimezones() {
  try {
    if (typeof Intl.supportedValuesOf === 'function') {
      return Intl.supportedValuesOf('timeZone').slice().sort((left, right) => left.localeCompare(right));
    }
  } catch {
    // Fall through to the static list.
  }
  return FALLBACK_TIMEZONES.slice();
}

export function mountRegionComboboxes(elements) {

  if (elements.languageComboboxRoot && elements.language) {
    elements.languageCombobox = mountSettingsCombobox({
      root: elements.languageComboboxRoot,
      input: elements.language,
      placeholder: 'Select language',
      searchable: false,
    });
  }

  if (elements.timezoneComboboxRoot && elements.timezone) {
    const timezoneOptions = listSupportedTimezones().map((timezone) => ({
      value: timezone,
      label: formatTimezoneLabel(timezone),
    }));

    elements.timezoneCombobox = mountSettingsCombobox({
      root: elements.timezoneComboboxRoot,
      input: elements.timezone,
      placeholder: 'Select timezone',
      searchable: true,
      options: timezoneOptions,
      quickActions: [{ id: 'device-timezone', label: 'Use device timezone' }],
      resolveQuickActionValue(action) {
        if (action.id === 'device-timezone') {
          const deviceTimezone = resolveLocalTimezone();
          if (deviceTimezone) {
            showToast('Timezone updated from your device.', 'success');
          }
          return deviceTimezone;
        }
        return '';
      },
    });
  }
}
