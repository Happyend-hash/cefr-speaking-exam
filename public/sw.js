/*
 * English Hub Family — service worker.
 *
 * Its only jobs: let phones install the site as an app, and show a friendly
 * page instead of the browser's error when there is no internet. It caches
 * nothing else on purpose — every screen and every result always comes fresh
 * from the server, so a new version is live the moment it is deployed.
 */
const OFFLINE = '/offline.html';
const CACHE = 'ehf-offline-v1';   // notifications added 2026-11-03

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll([OFFLINE, '/favicon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Only page loads get the offline fallback; everything else goes straight to the network.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

/*
 * Phone notifications (2026-11-03). The server sends one push per new
 * message, friend request, support reply or teacher message. If the site is
 * open and on screen, the page itself shows it (its badges update) and no
 * notification pops up; otherwise the phone shows one under "English Hub".
 * Each message is its own notification, so phones that count notifications
 * put the right red number on the app icon; where the Badging API exists
 * (iPhone home-screen app, desktop installs) the number is set directly.
 */
// Headless test browsers have no app icon and crash on the badge call.
const canBadge = 'setAppBadge' in self.navigator && !/Headless/.test(self.navigator.userAgent);
const setBadge = n => {
  if (!canBadge) return Promise.resolve();
  try {
    return (n > 0 ? self.navigator.setAppBadge(n) : self.navigator.clearAppBadge()).catch(() => {});
  } catch { return Promise.resolve(); }
};

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  event.waitUntil((async () => {
    await setBadge(Number(data.badge) || 0);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const onScreen = windows.filter(w => w.visibilityState === 'visible');
    windows.forEach(w => w.postMessage({ type: 'push', data }));
    if (onScreen.length) return;
    await self.registration.showNotification(data.title || 'English Hub', {
      body: data.body || '',
      icon: '/logo192.png',
      badge: '/notify-badge.png',
      tag: `${data.kind || 'other'}-${data.from || ''}-${data.at || Date.now()}`,
      data: { url: data.url || '/', kind: data.kind || 'other', from: data.from || '' },
      vibrate: [80, 40, 80]
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const mine = windows.find(w => new URL(w.url).origin === self.location.origin);
    if (mine) {
      await mine.focus().catch(() => {});
      mine.postMessage({ type: 'open', url });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// The page tells us what has been read: drop those notifications and fix the number.
self.addEventListener('message', event => {
  const msg = event.data || {};
  if (msg.type !== 'read') return;
  event.waitUntil((async () => {
    const list = await self.registration.getNotifications();
    list.forEach(n => {
      const d = n.data || {};
      const kindDone = (msg.kinds || []).includes(d.kind);
      const personDone = msg.from && d.kind === 'dm' && d.from === msg.from;
      if (kindDone || personDone) n.close();
    });
    await setBadge(Number(msg.badge) || 0);
  })());
});
