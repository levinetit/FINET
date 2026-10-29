/**
 * Coada scanărilor offline (Faza 9, ADR 0020): logica pură, fără React, fără IndexedDB și fără
 * rețea (le primește ca dependențe), deci testabilă în Node (`offline-scans.test.ts`, cu
 * `MemoryScanStore`). Implementarea IndexedDB: `offline-scans-idb.ts`; orchestrarea în browser:
 * `offline-scans-client.ts`.
 *
 * Reguli:
 * - o intrare = O cerere de încărcare (bonul lung își păstrează pozele și ordinea împreună);
 * - fiecare intrare poartă utilizatorul și gospodăria în care a fost făcută; se încarcă DOAR când
 *   ambele coincid cu sesiunea curentă (pozele lui A nu ajung niciodată în gospodăria lui B);
 * - o intrare se șterge local DOAR după confirmarea serverului (2xx; un duplicat exact întoarce
 *   200 cu `duplicate: true`, deci a doua încărcare nu creează nimic: deduplicarea SHA-256 a
 *   serverului, inclusiv pentru reîncercarea unui bon lung, ADR 0020);
 * - erorile permanente (400/413/415/422, conflictele care nu se rezolvă singure) rămân vizibile,
 *   cu motivul și acțiunile „Reîncearcă” / „Șterge”;
 * - 401/403 (sesiune sau Access expirate): intrarea rămâne, sincronizarea se oprește până la
 *   următorul prilej (reconectare, deschiderea paginii);
 * - rețea, 429 și 5xx: reîncercare cu pauză crescătoare (2 s … 5 min).
 */

export const OFFLINE_DB_NAME = "finet-offline";
export const OFFLINE_DB_VERSION = 1;
export const OFFLINE_STORE = "scans";
/** Eticheta Background Sync (aceeași în `src/pwa/sw-source.ts`). */
export const OFFLINE_SYNC_TAG = "finet-offline-scans";

/** Doar poze (master prompt, Faza 9): PDF-urile și WebP-ul se încarcă doar online. */
export const OFFLINE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);
/** Plafoane locale (decizia mea): 10 încărcări în așteptare, 50 MB în total, 7 zile. */
export const OFFLINE_MAX_ENTRIES = 10;
export const OFFLINE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const OFFLINE_TTL_MS = 7 * 24 * 3600 * 1000;
export const BACKOFF_MIN_MS = 2000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
/** Limita zilnică de documente: următoarea încercare peste o oră. */
export const DAILY_LIMIT_RETRY_MS = 3600 * 1000;

export type QueuedFile = Readonly<{ type: string; size: number; data: Blob }>;

export type QueuedScan = Readonly<{
  id: string;
  userId: string;
  householdId: string;
  createdAt: number;
  longReceipt: boolean;
  files: readonly QueuedFile[];
  state: "pending" | "failed";
  attempts: number;
  nextAttemptAt: number;
  /** Codul ultimei erori (stabil, fără conținut), afișat prin `ro.offline.errors`. */
  errorCode: string | null;
}>;

export type Owner = Readonly<{ userId: string; householdId: string }>;

/** Depozitul local. Implementările: IndexedDB (browser) și `MemoryScanStore` (teste). */
export interface ScanStore {
  list(): Promise<QueuedScan[]>;
  /** Adaugă sau înlocuiește (după `id`). Aruncă `QuotaExceededError` dacă nu mai e spațiu. */
  put(scan: QueuedScan): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryScanStore implements ScanStore {
  private readonly items = new Map<string, QueuedScan>();
  /** Doar pentru teste: plafonul de octeți după care `put` aruncă `QuotaExceededError`. */
  quotaBytes = Number.POSITIVE_INFINITY;

  async list(): Promise<QueuedScan[]> {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }
  async put(scan: QueuedScan): Promise<void> {
    const others = [...this.items.values()].filter((s) => s.id !== scan.id);
    if (bytesOf([...others, scan]) > this.quotaBytes) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
    this.items.set(scan.id, scan);
  }
  async remove(id: string): Promise<void> {
    this.items.delete(id);
  }
  async clear(): Promise<void> {
    this.items.clear();
  }
}

export function bytesOf(scans: readonly QueuedScan[]): number {
  return scans.reduce((sum, s) => sum + s.files.reduce((n, f) => n + f.size, 0), 0);
}

export const isOwnedBy = (scan: QueuedScan, owner: Owner): boolean =>
  scan.userId === owner.userId && scan.householdId === owner.householdId;

export type EnqueueProblem =
  "offline_type" | "offline_too_large" | "offline_full" | "offline_space";

/** Verificările înainte de salvarea locală (serverul le refăce pe toate la încărcare). */
export function enqueueProblem(
  existing: readonly QueuedScan[],
  files: readonly Readonly<{ type: string; size: number }>[],
  maxFileBytes: number,
): EnqueueProblem | null {
  if (files.length === 0 || files.some((f) => !OFFLINE_TYPES.has(f.type))) return "offline_type";
  if (files.some((f) => f.size <= 0 || f.size > maxFileBytes)) return "offline_too_large";
  if (existing.length >= OFFLINE_MAX_ENTRIES) return "offline_full";
  const added = files.reduce((n, f) => n + f.size, 0);
  if (bytesOf(existing) + added > OFFLINE_MAX_TOTAL_BYTES) return "offline_space";
  return null;
}

export const isQuotaError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");

/** Pauza după `attempts` încercări eșuate: 2 s, 4 s, 8 s … plafonat la 5 minute. */
export function backoffDelay(attempts: number): number {
  if (!Number.isSafeInteger(attempts) || attempts <= 0) return BACKOFF_MIN_MS;
  let delay = BACKOFF_MIN_MS;
  for (let i = 1; i < attempts && delay < BACKOFF_MAX_MS; i++) delay *= 2;
  return Math.min(delay, BACKOFF_MAX_MS);
}

/** Rezultatul unei încercări de încărcare, așa cum îl vede coada. */
export type UploadOutcome =
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "response"; status: number; code: string | null }>;

export type Decision =
  | Readonly<{ action: "delete" }>
  | Readonly<{ action: "retry"; delayMs: number; code: string }>
  | Readonly<{ action: "auth" }>
  | Readonly<{ action: "fail"; code: string }>;

/** Ce face coada după un răspuns (tabelul din ADR 0020, testat cod cu cod). */
export function decide(outcome: UploadOutcome, attempts: number): Decision {
  if (outcome.kind === "network") {
    return { action: "retry", delayMs: backoffDelay(attempts), code: "offline_network" };
  }
  const { status, code } = outcome;
  if (status >= 200 && status < 300) return { action: "delete" };
  if (status === 401 || status === 403) return { action: "auth" };
  if (status === 429 || status === 408 || status >= 500) {
    return { action: "retry", delayMs: backoffDelay(attempts), code: "offline_server" };
  }
  if (status === 409 && code === "daily_document_limit") {
    return { action: "retry", delayMs: DAILY_LIMIT_RETRY_MS, code };
  }
  return { action: "fail", code: code ?? "generic" };
}

export type FlushDeps = Readonly<{
  owner: Owner;
  now: () => number;
  upload: (scan: QueuedScan) => Promise<UploadOutcome>;
}>;

export type FlushResult = Readonly<{
  uploaded: number;
  waiting: number;
  failed: number;
  /** Sesiunea sau Access au expirat: sincronizarea s-a oprit. */
  needsAuth: boolean;
}>;

/**
 * Șterge intrările altor utilizatori și pe cele expirate (TTL). Intrările aceluiași utilizator
 * din altă gospodărie rămân (se încarcă după comutarea înapoi sau se șterg manual).
 */
export async function purgeForeign(store: ScanStore, userId: string, now: number): Promise<void> {
  for (const scan of await store.list()) {
    if (scan.userId !== userId || now - scan.createdAt > OFFLINE_TTL_MS) {
      await store.remove(scan.id);
    }
  }
}

/** O trecere prin coadă: încarcă, în ordine, intrările scadente ale proprietarului curent. */
export async function flushScans(store: ScanStore, deps: FlushDeps): Promise<FlushResult> {
  let uploaded = 0;
  let needsAuth = false;
  for (const scan of await store.list()) {
    if (!isOwnedBy(scan, deps.owner) || scan.state !== "pending") continue;
    if (scan.nextAttemptAt > deps.now()) continue;
    let outcome: UploadOutcome;
    try {
      outcome = await deps.upload(scan);
    } catch {
      outcome = { kind: "network" };
    }
    const attempts = scan.attempts + 1;
    const decision = decide(outcome, attempts);
    if (decision.action === "delete") {
      await store.remove(scan.id);
      uploaded++;
    } else if (decision.action === "auth") {
      await store.put({ ...scan, attempts, errorCode: "offline_auth" });
      needsAuth = true;
      break;
    } else if (decision.action === "retry") {
      await store.put({
        ...scan,
        attempts,
        nextAttemptAt: deps.now() + decision.delayMs,
        errorCode: decision.code,
      });
    } else {
      await store.put({ ...scan, attempts, state: "failed", errorCode: decision.code });
    }
  }
  const rest = (await store.list()).filter((s) => isOwnedBy(s, deps.owner));
  return {
    uploaded,
    waiting: rest.filter((s) => s.state === "pending").length,
    failed: rest.filter((s) => s.state === "failed").length,
    needsAuth,
  };
}

/** Momentul următoarei încercări scadente a proprietarului (`null` = nimic de reîncercat). */
export function nextDue(scans: readonly QueuedScan[], owner: Owner): number | null {
  const due = scans
    .filter((s) => isOwnedBy(s, owner) && s.state === "pending")
    .map((s) => s.nextAttemptAt);
  return due.length === 0 ? null : Math.min(...due);
}

/** „Reîncearcă” pe o intrare cu eroare: înapoi în așteptare, scadentă imediat. */
export function retryNow(scan: QueuedScan, now: number): QueuedScan {
  return { ...scan, state: "pending", nextAttemptAt: now, errorCode: null };
}

/** Corpul cererii: exact ce trimite încărcarea online (`kind`, `longReceipt`, `files`). */
export function uploadForm(scan: QueuedScan): FormData {
  const form = new FormData();
  form.append("kind", "receipt");
  if (scan.longReceipt) form.append("longReceipt", "true");
  // Nume generice: serverul nu le folosește (le generează el).
  scan.files.forEach((f, i) => form.append("files", f.data, `bon-${i + 1}`));
  return form;
}
