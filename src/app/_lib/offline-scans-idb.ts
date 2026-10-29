/**
 * `ScanStore` peste IndexedDB (Faza 9, ADR 0020). Baza `finet-offline`, depozitul `scans`
 * (cheia `id`); pozele stau ca `Blob` (nu ca `data:` URL). Aceeași schemă e citită de
 * `public/pwa/offline.js` (doar numărul intrărilor). Fiecare operație e o tranzacție proprie:
 * o eroare de cotă anulează scrierea întreagă, deci nu rămân intrări pe jumătate.
 */

import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_STORE,
  type QueuedScan,
  type ScanStore,
} from "./offline-scans";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("idb"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("idb abort"));
    tx.onerror = () => reject(tx.error ?? new Error("idb"));
  });
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) {
          db.createObjectStore(OFFLINE_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // O altă filă cere o versiune nouă: închidem, ca upgrade-ul să nu fie blocat.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = null;
        reject(req.error ?? new Error("idb open"));
      };
      req.onblocked = () => {
        opening = null;
        reject(new Error("idb blocked"));
      };
    });
  }
  return opening;
}

/** IndexedDB există (lipsește în unele moduri private sau e blocat de politici)? */
export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

export class IdbScanStore implements ScanStore {
  async list(): Promise<QueuedScan[]> {
    const db = await open();
    const tx = db.transaction(OFFLINE_STORE, "readonly");
    const all = (await request(tx.objectStore(OFFLINE_STORE).getAll())) as QueuedScan[];
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }

  async put(scan: QueuedScan): Promise<void> {
    const db = await open();
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    tx.objectStore(OFFLINE_STORE).put(scan);
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await open();
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    tx.objectStore(OFFLINE_STORE).delete(id);
    await done(tx);
  }

  async clear(): Promise<void> {
    const db = await open();
    const tx = db.transaction(OFFLINE_STORE, "readwrite");
    tx.objectStore(OFFLINE_STORE).clear();
    await done(tx);
  }
}

/**
 * La deconectare: șterge TOATĂ baza (`deleteDatabase`, care nu o creează dacă lipsește). Conexiunea
 * proprie se închide întâi; celelalte file o închid la `versionchange`. Erorile și blocajele sunt
 * înghițite după cel mult 2 s: deconectarea nu se blochează.
 */
export async function clearOfflineScans(): Promise<void> {
  if (!hasIndexedDb()) return;
  try {
    if (opening) (await opening.catch(() => null))?.close();
  } catch {
    // mai jos
  }
  opening = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      const req = indexedDB.deleteDatabase(OFFLINE_DB_NAME);
      req.onsuccess = finish;
      req.onerror = finish;
    } catch {
      finish();
    }
  });
}
