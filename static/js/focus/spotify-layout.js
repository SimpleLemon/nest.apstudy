const LAYOUT_KEY = 'apstudy.focus.spotify.layout.v1';
const PLAYER_PREFERENCES_KEY = 'apstudy.focus.spotify.preferences.v2';
const COMPACT_PLAYER_HEIGHT = 152;
const FULL_PLAYER_HEIGHT = 352;
const VIDEO_PLAYER_MIN_HEIGHT = 220;
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
  let keyboardResizeState = null;

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
        maxWidth: Math.max(340, Math.min(960, viewportWidth * 0.62)),
        minHeight: 320,
        maxHeight: Math.max(320, viewportHeight - 24),
      };
    }
    return {
      minWidth: Math.min(280, viewportWidth - 28),
      maxWidth: Math.max(280, Math.min(960, viewportWidth - (viewportWidth <= 520 ? 28 : 40))),
      minHeight: 320,
      maxHeight: Math.max(320, Math.min(760, viewportHeight * 0.78)),
    };
  }

  function fullPlayerHeight() {
    return preferences.layout === 'beside' && window.innerWidth > 900 ? 420 : FULL_PLAYER_HEIGHT;
  }

  function playerChromeHeight() {
    const panel = elements.utilities?.getBoundingClientRect();
    const frame = elements.playerFrame?.getBoundingClientRect();
    if (panel?.height && frame?.height) return Math.max(0, panel.height - frame.height);
    if (preferences.layout === 'floating' && window.innerWidth > 900) return 120;
    if (preferences.layout === 'beside' && window.innerWidth > 900) return 130;
    return 149;
  }

  // Spotify's compact and full embed heights are stable; intermediate heights can leave the embed in a broken layout.
  // Snap only to those safe sizes when below the full embed; above full, grow continuously and hard-clamp at bounds.
  function snapPlayerHeight(height, bounds) {
    if (!height) return 0;
    const chrome = playerChromeHeight();
    const provider = elements.spotifyEmbed?.dataset.playlistProvider || 'spotify';
    if (provider !== 'spotify') {
      return Math.min(bounds.maxHeight, Math.max(height, chrome + VIDEO_PLAYER_MIN_HEIGHT));
    }
    const requestedFrameHeight = Math.max(0, height - chrome);
    const full = fullPlayerHeight();
    const midpoint = (COMPACT_PLAYER_HEIGHT + full) / 2;
    const safeFrameHeight = requestedFrameHeight < full
      ? (requestedFrameHeight <= midpoint ? COMPACT_PLAYER_HEIGHT : full)
      : requestedFrameHeight;
    // Clamp at maxHeight — never bounce from a too-large size back down to compact.
    return Math.min(bounds.maxHeight, chrome + safeFrameHeight);
  }

  function applyDimensions(width = preferences.panel_width, height = preferences.panel_height, { snap = true } = {}) {
    if (!elements.utilities) return;
    const bounds = dimensionBounds();
    const visibleWidth = width > 0 ? Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width)) : 0;
    const boundedHeight = height > 0 ? Math.min(bounds.maxHeight, Math.max(bounds.minHeight, height)) : 0;
    const visibleHeight = boundedHeight > 0 && snap ? snapPlayerHeight(boundedHeight, bounds) : boundedHeight;
    if (height > 0 && visibleHeight > 0) preferences.panel_height = visibleHeight;
    if (width > 0 && visibleWidth > 0) preferences.panel_width = visibleWidth;
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
    keyboardResizeState = null;
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
    keyboardResizeState = null;
    preferences.layout = LAYOUT_MAP.get(value) || 'below';
    document.body.dataset.spotifyLayout = preferences.layout;
    elements.layoutInputs.forEach((input) => { input.checked = input.value === preferences.layout; });
    applyDimensions();
    requestAnimationFrame(position);
    if (shouldPersist) persist();
    return preferences.layout;
  }

  function applyPreferences(value) {
    keyboardResizeState = null;
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

  function resize(width, height, { snap = true } = {}) {
    const bounds = dimensionBounds();
    preferences.panel_width = Math.min(bounds.maxWidth, Math.max(bounds.minWidth, width));
    preferences.panel_height = Math.min(bounds.maxHeight, Math.max(bounds.minHeight, height));
    applyDimensions(preferences.panel_width, preferences.panel_height, { snap });
    requestAnimationFrame(position);
  }

  function finishResize() {
    if (!resizeState) return;
    elements.utilities?.classList.remove('is-resizing');
    resizeState = null;
    applyDimensions(preferences.panel_width, preferences.panel_height, { snap: true });
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
    keyboardResizeState = null;
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
      { snap: false },
    );
  });
  elements.panelResize?.addEventListener('pointerup', finishResize);
  elements.panelResize?.addEventListener('pointercancel', finishResize);
  elements.panelResize?.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !elements.utilities) return;
    const bounds = dimensionBounds();
    const rect = elements.utilities.getBoundingClientRect();
    const delta = event.shiftKey ? 48 : 16;
    keyboardResizeState ||= { width: rect.width, height: rect.height };
    keyboardResizeState.width = Math.min(
      bounds.maxWidth,
      Math.max(bounds.minWidth, keyboardResizeState.width + (event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0)),
    );
    keyboardResizeState.height = Math.min(
      bounds.maxHeight,
      Math.max(bounds.minHeight, keyboardResizeState.height + (event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0)),
    );
    resize(
      keyboardResizeState.width,
      keyboardResizeState.height,
    );
    persist();
    event.preventDefault();
  });
  const handleViewportResize = () => {
    keyboardResizeState = null;
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
