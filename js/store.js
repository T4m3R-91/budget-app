// The phone's own small database (IndexedDB), for working offline:
//   outbox: entries saved without a connection, waiting to be sent (see outbox.js)
//   cache:  the last data each screen loaded, shown when the server can't be reached (see offline.js)

const NAME = "household-budget";
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("outbox", { keyPath: "id" });
      req.result.createObjectStore("cache", { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function run(store, mode, work) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = work(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const idbGet = (store, key) => run(store, "readonly", (s) => s.get(key));
export const idbAll = (store) => run(store, "readonly", (s) => s.getAll());
export const idbPut = (store, value) => run(store, "readwrite", (s) => s.put(value));
export const idbDelete = (store, key) => run(store, "readwrite", (s) => s.delete(key));
export const idbClear = (store) => run(store, "readwrite", (s) => s.clear());
