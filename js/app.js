import { FogMap, fogFromSnapshot, WORLD } from './fog.js';
import { fetchWays, buildNetwork, summarize, inGeometry, geomBbox, distM } from './streets.js';
import { Graph, routesAB, routesLoop, toGPX } from './route.js';
import { idbGet, idbSet, wipeAll, ls } from './store.js';
import * as dbx from './dropbox.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const km = m => (m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let fog = null;
let radius = +(ls.get('tol') || 2);

// ---------------- map ----------------
const light = matchMedia('(prefers-color-scheme: light)');
const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([48.8566, 2.3522], 12);
L.control.zoom({ position: 'topright' }).addTo(map);
let base;
function setBase() {
  if (base) base.remove();
  base = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${light.matches ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`, {
    maxZoom: 19, subdomains: 'abcd', referrerPolicy: 'no-referrer',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
  }).addTo(map);
  base.bringToBack();
}
setBase(); light.addEventListener?.('change', () => { setBase(); redrawAll(); });

// Explored pixels layer (drawn from the decoded bitmaps, in this browser)
const FogLayer = L.GridLayer.extend({
  createTile(c) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    if (!fog) return cv;
    const ctx = cv.getContext('2d');
    const scale = Math.pow(2, c.z - 14);              // screen px per fog px
    const fx0 = c.x * 256 / scale, fy0 = c.y * 256 / scale, fsz = 256 / scale;
    const bx0 = Math.floor(fx0 / 64), by0 = Math.floor(fy0 / 64), bx1 = Math.floor((fx0 + fsz - 1) / 64), by1 = Math.floor((fy0 + fsz - 1) / 64);
    ctx.fillStyle = css('--done'); ctx.globalAlpha = 0.28;
    const draw = (key, b) => {
      const gbx = Math.floor(key / 65536), gby = key % 65536;
      for (let y = 0; y < 64; y++) for (let xb = 0; xb < 8; xb++) {
        const v = b[y * 8 + xb]; if (!v) continue;
        for (let bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) {
          const sx = ((gbx * 64 + xb * 8 + bit) - fx0) * scale, sy = ((gby * 64 + y) - fy0) * scale;
          const s = Math.max(1, scale);
          ctx.fillRect(Math.floor(sx), Math.floor(sy), Math.ceil(s), Math.ceil(s));
        }
      }
    };
    const n = (bx1 - bx0 + 1) * (by1 - by0 + 1);
    if (n <= fog.size) {
      for (let bx = bx0; bx <= bx1; bx++) for (let by = by0; by <= by1; by++) { const k = bx * 65536 + by, b = fog.blocks.get(k); if (b) draw(k, b); }
    } else {
      for (const [k, b] of fog.blocks) { const bx = Math.floor(k / 65536), by = k % 65536; if (bx >= bx0 && bx <= bx1 && by >= by0 && by <= by1) draw(k, b); }
    }
    return cv;
  },
});
const fogLayer = new FogLayer({ maxZoom: 19, zIndex: 300 }).addTo(map);
const streetsLayer = L.layerGroup().addTo(map);
const outlineLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const hlLayer = L.layerGroup().addTo(map);

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
  fog = f; fogLayer.redraw(); fogStatus(meta);
  await idbSet('fog', { ...f.serialize(), meta });
  if (current) analyze(current, false);
}

// tabs + sheet
$$('.tabs button').forEach(b => b.onclick = () => {
  $$('.tabs button').forEach(x => x.setAttribute('aria-selected', x === b));
  $$('.pane').forEach(p => (p.hidden = p.dataset.pane !== b.dataset.tab));
  $('#sheet').classList.remove('min');
});
$('#grip').onclick = () => $('#sheet').classList.toggle('min');
const showTab = t => $(`.tabs button[data-tab="${t}"]`).click();

// ---------------- streets / commune analysis ----------------
let current = null;          // { name, geom?, bbox, ways }
const waysCache = new Map(); // bbox key -> ways (memory)
let netCurrent = null;

async function getWays(bbox, key) {
  if (waysCache.has(key)) return waysCache.get(key);
  const stored = await idbGet('ways:' + key);
  if (stored && Date.now() - stored.t < 14 * 864e5) { waysCache.set(key, stored.ways); return stored.ways; }
  const ways = await fetchWays(bbox);
  // keep only what we need to reduce storage
  const slim = ways.map(w => ({ id: w.id, nodes: w.nodes, geometry: w.geometry.map(g => g && { lon: g.lon, lat: g.lat }), tags: { highway: w.tags?.highway, name: w.tags?.name } }));
  waysCache.set(key, slim); idbSet('ways:' + key, { t: Date.now(), ways: slim });
  return slim;
}

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
  $('#legend').hidden = false;
}

async function analyze(area, fit = true) {
  current = area;
  const out = $('#communeOut');
  if (!fog) { out.innerHTML = `<div class="empty"><b>Il manque tes traces.</b> Va dans l'onglet Données pour charger ton snapshot ou connecter Dropbox.</div>`; }
  outlineLayer.clearLayers(); hlLayer.clearLayers();
  if (area.geom) {
    const gj = L.geoJSON(area.geom, { style: { color: css('--fg'), weight: 2, opacity: .7, fill: false, dashArray: '6 4' }, interactive: false }).addTo(outlineLayer);
    if (fit) map.fitBounds(gj.getBounds(), { padding: [20, 20] });
  }
  if (!fog) return;
  out.innerHTML = `<p class="muted"><span class="spin"></span> Chargement des rues de ${esc(area.name)}…</p>`;
  chip('Chargement des rues…', 'busy');
  try {
    const ways = await getWays(area.bbox, area.key);
    const net = buildNetwork(ways, fog, { radius });
    const midIn = s => { const a = net.nodes.get(s.a), b = net.nodes.get(s.b); return inGeometry((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, area.geom); };
    const filter = area.geom ? midIn : null;
    netCurrent = { net, filter };
    drawStreets(net, filter);
    renderStats(area, summarize(net, filter || (() => true)));
  } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  fogStatus(fogMeta);
}

function renderStats(area, st) {
  const r = st.roads, p = st.paths;
  const todo = [...st.byName.values()].map(e => ({ ...e, left: e.total - e.done })).filter(e => e.left > 30).sort((a, b) => b.left - a.left);
  const virgin = todo.filter(e => e.done < 1).length;
  $('#communeOut').innerHTML = `
    <div class="stat">
      <div class="big">${pct(r.done, r.total)} %<small>des rues de ${esc(area.name)}</small></div>
      <div class="bar"><i style="width:${pct(r.done, r.total)}%"></i></div>
      <div class="kv"><span>${km(r.done)} faits sur ${km(r.total)}</span><span>reste ${km(r.total - r.done)}</span></div>
      <div class="kv"><span>Chemins et allées : ${pct(p.done, p.total)} %</span><span>${virgin} rues jamais foulées</span></div>
    </div>
    <h3>Rues à finir</h3>
    <ul class="list" id="todo">${todo.slice(0, 60).map((e, i) => `
      <li data-i="${i}"><span class="n">${esc(e.name)}</span><span class="v">${km(e.left)}</span>
      <span class="s">${e.done < 1 ? 'jamais parcourue' : pct(e.done, e.total) + ' % faite'} · ${km(e.total)} au total</span></li>`).join('')}</ul>`;
  $$('#todo li').forEach(li => li.onclick = () => {
    const e = todo[+li.dataset.i]; hlLayer.clearLayers();
    const lines = e.segs.map(s => { const a = netCurrent.net.nodes.get(s.a), b = netCurrent.net.nodes.get(s.b); return [[a[1], a[0]], [b[1], b[0]]]; });
    const pl = L.polyline(lines, { color: css('--fg'), weight: 7, opacity: .35, interactive: false }).addTo(hlLayer);
    map.fitBounds(pl.getBounds(), { padding: [60, 60], maxZoom: 17 });
    if (matchMedia('(max-width: 819px)').matches) $('#sheet').classList.add('min');
  });
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
    analyze({ name: c.nom, geom: c.contour, bbox: geomBbox(c.contour), key: 'c' + code });
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
    if (!pts[k] || (k === 'to' && loopMode)) continue;
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
map.on('click', e => {
  if (!picking) return;
  setPoint(picking, [e.latlng.lng, e.latlng.lat]);
  picking = null; $$('[data-pick]').forEach(x => x.classList.remove('picking'));
  $('#sheet').classList.remove('min');
});

// ---------------- routing ----------------
let loopMode = false;
function setMode(loop) {
  loopMode = loop;
  $('#modeAB').classList.toggle('on', !loop); $('#modeLoop').classList.toggle('on', loop);
  $('#modeAB').setAttribute('aria-checked', !loop); $('#modeLoop').setAttribute('aria-checked', loop);
  $('#toField').hidden = loop; $('#loopField').hidden = !loop; drawMarkers();
}
$('#modeAB').onclick = () => setMode(false); $('#modeLoop').onclick = () => setMode(true);
$('#loopKm').oninput = e => ($('#loopKmV').textContent = e.target.value);

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
  if (!pts.from) { toast('Choisis un départ (adresse, GPS ou carte).', true); return; }
  if (!loopMode && !pts.to) { toast('Choisis une arrivée.', true); return; }
  const target = +$('#loopKm').value * 1000;
  let bbox;
  if (loopMode) bbox = padBbox([pts.from], target / 2.6);
  else {
    const d = distM(...pts.from, ...pts.to);
    if (d > 15000) { toast('A et B sont à plus de 15 km : découpe le trajet en étapes.', true); return; }
    bbox = padBbox([pts.from, pts.to], Math.max(600, d * 0.3));
  }
  $('#go').disabled = true; out.innerHTML = `<p class="muted"><span class="spin"></span> Chargement des rues et calcul…</p>`;
  try {
    const ways = await getWays(bbox, 'r' + bbox.map(x => x.toFixed(3)).join(','));
    const net = buildNetwork(ways, fog, { radius });
    const g = new Graph(net);
    const a = g.nearest(...pts.from);
    if (a.dist > 300) throw new Error('Aucune rue piétonne près du départ.');
    if (loopMode) routes = routesLoop(g, a.node, target);
    else {
      const b = g.nearest(...pts.to);
      if (b.dist > 300) throw new Error("Aucune rue piétonne près de l'arrivée.");
      routes = routesAB(g, a.node, b.node) || [];
    }
    if (!routes.length) throw new Error('Pas d\'itinéraire trouvé. Essaie une autre distance ou un autre départ.');
    drawStreets(net); outlineLayer.clearLayers(); hlLayer.clearLayers();
    const base = routes[0].len;
    out.innerHTML = routes.map((r, i) => `
      <div class="card" data-i="${i}">
        <div class="t"><span>${r.label}</span><span>+${km(r.fresh)} nouveaux</span></div>
        <div class="kv"><span>${km(r.len)} · ~${Math.round(r.len / 1000 / 4.5 * 60)} min</span><span>${pct(r.fresh, r.len)} % de rues nouvelles${!loopMode && i ? ' · détour +' + pct(r.len - base, base) + ' %' : ''}</span></div>
        <div class="acts"><button class="btn small" data-gpx="${i}">GPX</button><a class="btn small ghost" data-gm="${i}" target="_blank" rel="noopener noreferrer">Google Maps</a></div>
      </div>`).join('') + `<p class="muted small">GPX : à ouvrir dans OsmAnd, Organic Maps ou Komoot pour suivre exactement le tracé. Google Maps recalcule entre quelques points de passage, le tracé peut un peu différer.</p>`;
    $$('#routeOut .card').forEach(c => c.onclick = e => { if (!e.target.closest('.acts')) selectRoute(+c.dataset.i); });
    $$('[data-gpx]').forEach(b => b.onclick = () => saveGPX(routes[+b.dataset.gpx]));
    $$('[data-gm]').forEach(a => (a.href = gmapsUrl(routes[+a.dataset.gm])));
    selectRoute(routes.length > 1 ? 1 : 0);
  } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  $('#go').disabled = false;
};
function selectRoute(i) {
  routeLayer.clearLayers();
  routes.forEach((r, j) => {
    if (j === i) return;
    L.polyline(r.coords.map(([x, y]) => [y, x]), { color: css('--fg'), weight: 3, opacity: .25, interactive: false }).addTo(routeLayer);
  });
  const sel = L.polyline(routes[i].coords.map(([x, y]) => [y, x]), { color: css('--fg'), weight: 5, opacity: .9, interactive: false }).addTo(routeLayer);
  map.fitBounds(sel.getBounds(), { padding: [30, 30] });
  $$('#routeOut .card').forEach(c => c.classList.toggle('sel', +c.dataset.i === i));
}
function saveGPX(r) {
  const blob = new Blob([toGPX(r.coords, 'Fog Explorer – ' + r.label)], { type: 'application/gpx+xml' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `fog-explorer-${r.label.toLowerCase().replace(/\W+/g, '-')}.gpx`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
  $('#dbxStatus').textContent = on ? 'Connecté à Dropbox (lecture seule).' : 'Non connecté.';
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
    await idbSet('dbxCache', r.cache);
    fogMeta = { source: 'Dropbox, ' + r.source, date: r.date };
    await setFog(r.fog, fogMeta);
    toast('Traces à jour depuis Dropbox.');
  } catch (e) { toast(e.message, true); fogStatus(fogMeta); dbxUi(); }
}

$('#tol').value = radius; $('#tolV').textContent = Math.round(radius * 6);
$('#tol').oninput = e => { radius = +e.target.value; $('#tolV').textContent = Math.round(radius * 6); };
$('#tol').onchange = () => { ls.set('tol', radius); if (current) analyze(current, false); };

$('#wipe').onclick = () => ($('#wipeConfirm').hidden = false);
$('#wipeNo').onclick = () => ($('#wipeConfirm').hidden = true);
$('#wipeYes').onclick = async () => {
  if (dbx.isConnected()) await dbx.disconnect();
  await wipeAll();
  fog = null; fogMeta = null; current = null; routes = [];
  [streetsLayer, outlineLayer, routeLayer, markerLayer, hlLayer].forEach(l => l.clearLayers());
  fogLayer.redraw(); $('#communeOut').innerHTML = ''; $('#routeOut').innerHTML = ''; $('#legend').hidden = true;
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

if ('serviceWorker' in navigator) { /* no service worker on purpose: nothing cached outside this page's own storage */ }
