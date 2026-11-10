// Heavy computing, off the main thread so the map never freezes: matching streets with your
// traces, commune statistics, routes, biggest network. Runs in this browser like the rest:
// the traces it receives come from the page and go nowhere else.
import { FogMap, WORLD } from './fog.js';
import { buildNetwork, summarize, inGeometry, km } from './streets.js';
import { Graph, routesAB, routesLoop, routeCommune } from './route.js';
import { largestNetworks } from './network.js';
import * as data from './data.js';
import { closeDb } from './store.js';

let fog = null, touchedCache = null, netCache = null;
const ll = p => [p[1], p[0]];
const midIn = (net, geom) => s => { const a = net.nodes.get(s.a), b = net.nodes.get(s.b); return inGeometry((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, geom); };

// streets as a few long lines per kind, ready to be drawn in three strokes
function packLines(net, filter) {
  const out = { done: [], road: [], path: [] };
  let line = [], kind = null, lastB = null, lastW = -1;
  const flush = () => { if (line.length > 1) out[kind].push(line); line = []; };
  for (const s of net.segs) {
    if (filter && !filter(s)) { flush(); lastB = null; continue; }
    const k = s.done ? 'done' : net.ways[s.w].path ? 'path' : 'road';
    if (s.w !== lastW || k !== kind || s.a !== lastB) { flush(); line.push(ll(net.nodes.get(s.a))); }
    line.push(ll(net.nodes.get(s.b)));
    kind = k; lastB = s.b; lastW = s.w;
  }
  flush();
  return out;
}
const pctOf = st => ({ p: st.roads.total ? st.roads.done / st.roads.total : 0, fin: st.finished, n: st.streets, km: st.roads.total });

const api = {
  init({ base }) { data.setBase(base); },
  setFog(s) { fog = s ? FogMap.deserialize(s) : null; touchedCache = netCache = null; },
  closeDb,

  // full analysis of an area: statistics, streets left to finish, and the lines to draw
  async analyze({ bbox, geom, radius }, prog) {
    const ways = await data.getWays(bbox, prog);
    const net = buildNetwork(ways, fog, { radius });
    const filter = geom ? midIn(net, geom) : null;
    const st = summarize(net, filter || (() => true));
    const todo = [...st.byName.values()].map(e => ({ name: e.name, total: e.total, done: e.done, left: e.total - e.done, segs: e.segs }))
      .filter(e => e.left > 30 && e.done < 0.9 * e.total).sort((a, b) => b.left - a.left);
    return {
      roads: st.roads, paths: st.paths, finished: st.finished, streets: st.streets,
      todoCount: todo.length, virgin: todo.filter(e => e.done < 1).length,
      todo: todo.slice(0, 80).map(e => ({ name: e.name, total: e.total, done: e.done, left: e.left, lines: e.segs.map(s => [ll(net.nodes.get(s.a)), ll(net.nodes.get(s.b))]) })),
      lines: packLines(net, filter),
    };
  },

  // just the numbers of one commune (map taps, "update all")
  async stats({ code, radius }) {
    const f = await data.communeByCode(code);
    if (!f) throw new Error('Commune inconnue.');
    const net = buildNetwork(await data.getWays(f.bbox), fog, { radius });
    return pctOf(summarize(net, midIn(net, f.geom)));
  },

  // explored pixels per commune (1 pixel out of 4 is looked at; only used to know where you have been)
  async touched() {
    if (touchedCache) return touchedCache;
    const feats = await data.loadCommunes();
    const cell = 0.02, grid = new Map(), counts = {};
    feats.forEach((f, i) => {
      const [s, w, n, e] = f.bbox;
      for (let x = Math.floor(w / cell); x <= Math.floor(e / cell); x++) for (let y = Math.floor(s / cell); y <= Math.floor(n / cell); y++) {
        const k = x + ',' + y; (grid.get(k) || grid.set(k, []).get(k)).push(i);
      }
    });
    if (fog) for (const [key, b] of fog.blocks) {
      const gbx = Math.floor(key / 65536), gby = key % 65536;
      for (let y = 0; y < 64; y += 2) for (let x = 0; x < 64; x += 2) {
        if (!(b[y * 8 + (x >> 3)] & (0x80 >> (x & 7)))) continue;
        const lon = (gbx * 64 + x) / WORLD * 360 - 180;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (gby * 64 + y) / WORLD))) * 180 / Math.PI;
        const cands = grid.get(Math.floor(lon / cell) + ',' + Math.floor(lat / cell));
        if (!cands) continue;
        for (const i of cands) {
          const [s, w, n, e] = feats[i].bbox;
          if (lat < s || lat > n || lon < w || lon > e) continue;
          if (inGeometry(lon, lat, feats[i].geom)) { counts[feats[i].code] = (counts[feats[i].code] || 0) + 1; break; }
        }
      }
    }
    return (touchedCache = counts);
  },

  network() {
    if (!fog) return null;
    netCache ||= largestNetworks(fog, { gap: 2 });
    return { pieces: netCache.pieces, comps: netCache.comps.map(c => ({ pixels: c.pixels, share: c.share, a: c.a, b: c.b, dist: c.dist, map: c.map.serialize() })) };
  },

  stations: ({ bbox }) => data.loadStations(bbox),

  async route({ mode, from, to, target, comBudget, toStation, geom, comName, bbox, charm, radius }, prog) {
    const ways = await data.getWays(bbox, prog);
    prog('Croisement avec tes traces…');
    const net = buildNetwork(ways, fog, { radius });
    prog('Calcul des itinéraires…');
    const g = new Graph(net, { charm });
    const a = g.nearest(...from);
    if (a.dist > 300) throw new Error('Aucune rue piétonne près du départ.');
    let routes;
    if (mode === 'loop') routes = routesLoop(g, a.node, target);
    else if (mode === 'com') {
      const inF = midIn(net, geom), inA = net.segs.map(inF);
      let ends = [a.node]; const endNames = new Map();
      if (toStation) {
        ends = [];
        for (const x of await data.loadStations(bbox)) { const nn = g.nearest(x.lon, x.lat); if (nn.dist < 250) { ends.push(nn.node); endNames.set(nn.node, x.name); } }
        if (!ends.length) throw new Error('Aucune gare trouvée autour de cette commune. Choisis « Retour au départ ».');
      }
      routes = [];
      for (const [f, label] of [[0.6, 'Sortie courte'], [1, 'Sortie complète']]) {
        const r = routeCommune(g, a.node, { budget: comBudget * f, inArea: si => inA[si], ends });
        if (r && r.freshIn >= 100 && !routes.some(o => Math.abs(o.len - r.len) < 100)) routes.push({ ...r, label, note: `+${km(r.freshIn)} dans ${comName}${endNames.has(r.end) ? ' · arrivée gare ' + endNames.get(r.end) : ''}` });
      }
      if (!routes.length) throw new Error(`Aucune rue nouvelle de ${comName} n'est atteignable avec ${km(comBudget)} depuis ce départ. Augmente la longueur max ou pars d'une gare plus proche.`);
    } else {
      const b = g.nearest(...to);
      if (b.dist > 300) throw new Error("Aucune rue piétonne près de l'arrivée.");
      routes = routesAB(g, a.node, b.node) || [];
    }
    if (!routes.length) throw new Error("Pas d'itinéraire trouvé. Essaie une autre distance ou un autre départ.");
    return routes.map(r => ({ label: r.label, note: r.note, len: r.len, fresh: r.fresh, coords: r.coords, isNew: r.isNew }));
  },
};

self.onmessage = async e => {
  const { id, fn, arg } = e.data;
  try { postMessage({ id, ok: await api[fn](arg, (...p) => postMessage({ id, prog: p })) }); }
  catch (err) { postMessage({ id, err: err?.message || String(err) }); }
};
