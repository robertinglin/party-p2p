const CACHE_NAME = "party-p2p-v1";
const STATIC_ASSETS = ["/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const response = await fetch("/", { cache: "no-store" });
  const html = await response.clone().text();
  await cache.put("/", response.clone());
  await cache.put("/index.html", response.clone());

  const assetMatches = Array.from(html.matchAll(/\/(assets\/[^\"']+)/g)).map((match) => `/${match[1]}`);
  const assets = Array.from(new Set([...STATIC_ASSETS, ...assetMatches]));
  await cache.addAll(assets);
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || caches.match("/index.html"));
      return cached || network;
    })
  );
});
