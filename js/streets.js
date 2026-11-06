// Walkable street network from OpenStreetMap (Overpass API) + exploration status from the fog.
// Only bounding boxes of the areas you look at are sent to Overpass; never your tracks.

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
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

export async function fetchWays(bbox, signal) {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body, signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('Overpass ' + r.status);
      const j = await r.json();
      return j.elements.filter(e => e.type === 'way' && e.geometry && e.nodes);
    } catch (e) { if (signal?.aborted) throw e; lastErr = e; }
  }
  throw new Error("Impossible de charger les rues d'OpenStreetMap (" + (lastErr?.message || 'réseau') + '). Réessaie dans une minute.');
}

export function distM(lon1, lat1, lon2, lat2) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Splits ways into segments (node to node) and measures how much of each one is explored.
// Returns { nodes: Map(id -> [lon,lat]), segs: [{a,b,len,frac,done,w}], ways: [{name,hw,path}] }
export function buildNetwork(ways, fog, { radius = 2, step = 8, threshold = 0.6 } = {}) {
  const nodes = new Map(), segs = [], wl = [];
  for (const w of ways) {
    const hw = w.tags?.highway || '';
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
        if (fog && fog.near(p.lon + (q.lon - p.lon) * t, p.lat + (q.lat - p.lat) * t, radius)) hit++;
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

// Stats for a set of segments
export function summarize(net, segFilter = () => true) {
  const st = { roads: { total: 0, done: 0 }, paths: { total: 0, done: 0 }, byName: new Map() };
  for (const s of net.segs) {
    if (!segFilter(s)) continue;
    const w = net.ways[s.w];
    const bucket = w.path ? st.paths : st.roads;
    bucket.total += s.len; if (s.done) bucket.done += s.len;
    if (!w.path && w.name) {
      let e = st.byName.get(w.name);
      if (!e) st.byName.set(w.name, e = { name: w.name, total: 0, done: 0, segs: [] });
      e.total += s.len; if (s.done) e.done += s.len; e.segs.push(s);
    }
  }
  return st;
}
