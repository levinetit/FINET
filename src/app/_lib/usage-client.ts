/**
 * Antetul `X-FINET-Client` al clientului web (6.5, ADR 0005): trimis DOAR după ce utilizatorul a
 * acordat `usage_stats` (comutatorul din `/profile`). Serverul verifică și el consimțământul
 * (nu înregistrează instalarea fără acord, iar la revocare șterge instalările și evenimentele),
 * deci regula e aplicată în ambele locuri.
 *
 * - Starea consimțământului vine de la server la fiecare pagină protejată (`UsageSync`), nu din
 *   `localStorage` (ar rămâne învechită între utilizatori sau dispozitive); comutatorul o schimbă
 *   imediat, în memorie.
 * - Identificatorul instalării (UUID aleator, fără legătură cu persoana) stă în `localStorage`;
 *   dacă stocarea nu e disponibilă, se folosește unul doar pentru pagina curentă.
 * - Antetul conține doar platforma, instalarea și limba: fără sume, fără text liber.
 */

export const CLIENT_HEADER_NAME = "X-FINET-Client";
export const INSTALLATION_STORAGE_KEY = "finet_installation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let usageStatsEnabled = false;
let memoryInstallation: string | null = null;

export function setUsageStatsEnabled(enabled: boolean): void {
  usageStatsEnabled = enabled;
}

export function isUsageStatsEnabled(): boolean {
  return usageStatsEnabled;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Identificatorul instalării: citit din stocare sau creat (UUID v4, litere mici). */
export function installationId(
  storage: StorageLike | null = browserStorage(),
  generate: () => string = () => crypto.randomUUID(),
): string {
  try {
    const stored = storage?.getItem(INSTALLATION_STORAGE_KEY);
    if (stored && UUID.test(stored)) return stored;
  } catch {
    // mai jos
  }
  const created = (memoryInstallation ?? generate()).toLowerCase();
  memoryInstallation = created;
  try {
    storage?.setItem(INSTALLATION_STORAGE_KEY, created);
  } catch {
    // Stocare blocată: instalarea rămâne doar în memorie.
  }
  return created;
}

/** Valoarea antetului, în forma completă din ADR 0005 (`platform=web; installation=…`). */
export function clientHeaderValue(installation: string, locale = "ro-RO"): string {
  return `platform=web; installation=${installation}; locale=${locale}`;
}

/** Antetul de adăugat unei cereri către `path`, sau `null` (fără consimțământ / altă rută). */
export function clientHeaderFor(path: string): string | null {
  if (!usageStatsEnabled || !path.startsWith("/api/v1/")) return null;
  return clientHeaderValue(installationId());
}
