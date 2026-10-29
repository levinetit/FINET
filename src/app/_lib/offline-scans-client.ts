/**
 * Orchestrarea cozii offline în browser (Faza 9, ADR 0020): un singur obiect pe filă, pornit de
 * `OfflineSync` (layout-ul autentificat) și folosit de pagina `/import`. Încarcă la pornire, la
 * evenimentul `online`, la mesajul Background Sync al service worker-ului și după pauza de
 * reîncercare; o singură trecere odată (în filă: un indicator; între file: Web Locks, dacă
 * există). Logica deciziilor e în `offline-scans.ts` (testată separat).
 */

import { CLIENT_HEADER_NAME, clientHeaderFor } from "./usage-client";
import {
  OFFLINE_SYNC_TAG,
  type Owner,
  type QueuedScan,
  type ScanStore,
  type UploadOutcome,
  enqueueProblem,
  flushScans,
  isOwnedBy,
  isQuotaError,
  nextDue,
  outcomeOf,
  ownerHeaders,
  purgeForeign,
  retryNow,
  uploadForm,
} from "./offline-scans";
import { IdbScanStore, hasIndexedDb } from "./offline-scans-idb";

/** Ce vede interfața despre o intrare (fără poze). */
export type ScanSummary = Readonly<{
  id: string;
  createdAt: number;
  longReceipt: boolean;
  files: number;
  state: QueuedScan["state"];
  errorCode: string | null;
  /** Aparține altei gospodării a aceluiași utilizator (nu se încarcă aici). */
  otherHousehold: boolean;
}>;

export type OfflineSnapshot = Readonly<{
  available: boolean;
  scans: readonly ScanSummary[];
  syncing: boolean;
  needsAuth: boolean;
}>;

/** Documentele confirmate de server la o încărcare din coadă (pentru lista „Încărcate recent”). */
export type UploadedDocuments = readonly Readonly<Record<string, unknown>>[];

export type EnqueueResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string }>;

const EMPTY: OfflineSnapshot = { available: false, scans: [], syncing: false, needsAuth: false };

async function uploadScan(scan: QueuedScan, sink: (docs: UploadedDocuments) => void) {
  // Proprietarul așteptat: serverul refuză (409 `owner_mismatch`) dacă sesiunea s-a schimbat.
  const headers: Record<string, string> = { ...ownerHeaders(scan) };
  const client = clientHeaderFor("/api/v1/documents");
  if (client) headers[CLIENT_HEADER_NAME] = client;
  let response: Response;
  try {
    response = await fetch("/api/v1/documents", {
      method: "POST",
      body: uploadForm(scan),
      credentials: "same-origin",
      cache: "no-store",
      headers,
    });
  } catch {
    return { kind: "network" } satisfies UploadOutcome;
  }
  const body = (await response.json().catch(() => null)) as {
    data?: { documents?: UploadedDocuments };
  } | null;
  if (response.ok && Array.isArray(body?.data?.documents)) sink(body.data.documents);
  return outcomeOf(response.status, body);
}

/**
 * Proprietarul sesiunii, citit de la server (`GET /api/v1/me`: utilizatorul și gospodăria
 * curentă, aceeași regulă ca la încărcare). `auth` = sesiune expirată; `null` = necunoscut
 * (rețea, eroare): nu se încarcă nimic în trecerea aceasta.
 */
async function sessionOwner(): Promise<Owner | "auth" | null> {
  try {
    const response = await fetch("/api/v1/me", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401 || response.status === 403) return "auth";
    if (!response.ok) return null;
    const body = (await response.json()) as {
      data?: { user?: { id?: unknown }; household?: { id?: unknown } | null };
    };
    const userId = body.data?.user?.id;
    const householdId = body.data?.household?.id;
    return typeof userId === "string" && typeof householdId === "string"
      ? { userId, householdId }
      : null;
  } catch {
    return null;
  }
}

class OfflineScans {
  private store: ScanStore | null = null;
  private owner: Owner | null = null;
  private snapshot: OfflineSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly uploadListeners = new Set<(docs: UploadedDocuments) => void>();
  private flushing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private detach: (() => void) | null = null;

  constructor(private readonly makeStore: () => ScanStore | null) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): OfflineSnapshot => this.snapshot;
  getServerSnapshot = (): OfflineSnapshot => EMPTY;

  onUploaded(fn: (docs: UploadedDocuments) => void): () => void {
    this.uploadListeners.add(fn);
    return () => this.uploadListeners.delete(fn);
  }

  /** Pornește (sau schimbă proprietarul): curăță intrările altor utilizatori, apoi încarcă. */
  async start(owner: Owner): Promise<void> {
    const changed =
      this.owner?.userId !== owner.userId || this.owner?.householdId !== owner.householdId;
    this.owner = owner;
    if (!this.store) this.store = this.makeStore();
    if (!this.store) return;
    if (!this.detach) this.attach();
    if (changed) {
      try {
        await purgeForeign(this.store, owner.userId, Date.now());
      } catch {
        // depozit indisponibil: rămâne gol
      }
    }
    await this.refresh();
    void this.flush();
  }

  private attach() {
    const onOnline = () => void this.flush();
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type === "FINET_SYNC_SCANS") void this.flush();
    };
    window.addEventListener("online", onOnline);
    navigator.serviceWorker?.addEventListener("message", onMessage);
    this.detach = () => {
      window.removeEventListener("online", onOnline);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
    };
  }

  private emit(next: Partial<OfflineSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const fn of this.listeners) fn();
  }

  private async refresh(): Promise<QueuedScan[]> {
    if (!this.store || !this.owner) return [];
    let all: QueuedScan[] = [];
    try {
      all = await this.store.list();
    } catch {
      this.emit({ available: false, scans: [] });
      return [];
    }
    const owner = this.owner;
    const mine = all.filter((s) => s.userId === owner.userId);
    this.emit({
      available: true,
      scans: mine.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        longReceipt: s.longReceipt,
        files: s.files.length,
        state: s.state,
        errorCode: s.errorCode,
        otherHousehold: !isOwnedBy(s, owner),
      })),
    });
    return all;
  }

  /** Salvează o încărcare în coadă (offline sau după o eroare de rețea). */
  async enqueue(
    files: readonly File[],
    longReceipt: boolean,
    maxFileBytes: number,
  ): Promise<EnqueueResult> {
    if (!this.store || !this.owner) return { ok: false, code: "offline_unavailable" };
    let existing: QueuedScan[];
    try {
      existing = await this.store.list();
    } catch {
      return { ok: false, code: "offline_unavailable" };
    }
    const problem = enqueueProblem(existing, files, maxFileBytes);
    if (problem) return { ok: false, code: problem };
    const now = Date.now();
    const scan: QueuedScan = {
      id: crypto.randomUUID(),
      userId: this.owner.userId,
      householdId: this.owner.householdId,
      createdAt: now,
      longReceipt,
      files: files.map((f) => ({ type: f.type, size: f.size, data: f })),
      state: "pending",
      attempts: 0,
      nextAttemptAt: now,
      errorCode: null,
    };
    try {
      await this.store.put(scan);
    } catch (error) {
      if (!isQuotaError(error)) return { ok: false, code: "offline_unavailable" };
      // Cota browserului: curățăm intrările expirate și ale altor utilizatori, o singură reîncercare.
      try {
        await purgeForeign(this.store, this.owner.userId, now);
        await this.store.put(scan);
      } catch {
        await this.refresh();
        return { ok: false, code: "offline_quota" };
      }
    }
    await this.refresh();
    this.registerSync();
    void this.flush();
    return { ok: true };
  }

  private registerSync() {
    // Background Sync (Chromium): doar un semnal suplimentar; coada nu depinde de el.
    navigator.serviceWorker?.ready
      .then((reg) => {
        const sync = (
          reg as ServiceWorkerRegistration & {
            sync?: { register(tag: string): Promise<void> };
          }
        ).sync;
        return sync?.register(OFFLINE_SYNC_TAG);
      })
      .catch(() => undefined);
  }

  async remove(id: string): Promise<void> {
    if (!this.store) return;
    try {
      await this.store.remove(id);
    } catch {
      // mai jos
    }
    await this.refresh();
  }

  async retry(id: string): Promise<void> {
    if (!this.store) return;
    try {
      const scan = (await this.store.list()).find((s) => s.id === id);
      if (scan) await this.store.put(retryNow(scan, Date.now()));
    } catch {
      // mai jos
    }
    this.emit({ needsAuth: false });
    await this.refresh();
    void this.flush();
  }

  /** O trecere prin coadă (ignorată dacă alta rulează deja în filă sau în altă filă). */
  async flush(): Promise<void> {
    const store = this.store;
    const initial = this.owner;
    if (!store || !initial || this.flushing) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let owner: Owner = initial;
    this.flushing = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = async () => {
      this.emit({ syncing: true });
      try {
        // Înainte de fiecare trecere: proprietarul sesiunii, recitit de la server (între timp se
        // poate comuta gospodăria în altă filă sau se poate autentifica alt cont).
        const current = await sessionOwner();
        if (current === "auth") {
          this.emit({ needsAuth: true });
          return;
        }
        if (!current) return;
        if (current.userId !== owner.userId || current.householdId !== owner.householdId) {
          this.owner = current;
          if (current.userId !== owner.userId) {
            await purgeForeign(store, current.userId, Date.now());
          }
          owner = current;
        }
        const result = await flushScans(store, {
          owner,
          now: () => Date.now(),
          upload: (scan) =>
            uploadScan(scan, (docs) => this.uploadListeners.forEach((fn) => fn(docs))),
        });
        this.emit({ needsAuth: result.needsAuth });
        if (result.ownerStale) {
          // Serverul a refuzat ca „străină” o intrare: proprietarul se recitește la trecerea următoare.
          const fresh = await sessionOwner();
          if (fresh && fresh !== "auth") {
            if (fresh.userId !== owner.userId) await purgeForeign(store, fresh.userId, Date.now());
            this.owner = fresh;
            owner = fresh;
          }
        }
      } catch {
        // depozit indisponibil: următoarea ocazie
      }
    };
    try {
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (locks) {
        await locks.request("finet-offline-scans", { ifAvailable: true }, async (lock) => {
          if (lock) await run();
        });
      } else {
        await run();
      }
    } finally {
      this.flushing = false;
      const all = await this.refresh();
      this.emit({ syncing: false });
      this.schedule(all, owner);
    }
  }

  private schedule(all: readonly QueuedScan[], owner: Owner) {
    if (this.snapshot.needsAuth) return;
    const due = nextDue(all, owner);
    if (due === null) return;
    const delay = Math.max(1000, due - Date.now());
    this.timer = setTimeout(() => void this.flush(), Math.min(delay, 2_147_000_000));
  }
}

let instance: OfflineScans | null = null;

/** Obiectul cozii din această filă (creat la prima cerere; fără IndexedDB → indisponibil). */
export function offlineScans(): OfflineScans {
  if (!instance) instance = new OfflineScans(() => (hasIndexedDb() ? new IdbScanStore() : null));
  return instance;
}
