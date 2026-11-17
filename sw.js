// Keeps the app's own files on the phone so it opens without signal.
// Claims are never cached here; the app keeps unsent claims itself and sends them when back online.
const VERSION = 'agsb-claims-v4';
const FILES = [
  './', './index.html', './app.js', './config.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './maskable-512.png',
  './apple-touch-icon.png', './favicon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Same-site files: try the network first (so updates show), fall back to the saved copy when offline.
self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) { return hit || caches.match('./index.html'); });
    })
  );
});
