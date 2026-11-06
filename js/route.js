// Walking routes that favour unexplored streets.
// Cost of a segment = length x (explored ? 1 : alpha). alpha < 1 makes new streets "cheaper",
// so the shortest path bends toward them; a lower alpha accepts bigger detours.
import { distM } from './streets.js';

class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1; if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

const BIG = /^(trunk|primary|secondary)(_link)?$/;
const SMALL = /^(footway|path|steps|pedestrian|living_street|track|bridleway)$/;

export class Graph {
  constructor(net, opts = {}) {
    this.net = net;
    this.idx = new Map(); this.coords = [];
    const ids = [];
    const id = n => { let i = this.idx.get(n); if (i === undefined) { i = ids.length; this.idx.set(n, i); ids.push(n); this.coords.push(net.nodes.get(n)); } return i; };
    this.adj = [];
    net.segs.forEach((s, si) => {
      const a = id(s.a), b = id(s.b);
      (this.adj[a] ||= []).push(b, si); (this.adj[b] ||= []).push(a, si);
    });
    this.setCharm(opts.charm);
  }
  // "charme": small streets, passages and steps feel cheaper, big roads feel longer
  setCharm(on) {
    this.mult = new Float32Array(this.net.segs.length).fill(1);
    if (!on) return;
    this.net.segs.forEach((s, i) => {
      const hw = this.net.ways[s.w].hw;
      this.mult[i] = BIG.test(hw) ? 1.4 : hw === 'tertiary' || hw === 'service' ? 1.1 : SMALL.test(hw) ? 0.85 : 1;
    });
  }
  // Dijkstra; stops early at `to` if given. used: Set of segs already walked (count as explored)
  run(from, to, alpha, penalty, used) {
    const n = this.coords.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), prevSeg = new Int32Array(n).fill(-1);
    const segs = this.net.segs, mult = this.mult, h = new Heap();
    dist[from] = 0; h.push(0, from);
    while (h.size) {
      const u = h.pop();
      if (u === to) break;
      const du = dist[u], a = this.adj[u];
      if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        const v = a[j], si = a[j + 1], s = segs[si];
        const fresh = !s.done && !(used && used.has(si));
        let c = s.len * (fresh ? alpha : 1) * mult[si];
        if (penalty && penalty.has(si)) c *= penalty.get(si);
        const nd = du + c;
        if (nd < dist[v] - 1e-9) { dist[v] = nd; prev[v] = u; prevSeg[v] = si; h.push(nd, v); }
      }
    }
    return { dist, prev, prevSeg };
  }
  pathTo(t, from, to) {
    if (from !== to && t.prev[to] < 0) return null;
    const path = [to], segs = [];
    for (let v = to; v !== from; v = t.prev[v]) { segs.push(t.prevSeg[v]); path.push(t.prev[v]); }
    return { path: path.reverse(), segs: segs.reverse() };
  }
  nearest(lon, lat) {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.coords.length; i++) {
      if (!this.adj[i]) continue;
      const [x, y] = this.coords[i];
      const d = distM(lon, lat, x, y);
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, dist: bd };
  }
  // penalty: Map(segIndex -> multiplier) used to avoid reusing segments on the way back
  shortest(from, to, alpha, penalty, used) {
    return this.pathTo(this.run(from, to, alpha, penalty, used), from, to);
  }
  describe(parts) {
    const segs = [].concat(...parts.map(p => p.segs)), nodes = [];
    parts.forEach((p, i) => nodes.push(...(i ? p.path.slice(1) : p.path)));
    const seen = new Set(), isNew = []; let len = 0, fresh = 0;
    for (const si of segs) {
      const s = this.net.segs[si]; len += s.len;
      const nw = !s.done && !seen.has(si);
      if (nw) fresh += s.len;
      isNew.push(nw); seen.add(si);
    }
    return { len, fresh, segs, isNew, coords: nodes.map(i => this.coords[i]) };
  }
}

export const PROFILES = [
  { key: 'direct', label: 'Direct', alpha: 1 },
  { key: 'mix', label: 'Équilibré', alpha: 0.55 },
  { key: 'aventure', label: 'Aventure', alpha: 0.3 },
];

export function routesAB(g, a, b) {
  const out = [];
  for (const p of PROFILES) {
    const r = g.shortest(a, b, p.alpha);
    if (!r) return null;
    const d = g.describe([r]);
    if (out.some(o => Math.abs(o.len - d.len) < 5 && Math.abs(o.fresh - d.fresh) < 5)) continue;
    out.push({ ...d, label: p.label });
  }
  return out;
}

// Loop of ~targetM metres: go to a waypoint, come back avoiding the outward segments.
export function routesLoop(g, start, targetM) {
  const [lon0, lat0] = g.coords[start];
  const cands = [];
  for (const radiusF of [0.28, 0.36]) {
    for (let k = 0; k < 12; k++) {
      const ang = k * Math.PI / 6, r = targetM * radiusF;
      const lat = lat0 + (r * Math.cos(ang)) / 111320;
      const lon = lon0 + (r * Math.sin(ang)) / (111320 * Math.cos(lat0 * Math.PI / 180));
      const wp = g.nearest(lon, lat);
      if (wp.node < 0 || wp.dist > r * 0.5) continue;
      const out = g.shortest(start, wp.node, 0.4);
      if (!out) continue;
      const pen = new Map(out.segs.map(s => [s, 4]));
      const back = g.shortest(wp.node, start, 0.4, pen);
      if (!back) continue;
      const d = g.describe([out, back]);
      if (d.len < targetM * 0.6 || d.len > targetM * 1.5) continue;
      cands.push({ ...d, score: d.fresh - Math.abs(d.len - targetM) * 0.5, ang: k });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const pick = [];
  for (const c of cands) {
    if (pick.some(p => Math.abs(p.ang - c.ang) < 2 || Math.abs(p.ang - c.ang) > 10)) continue;
    pick.push(c); if (pick.length === 3) break;
  }
  return pick.map((p, i) => ({ ...p, label: ['Boucle A', 'Boucle B', 'Boucle C'][i] }));
}

export function toGPX(coords, name) {
  const pts = coords.map(([lon, lat]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Fog Explorer" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${name}</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

// "Cocher une commune": greedy orienteering. From the current point, go to the reachable spot that
// collects the most new metres inside the commune per metre walked, while keeping enough budget to
// reach a finish (the start for a loop, or the nearest station). Repeat, then walk to the finish.
export function routeCommune(g, start, { budget, inArea, ends }) {
  const segs = g.net.segs, used = new Set(), parts = [], n = g.coords.length;
  const endCoords = ends.map(e => g.coords[e]);
  const toEnd = v => {
    const [x, y] = g.coords[v]; let m = Infinity;
    for (const [a, b] of endCoords) { const d = distM(x, y, a, b); if (d < m) m = d; }
    return m * 1.3;
  };
  const real = new Float64Array(n), gain = new Float64Array(n);
  let cur = start, walked = 0;
  for (let iter = 0; iter < 80; iter++) {
    const t = g.run(cur, -1, 0.35, null, used);
    const idx = [];
    for (let v = 0; v < n; v++) if (t.dist[v] < Infinity) idx.push(v);
    idx.sort((a, b) => t.dist[a] - t.dist[b]);
    real[cur] = 0; gain[cur] = 0;
    let best = -1, bs = 0;
    for (const v of idx) {
      if (v === cur) continue;
      const p = t.prev[v], si = t.prevSeg[v], s = segs[si];
      real[v] = real[p] + s.len;
      gain[v] = gain[p] + (!s.done && !used.has(si) && inArea(si) ? s.len : 0);
      if (gain[v] < 120 || walked + real[v] + toEnd(v) > budget) continue;
      const sc = gain[v] / (real[v] + 150);
      if (sc > bs) { bs = sc; best = v; }
    }
    if (best < 0) break;
    const p = g.pathTo(t, cur, best);
    parts.push(p); p.segs.forEach(s => used.add(s)); walked += real[best]; cur = best;
  }
  const pen = new Map([...used].map(s => [s, 2]));
  const t = g.run(cur, -1, 0.6, pen, used);
  let e = -1, ed = Infinity;
  for (const x of ends) if (t.dist[x] < ed) { ed = t.dist[x]; e = x; }
  if (e < 0) return null;
  if (e !== cur) parts.push(g.pathTo(t, cur, e));
  if (!parts.length) return null;
  const d = g.describe(parts);
  const seen = new Set(); let freshIn = 0;
  for (const si of d.segs) { if (!seen.has(si) && !segs[si].done && inArea(si)) freshIn += segs[si].len; seen.add(si); }
  return { ...d, freshIn, end: e };
}
