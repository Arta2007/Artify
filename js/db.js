// Tiny IndexedDB wrapper. Stores: tracks (metadata), files (audio blobs), art (cover blobs), playlists,
// history (listening log for stats), lyrics (text keyed by track id), kv (small app data such as folders).
const NAME = 'stash';
const VERSION = 3;
let dbp = null;

function open() {
  return dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      const stores = [['tracks', { keyPath: 'id' }], ['files'], ['art'], ['playlists', { keyPath: 'id' }],
        ['history', { keyPath: 'k', autoIncrement: true }], ['lyrics'], ['kv']];
      for (const [name, opts] of stores) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts);
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onversionchange = () => d.close();
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return open().then(d => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    let out;
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

export const get = (store, key) => tx(store, 'readonly', s => s.get(key));
export const all = store => tx(store, 'readonly', s => s.getAll());
export const put = (store, value, key) => tx(store, 'readwrite', s => (key === undefined ? s.put(value) : s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', s => s.delete(key));
export const keys = store => tx(store, 'readonly', s => s.getAllKeys());

export async function wipe() {
  if (dbp) (await dbp).close();
  dbp = null;
  await new Promise(r => {
    const q = indexedDB.deleteDatabase(NAME);
    q.onsuccess = q.onerror = q.onblocked = () => r();
  });
}
