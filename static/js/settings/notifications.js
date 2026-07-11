(function notificationSettings(global) {
  const selected = (button, value) => { button.classList.toggle('is-active', value); button.setAttribute('aria-pressed', String(value)); };
  const toast = (message, type = 'success') => global.APStudySettingsUtils?.showToast?.(message, type) || global.alert(message);
  let config = null;
  async function load() {
    const api = global.APStudyNotifications?.api;
    if (!api) return setTimeout(load, 50);
    try { config = await api('/api/notifications/preferences'); render(); } catch (error) { toast(error.message, 'error'); }
  }
  function render() {
    const permission = !('Notification' in global) ? 'unsupported' : Notification.permission;
    const status = document.getElementById('notification-permission-status');
    const enable = document.getElementById('notification-enable');
    const recovery = document.getElementById('notification-recovery');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (ios && !standalone) { status.textContent = 'Install Nest on your Home Screen to enable notifications.'; enable.disabled = true; recovery.hidden = false; recovery.textContent = 'In Safari, tap Share, then Add to Home Screen. Open the installed Nest app and return here.'; }
    else if (permission === 'denied') { status.textContent = 'Blocked in browser'; enable.disabled = true; recovery.hidden = false; recovery.textContent = 'Allow notifications for nest.apstudy.org in your browser’s site settings, then reload this page.'; }
    else { status.textContent = permission === 'granted' ? 'Enabled on this browser' : permission === 'unsupported' ? 'Not supported by this browser' : 'Not enabled on this browser'; enable.textContent = permission === 'granted' ? 'Refresh subscription' : 'Enable notifications'; enable.disabled = permission === 'unsupported'; recovery.hidden = true; }
    document.querySelectorAll('[data-push-toggle]').forEach((button) => selected(button, Boolean(config.preferences[button.dataset.pushToggle])));
    document.querySelectorAll('.notification-leads input').forEach((input) => { input.checked = config.preferences.calendar_lead_minutes.includes(Number(input.value)); });
    document.getElementById('notification-all-day-time').value = config.preferences.all_day_previous_time;
    const devices = document.getElementById('notification-devices');
    devices.innerHTML = config.devices.length ? config.devices.map((device) => `<div class="notification-device"><span><strong>${escape(device.device_name)}</strong><small>Last active ${new Date(device.last_seen_at || device.created_at).toLocaleDateString()}</small></span><button type="button" class="settings-button settings-button-secondary" data-revoke="${device.id}">Revoke</button></div>`).join('') : '<p class="settings-help-text">No browsers are registered yet.</p>';
  }
  async function enable() { try { await global.APStudyNotifications.enable(); toast('Notifications enabled.'); await load(); } catch (error) { toast(error.message, 'error'); await load(); } }
  async function save() {
    const preferences = {};
    document.querySelectorAll('[data-push-toggle]').forEach((button) => { preferences[button.dataset.pushToggle] = button.classList.contains('is-active'); });
    preferences.calendar_lead_minutes = Array.from(document.querySelectorAll('.notification-leads input:checked')).map((input) => Number(input.value));
    preferences.all_day_previous_time = document.getElementById('notification-all-day-time').value;
    try { config.preferences = (await global.APStudyNotifications.api('/api/notifications/preferences', { method: 'PATCH', body: JSON.stringify(preferences) })).preferences; toast('Notification preferences saved.'); render(); } catch (error) { toast(error.message, 'error'); }
  }
  async function test() { try { const result = await global.APStudyNotifications.api('/api/notifications/test', { method: 'POST', body: '{}' }); toast(`Test accepted by ${result.accepted} device${result.accepted === 1 ? '' : 's'}.`); } catch (error) { toast(error.message, 'error'); } }
  function escape(value) { const node = document.createElement('span'); node.textContent = value || ''; return node.innerHTML; }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('notification-enable')?.addEventListener('click', enable);
    document.getElementById('notification-save')?.addEventListener('click', save);
    document.getElementById('notification-test')?.addEventListener('click', test);
    document.querySelectorAll('[data-push-toggle]').forEach((button) => button.addEventListener('click', () => selected(button, !button.classList.contains('is-active'))));
    document.getElementById('notification-devices')?.addEventListener('click', async (event) => { const id = event.target.closest('[data-revoke]')?.dataset.revoke; if (!id) return; await global.APStudyNotifications.api(`/api/notifications/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' }); await load(); });
    void load();
  });
})(window);
