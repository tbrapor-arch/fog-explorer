// Walkable street network from OpenStreetMap (Overpass API) + exploration status from the fog.
// Only bounding boxes of the areas you look at are sent to Overpass; never your tracks.

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const ROADS = 'primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|road|service';
const PATHS = 'footway|path|steps|track|cycleway|bridleway';
export const PATH_TYPES = new Set(PATHS.split('|'));

export function overpassQuery([s, w, n, e]) {
  const bb = `${s.toFixed(5)},${w.toFixed(5)},${n.toFixed(5)},${e.toFixed(5)}`;
  return `[out:json][timeout:90];
way["highway"~"^(${ROADS}|${PATHS})$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"]["footway"!~"^(sidewalk|crossing)$"]["area"!="yes"](${bb});
out body geom qt;`;
}

// Asks the main server; if it hasn't answered after 7 s, also asks a mirror and keeps the first answer.
export async function fetchWays(bbox) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  const ask = url => fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    .then(r => { if (!r.ok) throw new Error('Overpass ' + r.status); return r.json(); })
    .then(j => j.elements.filter(e => e.type === 'way' && e.geometry && e.nodes));
  const tries = [];
  const race = new Promise((resolve, reject) => {
    let failed = 0, idx = 0, timer;
    const next = () => {
      if (idx >= OVERPASS.length) return;
      const p = ask(OVERPASS[idx++]);
      tries.push(p);
      p.then(resolve, () => { if (++failed >= OVERPASS.length) reject(new Error('serveurs indisponibles')); else next(); });
    };
    next();
    timer = setTimeout(next, 7000);
    race.finally?.(() => clearTimeout(timer));
  });
  try { return await race; }
  catch (e) { throw new Error("Impossible de charger les rues d'OpenStreetMap (" + e.message + '). Réessaie dans une minute.'); }
}

// Street data is cached by cells of ~2.2 x 2.2 km, so communes and routes share what was already
// downloaded and a second visit to an area is instant.
export const CELL_LAT = 0.02, CELL_LON = 0.03;
export function cellsFor([s, w, n, e]) {
  const out = [];
  for (let x = Math.floor(w / CELL_LON); x <= Math.floor(e / CELL_LON); x++)
    for (let y = Math.floor(s / CELL_LAT); y <= Math.floor(n / CELL_LAT); y++)
      out.push({ key: x + ',' + y, bbox: [y * CELL_LAT, x * CELL_LON, (y + 1) * CELL_LAT, (x + 1) * CELL_LON] });
  return out;
}

// ---- street data published with the app (built monthly by tools/build_streets.py) ----
export async function gunzipJSON(bytes) {
  // some servers already decompress .gz files on the way (Content-Encoding): then it's plain JSON
  if (!(bytes[0] === 0x1f && bytes[1] === 0x8b)) return JSON.parse(new TextDecoder().decode(bytes));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}
// tile JSON -> Overpass-like ways, keeping only ways with a node inside bbox
export function decodeTile(t, bbox) {
  const [s, w, n, e] = bbox, out = [];
  for (const [id, h, ni, width, ids, cs] of t.w) {
    const nodes = new Array(ids.length), geometry = new Array(ids.length);
    let pid = 0, x = 0, y = 0, inside = !bbox;
    for (let i = 0; i < ids.length; i++) {
      pid += ids[i]; x += cs[2 * i]; y += cs[2 * i + 1];
      const lon = x / 1e5, lat = y / 1e5;
      nodes[i] = pid; geometry[i] = { lon, lat };
      if (!inside && lat >= s && lat <= n && lon >= w && lon <= e) inside = true;
    }
    if (inside) out.push({ id, nodes, geometry, tags: { highway: t.h[h], name: ni >= 0 ? t.n[ni] : undefined, width: width || undefined } });
  }
  return out;
}
export function tilesFor([s, w, n, e], TL, TO) {
  const out = [];
  for (let x = Math.floor(w / TO); x <= Math.floor(e / TO); x++)
    for (let y = Math.floor(s / TL); y <= Math.floor(n / TL); y++) out.push(x + '_' + y);
  return out;
}

// Rail and metro stations around an area (RER, Transilien, métro, tram)
export async function fetchStations([s, w, n, e]) {
  const bb = `${s.toFixed(4)},${w.toFixed(4)},${n.toFixed(4)},${e.toFixed(4)}`;
  const q = `[out:json][timeout:40];(node["railway"~"^(station|halt)$"](${bb});node["railway"="tram_stop"]["name"](${bb}););out body qt;`;
  let last;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('Overpass ' + r.status);
      const seen = new Map();
      for (const el of (await r.json()).elements) {
        const name = el.tags?.name; if (!name) continue;
        const t = el.tags;
        const kind = t.railway === 'tram_stop' || t.station === 'light_rail' ? 'tram' : t.station === 'subway' ? 'métro' : 'train / RER';
        const k = name + '|' + Math.round(el.lat * 200) + '|' + Math.round(el.lon * 200);
        const prev = seen.get(k);
        if (!prev) seen.set(k, { name, lon: el.lon, lat: el.lat, kind });
        else if (!prev.kind.includes(kind)) prev.kind += ', ' + kind;
      }
      return [...seen.values()];
    } catch (e) { last = e; }
  }
  throw new Error('Gares indisponibles pour le moment (' + (last?.message || 'réseau') + ').');
}

export const km = m => (m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';

export function distM(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Extra GPS tolerance for wide roads: on a boulevard you walk on the sidewalk, 15–25 m from the
// line OpenStreetMap draws in the middle. One fog pixel ≈ 6 m in Île-de-France.
const PX_M = 6.3;
function radiusFor(hw, width, base) {
  const w = parseFloat(width);
  if (w > 0) return Math.max(base, Math.ceil((w / 2 + 6) / PX_M));
  if (/^(primary|secondary)(_link)?$/.test(hw)) return base + 2;
  if (/^tertiary/.test(hw) || hw === 'pedestrian') return base + 1;
  return base;
}

// How much of a segment counts as explored, in metres:
//  - ≥ 60 % of its sample points near a trace: the whole segment (it is "fait");
//  - 25–60 %: proportional credit (walked part of it);
//  - < 25 %: nothing (that's usually just crossing it at a junction).
export const credit = s => s.done ? s.len : s.frac >= 0.25 ? s.len * s.frac : 0;

// Splits ways into segments (node to node) and measures how much of each one is explored.
// Returns { nodes: Map(id -> [lon,lat]), segs: [{a,b,len,frac,done,w}], ways: [{name,hw,path}] }
export function buildNetwork(ways, fog, { radius = 2, step = 8, threshold = 0.6 } = {}) {
  const nodes = new Map(), segs = [], wl = [];
  for (const w of ways) {
    const hw = w.tags?.highway || '';
    if (hw === 'service' && !w.tags?.name) continue; // unnamed service roads: mostly private courtyards and car parks
    const r = radiusFor(hw, w.tags?.width, radius);
    const wi = wl.length;
    wl.push({ id: w.id, name: w.tags?.name || '', hw, path: PATH_TYPES.has(hw) });
    for (let i = 0; i < w.nodes.length; i++) {
      const g = w.geometry[i];
      if (g) nodes.set(w.nodes[i], [g.lon, g.lat]);
    }
    for (let i = 1; i < w.nodes.length; i++) {
      const p = w.geometry[i - 1], q = w.geometry[i];
      if (!p || !q) continue;
      const len = distM(p.lon, p.lat, q.lon, q.lat);
      if (len < 0.1) continue;
      const k = Math.max(1, Math.round(len / step));
      let hit = 0;
      for (let j = 0; j <= k; j++) {
        const t = j / k;
        if (fog && fog.near(p.lon + (q.lon - p.lon) * t, p.lat + (q.lat - p.lat) * t, r)) hit++;
      }
      const frac = hit / (k + 1);
      segs.push({ a: w.nodes[i - 1], b: w.nodes[i], len, frac, done: frac >= threshold, w: wi });
    }
  }
  return { nodes, segs, ways: wl };
}

// ---- geometry helpers for commune polygons (GeoJSON Polygon / MultiPolygon) ----
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inGeometry(lon, lat, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) {
    if (inRing(lon, lat, poly[0]) && !poly.slice(1).some(h => inRing(lon, lat, h))) return true;
  }
  return false;
}
export function geomBbox(geom) {
  let s = 90, w = 180, n = -90, e = -180;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const p of polys) for (const [x, y] of p[0]) { s = Math.min(s, y); n = Math.max(n, y); w = Math.min(w, x); e = Math.max(e, x); }
  return [s, w, n, e];
}

// Stats for a set of segments. Street = all OSM ways sharing a name in the area.
// A street is "finie" when ≥ 90 % of its length is credited.
export function summarize(net, segFilter = () => true) {
  const st = { roads: { total: 0, done: 0 }, paths: { total: 0, done: 0 }, byName: new Map(), streets: 0, finished: 0 };
  for (const s of net.segs) {
    if (!segFilter(s)) continue;
    const w = net.ways[s.w], c = credit(s);
    const bucket = w.path ? st.paths : st.roads;
    bucket.total += s.len; bucket.done += c;
    if (!w.path && w.name) {
      let e = st.byName.get(w.name);
      if (!e) st.byName.set(w.name, e = { name: w.name, total: 0, done: 0, segs: [] });
      e.total += s.len; e.done += c; e.segs.push(s);
    }
  }
  for (const e of st.byName.values()) { if (e.total < 20) continue; st.streets++; if (e.done >= 0.9 * e.total) st.finished++; }
  return st;
}
