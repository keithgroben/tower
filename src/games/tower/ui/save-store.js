/**
 * Where a saved tower lives in the browser.
 *
 * **IndexedDB, not localStorage**, and that is a measurement rather than a
 * preference. A 150-day tower snapshots to 752 kB — 84% of it the day log,
 * which the evaluation code genuinely reads all the way back, so it cannot be
 * trimmed. A day is 45 seconds at 1x, so Keith's six-hour tower is roughly 480
 * days and a couple of megabytes. localStorage caps an origin at about 5 MB
 * and stores UTF-16, which halves that again: the store would work all through
 * testing and fail on the first tower big enough to be worth keeping. That is
 * the same shape of bug as a number tuned for a mature tower that strands a
 * small one, pointed the other way.
 *
 * IndexedDB also stores the snapshot object directly — no `JSON.stringify` of
 * two megabytes on the main thread every autosave.
 *
 * Two object stores, deliberately:
 *   `meta`  — one small row per save, which is all the slot list ever reads
 *   `blobs` — the towers themselves, fetched only when one is loaded
 * Otherwise opening the list would pull every save in the store into memory.
 */

const DB_NAME = 'lift-saves';
const DB_VERSION = 1;
const META = 'meta';
const BLOBS = 'blobs';

/** The one slot the game writes to on its own. Reserved: a named save never takes it. */
export const AUTOSAVE_KEY = 'autosave';

/**
 * A tab-lifetime fallback. Anything that fails to reach IndexedDB — an
 * unavailable store on a file:// page, a locked-down private window, a write
 * that errors — still lands here, so the session keeps working. The panel says
 * which saves are only in memory rather than letting a player believe a tower
 * is safe when it is not.
 */
const memory = new Map();

/** True once the store is known to be unreachable, not merely slow. */
let unavailable = false;
export const isStorageUnavailable = () => unavailable;
export const memoryOnlyKeys = () => new Set(memory.keys());

let dbPromise = null;

function open() {
  if (unavailable) return Promise.reject(new Error('the browser has no usable save store'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') throw new Error('this browser has no IndexedDB');
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB refused to open'));
    request.onblocked = () => reject(new Error('another tab is holding an older save store open'));
  }).catch((error) => { dbPromise = null; unavailable = true; throw error; });
  return dbPromise;
}

/** A transaction as a promise that resolves only once the write is durable. */
function write(work) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction([META, BLOBS], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('the save store aborted the write'));
    try { work(tx.objectStore(META), tx.objectStore(BLOBS)); }
    catch (error) { try { tx.abort(); } catch { /* already aborting */ } reject(error); }
  }));
}

const read = (store, work) => open().then((db) => new Promise((resolve, reject) => {
  const request = work(db.transaction(store, 'readonly').objectStore(store));
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
}));

const byNewest = (a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0);

/**
 * Rows for the slot list, newest first. Never touches the tower blobs.
 * Memory rows are merged in and win on a shared key, so a save that failed to
 * reach the store is still listed and still loadable this session.
 */
export async function listSaves() {
  let rows = [];
  try { rows = await read(META, (store) => store.getAll()); }
  catch { /* the store is gone; memory is all there is */ }
  const merged = new Map(rows.map((row) => [row.key, row]));
  for (const [key, held] of memory) merged.set(key, held.meta);
  return [...merged.values()].sort(byNewest);
}

export async function readSave(key) {
  const held = memory.get(key);
  if (held) return held.blob;
  try { return (await read(BLOBS, (store) => store.get(key))) ?? null; }
  catch { return null; }
}

/**
 * Write a save. Returns `{meta, durable}` — `durable: false` means the tower is
 * in this tab and nowhere else, which the caller has to say out loud.
 *
 * A full disk throws `QuotaExceededError`, the one storage failure a player can
 * act on, so it is reported in those words rather than folded into "save
 * failed". It is also the one case that does NOT fall back to memory: pretending
 * to save when the browser just told you there is no room is the lie this whole
 * module exists to avoid.
 */
export async function writeSave(key, blob, { name = '' } = {}) {
  const meta = {
    key,
    name: name || (key === AUTOSAVE_KEY ? 'autosave' : 'save'),
    savedAt: blob.savedAt ?? Date.now(),
    summary: blob.summary ?? null,
    version: blob.version,
  };
  try {
    await write((metaStore, blobStore) => { metaStore.put(meta); blobStore.put(blob, key); });
    memory.delete(key);   // it reached the store; the fallback copy is now stale
    return { meta, durable: true };
  } catch (error) {
    if (error?.name === 'QuotaExceededError') {
      throw new Error('there is no room left in this browser’s storage for another tower. '
        + 'Delete a save, or export one to a file and delete it here.');
    }
    memory.set(key, { meta, blob });
    return { meta, durable: false, reason: error?.message ?? 'the browser refused to store it' };
  }
}

export async function deleteSave(key) {
  memory.delete(key);
  try { await write((metaStore, blobStore) => { metaStore.delete(key); blobStore.delete(key); }); }
  catch { /* already gone, or the store is unavailable — nothing to undo */ }
}

/** Ids are generated, never derived from the name: two towers may share a name. */
export const newSaveKey = () => 'save-' + Date.now().toString(36) + '-'
  + Math.floor(Math.random() * 1e6).toString(36);
