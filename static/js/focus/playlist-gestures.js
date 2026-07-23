const REMOVE_THRESHOLD = 72;
const MAX_DRAG = 104;

function pointerCapture(item, pointerId, capture) {
  try {
    item?.[capture ? 'setPointerCapture' : 'releasePointerCapture']?.(pointerId);
  } catch (_error) {
    // Synthetic events and older touch engines may not expose an active pointer capture.
  }
}

export function bindPlaylistGestures(list, { onRemove, onSelect } = {}) {
  if (!list) return () => {};
  let gesture = null;
  const eventController = new AbortController();
  const listenerOptions = { signal: eventController.signal };
  const sessionBlocksRemove = () => document.body.classList.contains('focus-session-active');

  const reset = (item) => {
    item?.classList.remove('is-swiping');
    item?.style.removeProperty('--focus-playlist-swipe-x');
  };

  const finish = (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const { item, url, offset } = gesture;
    gesture = null;
    pointerCapture(item, event.pointerId, false);
    if (!sessionBlocksRemove() && offset <= -REMOVE_THRESHOLD) {
      item.classList.add('is-removing');
      window.setTimeout(() => onRemove?.(url), 160);
      return;
    }
    reset(item);
  };

  list.addEventListener('pointerdown', (event) => {
    if (sessionBlocksRemove()) return;
    if (event.pointerType === 'mouse' || event.target.closest('[data-focus-playlist-remove]')) return;
    const item = event.target.closest('[data-focus-playlist-item]');
    if (!item) return;
    gesture = {
      item,
      url: item.dataset.focusPlaylistItem,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offset: 0,
      horizontal: false,
    };
    pointerCapture(item, event.pointerId, true);
  }, listenerOptions);

  list.addEventListener('pointermove', (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.startX;
    const deltaY = event.clientY - gesture.startY;
    if (!gesture.horizontal && Math.abs(deltaY) > Math.abs(deltaX)) return;
    if (deltaX >= 0) return;
    gesture.horizontal = true;
    gesture.offset = Math.max(-MAX_DRAG, deltaX);
    gesture.item.classList.add('is-swiping');
    gesture.item.style.setProperty('--focus-playlist-swipe-x', `${gesture.offset}px`);
    event.preventDefault();
  }, listenerOptions);

  list.addEventListener('pointerup', finish, listenerOptions);
  list.addEventListener('pointercancel', finish, listenerOptions);
  list.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-focus-playlist-remove]');
    if (remove) {
      event.preventDefault();
      event.stopPropagation();
      if (!sessionBlocksRemove()) onRemove?.(remove.dataset.focusPlaylistRemove);
      return;
    }
    const select = event.target.closest('[data-spotify-playlist]');
    if (select) onSelect?.(select.dataset.spotifyPlaylist);
  }, listenerOptions);

  return () => {
    eventController.abort();
    reset(gesture?.item);
    gesture = null;
  };
}
