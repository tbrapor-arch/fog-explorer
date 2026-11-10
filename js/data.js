// Public map data used by the app: streets, stations and commune limits.
// Everything is built once a month from OpenStreetMap and geo.api.gouv.fr (see tools/), published
// next to the app, then SAVED ON THE PHONE (IndexedDB) the first time it is needed. After that,
// looking at a commune, searching one or finding "the commune where I am" needs no network at all.
// Shared by the page and by the worker that does the heavy computing.
import { idbGet, idbSet, idbGetMany, idbEach, ls } from './store.js';
import { fetchWays, fetchStations, cellsFor, gunzipJSON, decodeTile, tilesFor, geomBbox, inGeometry } from './streets.js';

let BASE = typeof document !== 'undefined' ? document.baseURI : self.location.href;
export const setBase = u => { BASE = u; };
const url = p => new URL(p, BASE).href;
const bytesOf = async r => new Uint8Array(await r.arrayBuffer());

// ---- manifest: what is published, and when it was built ----
// The last known manifest is used right away (no waiting on the network to open a commune);
// a fresh one is fetched in the background and takes over as soon as it arrives.
let manifest, manifestP = null, onNewData = () => {};
export const onDataUpdate = fn => { onNewData = fn; };
async function refreshManifest() {
  const r = await fetch(url('data/manifest.json'), { cache: 'no-cache' });
  const m = r.ok ? await r.json() : null;
  if (m) {
    const changed = manifest && manifest.date !== m.date;
    manifest = m; idbSet('manifest', m);
    if (changed) { tileMem.clear(); stationsAll = null; onNewData(m); }
  }
  return m;
}
export function getManifest() {
  if (manifest !== undefined) return Promise.resolve(manifest);
  return manifestP ||= (async () => {
    await migrateTiles();
    const saved = await idbGet('manifest');
    if (saved) { manifest = saved; refreshManifest().catch(() => {}); }
    else { try { manifest = await refreshManifest(); } catch (e) { manifest = null; } manifest ??= null; }
    return manifest;
  })();
}

// Older versions kept one copy of each tile per month (`tile:<date>:<key>`), which grew by
// 30 MB every month. Tiles now live under `tile:<key>` with their date, replaced in place.
async function migrateTiles() {
  if (await idbGet('tilesV2')) return;
  await idbEach('tile:20', (key, val, cur, store) => {
    const m = /^tile:(\d{4}-\d\d-\d\d):(.+)$/.exec(key);
    if (m) { store.put({ d: m[1], b: val }, 'tile:' + m[2]); cur.delete(); }
  });
  await idbEach('stations:', (key, val, cur, store) => { store.put({ d: key.slice(9), b: val }, 'stations'); cur.delete(); });
  await idbSet('tilesV2', 1);
}

// One saved file: use the phone's copy when it is the current version; otherwise download it,
// and if that fails (offline) fall back on the older copy rather than on nothing.
async function saved(key, path, date, have) {
  const st = have !== undefined ? have : await idbGet(key);
  if (st && st.d === date) return st.b;
  try {
    const r = await fetch(url(path));
    if (!r.ok) throw new Error('Données indisponibles (' + r.status + ').');
    const b = await bytesOf(r);
    await idbSet(key, { d: date, b });
    return b;
  } catch (e) { if (st) return st.b; throw e; }
}

// ---- streets ----
const tileMem = new Map(); // parsed tiles, small LRU
async function tileData(key, m, have) {
  if (tileMem.has(key)) { const v = tileMem.get(key); tileMem.delete(key); tileMem.set(key, v); return v; }
  const v = await gunzipJSON(await saved('tile:' + key, 'data/t/' + key + '.json.gz', m.date, have));
  tileMem.set(key, v); if (tileMem.size > 40) tileMem.delete(tileMem.keys().next().value);
  return v;
}
export async function getWays(bbox, onProg = () => {}) {
  const m = await getManifest();
  if (!m) return getWaysOverpass(bbox, onProg);
  const keys = tilesFor(bbox, m.tileLat, m.tileLon).filter(k => m.tiles[k]);
  const need = keys.filter(k => !tileMem.has(k));
  const have = new Map((await idbGetMany(need.map(k => 'tile:' + k))).map((v, i) => [need[i], v ?? null]));
  let d = 0; onProg(0, keys.length);
  const tiles = await Promise.all(keys.map(async k => { const t = await tileData(k, m, have.get(k)); onProg(++d, keys.length); return t; }));
  const seen = new Set(), all = [];
  for (const t of tiles) for (const w of decodeTile(t, bbox)) if (!seen.has(w.id)) { seen.add(w.id); all.push(w); }
  return all;
}
// make sure the streets of an area are on the phone, without decoding them
export async function prefetch(bbox, onProg = () => {}) {
  const m = await getManifest();
  if (!m) { await getWaysOverpass(bbox, onProg); return; }
  const keys = tilesFor(bbox, m.tileLat, m.tileLon).filter(k => m.tiles[k]);
  let d = 0;
  for (const k of keys) { await saved('tile:' + k, 'data/t/' + k + '.json.gz', m.date); onProg(++d, keys.length); }
}

// fallback when the published data is not there: live Overpass, by cells, 2 at a time
const CELL_DAYS = 30, cellMem = new Map();
const slimWays = ways => ways.map(w => ({ id: w.id, nodes: w.nodes, geometry: w.geometry.map(g => g && { lon: +g.lon.toFixed(6), lat: +g.lat.toFixed(6) }), tags: { highway: w.tags?.highway, name: w.tags?.name, width: w.tags?.width } }));
async function getCell(c) {
  if (cellMem.has(c.key)) return cellMem.get(c.key);
  const st = await idbGet('cell:' + c.key);
  if (st && Date.now() - st.t < CELL_DAYS * 864e5) { cellMem.set(c.key, st.ways); return st.ways; }
  return null;
}
async function getWaysOverpass(bbox, onProg = () => {}) {
  const cells = cellsFor(bbox), have = new Map(), missing = [];
  for (const c of cells) { const w = await getCell(c); if (w) have.set(c.key, w); else missing.push(c); }
  let done = cells.length - missing.length; onProg(done, cells.length);
  const worker = async () => {
    while (missing.length) {
      const c = missing.shift();
      const ways = slimWays(await fetchWays(c.bbox));
      cellMem.set(c.key, ways); have.set(c.key, ways); idbSet('cell:' + c.key, { t: Date.now(), ways });
      onProg(++done, cells.length);
    }
  };
  await Promise.all([worker(), worker()]);
  const seen = new Set(), all = [];
  for (const ws of have.values()) for (const w of ws) if (!seen.has(w.id)) { seen.add(w.id); all.push(w); }
  return all;
}

// ---- stations (RER, Transilien, métro, tram) ----
let stationsAll = null;
export async function loadStations(bbox) {
  const m = await getManifest();
  if (!m) {
    const key = 'st:' + bbox.map(x => x.toFixed(2)).join(','), c = await idbGet(key);
    if (c && Date.now() - c.t < 30 * 864e5) return c.list;
    const list = await fetchStations(bbox); idbSet(key, { t: Date.now(), list });
    return list;
  }
  stationsAll ||= await gunzipJSON(await saved('stations', 'data/stations.json.gz', m.date));
  const [s, w, n, e] = bbox, seen = new Map();
  for (const [name, lon, lat, kind] of stationsAll) {
    if (lat < s || lat > n || lon < w || lon > e) continue;
    const k = name + '|' + Math.round(lat * 200) + '|' + Math.round(lon * 200), prev = seen.get(k);
    if (!prev) seen.set(k, { name, lon, lat, kind }); else if (!prev.kind.includes(kind)) prev.kind += ', ' + kind;
  }
  return [...seen.values()];
}

// ---- commune limits ----
// File format (tools/build_communes.py): {"v":1,"date":…,"c":[[code, nom, codePostal, population, polygons]]}
// polygons = [[ring, …], …], each ring a flat list of integers in 1e-5 degrees, delta-encoded.
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function decodeCommunes(j) {
  return j.c.map(([code, nom, cp, pop, polys]) => {
    const coordinates = polys.map(rings => rings.map(r => {
      const out = new Array(r.length / 2); let x = 0, y = 0;
      for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; out[i / 2] = [x / 1e5, y / 1e5]; }
      return out;
    }));
    const geom = { type: 'MultiPolygon', coordinates };
    return { code, nom, cp: cp || '', pop: pop || 0, key: norm(nom), geom, bbox: geomBbox(geom) };
  });
}
const GEO = 'https://geo.api.gouv.fr/communes';
async function communesFromApi() { // only when the published file is missing
  const c = await idbGet('idfCommunes');
  let f = c && Date.now() - c.t < 90 * 864e5 ? c.f : null;
  if (!f) {
    const [a, b] = await Promise.all([
      fetch(`${GEO}?codeRegion=11&fields=nom,code&format=geojson&geometry=contour`).then(r => r.json()),
      fetch(`${GEO}?codeDepartement=75&type=arrondissement-municipal&fields=nom,code&format=geojson&geometry=contour`).then(r => r.json()),
    ]);
    f = [...a.features.filter(x => x.properties.code !== '75056'), ...(b.features || [])]
      .filter(x => x.geometry).map(x => ({ nom: x.properties.nom, code: x.properties.code, geom: x.geometry, bbox: geomBbox(x.geometry) }));
    idbSet('idfCommunes', { t: Date.now(), f });
  }
  return f.map(x => ({ cp: '', pop: 0, key: norm(x.nom), ...x }));
}
let communesP = null, byCode = null;
export function loadCommunes() {
  return communesP ||= (async () => {
    const m = await getManifest();
    const list = m?.communes ? decodeCommunes(await gunzipJSON(await saved('communes', 'data/communes.json.gz', m.communes.date))) : await communesFromApi();
    byCode = new Map(list.map(f => [f.code, f]));
    return list;
  })().catch(e => { communesP = null; throw e; });
}
export const communeByCode = async code => { await loadCommunes(); return byCode.get(code) || null; };
export async function communeAt(lon, lat) {
  const list = await loadCommunes();
  return list.find(f => { const [s, w, n, e] = f.bbox; return lat >= s && lat <= n && lon >= w && lon <= e && inGeometry(lon, lat, f.geom); }) || null;
}
// name or postcode, accents and hyphens ignored; biggest communes first among equal matches
export async function searchCommunes(q, max = 8) {
  const list = await loadCommunes(), nq = norm(q);
  if (!nq) return [];
  const out = [];
  for (const f of list) {
    const i = f.key.indexOf(nq);
    const rank = i === 0 ? 0 : i > 0 && f.key[i - 1] === ' ' ? 1 : i > 0 ? 2 : f.cp.startsWith(nq) ? 1 : -1;
    if (rank >= 0) out.push({ f, rank });
  }
  return out.sort((a, b) => a.rank - b.rank || b.f.pop - a.f.pop || a.f.nom.localeCompare(b.f.nom, 'fr', { numeric: true })).slice(0, max).map(x => x.f);
}

// ---- one-time download of the whole region ----
export async function downloadAll(onProg) {
  const m = await getManifest();
  if (!m) throw new Error("Les données de toute l'Île-de-France ne sont pas encore publiées.");
  try { await navigator.storage?.persist?.(); } catch (e) {}
  const all = Object.keys(m.tiles), keys = [...all]; let done = 0, bytes = 0;
  const work = async () => { while (keys.length) { const k = keys.shift(); await saved('tile:' + k, 'data/t/' + k + '.json.gz', m.date); bytes += m.tiles[k]; onProg(++done, all.length, bytes, m.bytes); } };
  await Promise.all([work(), work(), work(), work()]);
  await saved('stations', 'data/stations.json.gz', m.date);
  if (m.communes) await saved('communes', 'data/communes.json.gz', m.communes.date);
  ls.set('allDownloaded', m.date);
}
