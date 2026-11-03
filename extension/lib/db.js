// IndexedDB wrapper shared by the service worker, offscreen document and extension pages.
const NAME = 'sap-process-recorder';
let dbPromise = null;

export function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      const has = (n) => d.objectStoreNames.contains(n);
      if (!has('sessions')) d.createObjectStore('sessions', { keyPath: 'id' });
      if (!has('events')) d.createObjectStore('events', { keyPath: ['sessionId', 'seq'] });
      if (!has('shots')) d.createObjectStore('shots', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      if (!has('audio')) d.createObjectStore('audio', { keyPath: ['sessionId', 'seq'] });
      // v2: speech-to-text runs (raw ASR output is never overwritten; normalisation is stored beside it)
      if (!has('transcripts')) d.createObjectStore('transcripts', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// Only await IndexedDB requests inside fn, otherwise the transaction auto-commits.
async function run(stores, mode, fn) {
  const d = await openDb();
  const t = d.transaction(stores, mode);
  const done = new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
  const out = await fn(t);
  await done;
  return out;
}

const range = (sid) => IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);

export const putSession = (s) => run('sessions', 'readwrite', (t) => wrap(t.objectStore('sessions').put(s)));
export const getSession = (id) => run('sessions', 'readonly', (t) => wrap(t.objectStore('sessions').get(id)));
export const listSessions = () => run('sessions', 'readonly', (t) => wrap(t.objectStore('sessions').getAll()));

export const putEvent = (e) => run('events', 'readwrite', (t) => wrap(t.objectStore('events').put(e)));
export const listEvents = (sid) => run('events', 'readonly', (t) => wrap(t.objectStore('events').getAll(range(sid))));
export const countEvents = (sid) => run('events', 'readonly', (t) => wrap(t.objectStore('events').count(range(sid))));
export const deleteEvent = (sid, seq) => run('events', 'readwrite', (t) => wrap(t.objectStore('events').delete([sid, seq])));
export const updateEvent = (sid, seq, fn) => run('events', 'readwrite', async (t) => {
  const st = t.objectStore('events');
  const e = await wrap(st.get([sid, seq]));
  if (!e) return null;
  fn(e);
  await wrap(st.put(e));
  return e;
});

export const putShot = (s) => run('shots', 'readwrite', (t) => wrap(t.objectStore('shots').put(s)));
export const getShot = (id) => run('shots', 'readonly', (t) => wrap(t.objectStore('shots').get(id)));
export const deleteShot = (id) => run('shots', 'readwrite', (t) => wrap(t.objectStore('shots').delete(id)));
export const listShotIds = (sid) => run('shots', 'readonly', (t) => wrap(t.objectStore('shots').index('sessionId').getAllKeys(sid)));

export const putAudio = (a) => run('audio', 'readwrite', (t) => wrap(t.objectStore('audio').put(a)));
export const listAudio = (sid) => run('audio', 'readonly', (t) => wrap(t.objectStore('audio').getAll(range(sid))));

export const putTranscript = (r) => run('transcripts', 'readwrite', (t) => wrap(t.objectStore('transcripts').put(r)));
export const getTranscript = (id) => run('transcripts', 'readonly', (t) => wrap(t.objectStore('transcripts').get(id)));
export const listTranscripts = (sid) => run('transcripts', 'readonly', (t) => wrap(t.objectStore('transcripts').index('sessionId').getAll(sid)));
export const deleteTranscript = (id) => run('transcripts', 'readwrite', (t) => wrap(t.objectStore('transcripts').delete(id)));

export const deleteSession = (sid) => run(['sessions', 'events', 'shots', 'audio', 'transcripts'], 'readwrite', async (t) => {
  const tr = t.objectStore('transcripts');
  (await wrap(tr.index('sessionId').getAllKeys(sid))).forEach((k) => tr.delete(k));
  t.objectStore('sessions').delete(sid);
  t.objectStore('events').delete(range(sid));
  t.objectStore('audio').delete(range(sid));
  const shots = t.objectStore('shots');
  const keys = await wrap(shots.index('sessionId').getAllKeys(sid));
  keys.forEach((k) => shots.delete(k));
});
