// Lets the dashboard install as an app, open instantly, and receive photos shared from
// the phone's gallery (Android: Share → GP Sync). Live data always comes from the network.
const CACHE = "gps-shell-v4";
const THUMBS = "gps-thumbs-v1";
const MAX_THUMBS = 2000;
const SHELL = ["./", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-192.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => ![CACHE, THUMBS, "gps-share"].includes(k)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

async function thumb(request) {
  const cache = await caches.open(THUMBS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const r = await fetch(request);
  if (r.ok && !r.redirected) {
    await cache.put(request, r.clone());
    trimThumbs(cache);
  }
  return r;
}

let trimming = false;
async function trimThumbs(cache) {
  // Oldest first: drop the extra ones now and then, not on every picture.
  if (trimming || Math.random() > 0.05) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_THUMBS)).map((k) => cache.delete(k)));
  } finally {
    trimming = false;
  }
}

async function receiveShare(request) {
  // Keep the shared files in a cache; the Upload page picks them up and uploads them.
  const form = await request.formData();
  const cache = await caches.open("gps-share");
  let i = 0;
  for (const file of form.getAll("media")) {
    if (typeof file === "string") continue;
    const key = new URL(`shared/${Date.now()}-${i++}?name=${encodeURIComponent(file.name)}`, self.registration.scope);
    await cache.put(key, new Response(file, { headers: { "Content-Type": file.type || "application/octet-stream" } }));
  }
  return Response.redirect(new URL("./#/upload/shared", self.registration.scope).href, 303);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.pathname.endsWith("/share")) {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method === "GET" && url.pathname.endsWith("/api/thumb") && url.searchParams.has("v")) {
    // A versioned thumbnail never changes: keep it on the phone, so scrolling back is instant.
    e.respondWith(thumb(e.request));
    return;
  }
  if (e.request.method !== "GET" || url.pathname.includes("/api/")) return; // never cache live data
  if (url.pathname.includes("/assets/")) {
    // Built files have hashed names and never change: cache first.
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((r) => {
            if (r.ok && !r.redirected) {
              const copy = r.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return r;
          }),
      ),
    );
    return;
  }
  // Everything else: network first so updates show at once; the cache is for offline starts.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        // Umbrel's login page is a redirect: never keep it as the app.
        if (r.ok && !r.redirected && url.origin === location.origin) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return r;
      })
      .catch(() =>
        caches
          .match(e.request)
          .then((hit) => hit || (e.request.mode === "navigate" ? caches.match("./") : undefined)),
      ),
  );
});
