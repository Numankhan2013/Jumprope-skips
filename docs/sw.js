// Skip Count service worker: makes the app installable and lets it open offline.
// The page is cached on install and refreshed in the background (network first for the
// page itself, so a new version shows up on the next launch). Libraries and fonts from
// CDNs are cached the first time they load. Firebase / Firestore traffic is never cached.
const VERSION = "95a6811318";
const SHELL = `skipcount-shell-${VERSION}`, CDN = "skipcount-cdn-v1";
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-touch-icon.png", "./voice/voice.json", "./voice/voice.mp3"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("skipcount-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  // never cache sign-in or database traffic
  if (/googleapis\.com$|firebaseapp\.com$|identitytoolkit|securetoken/.test(url.hostname) || url.pathname.includes("/__/auth/")) return;
  if (req.mode === "navigate" || (url.origin === location.origin && url.pathname.endsWith(".html"))) {
    // the page: network first (fresh version when online), cache when offline
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(SHELL).then(c => c.put("./index.html", copy)); return res; })
      .catch(() => caches.match("./index.html").then(r => r || caches.match("./"))));
    return;
  }
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); } return res; })));
    return;
  }
  if (/cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.gstatic\.com/.test(url.hostname)) {
    // libraries & fonts: cache first, fill on first use
    e.respondWith(caches.open(CDN).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }))));
  }
});
