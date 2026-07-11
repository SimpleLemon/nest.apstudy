(function notificationShell(global) {
  const state = { unread: 0 };
  const csrf = () => document.cookie.match(/(?:^|; )csrf_token=([^;]*)/)?.[1] || '';
  async function api(url, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (options.method && options.method !== 'GET') headers['X-CSRFToken'] = decodeURIComponent(csrf());
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Notification request failed.');
    return payload;
  }
  function base64Key(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  }
  async function registration() {
    if (!('serviceWorker' in navigator)) throw new Error('This browser does not support background notifications.');
    return navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
  }
  async function enable(deviceName) {
    if (!('Notification' in global)) throw new Error('This browser does not support notifications.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notifications are blocked in browser settings.');
    const config = await api('/api/notifications/preferences');
    if (!config.vapid_public_key) throw new Error('Push notifications are not configured on this server.');
    const reg = await registration();
    const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64Key(config.vapid_public_key) });
    return api('/api/notifications/subscriptions', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), device_name: deviceName || navigator.platform || 'This browser' }) });
  }
  async function disableCurrent() {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) return;
    await api('/api/notifications/subscriptions/current/delete', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
    await subscription.unsubscribe();
  }
  function renderBell() {
    const host = document.getElementById('navbar-notifications-host');
    if (!host) return;
    host.innerHTML = `<button class="navbar-button notification-bell" aria-label="Notifications" aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">notifications</span><span class="notification-badge" hidden></span></button><div class="notification-popover" hidden><div class="notification-popover-head"><strong>Notifications</strong><button type="button" data-read-all>Mark all read</button></div><div class="notification-popover-list" role="feed"></div><a href="/notifications" class="notification-view-all">View all notifications</a></div>`;
    const button = host.querySelector('.notification-bell');
    const popover = host.querySelector('.notification-popover');
    button.addEventListener('click', async () => { const opening = popover.hidden; popover.hidden = !opening; button.setAttribute('aria-expanded', String(opening)); if (opening) await loadRecent(host); });
    host.querySelector('[data-read-all]').addEventListener('click', async () => { await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ read: true }) }); await loadRecent(host); });
    void refreshCount(host);
  }
  async function showIntentPrompt() {
    if (!('Notification' in global) || Notification.permission !== 'default' || document.querySelector('.notification-intent-prompt')) return;
    try {
      const config = await api('/api/notifications/preferences');
      if (config.preferences.prompt_dismissed) return;
      const prompt = document.createElement('aside');
      prompt.className = 'notification-intent-prompt';
      prompt.setAttribute('role', 'dialog');
      prompt.setAttribute('aria-label', 'Enable notifications');
      prompt.innerHTML = '<strong>Stay ahead of what matters</strong><p>Let Nest alert you about deadlines, course openings, and messages—even when this tab is closed.</p><div><button type="button" data-not-now>Not now</button><button type="button" data-enable>Enable notifications</button></div>';
      document.body.appendChild(prompt);
      prompt.querySelector('[data-enable]').addEventListener('click', async () => { try { await enable(); prompt.remove(); } catch (error) { global.alert(error.message); } });
      prompt.querySelector('[data-not-now]').addEventListener('click', async () => { await api('/api/notifications/preferences', { method: 'PATCH', body: JSON.stringify({ prompt_dismissed: true }) }); prompt.remove(); });
    } catch (_) {}
  }
  async function refreshCount(host = document.getElementById('navbar-notifications-host')) {
    if (!host) return;
    try { const data = await api('/api/notifications/unread-count'); state.unread = data.unread_count; const badge = host.querySelector('.notification-badge'); badge.textContent = state.unread > 99 ? '99+' : String(state.unread); badge.hidden = !state.unread; if (navigator.setAppBadge) state.unread ? navigator.setAppBadge(state.unread) : navigator.clearAppBadge(); } catch (_) {}
  }
  async function loadRecent(host) {
    const list = host.querySelector('.notification-popover-list');
    list.innerHTML = '<p class="notification-empty">Loading…</p>';
    try { const data = await api('/api/notifications?limit=6'); list.innerHTML = data.notifications.length ? data.notifications.map((item) => `<a href="${item.target_url || '/notifications'}" class="notification-row ${item.is_read ? '' : 'is-unread'}" data-id="${item.id}"><strong>${escape(item.title || item.notification_type)}</strong><span>${escape(item.body || item.message)}</span></a>`).join('') : '<p class="notification-empty">You’re all caught up.</p>'; await refreshCount(host); } catch (error) { list.innerHTML = `<p class="notification-empty">${escape(error.message)}</p>`; }
  }
  function escape(value) { const node = document.createElement('span'); node.textContent = String(value || ''); return node.innerHTML; }
  global.APStudyNotifications = { api, enable, disableCurrent, registration, refreshCount };
  global.addEventListener('apstudy:notification-intent', showIntentPrompt);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderBell); else renderBell();
})(window);
