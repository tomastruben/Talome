// Self-unregister — the service worker was causing stale cache issues
// (chunk load failures, login-on-refresh, format not supported errors).
// Push notifications still work without it via the Notification API.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      // Clear all caches
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
      // Unregister this service worker
      self.registration.unregister(),
    ])
  );
});
