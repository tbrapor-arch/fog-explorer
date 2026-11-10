// Local-only storage (IndexedDB in this browser). Nothing here ever leaves the device.
// One connection is kept open and shared: opening a new one for every read was a large
// part of the app's sluggishness.
const DB = 'fog-explorer', STORE = 'kv';

let dbp = null;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = db.onclose = () => { try { db.close(); } catch (e) {} dbp = null; };
      res(db);
    };
    r.onerror = () => { dbp = null; rej(r.error); };
  });
}
async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    let t;
    try { t = db.transaction(STORE, mode); } catch (e) { dbp = null; rej(e); return; }
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
export const idbGet = k => tx('readonly', s => s.get(k)).catch(() => undefined);
export const idbSet = (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => undefined);
export const idbDel = k => tx('readwrite', s => s.delete(k)).catch(() => undefined);
// several keys in one transaction (much faster than one transaction per key)
export const idbGetMany = keys => tx('readonly', s => { const out = { result: new Array(keys.length) }; keys.forEach((k, i) => { s.get(k).onsuccess = e => (out.result[i] = e.target.result); }); return out; }).catch(() => keys.map(() => undefined));
// walks every key starting with `prefix`; fn(key, value, cursor) may call cursor.delete() or store.put()
export const idbEach = (prefix, fn) => tx('readwrite', s => {
  const r = s.openCursor(IDBKeyRange.bound(prefix, prefix + '￿'));
  r.onsuccess = () => { const c = r.result; if (!c) return; fn(c.key, c.value, c, s); c.continue(); };
}).catch(() => undefined);
export async function closeDb() { if (dbp) { try { (await dbp).close(); } catch (e) {} dbp = null; } }
export async function wipeAll() {
  try { localStorage.clear(); } catch (e) {}
  try { sessionStorage.clear(); } catch (e) {}
  await closeDb();
  await new Promise(res => { const r = indexedDB.deleteDatabase(DB); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}
export const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
