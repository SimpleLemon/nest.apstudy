const interfaceThemes = [
  'obsidian-dark',
  'parchment-light',
  'system-match',
  'nest-light',
  'nest-dark',
];
const themeToInterfaceTheme = {
  dark: 'obsidian-dark',
  light: 'parchment-light',
  system: 'system-match',
};
export function setToggleState(button, active) {
  if (!button) {
    return;
  }
  button.classList.toggle('is-active', Boolean(active));
  button.setAttribute('aria-pressed', active ? 'true' : 'false');
}

export function getToggleState(fieldName) {
  const button = document.querySelector(`[data-toggle-field="${fieldName}"]`);
  return Boolean(button && button.classList.contains('is-active'));
}

export function normalizeThemeValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (interfaceThemes.includes(normalized)) {
    return normalized;
  }
  if (themeToInterfaceTheme[normalized]) {
    return themeToInterfaceTheme[normalized];
  }
  return 'obsidian-dark';
}

export function applyThemePreference(theme) {
  const interfaceTheme = normalizeThemeValue(theme);
  window.APSTUDY_SET_THEME_PREFERENCE(interfaceTheme);
}

export function normalizeSidebarDefault(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'collapsed') {
    return 'collapsed';
  }
  return 'expanded';
}

export function applySidebarDefault(value) {
  const shouldCollapse = normalizeSidebarDefault(value) === 'collapsed';
  localStorage.setItem('sidebar-collapsed', String(shouldCollapse));
  if (typeof window.APSTUDY_SET_SIDEBAR_COLLAPSED === 'function') {
    window.APSTUDY_SET_SIDEBAR_COLLAPSED(shouldCollapse);
    return;
  }
  document.dispatchEvent(new CustomEvent('apstudy-sidebar-default-change', {
    detail: { collapsed: shouldCollapse },
  }));
}
