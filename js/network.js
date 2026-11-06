// "Plus grand réseau": the biggest uninterrupted piece of explored ground.
// Explored pixels (~6 m) are joined when they are at most `gap` pixels apart (default 2 ≈ 12 m),
// so small GPS dropouts don't split a walk. Then the two points of that piece that are the
// farthest apart as the crow flies (convex hull + exhaustive check on the hull).
import { WORLD, FogMap } from './fog.js';
import { distM } from './streets.js';

const toLonLat = (x, y) => [x / WORLD * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / WORLD))) * 180 / Math.PI];

function hull(pts) { // pts: [[x,y]] sorted unique; Andrew's monotone chain
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

export function largestNetworks(fog, { gap = 2, top = 5 } = {}) {
  // 1. list explored pixels
  const xs = [], ys = [];
  for (const [key, b] of fog.blocks) {
    const bx = Math.floor(key / 65536) * 64, by = (key % 65536) * 64;
    for (let y = 0; y < 64; y++) for (let xb = 0; xb < 8; xb++) {
      const v = b[y * 8 + xb]; if (!v) continue;
      for (let bit = 0; bit < 8; bit++) if (v & (0x80 >> bit)) { xs.push(bx + xb * 8 + bit); ys.push(by + y); }
    }
  }
  const n = xs.length, idx = new Map();
  for (let i = 0; i < n; i++) idx.set(xs[i] * WORLD + ys[i], i);
  // 2. union-find over neighbours within `gap`
  const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    for (let dy = 0; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
      if (dy === 0 && dx <= 0) continue;
      const j = idx.get((x + dx) * WORLD + (y + dy));
      if (j === undefined) continue;
      const a = find(i), b = find(j); if (a !== b) parent[a] = b;
    }
  }
  // 3. sizes
  const size = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); size.set(r, (size.get(r) || 0) + 1); }
  const roots = [...size.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  // 4. for each big piece: farthest pair + its pixels (to draw it)
  const comps = roots.map(([root, count]) => {
    const pts = [], map = new FogMap();
    for (let i = 0; i < n; i++) if (find(i) === root) {
      pts.push([xs[i], ys[i]]);
      const k = (xs[i] >> 6) * 65536 + (ys[i] >> 6);
      let b = map.blocks.get(k); if (!b) map.blocks.set(k, b = new Uint8Array(512));
      const lx = xs[i] & 63, ly = ys[i] & 63; b[ly * 8 + (lx >> 3)] |= 0x80 >> (lx & 7);
    }
    const h = hull(pts);
    let best = 0, pa = h[0], pb = h[0];
    for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) {
      const d = (h[i][0] - h[j][0]) ** 2 + (h[i][1] - h[j][1]) ** 2;
      if (d > best) { best = d; pa = h[i]; pb = h[j]; }
    }
    const a = toLonLat(pa[0] + .5, pa[1] + .5), b = toLonLat(pb[0] + .5, pb[1] + .5);
    return { pixels: count, share: count / n, a, b, dist: distM(a[0], a[1], b[0], b[1]), map };
  });
  return { total: n, pieces: size.size, comps };
}
