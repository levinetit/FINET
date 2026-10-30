/**
 * Limba paginilor PUBLICE ale site-ului `saas` (Faza 11-C3, ADR 0031). Doar română și engleză, doar
 * pe `/`, `/pricing`, `/terms`, `/privacy`, `/support`. Alegerea se face EXCLUSIV printr-un cookie
 * explicit (`finet_lang`), niciodată din `Accept-Language`: româna rămâne limba implicită, oricare
 * ar fi antetele browserului. Aplicația autentificată, `/login` și `/register*` rămân în română.
 */
export const SITE_LOCALES = ["ro", "en"] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];

export const DEFAULT_SITE_LOCALE: SiteLocale = "ro";
export const LANG_COOKIE = "finet_lang";
/** Antet INTERN (pus doar de `src/proxy.ts`, în cerere) cu limba documentului: `en` doar pe paginile publice. */
export const LANG_HEADER = "x-finet-lang";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Orice valoare în afară de `"en"` (lipsă, necunoscută, alterată) înseamnă româna. */
export function parseSiteLocale(value: string | null | undefined): SiteLocale {
  return value === "en" ? "en" : DEFAULT_SITE_LOCALE;
}

/** Valoarea pentru `document.cookie`: preferință de limbă, fără date personale, 1 an. */
export function langCookie(locale: SiteLocale, secure: boolean): string {
  return `${LANG_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Limba documentului (`<html lang>`): engleza DOAR pe paginile publice ale `saas` și doar cu
 * cookie-ul explicit; orice altceva (aplicația, login, înregistrare, `personal`) rămâne `ro`.
 */
export function documentLocale(
  input: Readonly<{ saas: boolean; publicPath: boolean; cookie: string | null | undefined }>,
): SiteLocale {
  return input.saas && input.publicPath ? parseSiteLocale(input.cookie) : DEFAULT_SITE_LOCALE;
}
