#!/usr/bin/env python3
"""Builds the commune limits served with the app (public data from geo.api.gouv.fr, no personal data).

Every commune of Île-de-France plus the 20 arrondissements of Paris, in one gzipped JSON:
  {"v":1, "date":"YYYY-MM-DD", "c":[[code, nom, codePostal, population, polygons]]}
  polygons = [[ring, ...], ...]; a ring is a flat list of integers in 1e-5 degrees (~1 m),
  lon/lat interleaved, delta-encoded.
The app saves this file on the phone, so opening a commune, searching one by name or finding
the commune you are standing in needs no network and tells no server where you are looking.

Usage: build_communes.py build OUTDIR
       build_communes.py publish OUTDIR SITE_DATA_DIR   (copies the file, declares it in manifest.json)
"""
import gzip, json, os, shutil, sys, time, urllib.request

API = 'https://geo.api.gouv.fr/communes'
FIELDS = 'fields=nom,code,codesPostaux,population&format=geojson&geometry=contour'
Q = 1e5


def get(url):
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'fog-explorer-build'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (attempt + 1))
    raise SystemExit(f'geo.api.gouv.fr unreachable: {last}')


def ring(coords):
    out, px, py = [], 0, 0
    for lon, lat in coords:
        x, y = round(lon * Q), round(lat * Q)
        if out and x == px and y == py:
            continue
        out += [x - px, y - py]
        px, py = x, y
    return out


def encode(features):
    rows = []
    for f in features:
        g, p = f.get('geometry'), f['properties']
        if not g:
            continue
        polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        enc = [[ring(r) for r in poly] for poly in polys]
        enc = [[r for r in poly if len(r) >= 8] for poly in enc]
        enc = [poly for poly in enc if poly]
        if not enc:
            continue
        cps = sorted(p.get('codesPostaux') or [])
        rows.append([p['code'], p['nom'], cps[0] if cps else '', p.get('population') or 0, enc])
    rows.sort(key=lambda r: r[0])
    return rows


def build(region, arrondissements, date):
    feats = [f for f in region['features'] if f['properties']['code'] != '75056'] + arrondissements.get('features', [])
    return {'v': 1, 'date': date, 'c': encode(feats)}


def main(outdir):
    date = time.strftime('%Y-%m-%d')
    doc = build(get(f'{API}?codeRegion=11&{FIELDS}'),
                get(f'{API}?codeDepartement=75&type=arrondissement-municipal&{FIELDS}'), date)
    if len(doc['c']) < 1200:
        raise SystemExit(f"only {len(doc['c'])} communes: refusing to publish an incomplete file")
    data = gzip.compress(json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode(), 9)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, 'communes.json.gz'), 'wb') as f:
        f.write(data)
    with open(os.path.join(outdir, 'communes.meta.json'), 'w') as f:
        json.dump({'date': date, 'n': len(doc['c']), 'bytes': len(data)}, f)
    print(f"{len(doc['c'])} communes, {len(data) / 1e6:.2f} MB")


def publish(outdir, sitedata):
    """Copies the file next to the street data and declares it in the site's manifest.json."""
    meta = json.load(open(os.path.join(outdir, 'communes.meta.json')))
    shutil.copy(os.path.join(outdir, 'communes.json.gz'), os.path.join(sitedata, 'communes.json.gz'))
    mp = os.path.join(sitedata, 'manifest.json')
    m = json.load(open(mp))
    m['bytes'] = m.get('bytes', 0) + meta['bytes']
    m['communes'] = meta
    json.dump(m, open(mp, 'w'), separators=(',', ':'))
    print('manifest: communes', meta)


if __name__ == '__main__':
    if sys.argv[1] == 'publish':
        publish(sys.argv[2], sys.argv[3])
    else:
        main(sys.argv[2])
