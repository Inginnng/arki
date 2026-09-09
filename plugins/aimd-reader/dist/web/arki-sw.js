// Only the application shell is cached. Project APIs, evidence and model responses
// remain in their explicitly managed, per-project stores, never the HTTP cache.
const CACHE = "arki-shell-v1";
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.add("/web.html")).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("arki-shell-") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !["/", "/web.html"].includes(url.pathname)) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { signal: AbortSignal.timeout(2500) });
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
        const cache = await caches.open(CACHE); await cache.put("/web.html", response.clone()); return response;
      }
      throw Error("SHELL_UNAVAILABLE");
    } catch { return await caches.match("/web.html") ?? new Response("请启动 Arki 后重新打开。", { status: 503, headers: { "content-type": "text/plain;charset=utf-8" } }); }
  })());
});
