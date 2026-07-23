const CLOSE_MS = 140;

export function createSettingsPanel({ dialog, openButtons, closeButton } = {}) {
  const eventController = new AbortController();
  const listenerOptions = { signal: eventController.signal };
  let lastTrigger = null;
  let closingTimer = null;

  function sync() {
    const open = Boolean(dialog?.open);
    document.body.classList.toggle('focus-settings-open', open);
    openButtons.forEach((trigger) => trigger.setAttribute('aria-expanded', String(open)));
  }

  function finishClose() {
    if (!dialog?.open) return;
    dialog.classList.remove('is-closing');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    sync();
    window.setTimeout(() => lastTrigger?.focus?.(), 0);
  }

  function close() {
    if (!dialog?.open || dialog.classList.contains('is-closing')) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finishClose();
      return;
    }
    dialog.classList.add('is-closing');
    window.clearTimeout(closingTimer);
    closingTimer = window.setTimeout(() => {
      closingTimer = null;
      finishClose();
    }, CLOSE_MS);
  }

  function open(trigger) {
    if (!dialog || dialog.open) return;
    window.clearTimeout(closingTimer);
    closingTimer = null;
    dialog.classList.remove('is-closing');
    lastTrigger = trigger || document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    sync();
  }

  closeButton?.addEventListener('click', (event) => {
    event.preventDefault();
    close();
  }, listenerOptions);
  dialog?.addEventListener('close', sync, listenerOptions);
  dialog?.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  }, listenerOptions);
  dialog?.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) close();
  }, listenerOptions);

  return {
    close,
    dispose: () => {
      window.clearTimeout(closingTimer);
      eventController.abort();
    },
    open,
    sync,
  };
}
