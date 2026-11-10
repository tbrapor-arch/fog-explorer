// Fog of World data decoding.
// Format (same as the app's cloud "Sync" folder and the Model/* folder of a .fwss snapshot):
//  - world split in 512x512 tiles, each tile in 128x128 blocks, each block a 64x64 bitmap
//    => 2^22 pixels around the world (~6 m per pixel in Île-de-France), web-mercator aligned.
//  - file = zlib( header: 128*128 uint16 LE block indexes (1-based, 0 = empty) + n * 515-byte blocks )
//  - a block = 512 bytes bitmap (8 bytes per row, MSB first) + 3 bytes of metadata.
//  - file name = 4 hex chars + tile id written with the digit mask "olhwjsktri" + 2 check chars.

export const TILE_W = 512, BLOCK_W = 128, BMP_W = 64;
export const WORLD = TILE_W * BLOCK_W * BMP_W; // 4194304 = 256 * 2^14
const MASK = 'olhwjsktri';
const HEADER = BLOCK_W * BLOCK_W * 2;
const BLOCK_BYTES = 515;

export function tileIdFromName(name) {
  if (!/^[0-9a-f]{4}[olhwjsktri]+[eizxdwknmo]{2}$/.test(name)) return null;
  let d = '';
  for (const c of name.slice(4, -2)) d += MASK.indexOf(c);
  const id = Number(d);
  return Number.isFinite(id) && id < TILE_W * TILE_W ? id : null;
}

export async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Explored pixels, stored per block. key = gbx * 65536 + gby (global block coords < 65536)
export class FogMap {
  constructor() { this.blocks = new Map(); }
  get size() { return this.blocks.size; }

  // Returns number of blocks added, or -1 if the buffer is not a fog tile.
  addTile(tileId, data) {
    if (data.length < HEADER || (data.length - HEADER) % BLOCK_BYTES !== 0) return -1;
    const n = (data.length - HEADER) / BLOCK_BYTES;
    const tx = tileId % TILE_W, ty = Math.floor(tileId / TILE_W);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let added = 0; this._count = undefined;
    for (let i = 0; i < BLOCK_W * BLOCK_W; i++) {
      const idx = dv.getUint16(i * 2, true);
      if (!idx) continue;
      if (idx > n) return -1;
      const off = HEADER + (idx - 1) * BLOCK_BYTES;
      const bmp = data.slice(off, off + 512);
      const gbx = tx * BLOCK_W + (i % BLOCK_W), gby = ty * BLOCK_W + Math.floor(i / BLOCK_W);
      const key = gbx * 65536 + gby;
      const prev = this.blocks.get(key);
      if (prev) for (let k = 0; k < 512; k++) prev[k] |= bmp[k];
      else { this.blocks.set(key, bmp); added++; }
    }
    return added;
  }

  isSet(gx, gy) {
    const b = this.blocks.get((gx >> 6) * 65536 + (gy >> 6));
    if (!b) return false;
    const x = gx & 63, y = gy & 63;
    return (b[y * 8 + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
  }

  // explored within r pixels (square) of a lon/lat
  near(lon, lat, r = 2) {
    const [gx, gy] = lonLatToPx(lon, lat);
    const x = Math.floor(gx), y = Math.floor(gy);
    const x0 = x - r, x1 = x + r, y0 = y - r, y1 = y + r;
    // usual case: the whole window is inside one block, so read its bitmap directly
    if ((x0 >> 6) === (x1 >> 6) && (y0 >> 6) === (y1 >> 6)) {
      const b = this.blocks.get((x0 >> 6) * 65536 + (y0 >> 6));
      if (!b) return false;
      const lx0 = x0 & 63, lx1 = x1 & 63;
      for (let ly = y0 & 63, le = y1 & 63; ly <= le; ly++) {
        const o = ly * 8;
        for (let lx = lx0; lx <= lx1; lx++) if (b[o + (lx >> 3)] & (0x80 >> (lx & 7))) return true;
      }
      return false;
    }
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (this.isSet(x + dx, y + dy)) return true;
    return false;
  }

  countPixels() {
    if (this._count !== undefined) return this._count;
    let c = 0;
    for (const b of this.blocks.values()) for (let k = 0; k < 512; k++) { let v = b[k]; while (v) { v &= v - 1; c++; } }
    return (this._count = c);
  }

  // compact serialization for IndexedDB
  serialize() {
    const keys = new Float64Array(this.blocks.size), data = new Uint8Array(this.blocks.size * 512);
    let i = 0;
    for (const [k, b] of this.blocks) { keys[i] = k; data.set(b, i * 512); i++; }
    return { keys, data };
  }
  static deserialize({ keys, data }) {
    const f = new FogMap();
    for (let i = 0; i < keys.length; i++) f.blocks.set(keys[i], data.subarray(i * 512, i * 512 + 512)); // views, no copy
    return f;
  }
}

export function lonLatToPx(lon, lat) {
  const x = (lon + 180) / 360 * WORLD;
  const s = Math.sin(lat * Math.PI / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
  return [x, y];
}

// .fwss snapshot = zip; tiles live in "Model/*/". Needs JSZip (global in browser, passed in node).
export async function fogFromSnapshot(arrayBuffer, JSZipLib = globalThis.JSZip) {
  const zip = await JSZipLib.loadAsync(arrayBuffer);
  const fog = new FogMap();
  let files = 0;
  for (const path of Object.keys(zip.files)) {
    const m = path.match(/^Model\/\*\/([^/]+)$/);
    if (!m) continue;
    const id = tileIdFromName(m[1]);
    if (id === null) continue;
    try {
      const raw = await inflate(await zip.files[path].async('uint8array'));
      if (fog.addTile(id, raw) >= 0) files++;
    } catch (e) { /* skip unreadable file */ }
  }
  if (!files) throw new Error("Aucune donnée Fog of World trouvée dans ce fichier. Vérifie que c'est bien un snapshot .fwss.");
  return fog;
}
