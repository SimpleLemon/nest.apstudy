// Own the egg's scheduled work so a cached or disposed page cannot finish an
// obsolete countdown/opening animation against a newer session.
export function createEggAnimation(elements, completionMessage) {
  let timer = null;
  let frame = null;
  let settle = null;
  let removeAbort = null;
  let generation = 0;
  let disposed = false;

  function clearWork() {
    generation += 1;
    window.clearTimeout(timer);
    if (frame !== null) cancelAnimationFrame(frame);
    timer = null;
    frame = null;
    removeAbort?.();
    removeAbort = null;
    const resolve = settle;
    settle = null;
    resolve?.();
  }

  function resetEgg() {
    clearWork();
    if (elements.countdown) {
      elements.countdown.hidden = true;
      elements.countdown.textContent = '';
    }
    elements.session?.removeAttribute('data-countdown-active');
    if (!elements.egg) return;
    elements.egg.dataset.eggState = 'closed';
    elements.egg.dataset.crackLevel = '0';
    elements.egg.dataset.nestStage = '0';
    elements.egg.style.setProperty('--focus-egg-progress', '0');
    elements.egg.setAttribute('aria-label', 'An egg resting in a nest');
    if (elements.eggResult) elements.eggResult.textContent = 'Focus complete.';
  }

  function begin(signal) {
    clearWork();
    if (disposed || signal?.aborted || !elements.egg) return null;
    const revision = generation;
    if (signal) {
      signal.addEventListener('abort', resetEgg, { once: true });
      removeAbort = () => signal.removeEventListener('abort', resetEgg);
    }
    return () => !disposed && revision === generation && !signal?.aborted;
  }

  function finish() {
    timer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    removeAbort?.();
    removeAbort = null;
    const resolve = settle;
    settle = null;
    resolve?.();
  }

  function startCountdown({ signal } = {}) {
    if (!elements.countdown) return Promise.resolve();
    const active = begin(signal);
    if (!active) return Promise.resolve();
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const interval = reducedMotion ? 120 : 380;
    let number = 3;
    elements.egg.dataset.eggState = 'countdown';
    elements.session?.setAttribute('data-countdown-active', 'true');
    elements.countdown.hidden = false;
    return new Promise((resolve) => {
      settle = resolve;
      const showNumber = () => {
        if (!active()) return;
        if (number === 0) {
          elements.countdown.hidden = true;
          elements.countdown.textContent = '';
          elements.egg.dataset.eggState = 'closed';
          elements.session?.removeAttribute('data-countdown-active');
          finish();
          return;
        }
        elements.countdown.textContent = String(number);
        elements.countdown.classList.remove('is-counting');
        void elements.countdown.offsetWidth;
        elements.countdown.classList.add('is-counting');
        number -= 1;
        timer = window.setTimeout(showNumber, interval);
      };
      showNumber();
    });
  }

  function playEggOpening(phase, { signal } = {}) {
    const active = begin(signal);
    if (!active) return Promise.resolve();
    elements.session?.removeAttribute('data-countdown-active');
    if (elements.countdown) elements.countdown.hidden = true;
    elements.egg.dataset.nestStage = '8';
    elements.egg.dataset.crackLevel = '3';
    elements.egg.dataset.eggState = 'opening';
    if (elements.eggResult) elements.eggResult.textContent = completionMessage(phase);
    elements.egg.setAttribute('aria-label', `${phase === 'break' ? 'Break' : 'Focus'} complete; an open book rises from the egg`);
    frame = requestAnimationFrame(() => {
      frame = null;
      if (active()) elements.egg.dataset.eggState = 'open';
    });
    return new Promise((resolve) => {
      settle = resolve;
      timer = window.setTimeout(() => {
        if (!active()) return;
        elements.egg.dataset.eggState = 'open';
        finish();
      }, 3000);
    });
  }

  return {
    startCountdown,
    playEggOpening,
    resetEgg,
    dispose() { disposed = true; resetEgg(); },
  };
}
