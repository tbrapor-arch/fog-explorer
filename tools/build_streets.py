#!/usr/bin/env python3
"""Builds the street data served with the app, from an OpenStreetMap extract (.osm.pbf).

Keeps only what a walker can use (same filter as the app's live Overpass query), cut in
tiles of 0.04° lat x 0.06° lon (~4.4 km), one gzipped JSON per tile:
  {"v":1, "h":[highway types], "n":[names], "w":[[id, h, n, width, node_id_deltas, coord_deltas]]}
coords are integers in 1e-5 degrees (~1 m), lon/lat interleaved, delta-encoded inside each way.
Also writes stations.json.gz and manifest.json (date, tiles and their sizes).

No personal data here: this is public map data only.
"""
import collections, gzip, json, math, os, sys, time
import osmium

ROADS = set('primary primary_link secondary secondary_link tertiary tertiary_link unclassified residential living_street pedestrian road service'.split())
PATHS = set('footway path steps track cycleway bridleway'.split())
BAD_SERVICE = {'parking_aisle', 'driveway', 'drive-through', 'emergency_access'}
TL, TO = 0.04, 0.06
Q = 1e5


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.tiles = collections.defaultdict(list)
        self.stations = []
        self.nways = 0

    def node(self, n):
        t = n.tags
        r = t.get('railway')
        name = t.get('name')
        if not name or r not in ('station', 'halt', 'tram_stop'):
            return
        st = t.get('station')
        kind = 'tram' if r == 'tram_stop' or st == 'light_rail' else 'métro' if st == 'subway' else 'train / RER'
        self.stations.append([name, round(n.location.lon, 5), round(n.location.lat, 5), kind])

    def way(self, w):
        t = w.tags
        hw = t.get('highway')
        if hw not in ROADS and hw not in PATHS:
            return
        if t.get('access') in ('private', 'no') or t.get('foot') in ('no', 'private'):
            return
        if t.get('service') in BAD_SERVICE or t.get('footway') in ('sidewalk', 'crossing') or t.get('area') == 'yes':
            return
        try:
            pts = [(n.ref, n.lon, n.lat) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2:
            return
        rec = (w.id, hw, t.get('name', ''), t.get('width', ''), pts)
        for k in {(math.floor(lon / TO), math.floor(lat / TL)) for _, lon, lat in pts}:
            self.tiles[k].append(rec)
        self.nways += 1


def encode(recs):
    hs, ns, hi, ni, out = [], [], {}, {}, []
    for wid, hw, name, width, pts in recs:
        if hw not in hi: hi[hw] = len(hs); hs.append(hw)
        if name and name not in ni: ni[name] = len(ns); ns.append(name)
        ids, cs, pid, px, py = [], [], 0, 0, 0
        for ref, lon, lat in pts:
            x, y = round(lon * Q), round(lat * Q)
            ids.append(ref - pid); cs.append(x - px); cs.append(y - py)
            pid, px, py = ref, x, y
        out.append([wid, hi[hw], ni[name] if name else -1, width, ids, cs])
    return {'v': 1, 'h': hs, 'n': ns, 'w': out}


def main(pbf, outdir):
    t0 = time.time()
    h = H()
    h.apply_file(pbf, locations=True, idx='flex_mem')
    os.makedirs(os.path.join(outdir, 't'), exist_ok=True)
    tiles, total = {}, 0
    for (x, y), recs in h.tiles.items():
        data = gzip.compress(json.dumps(encode(recs), ensure_ascii=False, separators=(',', ':')).encode(), 9)
        key = f'{x}_{y}'
        with open(os.path.join(outdir, 't', key + '.json.gz'), 'wb') as f:
            f.write(data)
        tiles[key] = len(data); total += len(data)
    st = gzip.compress(json.dumps(h.stations, ensure_ascii=False, separators=(',', ':')).encode(), 9)
    with open(os.path.join(outdir, 'stations.json.gz'), 'wb') as f:
        f.write(st)
    manifest = {'v': 1, 'date': time.strftime('%Y-%m-%d'), 'tileLat': TL, 'tileLon': TO,
                'tiles': tiles, 'bytes': total + len(st), 'ways': h.nways, 'stations': len(h.stations)}
    with open(os.path.join(outdir, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, separators=(',', ':'))
    print(f'{h.nways} ways, {len(tiles)} tiles, {len(h.stations)} stations, {(total + len(st)) / 1e6:.1f} MB, {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
