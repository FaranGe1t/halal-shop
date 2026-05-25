/**
 * Cache-first (stale-while-revalidate) для Telegram WebView.
 * Витрина, API каталога/баннера и изображения — из кеша, обновление в фоне.
 */
const CACHE_VERSION = "halal-market-v14.6.0";
const SHELL_CACHE = `halal-shell-${CACHE_VERSION}`;
const DATA_CACHE = `halal-data-${CACHE_VERSION}`;
const IMAGE_CACHE = `halal-images-${CACHE_VERSION}`;

const PRECACHE_SHELL = ["./", "style.css", "app.js", "sw.js"];

function isSameOrigin(request) {
  try {
    return new URL(request.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

function isApiDataPath(pathname) {
  return pathname === "/api/products" || pathname === "/api/get_banner";
}

function isShellPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname.endsWith(".css") ||
    pathname.endsWith(".js") ||
    pathname === "/sw.js"
  );
}

function isImagePath(pathname) {
  return pathname.startsWith("/uploads/");
}

function isProductsApiRequest(request) {
  try {
    return new URL(request.url).pathname === "/api/products";
  } catch {
    return false;
  }
}

async function isValidProductsCatalogResponse(response) {
  if (!response || !response.ok) return false;
  try {
    const data = await response.clone().json();
    const cats = data?.categories;
    const prods = data?.products;
    return (
      (Array.isArray(cats) && cats.length > 0) ||
      (Array.isArray(prods) && prods.length > 0)
    );
  } catch {
    return false;
  }
}

async function matchCachedRequest(request, cacheName) {
  const cache = await caches.open(cacheName);
  let hit = await cache.match(request);
  if (hit) return hit;

  const url = new URL(request.url);
  if (url.search) {
    const bareUrl = new URL(url.pathname, url.origin);
    hit = await cache.match(bareUrl.href);
    if (hit) return hit;
    hit = await cache.match(bareUrl.pathname);
    if (hit) return hit;
  }
  return null;
}

async function putInCache(request, response, cacheName) {
  if (!response || !response.ok) return;

  if (cacheName === DATA_CACHE && isProductsApiRequest(request)) {
    const valid = await isValidProductsCatalogResponse(response);
    if (!valid) {
      try {
        const cache = await caches.open(cacheName);
        await cache.delete(request);
        const url = new URL(request.url);
        await cache.delete(new URL(url.pathname, url.origin).href);
      } catch {
        /* ignore */
      }
      return;
    }
  }

  const cache = await caches.open(cacheName);
  try {
    await cache.put(request, response);
  } catch {
    /* quota / opaque */
  }
}

async function resolveCachedEntry(request, cacheName) {
  const cached = await matchCachedRequest(request, cacheName);
  if (!cached) return null;

  if (cacheName === DATA_CACHE && isProductsApiRequest(request)) {
    const valid = await isValidProductsCatalogResponse(cached);
    if (!valid) {
      try {
        const cache = await caches.open(cacheName);
        await cache.delete(request);
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  return cached;
}

async function cacheFirstStaleWhileRevalidate(request, cacheName) {
  const cached = await resolveCachedEntry(request, cacheName);

  const networkPromise = fetch(request)
    .then((networkResponse) => {
      putInCache(request, networkResponse.clone(), cacheName);
      return networkResponse;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }

  const network = await networkPromise;
  if (network) return network;
  return new Response("", { status: 504, statusText: "Offline" });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE_SHELL.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            /* отдельный файл может быть недоступен при install */
          }
        })
      );
      await caches.open(DATA_CACHE);
      await caches.open(IMAGE_CACHE);
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("halal-") &&
              name !== SHELL_CACHE &&
              name !== DATA_CACHE &&
              name !== IMAGE_CACHE
          )
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !isSameOrigin(event.request)) {
    return;
  }

  const { pathname } = new URL(event.request.url);
  let cacheName = null;

  if (isApiDataPath(pathname)) {
    cacheName = DATA_CACHE;
  } else if (isImagePath(pathname)) {
    cacheName = IMAGE_CACHE;
  } else if (isShellPath(pathname)) {
    cacheName = SHELL_CACHE;
  }

  if (!cacheName) return;

  event.respondWith(cacheFirstStaleWhileRevalidate(event.request, cacheName));
});
