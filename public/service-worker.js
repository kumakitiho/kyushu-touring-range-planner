const CACHE_PREFIX = "kyushu-touring-";
const CACHE_NAME = `${CACHE_PREFIX}v3`;
const BASE_URL = new URL("./", self.registration.scope);
const STATIC_FILES = ["./", "manifest.webmanifest", "icons/icon.svg", "images/kyushu-burger.svg", "images/kyushu-coast-road.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(cacheAppShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== BASE_URL.origin || !url.pathname.startsWith(BASE_URL.pathname)) return;
  if (url.pathname.includes("/api/")) return;

  event.respondWith(networkFirst(event.request));
});

async function cacheAppShell() {
  const indexUrl = BASE_URL.toString();
  const indexResponse = await fetch(indexUrl);
  if (!indexResponse.ok) throw new Error("App shell could not be loaded");
  const html = await indexResponse.clone().text();
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], BASE_URL))
    .filter((url) => url.origin === BASE_URL.origin && url.pathname.startsWith(BASE_URL.pathname))
    .map((url) => url.toString());
  const urls = [...STATIC_FILES.map((path) => new URL(path, BASE_URL).toString()), ...assetUrls];
  const cache = await caches.open(CACHE_NAME);
  await cache.put(indexUrl, indexResponse);
  await cache.addAll([...new Set(urls.filter((url) => url !== indexUrl))]);
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const appShell = await caches.match(BASE_URL.toString());
      if (appShell) return appShell;
    }
    throw error;
  }
}
