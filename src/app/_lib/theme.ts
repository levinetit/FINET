/**
 * Tema aleasă în profil (`user_preferences.theme`), oglindită într-un cookie fără date
 * personale (`finet_theme=light|dark`), ca layout-ul rădăcină să pună `data-theme` pe `<html>`
 * fără o interogare a bazei la fiecare pagină. „Ca sistemul” = fără cookie.
 */
export const THEME_COOKIE = "finet_theme";

export type ForcedTheme = "light" | "dark";

export function forcedTheme(value: string | undefined | null): ForcedTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

/** Valoarea `document.cookie` pentru tema aleasă (un an; „system” șterge cookie-ul). */
export function themeCookie(theme: string, secure: boolean): string {
  const forced = forcedTheme(theme);
  const attrs = `; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return forced
    ? `${THEME_COOKIE}=${forced}; Max-Age=31536000${attrs}`
    : `${THEME_COOKIE}=; Max-Age=0${attrs}`;
}
