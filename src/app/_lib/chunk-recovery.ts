/**
 * Recuperarea după un deploy (Faza 4, master prompt 7): un tab deschis înainte de deploy cere
 * fișiere JavaScript/CSS vechi din `/_next/static/`, care nu mai există (404) → `ChunkLoadError`
 * sau „Failed to fetch dynamically imported module”. Soluția: reîncărcarea paginii, cel mult o
 * dată la 8 secunde, DAR niciodată peste un formular necomis (atunci doar un banner).
 *
 * Funcții pure (fără `window`), testate în mediul `node` al Vitest; componenta
 * `src/components/app/chunk-recovery.tsx` și paginile de eroare le leagă de browser.
 */

/** Intervalul minim între două reîncărcări automate (ms). */
export const RELOAD_INTERVAL_MS = 8_000;

/** Cheia din `sessionStorage` cu momentul ultimei reîncărcări automate (ms epoch, text). */
export const RELOAD_STORAGE_KEY = "finet:chunk-reload-at";

/** Atributul formularelor cu modificări necomise (pus automat la `input`, scos la `submit`). */
export const DIRTY_ATTRIBUTE = "data-dirty";

// Mesajele browserelor și ale bundlerelor (webpack, Turbopack, Chrome, Firefox, Safari).
const CHUNK_MESSAGES = [
  /Loading (CSS )?chunk [^\s]+ failed/i,
  /Failed to load chunk/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
];

/** Eroarea vine dintr-un fișier static lipsă (chunk vechi după deploy)? */
export function isChunkLoadError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return typeof error === "string" && CHUNK_MESSAGES.some((re) => re.test(error));
  }
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === "ChunkLoadError") return true;
  return typeof message === "string" && CHUNK_MESSAGES.some((re) => re.test(message));
}

/** Adresa e un fișier static Next (`/_next/static/…`) de pe propriul domeniu? */
export function isStaticAssetUrl(url: string, origin: string): boolean {
  try {
    const u = new URL(url, origin);
    return u.origin === origin && u.pathname.startsWith("/_next/static/");
  } catch {
    return false;
  }
}

/** Accesul la `sessionStorage` (sau `null` dacă browserul îl refuză). */
export type StorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Momentul ultimei reîncărcări automate: `number`, `null` (niciuna) sau `"unavailable"` dacă
 * stocarea aruncă (mod privat, cookie-uri blocate) — atunci NU se reîncarcă automat (fără
 * marcaj, o buclă de reîncărcări n-ar putea fi oprită).
 */
export function readLastReload(storage: StorageLike | null): number | null | "unavailable" {
  if (!storage) return "unavailable";
  try {
    const raw = storage.getItem(RELOAD_STORAGE_KEY);
    if (raw === null) return null;
    const at = Number.parseInt(raw, 10);
    return Number.isSafeInteger(at) ? at : null;
  } catch {
    return "unavailable";
  }
}

/** Scrie marcajul; `false` dacă stocarea refuză (atunci nu se reîncarcă). */
export function markReload(storage: StorageLike | null, now: number): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RELOAD_STORAGE_KEY, String(now));
    return storage.getItem(RELOAD_STORAGE_KEY) === String(now);
  } catch {
    return false;
  }
}

export type RecoveryDecision = "reload" | "banner";

/**
 * Decizia: `banner` dacă există un formular necomis, dacă stocarea nu merge sau dacă ultima
 * reîncărcare automată a fost acum mai puțin de 8 secunde (fișierul lipsește și după
 * reîncărcare: nu intrăm în buclă); altfel `reload`.
 */
export function decideRecovery(
  input: Readonly<{ now: number; lastReloadAt: number | null | "unavailable"; dirty: boolean }>,
): RecoveryDecision {
  if (input.dirty) return "banner";
  if (input.lastReloadAt === "unavailable") return "banner";
  if (input.lastReloadAt !== null) {
    const elapsed = input.now - input.lastReloadAt;
    // Un ceas dat înapoi (elapsed negativ) e tratat ca „prea curând”.
    if (elapsed < RELOAD_INTERVAL_MS) return "banner";
  }
  return "reload";
}
