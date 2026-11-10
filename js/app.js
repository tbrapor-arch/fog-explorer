import { FogMap, fogFromSnapshot } from './fog.js';
import { inGeometry, distM, km } from './streets.js';
import { toGPX, toKML } from './route.js';
import { idbGet, idbSet, wipeAll, ls } from './store.js';
import * as dbx from './dropbox.js';
import * as data from './data.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const phone = () => matchMedia('(max-width: 819px)').matches;
const tick = () => new Promise(r => setTimeout(r, 0));

let fog = null, fogMeta = null;
let radius = +(ls.get('tol') || 2);

// ---------------- worker: all the heavy computing happens there, the map stays fluid ----------------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let rid = 0; const pending = new Map();
worker.onmessage = e => {
  const { id, ok, err, prog } = e.data, p = pending.get(id);
  if (!p) return;
  if (prog) { p.onProg?.(...prog); return; }
  pending.delete(id);
  if (err !== undefined) p.rej(new Error(err)); else p.res(ok);
};
worker.onerror = () => { for (const p of pending.values()) p.rej(new Error("Le calcul n'a pas pu démarrer. Recharge la page.")); pending.clear(); };
const rpc = (fn, arg, onProg) => new Promise((res, rej) => { const id = ++rid; pending.set(id, { res, rej, onProg }); worker.postMessage({ id, fn, arg }); });
rpc('init', { base: document.baseURI });

// ---------------- map ----------------
const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true, zoomSnap: 0.25, zoomDelta: 0.5 }).setView([48.8566, 2.3522], 12);
if (matchMedia('(pointer: fine)').matches) L.control.zoom({ position: 'bottomright' }).addTo(map);
window.__map = map; // handy for debugging from the console
let base, baseLabels;
const BASES = {
  epure: () => ({ url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', subdomains: '', native: 16,
    labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', plain: true,
    attribution: 'Fond &copy; Esri, HERE, Garmin, &copy; contributeurs <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
  osmfr: () => ({ url: 'https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', subdomains: 'abc',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · OSM France' }),
  osm: () => ({ url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: '',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }),
};
function setBase() {
  if (base) base.remove(); if (baseLabels) baseLabels.remove(); baseLabels = null;
  const b = (BASES[ls.get('base')] || BASES.epure)();
  base = L.tileLayer(b.url, { maxZoom: 19, maxNativeZoom: b.native || 19, subdomains: b.subdomains, referrerPolicy: 'strict-origin', attribution: b.attribution, className: b.plain ? 'paper' : 'basemap' }).addTo(map);
  base.bringToBack();
  if (b.labels) {
    if (!map.getPane('labels')) { map.createPane('labels').style.zIndex = 450; map.getPane('labels').style.pointerEvents = 'none'; }
    baseLabels = L.tileLayer(b.labels, { pane: 'labels', maxZoom: 19, maxNativeZoom: b.native || 19, referrerPolicy: 'strict-origin', className: 'paper' }).addTo(map);
  }
}
setBase();

// Explored pixels drawn from the decoded bitmaps, in this browser.
// "brume": a veil over everything, cleared where you've walked (like Fog of World);
// "traits": your traces drawn as coloured lines.
// Pixels are painted by horizontal runs, and when zoomed out several rows are merged into one,
// so a tile costs a few hundred rectangles instead of tens of thousands.
let fogStyle = ls.get('fogStyle2') || 'traits';
function paintFog(c, src, color) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  if (!src) return cv;
  const ctx = cv.getContext('2d');
  const scale = Math.pow(2, c.z - 14);              // screen px per fog px
  const brume = !color && fogStyle === 'brume';
  const dot = brume ? Math.max(scale * 1.6, 3.5) : Math.max(scale * 1.2, 2.6); // keep thin trails readable when zoomed out
  const off = (dot - scale) / 2, rs = scale >= 1 ? 1 : Math.min(64, Math.floor(1 / scale)), bw = 64 * scale;
  const fx0 = c.x * 256 / scale, fy0 = c.y * 256 / scale, fsz = 256 / scale, m = Math.ceil(dot / scale);
  const bx0 = Math.floor((fx0 - m) / 64), by0 = Math.floor((fy0 - m) / 64), bx1 = Math.floor((fx0 + fsz + m) / 64), by1 = Math.floor((fy0 + fsz + m) / 64);
  if (brume) {
    ctx.fillStyle = 'rgba(86, 100, 104, 0.32)'; ctx.fillRect(0, 0, 256, 256);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = '#000';
  } else ctx.fillStyle = color || '#3c8a68';
  const h = (rs - 1) * scale + dot;
  const draw = (key, b) => {
    const ox = (Math.floor(key / 65536) * 64 - fx0) * scale - off, oy = ((key % 65536) * 64 - fy0) * scale - off;
    if (ox > 256 || oy > 256 || ox + bw + dot < 0 || oy + bw + dot < 0) return;
    for (let y = 0; y < 64; y += rs) {
      const sy = oy + y * scale;
      if (sy > 256 || sy + h < 0) continue;
      let start = -1;
      for (let xb = 0; xb < 8; xb++) {
        let v = b[y * 8 + xb];
        for (let i = 1; i < rs; i++) v |= b[(y + i) * 8 + xb];
        if (v === 255) { if (start < 0) start = xb * 8; continue; }
        if (!v) { if (start >= 0) { ctx.fillRect(ox + start * scale, sy, (xb * 8 - start - 1) * scale + dot, h); start = -1; } continue; }
        for (let bit = 0; bit < 8; bit++) {
          const x = xb * 8 + bit;
          if (v & (0x80 >> bit)) { if (start < 0) start = x; }
          else if (start >= 0) { ctx.fillRect(ox + start * scale, sy, (x - start - 1) * scale + dot, h); start = -1; }
        }
      }
      if (start >= 0) ctx.fillRect(ox + start * scale, sy, (63 - start) * scale + dot, h);
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
const fogLayer = new FogLayer({ maxZoom: 19, zIndex: 300, opacity: fogStyle === 'brume' ? 1 : 0.7 }).addTo(map);
const streetsLayer = L.layerGroup().addTo(map);
const outlineLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
const hlLayer = L.layerGroup().addTo(map);

// ---------------- sheet: three heights on a phone, dragged by its head ----------------
const sheetEl = $('#sheet'), headEl = $('#head');
const navH = () => $('.nav').offsetHeight;
const SNAP = {
  peek: () => headEl.offsetHeight + 1,
  half: () => Math.round(innerHeight * 0.44),
  full: () => Math.max(Math.round(innerHeight * 0.5), innerHeight - navH() - 70),
};
let sheetAt = 'half';
function setSheet(at) { sheetAt = at; sheetEl.style.setProperty('--sheet-h', SNAP[at]() + 'px'); }
const sheetPeek = () => { if (phone()) setSheet('peek'); };
const sheetOpen = () => { if (sheetAt === 'peek') setSheet('half'); };
{
  let d = null;
  headEl.addEventListener('pointerdown', e => {
    if (!phone()) return;
    d = { y: e.clientY, h: sheetEl.offsetHeight, t: performance.now(), moved: false, last: e.clientY, lastT: performance.now(), v: 0 };
    headEl.setPointerCapture(e.pointerId); sheetEl.classList.add('drag');
  });
  headEl.addEventListener('pointermove', e => {
    if (!d) return;
    const dy = e.clientY - d.y, now = performance.now();
    if (Math.abs(dy) > 5) d.moved = true;
    if (now > d.lastT) d.v = (e.clientY - d.last) / (now - d.lastT);
    d.last = e.clientY; d.lastT = now;
    sheetEl.style.setProperty('--sheet-h', Math.max(SNAP.peek(), Math.min(SNAP.full(), d.h - dy)) + 'px');
  });
  const end = () => {
    if (!d) return;
    sheetEl.classList.remove('drag');
    const order = ['peek', 'half', 'full'], i = order.indexOf(sheetAt);
    if (!d.moved) setSheet(sheetAt === 'peek' ? 'half' : sheetAt === 'half' ? 'peek' : 'half');
    else if (Math.abs(d.v) > 0.45) setSheet(order[Math.max(0, Math.min(2, i + (d.v < 0 ? 1 : -1)))]);
    else { const h = sheetEl.offsetHeight; setSheet(order.reduce((a, b) => Math.abs(SNAP[b]() - h) < Math.abs(SNAP[a]() - h) ? b : a)); }
    d = null;
  };
  headEl.addEventListener('pointerup', end); headEl.addEventListener('pointercancel', end);
  headEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(sheetAt === 'peek' ? 'half' : 'peek'); } });
  addEventListener('resize', () => setSheet(sheetAt));
  setSheet('half');
}

// fit bounds in the part of the map not covered by the panel
function fit(bounds, maxZoom = 18) {
  if (!bounds.isValid()) return;
  const opts = phone() ? { paddingTopLeft: [20, 100], paddingBottomRight: [20, Math.min(SNAP[sheetAt](), SNAP.half()) + navH() + 16] }
    : { paddingTopLeft: [410, 30], paddingBottomRight: [30, 30] };
  map.fitBounds(bounds, { ...opts, maxZoom });
}

// ---------------- ui helpers ----------------
function chip(text, state = '') { $('#chipText').textContent = text; $('#chip').className = 'chip ' + state; $('#busyBar').hidden = state !== 'busy'; }
$('#chip').onclick = () => showTab('data');
let toastT;
function toast(msg, err = false, action) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = action.fn; t.append(b); }
  clearTimeout(toastT); if (!action) toastT = setTimeout(() => (t.hidden = true), err ? 7000 : 3500);
}
const fmtWhen = d => new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function fogStatus(meta = fogMeta) {
  if (!fog) { chip('Aucune trace chargée'); $('#dataStatus').textContent = 'Aucune trace. Charge un snapshot ou connecte Dropbox.'; return; }
  const d = meta?.date ? fmtWhen(meta.date) : '';
  chip(d ? 'Traces du ' + d : 'Traces chargées', 'ok');
  $('#dataStatus').textContent = `${fog.countPixels().toLocaleString('fr-FR')} pixels explorés (≈ ${(fog.countPixels() * 40 / 1e6).toFixed(1)} km²) · source : ${meta?.source || '?'}${d ? ' · ' + d : ''}`;
}
async function setFog(f, meta) {
  fog = f; touched = touchedP = null; netRes = null;
  const ser = f.serialize();
  rpc('setFog', ser);
  fogLayer.redraw(); fogStatus(meta);
  await idbSet('fog', { ...ser, meta });
  if (current) analyze(current, false);
  if (conquestOn) showConquest();
}

// tabs. Each tab shows only its own layers on the map, with its own legend and its own headline.
let curTab = 'commune';
const legendFor = {}, heads = { commune: ['Commune', ''], route: ['Itinéraire', ''], idf: ['Île-de-France', ''], data: ['Données et réglages', ''] };
function setHead(tab, title, sub = '') { heads[tab] = [title, sub]; if (tab === curTab) { $('#hTitle').textContent = title; $('#hSub').textContent = sub; } }
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
  $('#idfBtn').setAttribute('aria-pressed', curTab === 'idf' && conquestOn);
}
function selectTab(t) {
  curTab = t;
  $$('.nav button').forEach(x => x.setAttribute('aria-selected', x.dataset.tab === t));
  $$('.pane').forEach(p => (p.hidden = p.dataset.pane !== t));
  setHead(t, ...heads[t]);
  tabLayers();
  if (t === 'idf' && fog && !conquestOn) showConquest();
}
const showTab = t => { selectTab(t); sheetOpen(); };
$$('.nav button').forEach(b => b.onclick = () => { if (curTab === b.dataset.tab && phone()) setSheet(sheetAt === 'peek' ? 'half' : 'peek'); else showTab(b.dataset.tab); });

// ---------------- levels ----------------
// By % of street length walked. "Finie" stops at 90 %: a few streets are always unreachable or badly mapped.
const LEVELS = ['Vierge', 'Traversée', 'Visitée', 'Explorée', 'Conquise', 'Finie'];
const LEVEL_MIN = [0, 0, 0.10, 0.25, 0.50, 0.90];
function levelFromPct(p, touchedOrPos) {
  for (let i = LEVELS.length - 1; i >= 2; i--) if (p >= LEVEL_MIN[i]) return i;
  return touchedOrPos || p > 0 ? 1 : 0;
}
let pcts = {}; const pctsReady = idbGet('pcts').then(v => { if (v) pcts = v; });
let touched = null, touchedP = null;
const ensureTouched = () => touchedP ||= rpc('touched').then(c => (touched = c));
// a commune's % is recomputed only when you have new traces in it (its explored-pixel count changed)
const pxIn = code => touched ? (touched[code] || 0) : undefined;
const beenIn = code => (touched?.[code] || 0) >= 4;
const isStale = code => { const e = pcts[code]; if (!e) return beenIn(code); if (e.px === undefined) return true; return touched ? e.px !== pxIn(code) : false; };
const levelOf = code => { const p = pcts[code]?.p; return p !== undefined ? levelFromPct(p, beenIn(code) || !touched) : beenIn(code) ? 1 : 0; };
async function savePct(code, e) {
  try { await ensureTouched(); } catch (err) {}
  pcts[code] = { ...e, t: Date.now(), px: pxIn(code) }; idbSet('pcts', pcts);
  if (conquestOn) drawConquest();
}
const lvDot = lv => `<i class="lvdot" style="background:var(--lv${lv})"></i>`;

// ---------------- commune analysis ----------------
let current = null; // { name, code?, geom?, bbox }
let anaTok = 0;
const progTxt = (what, d, t) => t > 1 && d < t ? `${what} : ${d}/${t}…` : `${what}…`;
const legendStreets = $('#legend').innerHTML;

function drawStreets(lines) {
  streetsLayer.clearLayers();
  const cNew = css('--new'), cDone = css('--done'), o = { interactive: false, smoothFactor: 1.3 };
  if (lines.done.length) L.polyline(lines.done, { ...o, color: cDone, weight: 2, opacity: .75 }).addTo(streetsLayer);
  if (lines.path.length) L.polyline(lines.path, { ...o, color: cNew, weight: 2.5, opacity: .95, dashArray: '5 5' }).addTo(streetsLayer);
  if (lines.road.length) L.polyline(lines.road, { ...o, color: cNew, weight: 3.5, opacity: .95 }).addTo(streetsLayer);
  setLegend('commune', legendStreets);
}

async function analyze(area, fitView = true) {
  current = area; const tok = ++anaTok;
  const out = $('#communeOut');
  setHead('commune', area.name[0].toUpperCase() + area.name.slice(1));
  outlineLayer.clearLayers(); hlLayer.clearLayers();
  if (area.geom) {
    const gj = L.geoJSON(area.geom, { style: { color: css('--fg'), weight: 2, opacity: .7, fill: false, dashArray: '6 4' }, interactive: false }).addTo(outlineLayer);
    if (fitView) fit(gj.getBounds());
  }
  if (mode === 'com') $('#comName').textContent = area.geom ? area.name : "aucune (choisis-la dans l'onglet Commune)";
  if (!fog) { out.innerHTML = `<div class="empty"><b>Il manque tes traces.</b> Va dans Données pour charger ton snapshot ou connecter Dropbox.</div>`; return; }
  out.innerHTML = '<div class="skel" style="height:58px"></div><div class="skel" style="height:40px"></div><div class="skel" style="height:62px"></div>';
  chip('Rues de ' + area.name + '…', 'busy');
  try {
    const r = await rpc('analyze', { bbox: area.bbox, geom: area.geom || null, radius }, (d, t) => chip(progTxt('Téléchargement des rues', d, t), 'busy'));
    if (tok !== anaTok) return;
    drawStreets(r.lines);
    renderStats(area, r);
    if (area.code) savePct(area.code, { p: r.roads.total ? r.roads.done / r.roads.total : 0, fin: r.finished, n: r.streets, km: r.roads.total });
  } catch (e) { if (tok !== anaTok) return; out.innerHTML = `<div class="empty"><b>Impossible d'analyser ${esc(area.name)}.</b> ${esc(e.message)}</div>`; }
  fogStatus();
}

function renderStats(area, r) {
  const rd = r.roads, p = rd.total ? rd.done / rd.total : 0, P = Math.round(p * 100), lv = levelFromPct(p, true);
  const nx = lv < 5 ? Math.max(lv + 1, 2) : 0, need = nx ? Math.max(0, LEVEL_MIN[nx] * rd.total - rd.done) : 0;
  const next = !rd.total ? '' : nx
    ? `<p class="next">Encore <b>${km(need)}</b> de rues nouvelles pour passer « ${LEVELS[nx]} ».</p>`
    : `<p class="next">Commune finie. Il reste <b>${km(rd.total - rd.done)}</b> pour atteindre 100 %.</p>`;
  $('#communeOut').innerHTML = `
    <div class="hero">
      <div class="pc">${P}<i>%</i></div>
      <div class="lv">${lvDot(lv)}${LEVELS[lv]}</div>
      <div class="km">${km(rd.done)} faits sur ${km(rd.total)} de rues</div>
    </div>
    <div class="ladder" aria-hidden="true">
      <div class="track"><i style="width:${Math.min(100, p * 100)}%"></i></div>
      ${[2, 3, 4, 5].map(i => `<span class="tick" style="left:${LEVEL_MIN[i] * 100}%"></span><span class="lab${i === lv ? ' on' : ''}" style="left:${LEVEL_MIN[i] * 100}%">${LEVELS[i]}</span>`).join('')}
    </div>
    ${next}
    <div class="facts">
      <div><b>${r.finished}<small> / ${r.streets}</small></b><span>rues finies</span></div>
      <div><b>${r.virgin}</b><span>rues jamais foulées</span></div>
      <div><b>${pct(r.paths.done, r.paths.total)}<small> %</small></b><span>des chemins et allées</span></div>
    </div>
    ${area.geom ? `<button id="toCom" class="btn primary">Itinéraire pour cocher ${esc(area.name)}</button>` : ''}
    <details class="todo"><summary>Rues à finir (${r.todoCount})</summary>
    <ul class="list" id="todo">${r.todo.map((e, i) => `
      <li data-i="${i}"><span class="n">${esc(e.name)}</span><span class="v">${km(e.left)}</span>
      <span class="s">${e.done < 1 ? 'jamais parcourue' : pct(e.done, e.total) + ' % faite'} · ${km(e.total)} au total</span></li>`).join('')}</ul>
    ${r.todoCount > r.todo.length ? `<p class="muted small" style="padding:8px 0">Les ${r.todo.length} plus longues sont listées.</p>` : ''}</details>`;
  setHead('commune', area.name[0].toUpperCase() + area.name.slice(1), `${P} % · ${LEVELS[lv]}`);
  $('#toCom')?.addEventListener('click', () => { showTab('route'); setMode('com'); });
  $$('#todo li').forEach(li => li.onclick = () => {
    const e = r.todo[+li.dataset.i]; hlLayer.clearLayers();
    const pl = L.polyline(e.lines, { color: css('--fg'), weight: 8, opacity: .35, interactive: false }).addTo(hlLayer);
    sheetPeek(); setHead('commune', e.name, `reste ${km(e.left)}`);
    fit(pl.getBounds(), 17);
  });
}

// ---------------- conquest: every commune of Île-de-France by level ----------------
let idfFeats = null, conquestOn = false;
map.createPane('conq').style.zIndex = 250;
const conqRenderer = L.canvas({ pane: 'conq' });
const conquestLayer = L.layerGroup();
const DEPTS = { '75': 'Paris', '77': 'Seine-et-Marne', '78': 'Yvelines', '91': 'Essonne', '92': 'Hauts-de-Seine', '93': 'Seine-Saint-Denis', '94': 'Val-de-Marne', '95': "Val-d'Oise" };
const deptOf = code => code.slice(0, 2);
let conqDept = ls.get('conqDept') || 'all', conqView = ls.get('conqView') || 'visit', deptGeo = null;
const visited = code => levelOf(code) > 0;

function drawConquest(refit = false) {
  conquestLayer.clearLayers();
  const cols = LEVELS.map((_, i) => css('--lv' + i)), n = LEVELS.map(() => 0);
  const feats = idfFeats.filter(f => conqDept === 'all' || deptOf(f.code) === conqDept);
  const cVis = css('--done'), cNo = css('--lv0'), cBg = css('--paper'), cFg = css('--fg');
  // one shape per colour instead of one per commune: 1 300 layers became half a dozen
  const groups = new Map();
  for (const f of feats) {
    const lv = levelOf(f.code); n[lv]++;
    const fill = conqView === 'visit' ? (lv ? cVis : cNo) : cols[lv], k = fill + (lv ? '|1' : '|0');
    let g = groups.get(k); if (!g) groups.set(k, g = { fill, on: lv > 0, polys: [] });
    if (f.geom.type === 'Polygon') g.polys.push(f.geom.coordinates); else for (const p of f.geom.coordinates) g.polys.push(p);
  }
  for (const g of groups.values()) L.geoJSON({ type: 'MultiPolygon', coordinates: g.polys }, { pane: 'conq', renderer: conqRenderer, interactive: false, style: { color: cBg, weight: .7, fillColor: g.fill, fillOpacity: g.on ? .55 : .18 } }).addTo(conquestLayer);
  // department borders + labels
  const per = {};
  for (const f of idfFeats) { const d = deptOf(f.code); (per[d] ||= { n: 0, v: 0 }).n++; if (visited(f.code)) per[d].v++; }
  if (deptGeo) {
    const shown = deptGeo.features.filter(d => conqDept === 'all' || d.properties.code === conqDept);
    const gj = L.geoJSON({ type: 'FeatureCollection', features: shown }, { pane: 'conq', renderer: conqRenderer, interactive: false, style: { color: cFg, weight: 2.2, opacity: .8, fill: false } }).addTo(conquestLayer);
    if (conqDept === 'all') gj.eachLayer(l => {
      const c = l.feature.properties.code, st = per[c] || { n: 0, v: 0 };
      L.marker(l.getBounds().getCenter(), { pane: 'conq', interactive: false, icon: L.divIcon({ className: '', html: `<span class="dlab${'75 92 93 94'.includes(c) ? ' pc' : ''}"><b>${c}</b> ${st.v}/${st.n}</span>`, iconSize: [0, 0] }) }).addTo(conquestLayer);
    });
    if (refit) fit(gj.getBounds());
  }
  const tot = feats.length, vis = feats.filter(f => visited(f.code)).length;
  const unknown = feats.filter(f => isStale(f.code)).length;
  const place = conqDept === 'all' ? 'en Île-de-France' : (conqDept === '75' ? 'à Paris' : 'en ' + DEPTS[conqDept]);
  const plur = vis > 1 ? 's' : '';
  setHead('idf', conqDept === 'all' ? 'Île-de-France' : DEPTS[conqDept], `${vis} commune${plur} sur ${tot}`);
  $('#conquest').innerHTML = `
    <div class="stat">
      <div class="big">${vis}<small>commune${plur} visitée${plur} sur ${tot} ${place}</small></div>
      <div class="bar"><i style="width:${tot ? 100 * vis / tot : 0}%"></i></div>
    </div>
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
    ${conqView === 'levels' ? `<div class="levels">${LEVELS.map((l, i) => `<div><b>${n[i]}</b><span><i style="background:${cols[i]}"></i>${l}s</span></div>`).join('')}</div>
    <p class="muted small">En % des km de rues faites : traversée &lt; 10 %, visitée 10–25 %, explorée 25–50 %, conquise 50–90 %, finie ≥ 90 %.</p>` : ''}
    ${conqDept === 'all' ? `<ul class="list" id="deptList">${Object.entries(DEPTS).map(([c, nm]) => { const st = per[c] || { n: 0, v: 0 }; return `
      <li data-d="${c}"><span class="n">${c} · ${esc(nm)}</span><span class="v">${st.v}/${st.n}</span>
      <span class="s"><span class="bar"><i style="width:${st.n ? 100 * st.v / st.n : 0}%"></i></span></span></li>`; }).join('')}</ul>` : ''}
    <div class="row wrap">
      ${unknown ? `<button id="conquestCalc" class="btn small primary">Mettre à jour ${unknown} commune${unknown > 1 ? 's' : ''} avec de nouvelles traces</button>` : '<span class="muted small">Tous les pourcentages sont à jour.</span>'}
    </div>
    <p id="conquestProg" class="muted small" hidden></p>`;
  setLegend('idf', conqView === 'visit'
    ? `<span><i class="sq" style="background:${cVis}"></i>visitée</span><span><i class="sq" style="background:${cNo}"></i>pas encore</span>`
    : LEVELS.slice(1).map((l, i) => `<span><i class="sq" style="background:${cols[i + 1]}"></i>${l.toLowerCase()}</span>`).join(''));
  $('#conqDept').onchange = e => { conqDept = e.target.value; ls.set('conqDept', conqDept); drawConquest(true); };
  $('#cvVisit').onclick = () => { conqView = 'visit'; ls.set('conqView', conqView); drawConquest(); };
  $('#cvLevels').onclick = () => { conqView = 'levels'; ls.set('conqView', conqView); drawConquest(); };
  $$('#deptList li').forEach(li => li.onclick = () => { conqDept = li.dataset.d; ls.set('conqDept', conqDept); drawConquest(true); });
  $('#conquestCalc')?.addEventListener('click', calcAll);
  drawComTable(feats);
}

// table: every commune with its %, level and when the % was last computed
let tableAll = false, tableQ = '';
const fmtDay = t => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: '2-digit' });
function drawComTable(feats) {
  const rows = feats.filter(f => (tableAll || levelOf(f.code) > 0 || pcts[f.code]) && (!tableQ || f.key.includes(tableQ)))
    .map(f => ({ f, p: pcts[f.code], lv: levelOf(f.code) }))
    .sort((a, b) => (b.p?.p ?? -1) - (a.p?.p ?? -1) || a.f.nom.localeCompare(b.f.nom));
  const stale = r => r.p && isStale(r.f.code);
  const list = () => `${rows.slice(0, 400).map(r => `
      <li data-code="${r.f.code}"><span class="n">${lvDot(r.lv)}${esc(r.f.nom)}</span><span class="v">${r.p ? Math.round(r.p.p * 100) + ' %' : '—'}</span>
      <span class="s">${LEVELS[r.lv]} · ${r.p ? 'calculé le ' + fmtDay(r.p.t) + (stale(r) ? ' · <b>nouvelles traces depuis</b>' : '') : 'pas encore calculé'}</span></li>`).join('')}`;
  if (!$('#tableQ')) {
    $('#comTable').innerHTML = `
      <div class="row"><input id="tableQ" type="search" placeholder="Filtrer les communes" autocomplete="off">
      <label class="check small"><input type="checkbox" id="tableAll"> vierges aussi</label></div>
      <ul class="list" id="tableList"></ul><p class="muted small" id="tableMore" hidden></p>`;
    $('#tableQ').oninput = e => { tableQ = e.target.value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); drawComTable(tableFeats); };
    $('#tableAll').onchange = e => { tableAll = e.target.checked; drawComTable(tableFeats); };
    $('#tableList').onclick = e => { const li = e.target.closest('li[data-code]'); if (li) { showTab('commune'); openCommune(li.dataset.code); } };
  }
  tableFeats = feats;
  $('#tableList').innerHTML = list();
  $('#tableMore').hidden = rows.length <= 400; $('#tableMore').textContent = `${rows.length - 400} autres : affine avec le filtre.`;
}
let tableFeats = [];
function hideConquest() {
  conquestOn = false; tabLayers();
  setLegend('idf', ''); setHead('idf', 'Île-de-France');
  $('#conquest').innerHTML = '<button id="conquestBtn" class="btn">Afficher la carte de mes communes</button>'; $('#conquestBtn').onclick = () => showConquest();
}
async function showConquest() {
  if (!fog) { toast("Charge d'abord tes traces (onglet Données).", true); showTab('data'); return; }
  if (!idfFeats) $('#conquest').innerHTML = '<div class="skel" style="height:64px"></div>';
  try {
    idfFeats = await data.loadCommunes();
    deptGeo ||= await fetch('geo/departements-idf.geojson').then(r => r.json()).catch(() => null);
    await Promise.all([ensureTouched(), pctsReady]);
    const first = !conquestOn;
    conquestOn = true; tabLayers();
    drawConquest(first);
    if (first && !deptGeo) fit(L.latLngBounds([[48.12, 1.45], [49.24, 3.56]]));
  } catch (e) { hideConquest(); toast('Limites des communes indisponibles : ouvre une fois l\'appli avec du réseau pour les garder sur ce téléphone.', true); }
}
$('#conquestBtn').onclick = () => showConquest();
map.on('zoomend', () => map.getContainer().classList.toggle('zlo', map.getZoom() < 11));
map.getContainer().classList.toggle('zlo', map.getZoom() < 11);
$('#idfBtn').onclick = () => {
  if (curTab === 'idf' && conquestOn) { selectTab('commune'); return; }
  sheetPeek(); selectTab('idf');
};
let calcStop = false;
async function calcAll() {
  const list = idfFeats.filter(f => isStale(f.code));
  const btn = $('#conquestCalc'), prog = $('#conquestProg');
  calcStop = false; btn.textContent = 'Arrêter'; btn.onclick = () => (calcStop = true); prog.hidden = false;
  const online = !(await data.getManifest());
  for (let i = 0; i < list.length && !calcStop; i++) {
    const f = list[i];
    prog.textContent = `${i + 1}/${list.length} : ${f.nom}…`;
    try {
      pcts[f.code] = { ...(await rpc('stats', { code: f.code, radius })), t: Date.now(), px: pxIn(f.code) };
      if (i % 10 === 9) idbSet('pcts', pcts);
      if (online) await new Promise(r => setTimeout(r, 1500)); // be gentle with the free Overpass servers
    } catch (e) { prog.textContent = e.message; await new Promise(r => setTimeout(r, 5000)); }
  }
  idbSet('pcts', pcts);
  drawConquest();
}

// ---- biggest uninterrupted network ----
map.createPane('net').style.zIndex = 420;
const netLayer = L.layerGroup();
const NetFog = L.GridLayer.extend({ createTile(c) { return paintFog(c, netFog, '#7b3fe4'); } });
let netFog = null, netRes = null, netOn = false;
const netFogLayer = new NetFog({ pane: 'net', maxZoom: 19, opacity: 0.85 });
const netReset = () => { $('#netOut').innerHTML = '<button id="netBtn" class="btn">Calculer mon plus grand réseau</button>'; $('#netBtn').onclick = () => showNetwork(); };
async function showNetwork(i = 0) {
  if (!fog) { toast("Charge d'abord tes traces (onglet Données).", true); return; }
  if (!netRes) {
    $('#netOut').innerHTML = '<p class="muted"><span class="spin"></span> Analyse de tes traces…</p>';
    try { netRes = await rpc('network'); } catch (e) { netReset(); toast(e.message, true); return; }
  }
  const c = netRes?.comps[i];
  if (!c) { $('#netOut').innerHTML = '<p class="muted">Pas assez de traces.</p>'; return; }
  c.fog ||= FogMap.deserialize(c.map);
  setLegend('idf', '<span><i class="sq" style="background:#7b3fe4"></i>ce réseau</span><span><i class="sq" style="background:#3c8a68"></i>le reste de tes traces</span>');
  netFog = c.fog; netOn = true; netLayer.clearLayers(); tabLayers(); netFogLayer.redraw();
  const A = [c.a[1], c.a[0]], B = [c.b[1], c.b[0]];
  L.polyline([A, B], { pane: 'net', color: '#7b3fe4', weight: 3, dashArray: '8 6', interactive: false }).addTo(netLayer);
  for (const p of [A, B]) L.circleMarker(p, { pane: 'net', radius: 7, color: '#fff', weight: 3, fillColor: '#7b3fe4', fillOpacity: 1 }).addTo(netLayer);
  L.marker([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], { pane: 'net', interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="rlab on">${km(c.dist)} à vol d'oiseau</span>` }) }).addTo(netLayer);
  fit(L.latLngBounds([A, B]).pad(0.15));
  const [na, nb] = await Promise.all([data.communeAt(...c.a), data.communeAt(...c.b)]).then(x => x.map(f => f?.nom), () => []);
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
  $('#netHide').onclick = () => { netOn = false; tabLayers(); if (conquestOn) drawConquest(); netReset(); };
}
$('#netBtn').onclick = () => showNetwork();

// ---------------- commune search: all local, from the limits saved on the phone ----------------
function addRecent(f) {
  let r = []; try { r = JSON.parse(ls.get('recents') || '[]'); } catch (e) {}
  r = [{ code: f.code, nom: f.nom }, ...r.filter(x => x.code !== f.code)].slice(0, 6);
  ls.set('recents', JSON.stringify(r)); drawRecents();
}
function drawRecents() {
  let r = []; try { r = JSON.parse(ls.get('recents') || '[]'); } catch (e) {}
  r = r.filter(x => x.code !== current?.code);
  const el = $('#recents'); el.hidden = !r.length;
  el.innerHTML = r.map(x => `<button data-code="${esc(x.code)}">${lvDot(levelOf(x.code))}${esc(x.nom)}</button>`).join('');
}
$('#recents').onclick = e => { const b = e.target.closest('button[data-code]'); if (b) openCommune(b.dataset.code); };
let suggestN = 0;
$('#communeQ').addEventListener('input', async e => {
  const q = e.target.value.trim(), ul = $('#communeList'), n = ++suggestN;
  if (q.length < 2) { ul.hidden = true; return; }
  try {
    const list = await data.searchCommunes(q, 8);
    if (n !== suggestN) return;
    ul.innerHTML = list.map(f => { const p = pcts[f.code]; return `<li data-code="${f.code}">${lvDot(levelOf(f.code))}<span>${esc(f.nom)} <small>${esc(f.cp)}</small></span><span class="r">${p ? Math.round(p.p * 100) + ' %' : ''}</span></li>`; }).join('') || '<li class="muted">Aucune commune d\'Île-de-France à ce nom</li>';
    ul.hidden = false;
  } catch (err) { ul.hidden = true; toast("Limites des communes indisponibles : ouvre une fois l'appli avec du réseau pour les garder sur ce téléphone.", true); }
});
$('#communeList').onclick = e => { const li = e.target.closest('li[data-code]'); if (li) { $('#communeList').hidden = true; $('#communeQ').blur(); openCommune(li.dataset.code); } };
$('#communeQ').addEventListener('keydown', e => { if (e.key === 'Enter') $('#communeList li[data-code]')?.click(); });
async function openCommune(code, fitView = true) {
  let f;
  try { f = await data.communeByCode(code); }
  catch (e) { toast("Limites des communes indisponibles : ouvre une fois l'appli avec du réseau pour les garder sur ce téléphone.", true); return; }
  if (!f) { toast('Commune introuvable.', true); return; }
  ls.set('lastCommune', code); $('#communeQ').value = f.nom;
  const p = analyze({ name: f.nom, code, geom: f.geom, bbox: f.bbox }, fitView);
  addRecent(f);
  return p;
}
$('#communeHere').onclick = () => locate(async ([lon, lat]) => {
  const f = await data.communeAt(lon, lat).catch(() => null);
  if (f) openCommune(f.code); else toast("Tu n'es dans aucune commune d'Île-de-France connue.", true);
});
$('#viewHere').onclick = () => {
  if (map.getZoom() < 14) { toast('Zoome un peu plus (quartier) pour analyser la zone affichée.'); return; }
  const b = map.getBounds(), bbox = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  analyze({ name: 'la zone affichée', geom: null, bbox }, false); drawRecents();
};

// ---------------- my position (stays in this device) ----------------
let watchId = null, me = null, meMarker = null, meAcc = null, follow = false;
function showMe(p) {
  me = { ll: [p.coords.longitude, p.coords.latitude], acc: p.coords.accuracy, t: Date.now() };
  const at = [me.ll[1], me.ll[0]];
  if (!meMarker) {
    map.createPane('me').style.zIndex = 640;
    meAcc = L.circle(at, { pane: 'me', radius: me.acc, color: '#2a6fdb', weight: 1, opacity: .5, fillOpacity: .12, interactive: false }).addTo(map);
    meMarker = L.marker(at, { pane: 'me', interactive: false, icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
  } else { meMarker.setLatLng(at); meAcc.setLatLng(at).setRadius(me.acc); }
  if (follow) { follow = false; map.setView(at, Math.max(map.getZoom(), 16)); }
  $('#locBtn').classList.remove('wait');
}
function stopWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; me = null; meMarker?.remove(); meAcc?.remove(); meMarker = meAcc = null;
  $('#locBtn').setAttribute('aria-pressed', false); $('#locBtn').classList.remove('wait');
}
function startWatch() {
  if (!navigator.geolocation) { toast('Géolocalisation non disponible.', true); return; }
  follow = true; $('#locBtn').setAttribute('aria-pressed', true); $('#locBtn').classList.add('wait');
  watchId = navigator.geolocation.watchPosition(showMe, () => { stopWatch(); toast('Position refusée ou indisponible.', true); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
$('#locBtn').onclick = () => {
  if (watchId === null) { startWatch(); return; }
  if (me && map.distance(map.getCenter(), [me.ll[1], me.ll[0]]) > 60) map.setView([me.ll[1], me.ll[0]], Math.max(map.getZoom(), 16));
  else stopWatch();
};
// no GPS while the app is in the background
document.addEventListener('visibilitychange', () => {
  if (document.hidden && watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = -1; }
  else if (!document.hidden && watchId === -1) watchId = navigator.geolocation.watchPosition(showMe, () => stopWatch(), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
});
function locate(cb) {
  if (me && Date.now() - me.t < 15000) { cb(me.ll); return; }
  if (!navigator.geolocation) { toast('Géolocalisation non disponible.', true); return; }
  chip('Localisation…', 'busy');
  navigator.geolocation.getCurrentPosition(p => { fogStatus(); cb([p.coords.longitude, p.coords.latitude]); },
    () => { fogStatus(); toast('Position refusée ou indisponible.', true); }, { enableHighAccuracy: true, timeout: 15000 });
}

// ---------------- addresses ----------------
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
    L.marker([pts[k][1], pts[k][0]], { icon: L.divIcon({ className: '', html: `<div class="pin">${txt}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(markerLayer);
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
  if (picking) { toast('Touche la carte pour placer le point.'); sheetPeek(); }
});
// tap anywhere on the map: quick stats of the commune there
async function quickStats(f) {
  if (!pcts[f.code] || isStale(f.code)) {
    pcts[f.code] = { ...(await rpc('stats', { code: f.code, radius })), t: Date.now(), px: pxIn(f.code) };
    idbSet('pcts', pcts);
  }
  return pcts[f.code];
}
async function tapStats(latlng) {
  if (!fog) return;
  let f;
  try { f = await data.communeAt(latlng.lng, latlng.lat); await ensureTouched(); } catch (e) { return; }
  if (!f) return;
  const pop = L.popup({ maxWidth: 260, className: 'qpop' }).setLatLng(latlng).setContent(`<b>${esc(f.nom)}</b><br><span class="spin"></span> calcul…`).openOn(map);
  try {
    const e = await quickStats(f), lv = levelFromPct(e.p, beenIn(f.code));
    pop.setContent(`<b>${esc(f.nom)}</b><div class="qbig">${Math.round(e.p * 100)} %<small> des rues · ${LEVELS[lv]}</small></div>
      ${e.n ? `<div class="qs">${e.fin} rues finies sur ${e.n} · ${km(e.km)} de rues</div>` : ''}
      <div class="qs">calculé le ${fmtDay(e.t)}</div>
      <div class="qa"><button class="btn small" data-q="detail">Détail</button><button class="btn small primary" data-q="route">La cocher</button></div>`);
    const el = pop.getElement();
    el.querySelector('[data-q="detail"]').onclick = () => { map.closePopup(); showTab('commune'); openCommune(f.code); };
    el.querySelector('[data-q="route"]').onclick = async () => { map.closePopup(); openCommune(f.code); showTab('route'); setMode('com'); };
    if (conquestOn) drawConquest();
  } catch (err) { pop.setContent(`<b>${esc(f.nom)}</b><br>${esc(err.message)}`); }
}
map.on('click', e => {
  if (!picking) { tapStats(e.latlng); return; }
  setPoint(picking, [e.latlng.lng, e.latlng.lat]);
  picking = null; $$('[data-pick]').forEach(x => x.classList.remove('picking'));
  sheetOpen();
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

// start from a station (RER, Transilien, métro, tram)
$('[data-station="from"]').onclick = async () => {
  const ul = $('.suggest[data-for="fromQ"]');
  const ref = pts.from || (current?.geom ? null : [map.getCenter().lng, map.getCenter().lat]);
  const bbox = current?.geom && !pts.from ? padBbox([[current.bbox[1], current.bbox[0]], [current.bbox[3], current.bbox[2]]], 800) : padBbox([ref], 2500);
  ul.innerHTML = '<li class="muted"><span class="spin"></span> Recherche des gares…</li>'; ul.hidden = false;
  try {
    const list = await data.loadStations(bbox);
    const c = ref || [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
    const near = list.map(x => ({ ...x, d: distM(...c, x.lon, x.lat) })).sort((a, b) => a.d - b.d).slice(0, 12);
    ul.innerHTML = near.map((x, i) => `<li data-i="${i}"><span>${esc(x.name)} <small>${esc(x.kind)}</small></span><span class="r">${km(x.d)}</span></li>`).join('') || '<li class="muted">Aucune gare trouvée ici</li>';
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
  const curMode = mode;
  $('#go').disabled = true; out.innerHTML = `<p class="muted"><span class="spin"></span> <span id="routeSay">Chargement des rues…</span></p>`;
  $('#busyBar').hidden = false;
  try {
    const say = m => { const p = $('#routeSay'); if (p) p.textContent = m; };
    routes = await rpc('route', { mode: curMode, from: pts.from, to: pts.to, target, comBudget, toStation, geom: current?.geom || null, comName: current?.name || '', bbox, charm: $('#charm').checked, radius },
      (d, t) => say(typeof d === 'string' ? d : progTxt('Téléchargement des rues', d, t)));
    // route tab shows only routes; the commune view keeps its own layers
    const base = routes[0].len;
    out.innerHTML = routes.map((r, i) => `
      <div class="card" data-i="${i}">
        <div class="t"><span>${esc(r.label)}</span><span>+${km(r.fresh)} nouveaux</span></div>
        <div class="split" title="Part de rues nouvelles"><i style="width:${pct(r.fresh, r.len)}%"></i></div>
        <div class="kv"><span>${km(r.len)} · ~${Math.round(r.len / 1000 / 4.5 * 60)} min</span><span>${pct(r.fresh, r.len)} % de rues nouvelles${curMode === 'ab' && i ? ' · détour +' + pct(r.len - base, base) + ' %' : ''}</span></div>
        ${r.note ? `<div class="kv"><span>${esc(r.note)}</span></div>` : ''}
        <div class="acts"><button class="btn small primary" data-kml="${i}">Tracé KML</button><button class="btn small" data-gpx="${i}">GPX</button><a class="btn small ghost" data-gm="${i}" target="_blank" rel="noopener noreferrer">Itinéraire Google</a></div>
      </div>`).join('') + `<details class="howto"><summary>Ouvrir le tracé dans une appli de carte</summary><p class="muted small" style="margin-top:8px">KML / GPX : le tracé exact. Sur Android, Google Maps ne sait pas ouvrir ces fichiers : installe Organic Maps (gratuit, sans compte) ou OsmAnd, puis choisis-le « Toujours » à l'ouverture. Sur ordinateur : Google My Maps ou Google Earth. « Itinéraire Google » lance la navigation, mais Google recalcule entre 8 points de passage : le tracé peut différer.</p></details>`;
    $$('#routeOut .card').forEach(c => c.onclick = e => { if (!e.target.closest('.acts')) selectRoute(+c.dataset.i); });
    $$('[data-gpx]').forEach(b => b.onclick = () => saveGPX(routes[+b.dataset.gpx]));
    $$('[data-kml]').forEach(b => b.onclick = () => saveKML(routes[+b.dataset.kml]));
    $$('[data-gm]').forEach(a => (a.href = gmapsUrl(routes[+a.dataset.gm])));
    selectRoute(routes.length > 1 ? 1 : 0);
  } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  $('#go').disabled = false; $('#busyBar').hidden = true;
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
  L.polyline(r.coords.map(ll), { color: '#fff', weight: 10, opacity: .95, interactive: false }).addTo(routeLayer);
  const runs = { true: [], false: [] };
  let run = [ll(r.coords[0])], state = !!r.isNew[0];
  for (let k = 0; k < r.isNew.length; k++) {
    if (!!r.isNew[k] !== state) { runs[state].push(run); run = [run[run.length - 1]]; state = !!r.isNew[k]; }
    run.push(ll(r.coords[k + 1]));
  }
  runs[state].push(run);
  for (const s of [false, true]) if (runs[s].length) L.polyline(runs[s], { color: s ? cNew : cDone, weight: 6, opacity: 1, lineCap: 'round', interactive: false }).addTo(routeLayer);
  // labels to switch variant from the map
  routes.forEach((x, j) => {
    const at = x.coords[Math.floor(x.coords.length * (0.35 + 0.15 * j))] || x.coords[0];
    L.marker(ll(at), { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<span class="rlab${j === i ? ' on' : ''}">${esc(x.label)} · ${km(x.len)}</span>` }) })
      .on('click', () => selectRoute(j)).addTo(routeLayer);
  });
  setLegend('route', `<span><i class="sw new" style="border-top-width:5px"></i>nouveau</span><span><i class="sw done" style="border-top-width:5px"></i>déjà fait</span>${routes.length > 1 ? `<span><i class="sw" style="border-color:${css('--muted')};border-top-style:dotted"></i>autres variantes</span>` : ''}`);
  setHead('route', r.label, `${km(r.len)} · +${km(r.fresh)} nouveaux`);
  fit(L.latLngBounds(routes.flatMap(x => x.coords.map(ll))));
  $$('#routeOut .card').forEach(c => c.classList.toggle('sel', +c.dataset.i === i));
}
// share sheet first (Android offers the installed map apps directly), plain download otherwise
async function handOff(text, type, filename) {
  const blob = new Blob([text], { type });
  try {
    const file = new File([blob], filename, { type });
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const fileName = (r, ext) => `fog-explorer-${r.label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\W+/g, '-')}-${(r.len / 1000).toFixed(1).replace('.', ',')}km.${ext}`;
function saveKML(r) { handOff(toKML(r.coords, `Fog Explorer · ${r.label} · ${km(r.len)}`), 'application/vnd.google-earth.kml+xml', fileName(r, 'kml')); }
function saveGPX(r) { handOff(toGPX(r.coords, 'Fog Explorer – ' + r.label), 'application/gpx+xml', fileName(r, 'gpx')); }
function gmapsUrl(r) {
  const c = r.coords, f = p => `${p[1].toFixed(6)},${p[0].toFixed(6)}`, n = 8, wps = [];
  for (let k = 1; k <= n; k++) wps.push(f(c[Math.floor(k * (c.length - 1) / (n + 1))]));
  return `https://www.google.com/maps/dir/?api=1&travelmode=walking&origin=${f(c[0])}&destination=${f(c[c.length - 1])}&waypoints=${encodeURIComponent(wps.join('|'))}`;
}

// ---------------- data: file + Dropbox ----------------
$('#fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  chip('Lecture du snapshot…', 'busy');
  try {
    const fg = await fogFromSnapshot(await f.arrayBuffer());
    fogMeta = { source: f.name, date: f.lastModified };
    await setFog(fg, fogMeta);
    toast('Traces chargées.');
    if (!current) startCommune();
  } catch (err) { toast(err.message, true); fogStatus(); }
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
    if (r.unchanged && fog) { fogStatus(); }
    else {
      if (r.unchanged) { await idbSet('dbxCache', {}); return syncDropbox(); } // no local traces anymore: fetch again
      await idbSet('dbxCache', r.cache);
      const had = !!fog;
      fogMeta = { source: 'Dropbox, ' + r.source, date: r.date };
      await setFog(r.fog, fogMeta);
      if (!had && !current) startCommune();
    }
    const when = new Date(r.date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
    $('#dbxStatus').innerHTML = r.kind === 'sync'
      ? `Connecté · <b>synchro automatique active</b> : je lis les fichiers de synchro de Fog of World (dernière modification ${when}).<br><small>Dossiers vus : ${(r.dirs || []).map(esc).join(' · ')}</small>`
      : `Connecté · <b>synchro automatique pas encore active</b> : je n'ai trouvé que des snapshots manuels dans « ${esc(r.folder)} » (dernier : ${when}). Active la synchro Dropbox dans Fog of World (onglet nuage) pour que tout se mette à jour seul.<br><small>Dossiers vus : ${(r.dirs || []).map(esc).join(' · ')}</small>`;
    ls.set('dbxLast', $('#dbxStatus').innerHTML);
    if (!r.unchanged) toast(r.kind === 'sync' ? 'Nouvelles traces reçues (synchro auto Dropbox).' : 'Traces chargées depuis le dernier snapshot Dropbox.');
  } catch (e) { toast(e.message, true); fogStatus(); dbxUi(); }
}

$('#fogSel').value = fogStyle;
$('#fogSel').onchange = e => { fogStyle = e.target.value; ls.set('fogStyle2', fogStyle); fogLayer.setOpacity(fogStyle === 'brume' ? 1 : 0.7); fogLayer.redraw(); };
$('#baseSel').value = BASES[ls.get('base')] ? ls.get('base') : 'epure';
$('#baseSel').onchange = e => { ls.set('base', e.target.value); setBase(); };

// ---- maps kept on the phone ----
async function dataUi() {
  const m = await data.getManifest(), el = $('#dataInfo'), btn = $('#dlAll');
  if (!m) { el.textContent = "Rues téléchargées à la demande depuis OpenStreetMap (les cartes de toute l'Île-de-France ne sont pas encore publiées)."; btn.hidden = true; return; }
  const got = ls.get('allDownloaded'), all = got === m.date, mb = (m.bytes / 1e6).toFixed(0);
  el.textContent = `Rues, gares${m.communes ? ' et limites des communes' : ''} du ${new Date(m.date).toLocaleDateString('fr-FR')} · ${m.ways.toLocaleString('fr-FR')} voies · ${mb} Mo pour toute l'Île-de-France. `
    + (all ? 'Tout est sur ce téléphone : l\'appli marche sans réseau (sauf le fond de carte).' : got ? 'Une version plus récente est disponible.' : 'Chaque zone regardée est gardée sur ce téléphone.');
  btn.hidden = all; btn.textContent = got ? `Mettre à jour les cartes (${mb} Mo)` : `Tout garder sur ce téléphone (${mb} Mo, une seule fois)`;
}
$('#dlAll').onclick = async () => {
  const btn = $('#dlAll'); btn.disabled = true;
  try { await data.downloadAll((d, t, b, tb) => (btn.textContent = `Téléchargement… ${Math.round(100 * b / tb)} % (${(b / 1e6).toFixed(0)}/${(tb / 1e6).toFixed(0)} Mo)`)); toast("Toute l'Île-de-France est sur ton téléphone."); }
  catch (e) { toast(e.message, true); }
  btn.disabled = false; dataUi();
};
data.onDataUpdate(() => dataUi());
dataUi();
$('#prefetch').onclick = () => locate(async ll => {
  const btn = $('#prefetch'), bbox = padBbox([ll], 5000);
  btn.disabled = true;
  try {
    await data.prefetch(bbox, (d, t) => (btn.textContent = `Téléchargement… ${d}/${t} zones`));
    btn.textContent = 'Rues à 5 km autour de toi gardées';
  } catch (e) { btn.textContent = 'Réessayer'; toast(e.message, true); }
  btn.disabled = false;
});
$('#tol').value = radius; $('#tolV').textContent = Math.round(radius * 6);
$('#tol').oninput = e => { radius = +e.target.value; $('#tolV').textContent = Math.round(radius * 6); };
$('#tol').onchange = () => { ls.set('tol', radius); if (current) analyze(current, false); };

$('#wipe').onclick = () => ($('#wipeConfirm').hidden = false);
$('#wipeNo').onclick = () => ($('#wipeConfirm').hidden = true);
$('#wipeYes').onclick = async () => {
  if (dbx.isConnected()) await dbx.disconnect();
  await rpc('setFog', null); await rpc('closeDb');
  await wipeAll();
  fog = null; fogMeta = null; current = null; routes = []; pcts = {}; touched = touchedP = null; netRes = null; netOn = false; hideConquest(); netReset(); stopWatch();
  [streetsLayer, outlineLayer, routeLayer, markerLayer, hlLayer].forEach(l => l.clearLayers());
  fogLayer.redraw(); $('#communeOut').innerHTML = ''; $('#routeOut').innerHTML = ''; $('#communeQ').value = ''; drawRecents();
  for (const k in legendFor) delete legendFor[k]; $('#legend').hidden = true; setHead('commune', 'Commune'); setHead('route', 'Itinéraire');
  $('#wipeConfirm').hidden = true; $('#dbxKey').value = ''; dbxUi(); fogStatus(null); dataUi();
  toast('Toutes tes données ont été effacées de cet appareil.');
};

// ---------------- startup ----------------
function startCommune() {
  const last = ls.get('lastCommune');
  if (last) { openCommune(last); return; }
  $('#communeOut').innerHTML = `<div class="empty"><b>Choisis une commune.</b> Tape son nom, touche <b>Ici</b> pour celle où tu es, ou touche la carte.</div>`;
}
(async () => {
  dbxUi(); drawRecents();
  try {
    if (await dbx.handleRedirect()) { dbxUi(); toast('Dropbox connecté.'); showTab('data'); await syncDropbox(); }
  } catch (e) { toast(e.message, true); }
  const saved = await idbGet('fog');
  if (saved?.keys && !fog) {
    fog = FogMap.deserialize(saved); fogMeta = saved.meta;
    rpc('setFog', { keys: saved.keys, data: saved.data });
    fogLayer.redraw();
  }
  fogStatus();
  await pctsReady;
  if (dbx.isConnected() && ls.get('dbx_auto') !== '0' && !new URLSearchParams(location.search).has('nosync')) syncDropbox();
  if (!fog) {
    showTab('data');
    $('#communeOut').innerHTML = `<div class="empty"><b>Commence par tes traces.</b> Dans Fog of World : Réglages → Snapshot → Take Snapshot, puis charge le fichier .fwss dans Données. Ou connecte Dropbox pour que ce soit automatique.</div>`;
  } else startCommune();
  data.loadCommunes().then(drawRecents, () => {}); // have the commune limits on the phone from the first launch
})();

if ('serviceWorker' in navigator) {
  const opened = Date.now();
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(r => r.update()).catch(() => {});
  // A new version took over. Just after opening, switch to it straight away; later, never
  // interrupt what you are doing: offer it instead.
  let done = false;
  const had = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (done || !had) return; done = true;
    if (Date.now() - opened < 4000 || document.hidden) location.reload();
    else toast('Nouvelle version installée.', false, { label: 'Recharger', fn: () => location.reload() });
  });
}
