/*
 * Bitterbot phone app service worker (PLAN-62).
 *
 * Two jobs, nothing else:
 *   1. An offline shell. The app's HTML and its content-hashed assets are
 *      cached so the app opens (and shows "reconnecting") without a network.
 *      No gateway data is cached: chat, approvals and status always come live
 *      over the authenticated WebSocket.
 *   2. Web Push. Show the notification the gateway sent and, on tap, open the
 *      app at the right screen.
 */

const CACHE_PREFIX = "bitterbot-mobile-";
const CACHE = `${CACHE_PREFIX}shell-v2`;
const SCOPE = self.registration ? self.registration.scope : new URL("./", self.location).href;
const SHELL_URL = SCOPE; // …/m/

/** Pull the asset URLs out of the shell HTML so they can be cached together. */
function assetUrlsFrom(html, base) {
  const urls = new Set();
  const re = /(?:src|href)="([^"]+)"/g;
  let match;
  while ((match = re.exec(html))) {
    const value = match[1];
    if (/^(?:https?:|data:|mailto:)/.test(value) && !value.startsWith(self.location.origin)) {
      continue;
    }
    try {
      const url = new URL(value, base);
      if (url.origin === self.location.origin) {
        urls.add(url.href);
      }
    } catch {
      // ignore
    }
  }
  return [...urls];
}

async function cacheShell() {
  const cache = await caches.open(CACHE);
  const res = await fetch(SHELL_URL, { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    return;
  }
  const html = await res.clone().text();
  await cache.put(SHELL_URL, res);
  const assets = assetUrlsFrom(html, SHELL_URL);
  await Promise.all(
    assets.map(async (url) => {
      try {
        const r = await fetch(url, { credentials: "same-origin" });
        if (r.ok) {
          await cache.put(url, r);
        }
      } catch {
        // best-effort
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Only our own old shells: other Cache Storage on this origin (the
      // Control UI, anything else) is not ours to delete.
      await Promise.all(
        keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") {
    return;
  }
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }
  // The app's own pages: network first (updates land on the next open),
  // cached shell when offline.
  if (req.mode === "navigate" && url.href.startsWith(SCOPE)) {
    // Only the shell itself (…/m/ or …/m/index.html, any query) refreshes the
    // cached shell, and only a real HTML 200 from this origin. Any other page
    // under /m/ is served but never stored as the shell.
    const shellPath = new URL(SHELL_URL).pathname;
    const isShell = url.pathname === shellPath || url.pathname === `${shellPath}index.html`;
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const type = fresh.headers.get("content-type") || "";
          if (
            isShell &&
            fresh.ok &&
            fresh.status === 200 &&
            fresh.type === "basic" &&
            !fresh.redirected &&
            type.startsWith("text/html")
          ) {
            const cache = await caches.open(CACHE);
            await cache.put(SHELL_URL, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await caches.match(SHELL_URL);
          return cached || Response.error();
        }
      })(),
    );
    return;
  }
  // Content-hashed bundles, fonts and icons: cache first, they never change.
  const isStatic =
    url.pathname.includes("/assets/") ||
    url.pathname.includes("/fonts/") ||
    (url.href.startsWith(SCOPE) && /\.(png|svg|webmanifest|woff2)$/.test(url.pathname));
  if (isStatic) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) {
          return cached;
        }
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(req, res.clone());
        }
        return res;
      })(),
    );
  }
  // Everything else (the pairing API) goes to the network untouched.
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Bitterbot", body: event.data ? event.data.text() : "" };
  }
  const title = typeof data.title === "string" && data.title ? data.title : "Bitterbot";
  const target = typeof data.url === "string" && data.url.startsWith("#/") ? data.url : "#/chat";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === "string" ? data.body : "",
      tag: typeof data.tag === "string" ? data.tag : undefined,
      renotify: data.kind === "approval",
      icon: new URL("icons/icon-192.png", SCOPE).href,
      badge: new URL("icons/badge-96.png", SCOPE).href,
      data: { url: target },
      timestamp: typeof data.ts === "number" ? data.ts : Date.now(),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "#/chat";
  const full = new URL(target, SHELL_URL).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(SCOPE)) {
          client.postMessage({ type: "navigate", url: target });
          if ("focus" in client) {
            return client.focus();
          }
          return undefined;
        }
      }
      return self.clients.openWindow(full);
    })(),
  );
});
