// Keeps the field app usable with no signal: the app shell comes from the cache when the
// network fails. API calls always go to the network (the app queues records itself).
const CACHE = "needs-field-v3";
const SHELL = ["/pilot/app/", "/pilot/app/app.js?v=1", "/pilot/lib.js?v=2", "/pilot/pilot.css?v=4", "/style.css?v=1"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: false }).then((hit) => hit || caches.match("/pilot/app/"))));
});
