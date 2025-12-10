// storage.js — IDB + localStorage helper for stats and UI state
export async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('local-player-db', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('store')) db.createObjectStore('store');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function idbPut(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readwrite');
    tx.objectStore('store').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
export async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readonly');
    const r = tx.objectStore('store').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('store', 'readwrite');
    tx.objectStore('store').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// stats (localStorage)
const STATS_KEY = 'localPlayerStats_v1';
export function loadStats() {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('loadStats', e);
    return {};
  }
}
export function saveStats(stats) {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch (e) {
    console.error('saveStats', e);
  }
}

// UI state (localStorage)
const UI_KEY = 'localPlayerUI_v1';
export function loadUIState() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    return raw ? JSON.parse(raw) : { playlistCollapsed: true, sortKey: 'default', sortDir: 'desc', autoNormalize: true };
  } catch (e) {
    return { playlistCollapsed: true, sortKey: 'default', sortDir: 'desc', autoNormalize: true };
  }
}
export function saveUIState(uiState) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(uiState));
  } catch (e) { console.error('saveUIState', e); }
}

// Session state (localStorage) - tracks which songs have been played in current session
const SESSION_KEY = 'localPlayerSession_v1';
export function loadSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : { playedInCurrentSession: [] };
  } catch (e) {
    return { playedInCurrentSession: [] };
  }
}
export function saveSessionState(sessionState) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessionState));
  } catch (e) { console.error('saveSessionState', e); }
}