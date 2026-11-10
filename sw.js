// Keeps the app's own code on the phone so it opens instantly, offline too, and installs as an app.
// Never caches your traces, map tiles, streets or anything from another site.
//
// The app opens from this cache without waiting for the network. A new version is downloaded in
// the background (the publish workflow stamps BUILD with the commit) and the page offers to
// switch to it. On an unstamped copy (development) the network is asked first instead.
const BUILD = '__BUILD__';
const DEV = BUILD.startsWith('__');
const CACHE = 'fog-explorer-' + BUILD;
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png',
  'js/app.js', 'js/fog.js', 'js/streets.js', 'js/route.js', 'js/store.js', 'js/dropbox.js', 'js/network.js', 'js/data.js', 'js/worker.js',
  'vendor/leaflet.js', 'vendor/leaflet.css', 'vendor/jszip.min.js', 'geo/departements-idf.geojson'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/data/')) return; // street data lives in IndexedDB
  const fromNet = () => fetch(e.request, { cache: 'no-cache' }).then(r => {
    if (r.ok && !u.search.includes('code=')) { const c = r.clone(); caches.open(CACHE).then(cc => cc.put(e.request, c)); }
    return r;
  });
  const fromCache = () => caches.open(CACHE).then(c => c.match(e.request, { ignoreSearch: true }));
  e.respondWith(DEV ? fromNet().catch(fromCache) : fromCache().then(r => r || fromNet()));
});
