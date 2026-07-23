function createAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  return AudioContext ? new AudioContext() : null;
}

export function createCompletionEffects() {
  let audioContext = null;
  let notificationsEnabled = false;

  async function prepare() {
    audioContext ||= createAudioContext();
    if (audioContext?.state === 'suspended') await audioContext.resume().catch(() => {});
    notificationsEnabled = 'Notification' in window && Notification.permission === 'granted';
    if (!window.APStudyNotifications?.api) return;
    try {
      const payload = await window.APStudyNotifications.api('/api/notifications/preferences');
      notificationsEnabled = Boolean(payload.preferences?.push_enabled);
    } catch (_error) { /* Browser permission remains the safe fallback. */ }
  }

  function tap(frequency, startsAt) {
    if (!audioContext) return;
    const oscillator = audioContext.createOscillator();
    const overtone = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const overtoneGain = audioContext.createGain();
    oscillator.type = 'triangle';
    overtone.type = 'sine';
    oscillator.frequency.value = frequency;
    overtone.frequency.value = frequency * 2;
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(0.075, startsAt + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.62);
    overtoneGain.gain.setValueAtTime(0.0001, startsAt);
    overtoneGain.gain.exponentialRampToValueAtTime(0.018, startsAt + 0.006);
    overtoneGain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.28);
    oscillator.connect(gain).connect(audioContext.destination);
    overtone.connect(overtoneGain).connect(audioContext.destination);
    oscillator.start(startsAt);
    overtone.start(startsAt);
    oscillator.stop(startsAt + 0.65);
    overtone.stop(startsAt + 0.3);
  }

  function playPianoCue() {
    if (!audioContext || audioContext.state !== 'running') return;
    const now = audioContext.currentTime + 0.02;
    tap(523.25, now);
    tap(659.25, now + 0.16);
    tap(783.99, now + 0.34);
  }

  async function notify(title, body) {
    if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
    const options = { body, icon: '/static/images/brand/nest-logo-v1-192.png', tag: 'nest-focus-complete' };
    if (document.hidden && navigator.serviceWorker) {
      const registration = await navigator.serviceWorker.getRegistration('/').catch(() => null);
      if (registration) {
        await registration.showNotification(title, options).catch(() => {});
        return;
      }
    }
    try { new Notification(title, options); } catch (_error) { /* Permission can change mid-session. */ }
  }

  function complete(phase) {
    playPianoCue();
    const isBreak = phase === 'break';
    void notify(isBreak ? 'Break complete' : 'Focus complete', isBreak
      ? 'Your next focus block is ready.'
      : 'Nice work. Return to Nest when you’re ready.');
  }

  function dispose() {
    void audioContext?.close?.().catch(() => {});
    audioContext = null;
    notificationsEnabled = false;
  }

  return { complete, dispose, prepare };
}
