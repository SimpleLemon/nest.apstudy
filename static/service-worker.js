const FALLBACK_URL = '/notifications';

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (_) { data = {}; }
  const title = String(data.title || 'Nest.APStudy');
  const options = {
    body: String(data.body || 'You have a new notification.'),
    icon: 'https://resources.apstudy.org/images/AP-Resources-Logo.png',
    badge: 'https://resources.apstudy.org/images/AP-Resources-Logo.png',
    tag: String(data.tag || data.id || 'nest-notification'),
    renotify: true,
    timestamp: Date.parse(data.timestamp || '') || Date.now(),
    data: { id: data.id, url: safePath(data.url), category: data.category },
  };
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    setBadge(Number(data.badgeCount || 0)),
  ]));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safePath(event.notification.data?.url);
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { existing.navigate(url); return existing.focus(); }
    return clients.openWindow(url);
  }));
});

function safePath(value) {
  try {
    const url = new URL(String(value || FALLBACK_URL), self.location.origin);
    return url.origin === self.location.origin ? `${url.pathname}${url.search}${url.hash}` : FALLBACK_URL;
  } catch (_) { return FALLBACK_URL; }
}

function setBadge(count) {
  if (!self.navigator?.setAppBadge) return Promise.resolve();
  return count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge();
}
