const CACHE_NAME = "party-p2p-v2";
const BASE_URL = new URL(self.registration.scope);
const STATIC_ASSETS = ["manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png"];

function appUrl(path) {
  return new URL(path, BASE_URL).toString();
}

async function cacheAppShell() {
  const cache = await caches.open(CACHE_NAME);
  const indexUrl = appUrl("");
  const indexHtmlUrl = appUrl("index.html");
  const response = await fetch(indexUrl, { cache: "no-store" });
  const html = await response.clone().text();
  await cache.put(indexUrl, response.clone());
  await cache.put(indexHtmlUrl, response.clone());

  const assetMatches = Array.from(html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)).map((match) => new URL(match[1], BASE_URL).toString());
  const assets = Array.from(new Set([...STATIC_ASSETS.map(appUrl), ...assetMatches]));
  await Promise.all(assets.map((asset) => cache.add(asset).catch(() => undefined)));
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
        .catch(() => {
          if (request.mode === "navigate") return cached || caches.match(appUrl("index.html"));
          return cached || Response.error();
        });
      return cached || network;
    })
  );
});
