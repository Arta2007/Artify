// Offline cache for the app shell. Bump CACHE when files change so phones pick up the new version.
const CACHE = 'artify-v16';
const RUNTIME = 'stash-runtime-v1'; // the AI library from the CDN, cached the first time it's used
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/tags.js', 'js/spotify.js', 'js/icons.js', 'js/engine.js', 'js/analysis.js',
  'js/analysis-worker.js', 'js/lang.js', 'js/lang-worker.js', 'js/smart.js', 'js/lyrics.js', 'js/zip.js', 'js/lyricsync.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== RUNTIME && k !== SHARE && !k.startsWith('transformers')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Songs shared to Artify from other apps (Android / desktop Chrome "Share" menu) arrive as a POST.
// Park the files in a cache, then open the app, which imports them.
const SHARE = 'artify-shared';
async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('audio').filter(f => f && typeof f === 'object' && f.size);
    const cache = await caches.open(SHARE);
    let n = 0;
    for (const f of files) {
      await cache.put(new Request(`./shared/${Date.now()}-${n++}`), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name || 'shared song') } }));
    }
    return Response.redirect(`./?shared=${n}`, 303);
  } catch {
    return Response.redirect('./?shared=error', 303);
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Versioned CDN files never change: cache-first so the language AI works offline later.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(RUNTIME).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return; // Spotify, MusicBrainz, Hugging Face go straight to the network

  // Navigations (including the Spotify redirect with ?code=) always get the cached shell.
  const key = req.mode === 'navigate' ? new Request(new URL('index.html', self.registration.scope)) : req;

  // Stale-while-revalidate: answer from cache instantly, refresh the cache in the background.
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(key, { ignoreSearch: true });
    const net = fetch(key).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
