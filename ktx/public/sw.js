/* Minimal service worker: enables "Add to Home Screen" (PWA install) and
   lets reservation-complete notifications show while the tab is backgrounded.
   Intentionally no offline caching of API responses. */

const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icon.svg"];
const CACHE = "ktx-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API traffic; always hit the network.
  if (url.pathname.startsWith("/api/")) return;
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((hit) => hit || fetch(event.request))
  );
});

// Focus/open the app when the user taps the notification.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.includes("/ktx") && "focus" in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow("/ktx/") : null;
    })
  );
});
