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

export class Graph {
  constructor(net) {
    this.net = net;
    this.idx = new Map(); this.coords = [];
    const ids = [];
    const id = n => { let i = this.idx.get(n); if (i === undefined) { i = ids.length; this.idx.set(n, i); ids.push(n); this.coords.push(net.nodes.get(n)); } return i; };
    this.adj = [];
    net.segs.forEach((s, si) => {
      const a = id(s.a), b = id(s.b);
      (this.adj[a] ||= []).push(b, si); (this.adj[b] ||= []).push(a, si);
    });
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
  shortest(from, to, alpha, penalty) {
    const n = this.coords.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), prevSeg = new Int32Array(n).fill(-1);
    const segs = this.net.segs, h = new Heap();
    dist[from] = 0; h.push(0, from);
    while (h.size) {
      const u = h.pop();
      if (u === to) break;
      const du = dist[u], a = this.adj[u];
      if (!a) continue;
      for (let j = 0; j < a.length; j += 2) {
        const v = a[j], si = a[j + 1], s = segs[si];
        let c = s.len * (s.done ? 1 : alpha);
        if (penalty && penalty.has(si)) c *= penalty.get(si);
        const nd = du + c;
        if (nd < dist[v] - 1e-9) { dist[v] = nd; prev[v] = u; prevSeg[v] = si; h.push(nd, v); }
      }
    }
    if (from !== to && prev[to] < 0) return null;
    const path = [to], segList = [];
    for (let v = to; v !== from; v = prev[v]) { segList.push(prevSeg[v]); path.push(prev[v]); }
    path.reverse(); segList.reverse();
    return { path, segs: segList };
  }
  describe(parts) {
    const segs = [].concat(...parts.map(p => p.segs)), nodes = [];
    parts.forEach((p, i) => nodes.push(...(i ? p.path.slice(1) : p.path)));
    const seen = new Set(); let len = 0, fresh = 0;
    for (const si of segs) {
      const s = this.net.segs[si]; len += s.len;
      if (!s.done && !seen.has(si)) fresh += s.len;
      seen.add(si);
    }
    return { len, fresh, segs, coords: nodes.map(i => this.coords[i]) };
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
