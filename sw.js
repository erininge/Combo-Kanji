const CACHE = "jlpt-combo-kanji-v1.1.1-5f3c8c7f20";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./data/combo_vocab.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./sw.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => k === CACHE ? null : caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.endsWith("/data/combo_vocab.json")) {
    e.respondWith(
      fetch(e.request).then(res => {
        if (!res.ok) throw new Error("Dataset fetch failed");
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
        return res;
      }).catch(() => new Response(JSON.stringify({ error: "Dataset fetch failed" }), {
        status: 503,
        headers: { "Content-Type": "application/json" }
      }))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(()=>caches.match("./index.html")))
  );
});
