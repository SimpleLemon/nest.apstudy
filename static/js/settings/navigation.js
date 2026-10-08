const SETTINGS_SECTION_IDS = ['account', 'tier', 'data', 'preferences', 'notifications'];
export function normalizeSectionId(hashValue) {
  if (!hashValue) {
    return '';
  }
  const normalized = String(hashValue).replace(/^#/, '').trim().toLowerCase();
  return SETTINGS_SECTION_IDS.includes(normalized) ? normalized : '';
}
export function createSettingsNavigation(onTierActivated) {
  const elements = {
    tabs: Array.from(document.querySelectorAll('.settings-tab')),
    sections: Array.from(document.querySelectorAll('.settings-section')),
  };
  function bindNavigation() {
    elements.tabs.forEach((tab) => {
      tab.addEventListener('click', (event) => {
        event.preventDefault();
        const targetId = normalizeSectionId(tab.getAttribute('href'));
        if (!targetId) {
          return;
        }
        activateSection(targetId, { pushState: true });
      });
    });

    window.addEventListener('hashchange', () => {
      const targetId = normalizeSectionId(window.location.hash) || 'account';
      activateSection(targetId);
    });
  }

  function syncHashOnLoad() {
    const targetId = normalizeSectionId(window.location.hash) || 'account';
    activateSection(targetId);
  }

  function activateSection(sectionId, options = {}) {
    const normalized = SETTINGS_SECTION_IDS.includes(sectionId) ? sectionId : 'account';
    elements.tabs.forEach((tab) => {
      const isActive = tab.getAttribute('data-tab') === normalized;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-current', isActive ? 'page' : 'false');
    });

    if (options.pushState) {
      history.pushState(null, '', `#${normalized}`);
    }

    // Show/hide sections like tab panels instead of scrolling.
    elements.sections.forEach((section) => {
      const isActive = section.id === normalized;
      section.hidden = !isActive;
      section.setAttribute('aria-hidden', isActive ? 'false' : 'true');
    });

    if (normalized === 'tier') {
      void onTierActivated();
    }
  }
  return { bindNavigation, syncHashOnLoad };
}
