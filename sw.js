// The app's offline copy (a service worker). It keeps the app's own files on the phone, so the app
// opens instantly and without a connection, and keeps the libraries it loads from CDNs.
//
// RELEASES: raise VERSION every time any app file changes, and upload this file with them. The
// phone then fetches the new files in the background and the app offers "Reload". Profile shows
// this version, so it always names the files actually running on the phone.

const VERSION = "2.3.6";
const APP = `app-${VERSION}`;
const LIBS = "libs"; // CDN libraries: their URLs name their version, so they're kept across releases

const FILES = [
  "./", "index.html", "styles.css", "config.js", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
  "js/app.js", "js/budget.js", "js/dashboard.js", "js/db.js", "js/entry.js", "js/export.js",
  "js/filters.js", "js/fx.js", "js/history.js", "js/numbers.js", "js/offline.js", "js/outbox.js",
  "js/profile.js", "js/receipt-parse.js", "js/receipt.js", "js/recurring.js", "js/settings.js",
  "js/state.js", "js/store.js", "js/ui.js",
];
const LIB_HOSTS = ["cdn.jsdelivr.net", "cdn.sheetjs.com"];

self.addEventListener("install", (event) => {
  // cache: "reload" skips the browser's own cache, so a release never picks up stale copies.
  event.waitUntil(caches.open(APP).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("app-") && key !== APP) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting(); // the person tapped Reload
  if (event.data === "version") event.ports[0]?.postMessage(VERSION); // for Profile
  if (event.data?.type === "keep-libs") event.waitUntil(keepLibs(event.data.urls));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) event.respondWith(appFile(req));
  else if (isLib(url, req)) event.respondWith(libFile(req));
  // Anything else (Supabase, exchange rates) goes straight to the network.
});

// Libraries, not live data: the currency-rate files on jsdelivr change daily and are fetched no-store.
const isLib = (url, req) => LIB_HOSTS.includes(url.hostname) && req.cache !== "no-store" && !url.pathname.includes("currency-api");

async function appFile(req) {
  const cache = await caches.open(APP);
  const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === "navigate" ? await cache.match("index.html") : null);
  return hit || fetch(req);
}

// "opaque": a script loaded without CORS (SheetJS); it can still be kept and served back.
const keepable = (res) => res.ok || res.type === "opaque";

async function libFile(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (keepable(res)) cache.put(req, res.clone());
  return res;
}

// Libraries the page loaded before this worker was in charge (the very first visit).
async function keepLibs(urls) {
  const cache = await caches.open(LIBS);
  for (const u of urls || []) {
    const url = new URL(u);
    if (!LIB_HOSTS.includes(url.hostname) || url.pathname.includes("currency-api") || (await cache.match(u))) continue;
    try {
      const res = await fetch(u).catch(() => fetch(u, { mode: "no-cors" }));
      if (keepable(res)) await cache.put(u, res);
    } catch { /* offline: next time */ }
  }
}
