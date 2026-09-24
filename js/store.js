// 端末内の保存（IndexedDB）。読み込んだ楽譜・パートごとの前回の点数・聞き直し用の録音だけを置く。外部送信なし。

import { takesToPrune } from './recorder.js';

const DB = 'gassho-renshu';
const STORE = 'scores';
const TAKES = 'takes';
export const MAX_TAKES = 5; // 楽譜ごとに残す録音の数

function open() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('NO_IDB')); return; }
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(TAKES)) db.createObjectStore(TAKES, { keyPath: 'id' }).createIndex('scoreId', 'scoreId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(name, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const st = t.objectStore(name);
    let result;
    Promise.resolve(fn(st)).then((r) => { result = r; });
    t.oncomplete = () => { db.close(); resolve(result); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error); };
  });
}

const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

export const store = {
  async list() {
    try {
      const all = await tx(STORE, 'readonly', (st) => wrap(st.getAll()));
      return (all || []).sort((a, b) => (b.openedAt || b.addedAt) - (a.openedAt || a.addedAt));
    } catch (_) { return []; }
  },
  async get(id) { return tx(STORE, 'readonly', (st) => wrap(st.get(id))); },
  async put(rec) { return tx(STORE, 'readwrite', (st) => wrap(st.put(rec))); },
  async remove(id) { await clearTakes(id).catch(() => {}); return tx(STORE, 'readwrite', (st) => wrap(st.delete(id))); },
};

// ---- 聞き直し用の録音 ----
/** その楽譜の録音（新しい順） */
export async function listTakes(scoreId) {
  try {
    const all = await tx(TAKES, 'readonly', (st) => wrap(st.index('scoreId').getAll(scoreId)));
    return (all || []).sort((a, b) => b.createdAt - a.createdAt);
  } catch (_) { return []; }
}
/** 保存して、古いもの（MAX_TAKES 件より前）を自動で消す */
export async function putTake(take) {
  await tx(TAKES, 'readwrite', (st) => wrap(st.put(take)));
  const all = await listTakes(take.scoreId);
  const drop = takesToPrune(all, take.scoreId, MAX_TAKES);
  for (const id of drop) await removeTake(id);
  return drop;
}
export async function removeTake(id) { return tx(TAKES, 'readwrite', (st) => wrap(st.delete(id))); }
export async function clearTakes(scoreId) {
  const all = await listTakes(scoreId);
  for (const t of all) await removeTake(t.id);
  return all.length;
}

/** 同じ中身の楽譜を二重に保存しないための簡単なハッシュ */
export function hashText(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}
