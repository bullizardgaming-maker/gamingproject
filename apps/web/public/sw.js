// Web Push: show notifications sent by the Bullizard API and open the right page when tapped.
self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { title: 'Bullizard', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(msg.title || 'Bullizard', {
      body: msg.body || '',
      tag: msg.tag || undefined,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      data: { url: msg.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((tabs) => {
      const same = tabs.find((t) => t.url === url);
      if (same) return same.focus();
      return self.clients.openWindow(url);
    }),
  );
});
