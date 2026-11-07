import { FogMap, fogFromSnapshot, WORLD } from './fog.js';
import { fetchWays, fetchStations, cellsFor, gunzipJSON, decodeTile, tilesFor, buildNetwork, summarize, inGeometry, geomBbox, distM } from './streets.js';
import { Graph, routesAB, routesLoop, routeCommune, toGPX, toKML } from './route.js';
import { idbGet, idbSet, wipeAll, ls } from './store.js';
import * as dbx from './dropbox.js';
import { largestNetworks } from './network.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const km = m => (m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let fog = null;
let radius = +(ls.get('tol') || 2);

// ---------------- map ----------------
const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true, zoomSnap: 0.25, zoomDelta: 0.5 }).setView([48.8566, 2.3522], 12);
L.control.zoom({ position: 'topright' }).addTo(map);
window.__map = map; // handy for debugging from the console
let base;
const BASES = {
  epure: () => ({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', subdomains: '', native: 16,
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', plain: true,
    attribution: 'Fond &copy; Esri, HERE, Garmin, &copy; contributeurs <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
  osmfr: () => ({ url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · OSM France' }),
  osm: () => ({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: '',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
};
let baseLabels;
function setBase() {
  if (base) base.remove(); if (baseLabels) baseLabels.remove();
  const b = (BASES[ls.get('base')] || BASES.epure)();
  base = L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.native || 19, subdomains: b.subdomains, referrerPolicy: 'strict-origin', attribution: b.attribution, className: b.plain ? 'paper' : 'basemap' }).addTo(map);
  base.bringToBack();
  if (b.labels) {
    if (!map.getPane('labels')) { map.createPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none'; }
    baseLabels = L.tileLayer(b.labels, { pane: 'labels', maxZoom: 19, maxNativeZoom: b.native || 19, referrerPolicy: 'strict-origin', className: 'paper' }).addTo(map);
  }
}
setBase();

// Explored pixels layer (drawn from the decoded bitmaps, in this browser)
// Explored pixels drawn from the decoded bitmaps, in this browser.
// "brume": a veil over everything, cleared where you've walked (like Fog of World);
// "traits": your traces drawn as coloured lines.
let fogStyle = ls.get('fogStyle2') || 'traits';
function paintFog(c, src, color, alpha) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  if (!src) return cv;
  const ctx = cv.getContext('2d');
  const scale = Math.pow(2, c.z - 14);              // screen px per fog px
  const brume = !color && fogStyle === 'brume';
  const dot = brume ? Math.max(scale * 1.6, 3.5) : Math.max(scale * 1.2, 2.6); // keep thin trails readable when zoomed out
  const off = (dot - scale) / 2;
  const fx0 = c.x * 256 / scale, fy0 = c.y * 256 / scale, fsz = 256 / scale, m = Math.ceil(dot / scale);
  const bx0 = Math.floor((fx0 - m) / 64), by0 = Math.floor((fy0 - m) / 64), bx1 = Math.floor((fx0 + fsz + m) / 64), by1 = Math.floor((fy0 + fsz + m) / 64);
  if (brume) {
    ctx.fillStyle = 'rgba(70, 84, 104, 0.30)'; ctx.fillRect(0, 0, 256, 256);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
  } else { ctx.fillStyle = color || '#2b7fd4'; ctx.globalAlpha = alpha || 0.7; }
  const draw = (key, b) => {
    const gbx = Math.floor(key / 65536), gby = key % 65536;
    for (let y = 0; y < 64; y++) for (let xb = 0; xb < 8; xb++) {
      const v = b[y * 8 + xb]; if (!v) continue;
      for (let bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) {
        const sx = ((gbx * 64 + xb * 8 + bit) - fx0) * scale - off, sy = ((gby * 64 + y) - fy0) * scale - off;
        if (sx > 256 || sy > 256 || sx + dot < 0 || sy + dot < 0) continue;
        ctx.fillRect(sx, sy, dot, dot);
      }
    }
  };
  const n = (bx1 - bx0 + 1) * (by1 - by0 + 1);
  if (n <= src.size) {
    for (let bx = bx0; bx <= bx1; bx++) for (let by = by0; by <= by1; by++) { const k = bx * 65536 + by, b = src.blocks.get(k); if (b) draw(k, b); }
  } else {
    for (const [k, b] of src.blocks) { const bx = Math.floor(k / 65536), by = k % 65536; if (bx >= bx0 && bx <= bx1 && by >= by0 && by <= by1) draw(k, b); }
  }
  return cv;
}
const FogLayer = L.GridLayer.extend({ createTile(c) { return paintFog(c, fog); } });
const fogLayer = new FogLayer({ maxZoom: 19, zIndex: 300 }).addTo(map);
const streetsLayer = L.layerGroup().addTo(map);
const outlineLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const hlLayer = L.layerGroup().addTo(map);

// fit bounds in the part of the map not covered by the panel
function fit(bounds, maxZoom = 18) {
  const phone = matchMedia('(max-width: 819px)').matches, sh = $('#sheet');
  const opts = phone ? { paddingTopLeft: [20, 90], paddingBottomRight: [20, sh.classList.contains('min') ? 110 : sh.offsetHeight + 16] }
    : { paddingTopLeft: [410, 30], paddingBottomRight: [30, 30] };
  map.fitBounds(bounds, { ...opts, maxZoom });
}

// ---------------- ui helpers ----------------
function chip(text, state = '') { $('#chipText').textContent = text; $('#chip').className = 'chip ' + state; }
let toastT;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}
function fogStatus(meta) {
  if (!fog) { chip('Aucune donnée chargée'); $('#dataStatus').textContent = 'Aucune donnée. Charge un snapshot ou connecte Dropbox.'; return; }
  const d = meta?.date ? new Date(meta.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  chip(`Traces : ${meta?.source || 'chargées'}${d ? ' · ' + d : ''}`, 'ok');
  $('#dataStatus').textContent = `${fog.countPixels().toLocaleString('fr-FR')} pixels explorés (≈ ${(fog.countPixels() * 40 / 1e6).toFixed(1)} km²) · source : ${meta?.source || '?'}${d ? ' · ' + d : ''}`;
}
async function setFog(f, meta) {
  fog = f; touched = null; fogLayer.redraw(); fogStatus(meta);
  await idbSet('fog', { ...f.serialize(), meta });
  if (current) analyze(current, false);
}

// tabs + sheet
// Each tab shows only its own layers on the map, with its own legend.
let curTab = 'commune';
const legendFor = {};
function setLegend(tab, html) { if (html !== undefined) legendFor[tab] = html; if (tab !== curTab) return; const h = legendFor[curTab]; $('#legend').hidden = !h; if (h) $('#legend').innerHTML = h; }
function tabLayers() {
  const want = {
    commune: [streetsLayer, outlineLayer, hlLayer],
    route: [routeLayer, markerLayer],
    idf: [conquestLayer, netFogLayer, netLayer],
    data: [],
  }[curTab] || [];
  const all = [streetsLayer, outlineLayer, hlLayer, routeLayer, markerLayer, conquestLayer, netFogLayer, netLayer];
  for (const l of all) {
    const on = want.includes(l) && (l === conquestLayer ? conquestOn : l === netFogLayer || l === netLayer ? netOn : true);
    if (on && !map.hasLayer(l)) map.addLayer(l); else if (!on && map.hasLayer(l)) map.removeLayer(l);
  }
  setLegend(curTab);
}
function selectTab(t) {
  curTab = t;
  $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t));
  $$('.pane').forEach(p => (p.hidden = p.dataset.pane !== t));
  tabLayers();
  if (t === 'idf' && fog && !conquestOn) showConquest(true);
}
$$('.tabs button').forEach(b => b.onclick = () => { selectTab(b.dataset.tab); $('#sheet').classList.remove('min'); });
$('#grip').onclick = () => $('#sheet').classList.toggle('min');
const showTab = t => { selectTab(t); $('#sheet').classList.remove('min'); };

// ---------------- streets / commune analysis ----------------
let current = null;          // { name, geom?, bbox, ways }
const waysCache = new Map(); // bbox key -> ways (memory)
let netCurrent = null;

const CELL_DAYS = 30;
const slimWays = ways => ways.map(w => ({ id: w.id, nodes: w.nodes, geometry: w.geometry.map(g => g && { lon: +g.lon.toFixed(6), lat: +g.lat.toFixed(6) }), tags: { highway: w.tags?.highway, name: w.tags?.name, width: w.tags?.width } }));
async function getCell(c) {
  if (waysCache.has(c.key)) return waysCache.get(c.key);
  const st = await idbGet('cell:' + c.key);
  if (st && Date.now() - st.t < CELL_DAYS * 864e5) { waysCache.set(c.key, st.ways); return st.ways; }
  return null;
}
// ---- local street data (published with the app, downloaded once, kept on the phone) ----
let manifest; // undefined = not checked yet, null = not available
async function getManifest() {
  if (manifest !== undefined) return manifest;
  try { const r = await fetch('data/manifest.json', { cache: 'no-cache' }); manifest = r.ok ? await r.json() : null; }
  catch (e) { manifest = (await idbGet('manifest')) || null; } // offline: use the last known one
  if (manifest) idbSet('manifest', manifest);
  return manifest;
}
const tileMem = new Map(); // decoded tiles, small LRU
async function tileBytes(key, m) {
  const id = 'tile:' + m.date + ':' + key;
  let b = await idbGet(id);
  if (!b) {
    const r = await fetch('data/t/' + key + '.json.gz');
    if (!r.ok) throw new Error('Données de rues indisponibles (' + r.status + ').');
    b = new Uint8Array(await r.arrayBuffer());
    await idbSet(id, b);
  }
  return b;
}
async function tileData(key, m) {
  if (tileMem.has(key)) { const v = tileMem.get(key); tileMem.delete(key); tileMem.set(key, v); return v; }
  const v = await gunzipJSON(await tileBytes(key, m));
  tileMem.set(key, v); if (tileMem.size > 24) tileMem.delete(tileMem.keys().next().value);
  return v;
}
async function getWays(bbox, _key, onProg = () => {}) {
  const m = await getManifest();
  if (!m) return getWaysOverpass(bbox, _key, onProg);
  const keys = tilesFor(bbox, m.tileLat, m.tileLon).filter(k => m.tiles[k]);
  const seen = new Set(), all = []; let d = 0;
  onProg(0, keys.length);
  for (const k of keys) {
    for (const w of decodeTile(await tileData(k, m), bbox)) if (!seen.has(w.id)) { seen.add(w.id); all.push(w); }
    onProg(++d, keys.length);
  }
  return all;
}
let stationsAll = null;
async function localStations(bbox) {
  const m = await getManifest(); if (!m) return null;
  if (!stationsAll) {
    let b = await idbGet('stations:' + m.date);
    if (!b) { const r = await fetch('data/stations.json.gz'); if (!r.ok) return null; b = new Uint8Array(await r.arrayBuffer()); idbSet('stations:' + m.date, b); }
    stationsAll = await gunzipJSON(b);
  }
  const [s, w, n, e] = bbox, seen = new Map();
  for (const [name, lon, lat, kind] of stationsAll) {
    if (lat < s || lat > n || lon < w || lon > e) continue;
    const k = name + '|' + Math.round(lat * 200) + '|' + Math.round(lon * 200), prev = seen.get(k);
    if (!prev) seen.set(k, { name, lon, lat, kind }); else if (!prev.kind.includes(kind)) prev.kind += ', ' + kind;
  }
  return [...seen.values()];
}
// one-time download of the whole region
async function downloadAll(onProg) {
  const m = await getManifest();
  if (!m) throw new Error("Les données de toute l'Île-de-France ne sont pas encore publiées.");
  try { await navigator.storage?.persist?.(); } catch (e) {}
  const keys = Object.keys(m.tiles); let done = 0, bytes = 0;
  const work = async () => { while (keys.length) { const k = keys.shift(); await tileBytes(k, m); bytes += m.tiles[k]; onProg(++done, Object.keys(m.tiles).length, bytes, m.bytes); } };
  await Promise.all([work(), work(), work(), work()]);
  await localStations([-90, -180, 90, 180]);
  ls.set('allDownloaded', m.date);
}

// fallback: live Overpass, by cells. onProg(done, total), 2 at a time (the free servers allow 2 slots)
async function getWaysOverpass(bbox, _key, onProg = () => {}) {
  const cells = cellsFor(bbox), have = new Map(), missing = [];
  for (const c of cells) { const w = await getCell(c); if (w) have.set(c.key, w); else missing.push(c); }
  let done = cells.length - missing.length; onProg(done, cells.length);
  const worker = async () => {
    while (missing.length) {
      const c = missing.shift();
      const ways = slimWays(await fetchWays(c.bbox));
      waysCache.set(c.key, ways); have.set(c.key, ways); idbSet('cell:' + c.key, { t: Date.now(), ways });
      onProg(++done, cells.length);
    }
  };
  await Promise.all([worker(), worker()]);
  const seen = new Set(), all = [];
  for (const ws of have.values()) for (const w of ws) if (!seen.has(w.id)) { seen.add(w.id); all.push(w); }
  return all;
}
const progTxt = (what, d, t) => t > 1 && d < t ? `${what} : zone ${d + 1}/${t}…` : `${what}…`;

function drawStreets(net, filter) {
  streetsLayer.clearLayers();
  const cNew = css('--new'), cDone = css('--done');
  let line = [], state = null, lastB = null, lastW = -1;
  const flush = () => {
    if (line.length > 1) {
      const w = net.ways[lastW];
      L.polyline(line, state ? { color: cDone, weight: 2, opacity: .75, interactive: false }
        : { color: cNew, weight: w.path ? 2.5 : 3.5, opacity: .95, dashArray: w.path ? '5 5' : null, interactive: false }).addTo(streetsLayer);
    }
    line = [];
  };
  for (const s of net.segs) {
    if (filter && !filter(s)) { flush(); lastB = null; continue; }
    if (s.w !== lastW || s.done !== state || s.a !== lastB) { flush(); const a = net.nodes.get(s.a); line.push([a[1], a[0]]); }
    const b = net.nodes.get(s.b); line.push([b[1], b[0]]);
    state = s.done; lastB = s.b; lastW = s.w;
  }
  flush();
  setLegend('commune', legendStreets);
}

async function analyze(area, fitView = true) {
  current = area;
  const out = $('#communeOut');
  if (!fog) { out.innerHTML = `<div class="empty"><b>Il manque tes traces.</b> Va dans l'onglet Données pour charger ton snapshot ou connecter Dropbox.</div>`; }
  outlineLayer.clearLayers(); hlLayer.clearLayers();
  if (area.geom) {
    const gj = L.geoJSON(area.geom, { style: { color: css('--fg'), weight: 2, opacity: .7, fill: false, dashArray: '6 4' }, interactive: false }).addTo(outlineLayer);
    if (fitView) fit(gj.getBounds());
  }
  if (!fog) return;
  out.innerHTML = `<p class="muted"><span class="spin"></span> Chargement des rues de ${esc(area.name)}…</p>`;
  chip('Chargement des rues…', 'busy');
  try {
    const ways = await getWays(area.bbox, area.key, (d, t) => { const m = progTxt('Téléchargement des rues de ' + area.name, d, t); chip(m, 'busy'); const p = $('#communeOut p.muted'); if (p) p.innerHTML = '<span class="spin"></span> ' + esc(m); });
    chip('Croisement avec tes traces…', 'busy'); await new Promise(r => setTimeout(r, 0));
    const net = buildNetwork(ways, fog, { radius });
    const midIn = s => { const a = net.nodes.get(s.a), b = net.nodes.get(s.b); return inGeometry((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, area.geom); };
    const filter = area.geom ? midIn : null;
    netCurrent = { net, filter };
    drawStreets(net, filter);
    const st = summarize(net, filter || (() => true));
    renderStats(area, st);
    if (area.code) savePct(area.code, st.roads.total ? st.roads.done / st.roads.total : 0, { fin: st.finished, n: st.streets, km: st.roads.total });
  } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  fogStatus(fogMeta);
}

function renderStats(area, st) {
  const r = st.roads, p = st.paths;
  const todo = [...st.byName.values()].map(e => ({ ...e, left: e.total - e.done })).filter(e => e.left > 30 && e.done < 0.9 * e.total).sort((a, b) => b.left - a.left);
  const virgin = todo.filter(e => e.done < 1).length;
  $('#communeOut').innerHTML = `
    <div class="stat">
      <div class="big">${pct(r.done, r.total)} %<small>des rues de ${esc(area.name)}</small></div>
      <div class="bar"><i style="width:${pct(r.done, r.total)}%"></i></div>
      <div class="kv"><span>${km(r.done)} faits sur ${km(r.total)}</span><span>reste ${km(r.total - r.done)}</span></div>
      <div class="kv"><span><b>${st.finished}</b> rues finies sur ${st.streets}</span><span>${virgin} jamais foulées</span></div>
      <div class="kv"><span>Chemins et allées : ${pct(p.done, p.total)} %</span><span>niveau : <b>${LEVELS[levelFromPct(r.total ? r.done / r.total : 0, true)]}</b></span></div>
    </div>
    ${area.geom ? `<button id="toCom" class="btn primary">Itinéraire pour cocher ${esc(area.name)}</button>` : ''}
    <details class="todo"><summary>Rues à finir (${todo.length})</summary>
    <ul class="list" id="todo">${todo.slice(0, 60).map((e, i) => `
      <li data-i="${i}"><span class="n">${esc(e.name)}</span><span class="v">${km(e.left)}</span>
      <span class="s">${e.done < 1 ? 'jamais parcourue' : pct(e.done, e.total) + ' % faite'} · ${km(e.total)} au total</span></li>`).join('')}</ul></details>`;
  $('#toCom')?.addEventListener('click', () => { showTab('route'); setMode('com'); });
  $$('#todo li').forEach(li => li.onclick = () => {
    const e = todo[+li.dataset.i]; hlLayer.clearLayers();
    const lines = e.segs.map(s => { const a = netCurrent.net.nodes.get(s.a), b = netCurrent.net.nodes.get(s.b); return [[a[1], a[0]], [b[1], b[0]]]; });
    const pl = L.polyline(lines, { color: css('--fg'), weight: 7, opacity: .35, interactive: false }).addTo(hlLayer);
    if (matchMedia('(max-width: 819px)').matches) $('#sheet').classList.add('min');
    fit(pl.getBounds(), 17);
  });
}


// ---------------- conquest: every commune of Île-de-France by level ----------------
// Levels by % of street length walked. "Finie" stops at 90 %: a few streets are always
// unreachable or badly mapped.
const LEVELS = ['Vierge', 'Traversée', 'Visitée', 'Explorée', 'Conquise', 'Finie'];
const LEVEL_MIN = [0, 0, 0.10, 0.25, 0.50, 0.90];
function levelFromPct(p, touchedOrPos) {
  for (let i = LEVELS.length - 1; i >= 2; i--) if (p >= LEVEL_MIN[i]) return i;
  return touchedOrPos || p > 0 ? 1 : 0;
}
let pcts = {}; idbGet('pcts').then(v => { if (v) pcts = v; });
// a commune's % is recomputed only when you have new traces in it (its explored-pixel count changed)
const pxIn = code => touched ? (touched[code] || 0) : undefined;
const isStale = code => { const e = pcts[code]; if (!e) return (touched?.[code] || 0) >= 4; if (e.px === undefined) return true; return touched ? e.px !== pxIn(code) : false; };
async function savePct(code, p, extra = {}) {
  if (!touched) { try { await loadIdf(); touched = computeTouched(); } catch (e) {} }
  pcts[code] = { p, t: Date.now(), px: pxIn(code), ...extra }; idbSet('pcts', pcts); if (conquestOn) drawConquest(); }
let idfFeats = null, touched = null, conquestOn = false;
map.createPane('conq').style.zIndex = 250;
const conqRenderer = L.canvas({ pane: 'conq' });
const conquestLayer = L.layerGroup();

async function loadIdf() {
  if (idfFeats) return idfFeats;
  const c = await idbGet('idfCommunes');
  if (c && Date.now() - c.t < 90 * 864e5) return (idfFeats = c.f);
  const [a, b] = await Promise.all([
    fetch(`${GEO}?codeRegion=11&fields=nom,code&format=geojson&geometry=contour`).then(r => r.json()),
    fetch(`${GEO}?codeDepartement=75&type=arrondissement-municipal&fields=nom,code&format=geojson&geometry=contour`).then(r => r.json()),
  ]);
  const f = [...a.features.filter(x => x.properties.code !== '75056'), ...(b.features || [])]
    .filter(x => x.geometry).map(x => ({ nom: x.properties.nom, code: x.properties.code, geom: x.geometry, bbox: geomBbox(x.geometry) }));
  idbSet('idfCommunes', { t: Date.now(), f });
  return (idfFeats = f);
}
// counts fog pixels per commune (in this browser)
function computeTouched() {
  const cell = 0.02, grid = new Map(), counts = {};
  idfFeats.forEach((f, i) => {
    const [s, w, n, e] = f.bbox;
    for (let x = Math.floor(w / cell); x <= Math.floor(e / cell); x++) for (let y = Math.floor(s / cell); y <= Math.floor(n / cell); y++) {
      const k = x + ',' + y; (grid.get(k) || grid.set(k, []).get(k)).push(i);
    }
  });
  for (const [key, b] of fog.blocks) {
    const gbx = Math.floor(key / 65536), gby = key % 65536;
    for (let y = 0; y < 64; y += 2) for (let x = 0; x < 64; x += 2) {
      if (!(b[y * 8 + (x >> 3)] & (0x80 >> (x & 7)))) continue;
      const lon = (gbx * 64 + x) / WORLD * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (gby * 64 + y) / WORLD))) * 180 / Math.PI;
      const cands = grid.get(Math.floor(lon / cell) + ',' + Math.floor(lat / cell));
      if (!cands) continue;
      for (const i of cands) {
        const [s, w, n, e] = idfFeats[i].bbox;
        if (lat < s || lat > n || lon < w || lon > e) continue;
        if (inGeometry(lon, lat, idfFeats[i].geom)) { counts[idfFeats[i].code] = (counts[idfFeats[i].code] || 0) + 1; break; }
      }
    }
  }
  return counts;
}
const levelOf = code => {
  const p = pcts[code]?.p;
  if (p !== undefined) return levelFromPct(p, (touched[code] || 0) >= 4);
  return (touched[code] || 0) >= 4 ? 1 : 0;
};
const DEPTS = { '75': 'Paris', '77': 'Seine-et-Marne', '78': 'Yvelines', '91': 'Essonne', '92': 'Hauts-de-Seine', '93': 'Seine-Saint-Denis', '94': 'Val-de-Marne', '95': "Val-d'Oise" };
const deptOf = code => code.slice(0, 2);
let conqDept = ls.get('conqDept') || 'all', conqView = ls.get('conqView') || 'visit', deptGeo = null;
const legendStreets = $('#legend').innerHTML;
const visited = code => levelOf(code) > 0;
const pctTxt = (a, b) => (b ? Math.round(100 * a / b) : 0) + ' %';

function drawConquest(refit = false) {
  conquestLayer.clearLayers();
  const cols = LEVELS.map((_, i) => css('--lv' + i)), n = LEVELS.map(() => 0);
  const feats = idfFeats.filter(f => conqDept === 'all' || deptOf(f.code) === conqDept);
  const cVis = css('--done'), cNo = css('--lv0');
  for (const f of feats) {
    const lv = levelOf(f.code); n[lv]++;
    const p = pcts[f.code]?.p;
    const fill = conqView === 'visit' ? (lv ? cVis : cNo) : cols[lv];
    L.geoJSON(f.geom, { pane: 'conq', renderer: conqRenderer, interactive: false, style: { color: css('--bg'), weight: .7, fillColor: fill, fillOpacity: lv ? .55 : .18 } })
      .addTo(conquestLayer);
  }
  // department borders + labels
  const per = {};
  for (const f of idfFeats) { const d = deptOf(f.code); (per[d] ||= { n: 0, v: 0 }).n++; if (visited(f.code)) per[d].v++; }
  if (deptGeo) {
    const shown = deptGeo.features.filter(d => conqDept === 'all' || d.properties.code === conqDept);
    const gj = L.geoJSON({ type: 'FeatureCollection', features: shown }, { pane: 'conq', renderer: conqRenderer, interactive: false, style: { color: css('--fg'), weight: 2.2, opacity: .8, fill: false } }).addTo(conquestLayer);
    if (conqDept === 'all') gj.eachLayer(l => {
      const c = l.feature.properties.code, st = per[c] || { n: 0, v: 0 };
      L.marker(l.getBounds().getCenter(), { pane: 'conq', interactive: false, icon: L.divIcon({ className: '', html: `<span class="dlab${'75 92 93 94'.includes(c) ? ' pc' : ''}"><b>${c}</b> ${st.v}/${st.n}</span>`, iconSize: [0, 0] }) }).addTo(conquestLayer);
    });
    if (refit) fit(gj.getBounds());
  }
  const tot = feats.length, vis = feats.filter(f => visited(f.code)).length;
  const unknown = feats.filter(f => isStale(f.code)).length;
  const place = conqDept === 'all' ? "en Île-de-France" : (conqDept === '75' ? 'à Paris' : 'en ' + DEPTS[conqDept]);
  $('#conquest').innerHTML = `
    <div class="row">
      <select id="conqDept" class="grow" aria-label="Zone">
        <option value="all">Toute l'Île-de-France</option>
        ${Object.entries(DEPTS).map(([c, nm]) => `<option value="${c}" ${c === conqDept ? 'selected' : ''}>${c} · ${nm}</option>`).join('')}
      </select>
    </div>
    <div class="seg" role="radiogroup" aria-label="Affichage">
      <button id="cvVisit" class="${conqView === 'visit' ? 'on' : ''}" role="radio" aria-checked="${conqView === 'visit'}">Visitée ou non</button>
      <button id="cvLevels" class="${conqView === 'levels' ? 'on' : ''}" role="radio" aria-checked="${conqView === 'levels'}">Niveaux</button>
    </div>
    <div class="stat">
      <div class="big">${vis}<small>communes visitées sur ${tot} ${place}</small></div>
      <div class="bar"><i style="width:${tot ? 100 * vis / tot : 0}%"></i></div>
    </div>
    ${conqView === 'levels' ? `<div class="levels">${LEVELS.map((l, i) => `<div><b>${n[i]}</b><span><i style="background:${cols[i]}"></i>${l}s</span></div>`).join('')}</div>
    <p class="muted small">En % des km de rues faites : traversée &lt; 10 %, visitée 10–25 %, explorée 25–50 %, conquise 50–90 %, finie ≥ 90 %.</p>` : ''}
    ${conqDept === 'all' ? `<ul class="list" id="deptList">${Object.entries(DEPTS).map(([c, nm]) => { const st = per[c] || { n: 0, v: 0 }; return `
      <li data-d="${c}"><span class="n">${c} · ${esc(nm)}</span><span class="v">${st.v}/${st.n}</span>
      <span class="s"><span class="bar"><i style="width:${st.n ? 100 * st.v / st.n : 0}%"></i></span></span></li>`; }).join('')}</ul>` : ''}
    <div class="row wrap">
      <button id="conquestHide" class="btn small">Masquer la carte</button>
      ${unknown ? `<button id="conquestCalc" class="btn small">Mettre à jour ${unknown} commune${unknown > 1 ? 's' : ''} avec de nouvelles traces</button>` : '<span class="muted small">Tout est à jour ✓</span>'}
    </div>
    <p id="conquestProg" class="muted small" hidden></p>`;
  setLegend('idf', conqView === 'visit'
    ? `<span><i class="sq" style="background:${cVis}"></i>visitée</span><span><i class="sq" style="background:${cNo}"></i>pas encore</span>`
    : LEVELS.slice(1).map((l, i) => `<span><i class="sq" style="background:${cols[i + 1]}"></i>${l.toLowerCase()}</span>`).join(''));
  $('#conqDept').onchange = e => { conqDept = e.target.value; ls.set('conqDept', conqDept); drawConquest(true); };
  $('#cvVisit').onclick = () => { conqView = 'visit'; ls.set('conqView', conqView); drawConquest(); };
  $('#cvLevels').onclick = () => { conqView = 'levels'; ls.set('conqView', conqView); drawConquest(); };
  $$('#deptList li').forEach(li => li.onclick = () => { conqDept = li.dataset.d; ls.set('conqDept', conqDept); drawConquest(true); });
  $('#conquestHide').onclick = hideConquest;
  $('#conquestCalc')?.addEventListener('click', calcAll);
  drawComTable(feats);
}
// ---- biggest uninterrupted network ----
map.createPane('net').style.zIndex = 420;
const netLayer = L.layerGroup();
const NetFog = L.GridLayer.extend({ createTile(c) { return paintFog(c, netFog, '#7b3fe4', 0.85); } });
let netFog = null, netRes = null, netOn = false;
const netFogLayer = new NetFog({ pane: 'net', maxZoom: 19 });
async function communeAt(lon, lat) {
  try { await loadIdf(); } catch (e) { return null; }
  const f = idfFeats.find(f => { const [s, w, n, e] = f.bbox; return lat >= s && lat <= n && lon >= w && lon <= e && inGeometry(lon, lat, f.geom); });
  return f?.nom || null;
}
async function showNetwork(i = 0) {
  if (!fog) { toast("Charge d'abord tes traces (onglet Données).", true); return; }
  $('#netOut').innerHTML = '<p class="muted"><span class="spin"></span> Analyse de tes traces…</p>';
  await new Promise(r => setTimeout(r, 30));
  if (!netRes || netRes.fog !== fog) netRes = { fog, ...largestNetworks(fog, { gap: 2 }) };
  const c = netRes.comps[i];
  if (!c) { $('#netOut').innerHTML = '<p class="muted">Pas assez de traces.</p>'; return; }
  setLegend('idf', '<span><i class="sq" style="background:#7b3fe4"></i>ce réseau</span><span><i class="sq" style="background:#2b7fd4"></i>le reste de tes traces</span>');
  netFog = c.map; netOn = true; netLayer.clearLayers(); tabLayers(); netFogLayer.redraw();
  const A = [c.a[1], c.a[0]], B = [c.b[1], c.b[0]];
  L.polyline([A, B], { pane: 'net', color: '#7b3fe4', weight: 3, dashArray: '8 6', interactive: false }).addTo(netLayer);
  for (const p of [A, B]) L.circleMarker(p, { pane: 'net', radius: 7, color: '#fff', weight: 3, fillColor: '#7b3fe4', fillOpacity: 1 }).addTo(netLayer);
  L.marker([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], { pane: 'net', interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="rlab on">${km(c.dist)} à vol d'oiseau</span>` }) }).addTo(netLayer);
  fit(L.latLngBounds([A, B]).pad(0.15));
  const [na, nb] = await Promise.all([communeAt(...c.a), communeAt(...c.b)]);
  const km2 = c.pixels * 40 / 1e6;
  $('#netOut').innerHTML = `
    <div class="stat">
      <div class="big">${km(c.dist)}<small>à vol d'oiseau${na && nb ? `, de ${esc(na)} à ${esc(nb)}` : ''}</small></div>
      <div class="kv"><span>${km2.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km² explorés d'un seul tenant</span><span>${Math.round(c.share * 100)} % de tout ce que tu as exploré</span></div>
      <div class="kv"><span>${netRes.pieces} morceaux séparés au total</span><span></span></div>
    </div>
    <div class="row wrap">${netRes.comps.slice(0, 5).map((x, j) => `<button class="btn small ${j === i ? 'primary' : ''}" data-net="${j}">${j === 0 ? 'Le plus grand' : '#' + (j + 1)} · ${km(x.dist)}</button>`).join('')}
    <button id="netHide" class="btn small ghost">Masquer</button></div>
    <p class="muted small">Un réseau = des zones explorées reliées sans interruption. Une coupure GPS de moins de ~12 m ne casse pas le réseau.</p>`;
  $$('[data-net]').forEach(b => b.onclick = () => showNetwork(+b.dataset.net));
  $('#netHide').onclick = () => { netOn = false; tabLayers(); if (conquestOn) drawConquest(); $('#netOut').innerHTML = '<button id="netBtn" class="btn">Calculer mon plus grand réseau</button>'; $('#netBtn').onclick = () => showNetwork(); };
}
$('#netBtn').onclick = () => showNetwork();

// table: every commune with its %, level and when the % was last computed
let tableAll = false, tableQ = '';
const fmtDay = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
function drawComTable(feats) {
  const rows = feats.filter(f => (tableAll || levelOf(f.code) > 0 || pcts[f.code]) && (!tableQ || f.nom.toLowerCase().includes(tableQ)))
    .map(f => ({ f, p: pcts[f.code], lv: levelOf(f.code) }))
    .sort((a, b) => (b.p?.p ?? -1) - (a.p?.p ?? -1) || a.f.nom.localeCompare(b.f.nom));
  const stale = r => r.p && isStale(r.f.code);
  $('#comTable').innerHTML = `
    <div class="row"><input id="tableQ" type="search" placeholder="Filtrer les communes" value="${esc(tableQ)}" autocomplete="off">
    <label class="check small"><input type="checkbox" id="tableAll" ${tableAll ? 'checked' : ''}> vierges aussi</label></div>
    <ul class="list">${rows.slice(0, 400).map(r => `
      <li data-code="${r.f.code}"><span class="n">${esc(r.f.nom)}</span><span class="v">${r.p ? Math.round(r.p.p * 100) + ' %' : '—'}</span>
      <span class="s">${LEVELS[r.lv]} · ${r.p ? 'calculé le ' + fmtDay(r.p.t) + (stale(r) ? ' · <b>nouvelles traces depuis</b>' : '') : 'pas encore calculé'}</span></li>`).join('')}</ul>
    ${rows.length > 400 ? `<p class="muted small">${rows.length - 400} autres : affine avec le filtre.</p>` : ''}`;
  $('#tableQ').oninput = e => { tableQ = e.target.value.toLowerCase(); const pos = e.target.selectionStart; drawComTable(feats); const q = $('#tableQ'); q.focus(); q.setSelectionRange(pos, pos); };
  $('#tableAll').onchange = e => { tableAll = e.target.checked; drawComTable(feats); };
  $$('#comTable li[data-code]').forEach(li => li.onclick = () => { const f = idfFeats.find(x => x.code === li.dataset.code); showTab('commune'); $('#communeQ').value = f.nom; openCommune(f.code); });
}
function hideConquest() {
  conquestOn = false; tabLayers(); mapBtn?.classList.remove('on');
  setLegend('idf', '');
  $('#conquest').innerHTML = '<button id="conquestBtn" class="btn">Afficher la carte de mes communes</button>'; $('#conquestBtn').onclick = () => showConquest();
}
async function showConquest(fromMap = false) {
  if (!fog) { toast("Charge d'abord tes traces (onglet Données).", true); showTab('data'); return; }
  if (curTab !== 'idf') { curTab = 'idf'; $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === 'idf')); $$('.pane').forEach(p => (p.hidden = p.dataset.pane !== 'idf')); }
  $('#conquest').innerHTML = '<p class="muted"><span class="spin"></span> Chargement des 1 300 communes…</p>';
  $('#conquest').scrollIntoView({ block: 'nearest' });
  try {
    await loadIdf();
    if (!deptGeo) deptGeo = await fetch('geo/departements-idf.geojson').then(r => r.json()).catch(() => null);
    if (!touched) touched = computeTouched();
    conquestOn = true; mapBtn?.classList.add('on'); tabLayers();
    drawConquest(true);
    if (!deptGeo) fit(L.latLngBounds([[48.12, 1.45], [49.24, 3.56]]));
  } catch (e) { hideConquest(); toast('Limites des communes indisponibles pour le moment.', true); }
}
$('#conquestBtn').onclick = () => showConquest();
map.on('zoomend', () => map.getContainer().classList.toggle('zlo', map.getZoom() < 11));
map.getContainer().classList.toggle('zlo', map.getZoom() < 11);
// map button to open/close the commune map directly
let mapBtn = null;
L.Control.Conq = L.Control.extend({ onAdd() {
  const b = L.DomUtil.create('button', 'mapbtn'); b.type = 'button'; b.textContent = 'IDF'; b.title = 'Carte de mes communes';
  L.DomEvent.disableClickPropagation(b); b.onclick = () => { if (curTab === 'idf' && conquestOn) { selectTab('commune'); return; } if (matchMedia('(max-width: 819px)').matches) $('#sheet').classList.add('min'); selectTab('idf'); if (!conquestOn) showConquest(true); };
  return (mapBtn = b);
} });
new L.Control.Conq({ position: 'topright' }).addTo(map);
let calcStop = false;
async function calcAll() {
  const list = idfFeats.filter(f => isStale(f.code));
  const btn = $('#conquestCalc'), prog = $('#conquestProg');
  calcStop = false; btn.textContent = 'Arrêter'; btn.onclick = () => (calcStop = true); prog.hidden = false;
  for (let i = 0; i < list.length && !calcStop; i++) {
    const f = list[i];
    prog.textContent = `${i + 1}/${list.length} : ${f.nom}…`;
    try {
      const ways = await getWays(f.bbox, null);
      const net = buildNetwork(ways, fog, { radius });
      const st = summarize(net, s => { const a = net.nodes.get(s.a), b = net.nodes.get(s.b); return inGeometry((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, f.geom); });
      pcts[f.code] = { p: st.roads.total ? st.roads.done / st.roads.total : 0, t: Date.now(), px: pxIn(f.code), fin: st.finished, n: st.streets, km: st.roads.total };
      idbSet('pcts', pcts);
      await new Promise(r => setTimeout(r, manifest ? 30 : 1500)); // be gentle with the free Overpass servers
    } catch (e) { prog.textContent = e.message; await new Promise(r => setTimeout(r, 5000)); }
  }
  drawConquest();
}

// commune search (geo.api.gouv.fr: official commune and arrondissement boundaries)
const IDF = /^(75|77|78|91|92|93|94|95)/;
const GEO = 'https://geo.api.gouv.fr/communes';
let suggestT;
$('#communeQ').addEventListener('input', e => {
  clearTimeout(suggestT);
  const q = e.target.value.trim(), ul = $('#communeList');
  if (q.length < 2) { ul.hidden = true; return; }
  suggestT = setTimeout(async () => {
    try {
      const r = await fetch(`${GEO}?nom=${encodeURIComponent(q)}&type=commune-actuelle,arrondissement-municipal&fields=nom,code,codesPostaux,population&boost=population&limit=15`);
      const list = (await r.json()).filter(c => IDF.test(c.code)).slice(0, 7);
      ul.innerHTML = list.map(c => `<li data-code="${c.code}" data-nom="${esc(c.nom)}">${esc(c.nom)}<small>${c.codesPostaux?.[0] || c.code}</small></li>`).join('') || '<li class="muted">Aucune commune d\'Île-de-France</li>';
      ul.hidden = false;
      ul.querySelectorAll('li[data-code]').forEach(li => li.onclick = () => { ul.hidden = true; $('#communeQ').value = li.dataset.nom; openCommune(li.dataset.code); });
    } catch (err) { ul.hidden = true; toast('Recherche de commune indisponible pour le moment.', true); }
  }, 250);
});
async function openCommune(code) {
  if (code === '75056') { toast('Paris est trop grand pour un seul calcul : choisis un arrondissement (ex. « Paris 13e »).', true); return; }
  try {
    const r = await fetch(`${GEO}?code=${code}&type=commune-actuelle,arrondissement-municipal&fields=nom,code,contour`);
    const c = (await r.json())[0];
    if (!c?.contour) throw new Error();
    ls.set('lastCommune', code);
    analyze({ name: c.nom, code, geom: c.contour, bbox: geomBbox(c.contour), key: 'c' + code });
  } catch (e) { toast('Impossible de récupérer les limites de cette commune.', true); }
}
$('#communeHere').onclick = () => locate(async ([lon, lat]) => {
  try {
    const r = await fetch(`${GEO}?lat=${lat}&lon=${lon}&type=commune-actuelle,arrondissement-municipal&fields=nom,code`);
    const list = await r.json();
    const c = list.find(x => x.code.startsWith('751')) || list[0];
    if (!c) throw new Error();
    $('#communeQ').value = c.nom; openCommune(c.code);
  } catch (e) { toast('Commune introuvable pour ta position.', true); }
});
$('#viewHere').onclick = () => {
  if (map.getZoom() < 14) { toast('Zoome un peu plus (quartier) pour analyser la zone affichée.'); return; }
  const b = map.getBounds(), bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  analyze({ name: 'la zone affichée', geom: null, bbox, key: 'v' + bbox.map(x => x.toFixed(3)).join(',') }, false);
};

// ---------------- geolocation / addresses ----------------
function locate(cb) {
  if (!navigator.geolocation) { toast('Géolocalisation non disponible.', true); return; }
  chip('Localisation…', 'busy');
  navigator.geolocation.getCurrentPosition(p => { fogStatus(fogMeta); cb([p.coords.longitude, p.coords.latitude]); },
    () => { fogStatus(fogMeta); toast('Position refusée ou indisponible.', true); }, { enableHighAccuracy: true, timeout: 15000 });
}
async function geocode(q) {
  const c = map.getCenter();
  for (const base of ['https://data.geopf.fr/geocodage/search', 'https://api-adresse.data.gouv.fr/search/']) {
    try {
      const r = await fetch(`${base}?q=${encodeURIComponent(q)}&limit=5&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}`);
      if (r.ok) return (await r.json()).features || [];
    } catch (e) {}
  }
  return [];
}
const pts = { from: null, to: null };
function setPoint(which, lonlat, label) {
  pts[which] = lonlat;
  $(which === 'from' ? '#fromQ' : '#toQ').value = label || `${lonlat[1].toFixed(5)}, ${lonlat[0].toFixed(5)}`;
  drawMarkers();
}
function drawMarkers() {
  markerLayer.clearLayers();
  for (const [k, txt] of [['from', 'A'], ['to', 'B']]) {
    if (!pts[k] || (k === 'to' && mode !== 'ab')) continue;
    L.marker([pts[k][1], pts[k][0]], { icon: L.divIcon({ className: '', html: `<div style="width:26px;height:26px;border-radius:50%;background:${css('--fg')};color:${css('--bg')};display:grid;place-items:center;font:700 13px system-ui;box-shadow:0 2px 6px rgba(0,0,0,.4)">${txt}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(markerLayer);
  }
}
for (const id of ['fromQ', 'toQ']) {
  const inp = $('#' + id), ul = $(`.suggest[data-for="${id}"]`), which = id === 'fromQ' ? 'from' : 'to';
  let t;
  inp.addEventListener('input', () => {
    clearTimeout(t); pts[which] = null;
    const q = inp.value.trim(); if (q.length < 3) { ul.hidden = true; return; }
    t = setTimeout(async () => {
      const f = await geocode(q);
      ul.innerHTML = f.map((x, i) => `<li data-i="${i}">${esc(x.properties.label)}</li>`).join('') || '<li class="muted">Aucune adresse trouvée</li>';
      ul.hidden = false;
      ul.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => { const x = f[+li.dataset.i]; ul.hidden = true; setPoint(which, x.geometry.coordinates, x.properties.label); });
    }, 300);
  });
}
$$('[data-gps]').forEach(b => b.onclick = () => locate(ll => { setPoint(b.dataset.gps, ll, 'Ma position'); map.setView([ll[1], ll[0]], 15); }));
let picking = null;
$$('[data-pick]').forEach(b => b.onclick = () => {
  picking = picking === b.dataset.pick ? null : b.dataset.pick;
  $$('[data-pick]').forEach(x => x.classList.toggle('picking', x.dataset.pick === picking));
  if (picking) { toast('Touche la carte pour placer le point.'); if (matchMedia('(max-width: 819px)').matches) $('#sheet').classList.add('min'); }
});
// tap anywhere on the map: quick stats of the commune there
async function quickStats(f) {
  if (!pcts[f.code] || isStale(f.code)) {
    const ways = await getWays(f.bbox, null);
    const net = buildNetwork(ways, fog, { radius });
    const st = summarize(net, s => { const a = net.nodes.get(s.a), b = net.nodes.get(s.b); return inGeometry((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, f.geom); });
    pcts[f.code] = { p: st.roads.total ? st.roads.done / st.roads.total : 0, t: Date.now(), px: pxIn(f.code), fin: st.finished, n: st.streets, km: st.roads.total };
    idbSet('pcts', pcts);
  }
  return pcts[f.code];
}
async function tapStats(latlng) {
  if (!fog) return;
  let f;
  try { await loadIdf(); if (!touched) touched = computeTouched(); f = idfFeats.find(x => { const [s, w, n, e] = x.bbox; return latlng.lat >= s && latlng.lat <= n && latlng.lng >= w && latlng.lng <= e && inGeometry(latlng.lng, latlng.lat, x.geom); }); }
  catch (e) { return; }
  if (!f) return;
  const pop = L.popup({ maxWidth: 260, className: 'qpop' }).setLatLng(latlng).setContent(`<b>${esc(f.nom)}</b><br><span class="spin"></span> calcul…`).openOn(map);
  try {
    const e = await quickStats(f), lv = levelFromPct(e.p, (touched[f.code] || 0) >= 4);
    pop.setContent(`<b>${esc(f.nom)}</b><div class="qbig">${Math.round(e.p * 100)} %<small> des rues · ${LEVELS[lv]}</small></div>
      ${e.n ? `<div class="qs">${e.fin} rues finies sur ${e.n} · ${km(e.km)} de rues</div>` : ''}
      <div class="qs">calculé le ${fmtDay(e.t)}</div>
      <div class="qa"><button class="btn small" data-q="detail">Détail</button><button class="btn small primary" data-q="route">La cocher</button></div>`);
    const el = pop.getElement();
    el.querySelector('[data-q="detail"]').onclick = () => { map.closePopup(); showTab('commune'); $('#communeQ').value = f.nom; openCommune(f.code); };
    el.querySelector('[data-q="route"]').onclick = async () => { map.closePopup(); $('#communeQ').value = f.nom; await openCommune(f.code); showTab('route'); setMode('com'); };
    if (conquestOn) drawConquest();
  } catch (err) { pop.setContent(`<b>${esc(f.nom)}</b><br>${esc(err.message)}`); }
}
map.on('click', e => {
  if (!picking) { tapStats(e.latlng); return; }
  setPoint(picking, [e.latlng.lng, e.latlng.lat]);
  picking = null; $$('[data-pick]').forEach(x => x.classList.remove('picking'));
  $('#sheet').classList.remove('min');
});

// ---------------- routing ----------------
let mode = 'ab';
const MODES = { ab: '#modeAB', loop: '#modeLoop', com: '#modeCom' };
function setMode(m) {
  mode = m;
  for (const [k, sel] of Object.entries(MODES)) { $(sel).classList.toggle('on', k === m); $(sel).setAttribute('aria-checked', k === m); }
  $('#toField').hidden = m !== 'ab'; $('#loopField').hidden = m !== 'loop'; $('#comField').hidden = m !== 'com';
  if (m === 'com') $('#comName').textContent = current?.geom ? current.name : 'aucune (choisis-la dans l\'onglet Commune)';
  drawMarkers();
}
$('#modeAB').onclick = () => setMode('ab'); $('#modeLoop').onclick = () => setMode('loop'); $('#modeCom').onclick = () => setMode('com');
$('#loopKm').oninput = e => ($('#loopKmV').textContent = e.target.value);
$('#comKm').oninput = e => ($('#comKmV').textContent = e.target.value);
$('#charm').checked = ls.get('charm') !== '0';
$('#charm').onchange = e => ls.set('charm', e.target.checked ? '1' : '0');

// stations (RER, Transilien, métro, tram) from OpenStreetMap, to start or finish at a station
let stations = [];
async function loadStations(bbox, key) {
  const cached = (await getManifest()) ? null : await idbGet('st:' + key);
  if (cached && Date.now() - cached.t < 30 * 864e5) return (stations = cached.list);
  stations = (await localStations(bbox)) || await fetchStations(bbox);
  idbSet('st:' + key, { t: Date.now(), list: stations });
  return stations;
}
$('[data-station="from"]').onclick = async () => {
  const ul = $('.suggest[data-for="fromQ"]');
  const ref = pts.from || (current?.geom ? null : [map.getCenter().lng, map.getCenter().lat]);
  const bbox = current?.geom && !pts.from ? padBbox([[current.bbox[1], current.bbox[0]], [current.bbox[3], current.bbox[2]]], 800) : padBbox([ref], 2500);
  ul.innerHTML = '<li class="muted"><span class="spin"></span> Recherche des gares…</li>'; ul.hidden = false;
  try {
    const list = await loadStations(bbox, bbox.map(x => x.toFixed(2)).join(','));
    const c = ref || [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
    const near = list.map(x => ({ ...x, d: distM(...c, x.lon, x.lat) })).sort((a, b) => a.d - b.d).slice(0, 12);
    ul.innerHTML = near.map((x, i) => `<li data-i="${i}">${esc(x.name)}<small>${esc(x.kind)} · ${km(x.d)}</small></li>`).join('') || '<li class="muted">Aucune gare trouvée ici</li>';
    ul.querySelectorAll('li[data-i]').forEach(li => li.onclick = () => { const x = near[+li.dataset.i]; ul.hidden = true; setPoint('from', [x.lon, x.lat], 'Gare ' + x.name); map.setView([x.lat, x.lon], 15); });
  } catch (e) { ul.innerHTML = `<li class="muted">${esc(e.message)}</li>`; }
};

function padBbox(points, padM) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [lon, lat] of points) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); }
  const dLat = padM / 111320, dLon = padM / (111320 * Math.cos(s * Math.PI / 180));
  return [s - dLat, w - dLon, n + dLat, e + dLon];
}

let routes = [];
$('#go').onclick = async () => {
  const out = $('#routeOut');
  if (!fog) { out.innerHTML = `<div class="empty"><b>Il manque tes traces.</b> Charge-les dans l'onglet Données.</div>`; return; }
  if (mode === 'com' && !current?.geom) { toast("Choisis d'abord une commune dans l'onglet Commune.", true); return; }
  if (!pts.from) { toast('Choisis un départ (adresse, GPS, gare ou carte).', true); return; }
  if (mode === 'ab' && !pts.to) { toast('Choisis une arrivée.', true); return; }
  const target = +$('#loopKm').value * 1000, comBudget = +$('#comKm').value * 1000, toStation = $('#comEnd').value === 'station';
  let bbox;
  if (mode === 'loop') bbox = padBbox([pts.from], target / 2.6);
  else if (mode === 'com') {
    const [s, w, n, e] = current.bbox;
    bbox = padBbox([[w, s], [e, n], pts.from], 500);
    if (distM(bbox[1], bbox[0], bbox[3], bbox[2]) > 22000) { toast('Départ trop loin de la commune : choisis un départ dedans ou à côté.', true); return; }
  } else {
    const d = distM(...pts.from, ...pts.to);
    if (d > 15000) { toast('A et B sont à plus de 15 km : découpe le trajet en étapes.', true); return; }
    bbox = padBbox([pts.from, pts.to], Math.max(500, d * 0.18));
  }
  $('#go').disabled = true; out.innerHTML = `<p class="muted"><span class="spin"></span> Chargement des rues et calcul…</p>`;
  try {
    const say = m => { const p = $('#routeOut p.muted'); if (p) p.innerHTML = '<span class="spin"></span> ' + esc(m); };
    const ways = await getWays(bbox, null, (d, t) => say(progTxt('Téléchargement des rues', d, t)));
    say('Croisement avec tes traces…'); await new Promise(r => setTimeout(r, 0));
    const net = buildNetwork(ways, fog, { radius });
    say('Calcul des itinéraires…'); await new Promise(r => setTimeout(r, 0));
    const g = new Graph(net, { charm: $('#charm').checked });
    const a = g.nearest(...pts.from);
    if (a.dist > 300) throw new Error('Aucune rue piétonne près du départ.');
    if (mode === 'loop') routes = routesLoop(g, a.node, target);
    else if (mode === 'com') {
      const geom = current.geom;
      const inA = net.segs.map(s => { const p = net.nodes.get(s.a), q = net.nodes.get(s.b); return inGeometry((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, geom); });
      let ends = [a.node], endNames = new Map();
      if (toStation) {
        const st = await loadStations(bbox, bbox.map(x => x.toFixed(2)).join(','));
        ends = [];
        for (const x of st) { const nn = g.nearest(x.lon, x.lat); if (nn.dist < 250) { ends.push(nn.node); endNames.set(nn.node, x.name); } }
        if (!ends.length) throw new Error('Aucune gare trouvée autour de cette commune. Choisis « Retour au départ ».');
      }
      routes = [];
      for (const [f, label] of [[0.6, 'Sortie courte'], [1, 'Sortie complète']]) {
        const r = routeCommune(g, a.node, { budget: comBudget * f, inArea: si => inA[si], ends });
        if (r && r.freshIn >= 100 && !routes.some(o => Math.abs(o.len - r.len) < 100)) routes.push({ ...r, label, note: `+${km(r.freshIn)} dans ${current.name}${endNames.has(r.end) ? ' · arrivée gare ' + endNames.get(r.end) : ''}` });
      }
      if (!routes.length) throw new Error(`Aucune rue nouvelle de ${current.name} n'est atteignable avec ${km(comBudget)} depuis ce départ. Augmente la longueur max ou pars d'une gare plus proche.`);
    } else {
      const b = g.nearest(...pts.to);
      if (b.dist > 300) throw new Error("Aucune rue piétonne près de l'arrivée.");
      routes = routesAB(g, a.node, b.node) || [];
    }
    if (!routes.length) throw new Error('Pas d\'itinéraire trouvé. Essaie une autre distance ou un autre départ.');
    // route tab shows only routes; the commune view keeps its own layers
    const base = routes[0].len;
    out.innerHTML = routes.map((r, i) => `
      <div class="card" data-i="${i}">
        <div class="t"><span>${r.label}</span><span>+${km(r.fresh)} nouveaux</span></div>
        <div class="kv"><span>${km(r.len)} · ~${Math.round(r.len / 1000 / 4.5 * 60)} min</span><span>${pct(r.fresh, r.len)} % de rues nouvelles${mode === 'ab' && i ? ' · détour +' + pct(r.len - base, base) + ' %' : ''}</span></div>
        ${r.note ? `<div class="kv"><span>${esc(r.note)}</span></div>` : ''}
        <div class="acts"><button class="btn small primary" data-kml="${i}">Tracé KML</button><button class="btn small" data-gpx="${i}">GPX</button><a class="btn small ghost" data-gm="${i}" target="_blank" rel="noopener noreferrer">Itinéraire Google</a></div>
      </div>`).join('') + `<p class="muted small">KML / GPX : le tracé exact. Sur Android, Google Maps ne sait pas ouvrir ces fichiers : installe Organic Maps (gratuit, sans compte) ou OsmAnd, puis choisis-le « Toujours » à l'ouverture. Sur ordinateur : Google My Maps ou Google Earth. « Itinéraire Google » lance la navigation, mais Google recalcule entre 8 points de passage : le tracé peut différer.</p>`;
    $$('#routeOut .card').forEach(c => c.onclick = e => { if (!e.target.closest('.acts')) selectRoute(+c.dataset.i); });
    $$('[data-gpx]').forEach(b => b.onclick = () => saveGPX(routes[+b.dataset.gpx]));
    $$('[data-kml]').forEach(b => b.onclick = () => saveKML(routes[+b.dataset.kml]));
    $$('[data-gm]').forEach(a => (a.href = gmapsUrl(routes[+a.dataset.gm])));
    selectRoute(routes.length > 1 ? 1 : 0);
  } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  $('#go').disabled = false;
};
// All variants on the map. The selected one is coloured piece by piece:
// orange = streets you've never walked, blue = already done. Others: thin, tap their label to pick.
function selectRoute(i) {
  routeLayer.clearLayers();
  const ll = c => [c[1], c[0]];
  routes.forEach((r, j) => {
    if (j === i) return;
    L.polyline(r.coords.map(ll), { color: '#fff', weight: 6, opacity: .8, interactive: false }).addTo(routeLayer);
    L.polyline(r.coords.map(ll), { color: css('--muted'), weight: 3.5, opacity: .9, dashArray: '2 7', lineCap: 'round', interactive: false }).addTo(routeLayer);
  });
  const r = routes[i], cNew = css('--new'), cDone = css('--done');
  const casing = L.polyline(r.coords.map(ll), { color: '#fff', weight: 10, opacity: .95, interactive: false }).addTo(routeLayer);
  let run = [ll(r.coords[0])], state = r.isNew[0];
  const flush = () => run.length > 1 && L.polyline(run, { color: state ? cNew : cDone, weight: 6, opacity: 1, lineCap: 'round', interactive: false }).addTo(routeLayer);
  for (let k = 0; k < r.isNew.length; k++) {
    if (r.isNew[k] !== state) { flush(); run = [run[run.length - 1]]; state = r.isNew[k]; }
    run.push(ll(r.coords[k + 1]));
  }
  flush();
  // labels to switch variant from the map
  routes.forEach((x, j) => {
    const at = x.coords[Math.floor(x.coords.length * (0.35 + 0.15 * j))] || x.coords[0];
    L.marker(ll(at), { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="rlab${j === i ? ' on' : ''}">${esc(x.label)} · ${km(x.len)}</span>` }) })
      .on('click', () => selectRoute(j)).addTo(routeLayer);
  });
  setLegend('route', `<span><i class="sw new" style="border-top-width:5px"></i>nouveau</span><span><i class="sw done" style="border-top-width:5px"></i>déjà fait</span>${routes.length > 1 ? `<span><i class="sw" style="border-color:${css('--muted')};border-top-style:dotted"></i>autres variantes</span>` : ''}`);
  fit(L.latLngBounds(routes.flatMap(x => x.coords.map(ll))));
  $$('#routeOut .card').forEach(c => c.classList.toggle('sel', +c.dataset.i === i));
}
// share sheet first (Android offers Google Maps / Earth directly), plain download otherwise
async function handOff(text, type, filename) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], filename, { type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const fileName = (r, ext) => `fog-explorer-${r.label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, '-')}-${(r.len / 1000).toFixed(1).replace('.', ',')}km.${ext}`;
function saveKML(r) { handOff(toKML(r.coords, `Fog Explorer · ${r.label} · ${km(r.len)}`), 'application/vnd.google-earth.kml+xml', fileName(r, 'kml')); }
function saveGPX(r) {
  handOff(toGPX(r.coords, 'Fog Explorer – ' + r.label), 'application/gpx+xml', fileName(r, 'gpx'));
}
function gmapsUrl(r) {
  const c = r.coords, f = p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`, n = 8, wps = [];
  for (let k = 1; k <= n; k++) wps.push(f(c[Math.floor(k * (c.length - 1) / (n + 1))]));
  return `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${f(c[0])}&destination=${f(c[c.length - 1])}&waypoints=${encodeURIComponent(wps.join('|'))}`;
}

// ---------------- data: file + Dropbox ----------------
let fogMeta = null;
$('#fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  chip('Lecture du snapshot…', 'busy');
  try {
    const fg = await fogFromSnapshot(await f.arrayBuffer());
    fogMeta = { source: f.name, date: f.lastModified };
    await setFog(fg, fogMeta);
    toast('Traces chargées.');
  } catch (err) { toast(err.message, true); fogStatus(fogMeta); }
  e.target.value = '';
};

$('#redir').textContent = dbx.redirectUri();
$('#dbxKey').value = dbx.appKey(); $('#dbxFolder').value = dbx.folder();
$('#dbxAuto').checked = ls.get('dbx_auto') !== '0';
$('#dbxKey').onchange = e => dbx.setAppKey(e.target.value);
$('#dbxFolder').onchange = e => dbx.setFolder(e.target.value);
$('#dbxAuto').onchange = e => ls.set('dbx_auto', e.target.checked ? '1' : '0');
function dbxUi() {
  const on = dbx.isConnected();
  if (on && ls.get('dbxLast')) $('#dbxStatus').innerHTML = ls.get('dbxLast'); else $('#dbxStatus').textContent = on ? 'Connecté à Dropbox (lecture seule).' : 'Non connecté.';
  $('#dbxConnect').hidden = on; $('#dbxSync').hidden = !on; $('#dbxOff').hidden = !on;
}
$('#dbxConnect').onclick = async () => { dbx.setAppKey($('#dbxKey').value); try { await dbx.connect(); } catch (e) { toast(e.message, true); } };
$('#dbxOff').onclick = async () => { await dbx.disconnect(); dbxUi(); toast('Dropbox déconnecté.'); };
$('#dbxSync').onclick = () => syncDropbox();
async function syncDropbox() {
  chip('Synchro Dropbox…', 'busy');
  try {
    const cache = (await idbGet('dbxCache')) || {};
    const r = await dbx.sync(cache, msg => chip(msg, 'busy'));
    $('#dbxFolder').value = dbx.folder();
    if (r.unchanged && fog) { fogStatus(fogMeta); }
    else {
      if (r.unchanged) { await idbSet('dbxCache', {}); return syncDropbox(); } // no local traces anymore: fetch again
      await idbSet('dbxCache', r.cache);
      fogMeta = { source: 'Dropbox, ' + r.source, date: r.date };
      await setFog(r.fog, fogMeta);
    }
    const when = new Date(r.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
    $('#dbxStatus').innerHTML = r.kind === 'sync'
      ? `Connecté · <b>synchro automatique active</b> : je lis les fichiers de synchro de Fog of World (dernière modification ${when}).<br><small>Dossiers vus : ${(r.dirs || []).map(esc).join(' · ')}</small>`
      : `Connecté · <b>synchro automatique pas encore active</b> : je n'ai trouvé que des snapshots manuels dans « ${esc(r.folder)} » (dernier : ${when}). Active la synchro Dropbox dans Fog of World (onglet nuage) pour que tout se mette à jour seul.<br><small>Dossiers vus : ${(r.dirs || []).map(esc).join(' · ')}</small>`;
    ls.set('dbxLast', $('#dbxStatus').innerHTML);
    if (!r.unchanged) toast(r.kind === 'sync' ? 'Nouvelles traces reçues (synchro auto Dropbox).' : 'Traces chargées depuis le dernier snapshot Dropbox.');
  } catch (e) { toast(e.message, true); fogStatus(fogMeta); dbxUi(); }
}

$('#fogSel').value = fogStyle;
$('#fogSel').onchange = e => { fogStyle = e.target.value; ls.set('fogStyle2', fogStyle); fogLayer.redraw(); };
$('#baseSel').value = BASES[ls.get('base')] ? ls.get('base') : 'epure';
$('#baseSel').onchange = e => { ls.set('base', e.target.value); setBase(); };
async function dataUi() {
  const m = await getManifest(), el = $('#dataInfo'), btn = $('#dlAll');
  if (!m) { el.textContent = "Rues téléchargées à la demande depuis OpenStreetMap (les données hors ligne de toute l'Île-de-France ne sont pas encore publiées)."; btn.hidden = true; return; }
  const all = ls.get('allDownloaded') === m.date;
  el.textContent = `Rues OpenStreetMap du ${new Date(m.date).toLocaleDateString('fr-FR')} · ${m.ways.toLocaleString('fr-FR')} voies · ${(m.bytes / 1e6).toFixed(0)} Mo pour toute l'Île-de-France.` + (all ? ' Tout est sur ce téléphone ✓' : ' Les zones regardées sont gardées sur le téléphone.');
  btn.hidden = all; btn.textContent = `Tout télécharger maintenant (${(m.bytes / 1e6).toFixed(0)} Mo, une seule fois)`;
}
$('#dlAll').onclick = async () => {
  const btn = $('#dlAll'); btn.disabled = true;
  try { await downloadAll((d, t, b, tb) => (btn.textContent = `Téléchargement… ${Math.round(100 * b / tb)} % (${(b / 1e6).toFixed(0)}/${(tb / 1e6).toFixed(0)} Mo)`)); toast("Toutes les rues d'Île-de-France sont sur ton téléphone."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; dataUi();
};
dataUi();
$('#prefetch').onclick = () => locate(async ll => {
  const btn = $('#prefetch'), bbox = padBbox([ll], 5000);
  btn.disabled = true;
  try {
    await getWays(bbox, null, (d, t) => (btn.textContent = `Téléchargement… ${d}/${t} zones`));
    btn.textContent = 'Rues à 5 km autour de toi prêtes ✓';
  } catch (e) { btn.textContent = 'Réessayer le préchargement'; toast(e.message, true); }
  btn.disabled = false;
});
$('#tol').value = radius; $('#tolV').textContent = Math.round(radius * 6);
$('#tol').oninput = e => { radius = +e.target.value; $('#tolV').textContent = Math.round(radius * 6); };
$('#tol').onchange = () => { ls.set('tol', radius); if (current) analyze(current, false); };

$('#wipe').onclick = () => ($('#wipeConfirm').hidden = false);
$('#wipeNo').onclick = () => ($('#wipeConfirm').hidden = true);
$('#wipeYes').onclick = async () => {
  if (dbx.isConnected()) await dbx.disconnect();
  await wipeAll();
  fog = null; fogMeta = null; current = null; routes = []; pcts = {}; touched = null; idfFeats = null; hideConquest();
  [streetsLayer, outlineLayer, routeLayer, markerLayer, hlLayer].forEach(l => l.clearLayers());
  fogLayer.redraw(); $('#communeOut').innerHTML = ''; $('#routeOut').innerHTML = ''; for (const k in legendFor) delete legendFor[k]; $('#legend').hidden = true;
  $('#wipeConfirm').hidden = true; $('#dbxKey').value = ''; dbxUi(); fogStatus(null);
  toast('Toutes tes données ont été effacées de cet appareil.');
};

function redrawAll() { fogLayer.redraw(); if (current) analyze(current, false); }

// ---------------- startup ----------------
(async () => {
  dbxUi();
  try {
    if (await dbx.handleRedirect()) { dbxUi(); toast('Dropbox connecté.'); showTab('data'); await syncDropbox(); }
  } catch (e) { toast(e.message, true); }
  const saved = await idbGet('fog');
  if (saved?.keys && !fog) { fog = FogMap.deserialize(saved); fogMeta = saved.meta; fogLayer.redraw(); }
  fogStatus(fogMeta);
  if (dbx.isConnected() && ls.get('dbx_auto') !== '0' && !new URLSearchParams(location.search).has('nosync')) syncDropbox();
  if (!fog) {
    showTab('data');
    $('#communeOut').innerHTML = `<div class="empty"><b>Commence par tes traces.</b> Dans Fog of World : Réglages → Snapshot → Take Snapshot, puis charge le fichier .fwss dans l'onglet Données. Ou connecte Dropbox pour que ce soit automatique.</div>`;
  } else {
    const last = ls.get('lastCommune');
    if (last) openCommune(last);
    else $('#communeOut').innerHTML = `<div class="empty">Cherche une commune pour voir tes rues manquantes, ou touche <b>Ici</b>.</div>`;
  }
})();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  // a new version took over: reload once so the screen shows it
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; location.reload(); } });
}
