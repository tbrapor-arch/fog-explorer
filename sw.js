// Caches only the app's own code so it opens offline and installs as an app.
// Never caches your traces, map tiles, streets or anything from another site.
const CACHE = 'fog-explorer-v13';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'js/app.js', 'js/fog.js', 'js/streets.js', 'js/route.js', 'js/store.js', 'js/dropbox.js', 'js/network.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/jszip.min.js', 'geo/departements-idf.geojson'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// network first (so updates arrive right away), cache as fallback when offline
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/data/')) return; // street data lives in IndexedDB
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok && !u.search.includes('code=')) { const c = r.clone(); caches.open(CACHE).then(cc => cc.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
