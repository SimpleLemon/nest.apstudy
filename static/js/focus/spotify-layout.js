const LAYOUT_KEY = 'apstudy.focus.spotify.layout.v1';
const PLAYER_PREFERENCES_KEY = 'apstudy.focus.spotify.preferences.v2';
const LAYOUT_MAP = new Map([
  ['below', 'below'], ['bottom-compact', 'below'], ['bottom-large', 'below'],
  ['beside', 'beside'], ['right-compact', 'beside'], ['right-large', 'beside'],
  ['floating', 'floating'],
]);

function readPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch (_error) {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (_error) {
    // Browser preferences are optional; storage restrictions must not block the timer.
  }
}

export function createSpotifyLayout({ elements, savePreferences } = {}) {
  let preferences = {
    layout: 'beside', floating_size: 'compact', floating_x: 1, floating_y: 1, panel_width: 0, panel_height: 0,
  };
  let dragState = null;
  let resizeState = null;

  function normalized(value = {}) {
    const coordinate = (next, fallback) => {
      const number = Number(next);
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
    };
    const dimension = (next, fallback) => {
      const number = Number(next);
      return Number.isFinite(number) && number > 0 ? number : fallback;
    };
    return {
      layout: LAYOUT_MAP.get(value.layout) || preferences.layout || 'beside',
      floating_size: value.floating_size === 'expanded' ? 'expanded' : 'compact',
      floating_x: coordinate(value.floating_x, preferences.floating_x),
      floating_y: coordinate(value.floating_y, preferences.floating_y),
      panel_width: dimension(value.panel_width, preferences.panel_width),
      panel_height: dimension(value.panel_height, preferences.panel_height),
    };
  }

  function dimensionBounds() {
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const floating = preferences.layout === 'floating' && viewportWidth > 900;
    const beside = preferences.layout === 'beside' && viewportWidth > 900;
    if (floating) {
      return {
        minWidth: Math.min(280, viewportWidth - 40),
        maxWidth: Math.max(280, viewportWidth - 40),
        minHeight: Math.min(260, viewportHeight - 40),
        maxHeight: Math.max(260, viewportHeight - 40),
      };
    }
    if (beside) {
      return {
        minWidth: 340,
        maxWidth: Math.max(340, Math.min(620, viewportWidth * 0.46)),
        minHeight: 360,
        maxHeight: Math.max(360, Math.min(900, viewportHeight - 40)),
      };
    }
    return {
      minWidth: Math.min(280, viewportWidth - 28),
      maxWidth: Math.max(280, Math.min(960, viewportWidth - (viewportWidth <= 520 ? 28 : 40))),
      minHeight: 320,
      maxHeight: Math.max(320, Math.min(760, viewportHeight * 0.78)),
    };
  }

  function applyDimensions(width = preferences.panel_width, height = preferences.panel_height) {
    if (!elements.utilities) return;
    const bounds = dimensionBounds();
    const visibleWidth = width > 0 ? Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width)) : 0;
    const visibleHeight = height > 0 ? Math.min(bounds.maxHeight, Math.max(bounds.minHeight, height)) : 0;
    const rootStyle = document.body.style;
    document.body.dataset.spotifyCustomSize = String(Boolean(visibleWidth && visibleHeight));
    if (visibleWidth) rootStyle.setProperty('--focus-player-width', `${Math.round(visibleWidth)}px`);
    else rootStyle.removeProperty('--focus-player-width');
    if (visibleHeight) rootStyle.setProperty('--focus-player-height', `${Math.round(visibleHeight)}px`);
    else rootStyle.removeProperty('--focus-player-height');
    elements.panelResize?.setAttribute(
      'aria-label',
      visibleWidth && visibleHeight
        ? `Resize music panel. Current size ${Math.round(visibleWidth)} by ${Math.round(visibleHeight)} pixels`
        : 'Resize music panel',
    );
  }

  function persist() {
    writePreference(LAYOUT_KEY, preferences.layout);
    writePreference(PLAYER_PREFERENCES_KEY, JSON.stringify(preferences));
    Promise.resolve(savePreferences?.(preferences)).catch(() => {
      // The local copy remains usable while account sync retries on the next change.
    });
  }

  function position() {
    if (!elements.utilities || preferences.layout !== 'floating' || window.innerWidth <= 900) return;
    const margin = 20;
    const rect = elements.utilities.getBoundingClientRect();
    const availableX = Math.max(0, window.innerWidth - rect.width - (margin * 2));
    const availableY = Math.max(0, window.innerHeight - rect.height - (margin * 2));
    elements.utilities.style.setProperty('--focus-floating-left', `${Math.round(margin + (availableX * preferences.floating_x))}px`);
    elements.utilities.style.setProperty('--focus-floating-top', `${Math.round(margin + (availableY * preferences.floating_y))}px`);
  }

  function setSize(value, shouldPersist = true) {
    preferences.floating_size = value === 'expanded' ? 'expanded' : 'compact';
    document.body.dataset.spotifyFloatingSize = preferences.floating_size;
    const expanded = preferences.floating_size === 'expanded';
    elements.floatingSize?.setAttribute('aria-pressed', String(expanded));
    elements.floatingSize?.setAttribute('aria-label', expanded ? 'Make playlist player compact' : 'Expand playlist player');
    if (elements.floatingSize) elements.floatingSize.dataset.expanded = String(expanded);
    if (shouldPersist) {
      preferences.panel_width = 0;
      preferences.panel_height = 0;
      applyDimensions();
    }
    requestAnimationFrame(position);
    if (shouldPersist) persist();
  }

  function setLayout(value, shouldPersist = true) {
    preferences.layout = LAYOUT_MAP.get(value) || 'below';
    document.body.dataset.spotifyLayout = preferences.layout;
    elements.layoutInputs.forEach((input) => { input.checked = input.value === preferences.layout; });
    applyDimensions();
    requestAnimationFrame(position);
    if (shouldPersist) persist();
    return preferences.layout;
  }

  function applyPreferences(value) {
    preferences = normalized(value);
    setLayout(preferences.layout, false);
    setSize(preferences.floating_size, false);
    applyDimensions();
  }

  function move(left, top) {
    if (!elements.utilities) return;
    const margin = 20;
    const rect = elements.utilities.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    elements.utilities.style.setProperty('--focus-floating-left', `${Math.min(maxLeft, Math.max(margin, left))}px`);
    elements.utilities.style.setProperty('--focus-floating-top', `${Math.min(maxTop, Math.max(margin, top))}px`);
  }

  function finishDrag() {
    if (!dragState || !elements.utilities) return;
    const margin = 20;
    const rect = elements.utilities.getBoundingClientRect();
    const availableX = Math.max(1, window.innerWidth - rect.width - (margin * 2));
    const availableY = Math.max(1, window.innerHeight - rect.height - (margin * 2));
    preferences.floating_x = Math.min(1, Math.max(0, (rect.left - margin) / availableX));
    preferences.floating_y = Math.min(1, Math.max(0, (rect.top - margin) / availableY));
    elements.utilities.classList.remove('is-dragging');
    dragState = null;
    persist();
  }

  function resize(width, height) {
    const bounds = dimensionBounds();
    preferences.panel_width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width));
    preferences.panel_height = Math.min(bounds.maxHeight, Math.max(bounds.minHeight, height));
    applyDimensions();
    requestAnimationFrame(position);
  }

  function finishResize() {
    if (!resizeState) return;
    elements.utilities?.classList.remove('is-resizing');
    resizeState = null;
    persist();
  }

  elements.floatingSize?.addEventListener('click', () => {
    setSize(preferences.floating_size === 'expanded' ? 'compact' : 'expanded');
  });
  elements.floatingHandle?.addEventListener('pointerdown', (event) => {
    if (preferences.layout !== 'floating' || window.innerWidth <= 900) return;
    const rect = elements.utilities.getBoundingClientRect();
    dragState = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    elements.floatingHandle.setPointerCapture?.(event.pointerId);
    elements.utilities.classList.add('is-dragging');
    event.preventDefault();
  });
  elements.floatingHandle?.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    move(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY);
  });
  elements.floatingHandle?.addEventListener('pointerup', finishDrag);
  elements.floatingHandle?.addEventListener('pointercancel', finishDrag);
  elements.floatingHandle?.addEventListener('keydown', (event) => {
    if (preferences.layout !== 'floating' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const rect = elements.utilities.getBoundingClientRect();
    const delta = event.shiftKey ? 50 : 16;
    move(
      rect.left + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0),
      rect.top + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0),
    );
    dragState = { keyboard: true };
    finishDrag();
    event.preventDefault();
  });
  elements.panelResize?.addEventListener('pointerdown', (event) => {
    if (!elements.utilities) return;
    const rect = elements.utilities.getBoundingClientRect();
    resizeState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
    };
    elements.panelResize.setPointerCapture?.(event.pointerId);
    elements.utilities.classList.add('is-resizing');
    event.preventDefault();
  });
  elements.panelResize?.addEventListener('pointermove', (event) => {
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    resize(
      resizeState.width + event.clientX - resizeState.startX,
      resizeState.height + event.clientY - resizeState.startY,
    );
  });
  elements.panelResize?.addEventListener('pointerup', finishResize);
  elements.panelResize?.addEventListener('pointercancel', finishResize);
  elements.panelResize?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !elements.utilities) return;
    const rect = elements.utilities.getBoundingClientRect();
    const delta = event.shiftKey ? 48 : 16;
    resize(
      rect.width + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0),
      rect.height + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0),
    );
    persist();
    event.preventDefault();
  });
  const handleViewportResize = () => {
    applyDimensions();
    position();
  };
  window.addEventListener('resize', handleViewportResize);
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => position())
    : null;
  if (elements.utilities) resizeObserver?.observe(elements.utilities);

  let saved = {};
  try {
    saved = JSON.parse(readPreference(PLAYER_PREFERENCES_KEY, '{}'));
  } catch (_error) {
    saved = {};
  }
  applyPreferences({ layout: readPreference(LAYOUT_KEY, 'beside'), ...saved });

  return {
    applyPreferences,
    setLayout,
    dispose: () => {
      window.removeEventListener('resize', handleViewportResize);
      resizeObserver?.disconnect();
    },
  };
}
