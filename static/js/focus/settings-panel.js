export function createSettingsPanel({ dialog, openButtons, closeButton } = {}) {
  const eventController = new AbortController();
  const listenerOptions = { signal: eventController.signal };
  let lastTrigger = null;

  function sync() {
    const open = Boolean(dialog?.open);
    document.body.classList.toggle('focus-settings-open', open);
    openButtons.forEach((trigger) => trigger.setAttribute('aria-expanded', String(open)));
  }

  function close() {
    if (!dialog?.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
    sync();
    window.setTimeout(() => lastTrigger?.focus?.(), 0);
  }

  function open(trigger) {
    if (!dialog || dialog.open) return;
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
  dialog?.addEventListener('cancel', () => window.setTimeout(sync, 0), listenerOptions);
  dialog?.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) close();
  }, listenerOptions);

  return {
    close,
    dispose: () => eventController.abort(),
    open,
    sync,
  };
}
