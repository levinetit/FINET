/**
 * Ajutoarele PWA din browser (Faza 9, ADR 0020): invitația de instalare și preferința ei.
 * Funcții pure (testate în `pwa-ui.test.ts`); accesul la `localStorage` e mereu în try/catch
 * (mod privat, stocare blocată): fără stocare, invitația se poate închide doar pentru pagina
 * curentă.
 */

/** Cheia preferinței „nu mai arăta invitația de instalare”. */
export const INSTALL_DISMISSED_KEY = "finet_install_prompt_dismissed";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readDismissed(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Salvează preferința; `false` dacă stocarea nu e disponibilă. */
export function writeDismissed(storage: StorageLike | null): boolean {
  try {
    if (!storage) return false;
    storage.setItem(INSTALL_DISMISSED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export type InstallMode = "none" | "prompt" | "ios";

/**
 * Ce invitație se arată: `prompt` (Android/Chromium: evenimentul `beforeinstallprompt` a venit),
 * `ios` (Safari pe iPhone/iPad: instrucțiunile „Partajează → Adaugă pe ecranul principal”) sau
 * nimic (închisă înainte, aplicația rulează deja instalată sau browserul nu poate instala).
 */
export function installMode(state: {
  dismissed: boolean;
  standalone: boolean;
  hasPrompt: boolean;
  ios: boolean;
}): InstallMode {
  if (state.dismissed || state.standalone) return "none";
  if (state.hasPrompt) return "prompt";
  return state.ios ? "ios" : "none";
}

/** iPhone/iPad (inclusiv iPadOS care se prezintă ca Mac, dar are ecran tactil). */
export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}
