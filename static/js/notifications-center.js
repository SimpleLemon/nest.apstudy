(function center(global) {
  let category = 'all'; let cursor = null;
  const api = (...args) => global.APStudyNotifications.api(...args);
  const escape = (value) => { const node = document.createElement('span'); node.textContent = value || ''; return node.innerHTML; };
  async function load(append = false) {
    if (!global.APStudyNotifications) return setTimeout(() => load(append), 50);
    const feed = document.getElementById('notification-center-feed'); feed.setAttribute('aria-busy', 'true');
    const query = new URLSearchParams({ limit: '30' }); if (category !== 'all') query.set('category', category); if (append && cursor) query.set('before', cursor);
    try { const data = await api(`/api/notifications?${query}`); const html = data.notifications.map((item) => `<article class="notification-center-item ${item.is_read ? '' : 'is-unread'}" data-id="${item.id}"><a href="${item.target_url || '#'}"><span class="material-symbols-outlined" aria-hidden="true">${icon(item.category)}</span><span><strong>${escape(item.title || item.notification_type)}</strong><small>${escape(item.body || item.message)}</small><time>${new Date(item.created_at).toLocaleString()}</time></span></a><div><button data-read aria-label="Mark read">done</button><button data-delete aria-label="Delete">delete</button></div></article>`).join(''); if (append) feed.insertAdjacentHTML('beforeend', html); else feed.innerHTML = html || '<p class="notification-empty">You’re all caught up.</p>'; cursor = data.next_cursor; document.getElementById('notification-center-more').hidden = !cursor; } catch (error) { feed.innerHTML = `<p class="notification-empty">${escape(error.message)}</p>`; } finally { feed.setAttribute('aria-busy', 'false'); }
  }
  function icon(value) { return ({ calendar: 'calendar_month', courses: 'school', chat_dm: 'chat', chat_mention: 'alternate_email', notes: 'edit_note' })[value] || 'notifications'; }
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => { category = button.dataset.category; cursor = null; document.querySelectorAll('[data-category]').forEach((item) => item.setAttribute('aria-selected', String(item === button))); void load(); }));
    document.getElementById('notification-center-read-all').addEventListener('click', async () => { await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ read: true, category: category === 'all' ? null : category }) }); await load(); });
    document.getElementById('notification-center-clear').addEventListener('click', async () => { if (!confirm('Clear these notifications?')) return; await api('/api/notifications', { method: 'DELETE', body: JSON.stringify({ category: category === 'all' ? null : category }) }); await load(); });
    document.getElementById('notification-center-more').addEventListener('click', () => load(true));
    document.getElementById('notification-center-feed').addEventListener('click', async (event) => { const item = event.target.closest('[data-id]'); if (!item) return; if (event.target.closest('[data-delete]')) { event.preventDefault(); await api('/api/notifications', { method: 'DELETE', body: JSON.stringify({ ids: [item.dataset.id] }) }); item.remove(); } else if (event.target.closest('[data-read]')) { event.preventDefault(); await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [item.dataset.id], read: true }) }); item.classList.remove('is-unread'); } });
    void load();
  });
})(window);
