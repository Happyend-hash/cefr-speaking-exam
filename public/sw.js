/*
 * English Hub Family — service worker.
 *
 * Its only jobs: let phones install the site as an app, and show a friendly
 * page instead of the browser's error when there is no internet. It caches
 * nothing else on purpose — every screen and every result always comes fresh
 * from the server, so a new version is live the moment it is deployed.
 */
const OFFLINE = '/offline.html';
const CACHE = 'ehf-offline-v1';

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
