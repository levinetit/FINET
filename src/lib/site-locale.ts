/**
 * Limba paginilor PUBLICE ale site-ului `saas` (Faza 11-C3, ADR 0031; Faza 13, ADR 0033): română,
 * engleză, spaniolă, franceză, germană, italiană, poloneză și turcă, doar pe `/`, `/pricing`,
 * `/terms`, `/privacy`, `/support`. Alegerea se face EXCLUSIV printr-un cookie
 * explicit (`finet_lang`), niciodată din `Accept-Language`: româna rămâne limba implicită, oricare
 * ar fi antetele browserului. Aplicația autentificată, `/login` și `/register*` rămân în română.
 */
export const SITE_LOCALES = ["ro", "en", "es", "fr", "de", "it", "pl", "tr"] as const;
export type SiteLocale = (typeof SITE_LOCALES)[number];

export const DEFAULT_SITE_LOCALE: SiteLocale = "ro";

/** Numele fiecărei limbi în limba ei (etichetele comutatorului; fără traducere, ca să fie recunoscute). */
export const SITE_LOCALE_NAMES: Readonly<Record<SiteLocale, string>> = {
  ro: "Română",
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  pl: "Polski",
  tr: "Türkçe",
};
export const LANG_COOKIE = "finet_lang";
/** Antet INTERN (pus doar de `src/proxy.ts`, în cerere) cu limba documentului: `en` doar pe paginile publice. */
export const LANG_HEADER = "x-finet-lang";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/** Orice valoare în afara listei exacte (lipsă, necunoscută, alterată, altă literă) înseamnă româna. */
export function parseSiteLocale(value: string | null | undefined): SiteLocale {
  return SITE_LOCALES.find((l) => l === value) ?? DEFAULT_SITE_LOCALE;
}

/**
 * Limba textelor JURIDICE: româna (referința) și engleza (traducere de lucru). Celelalte limbi
 * primesc textul englez, cu o notă localizată, până la revizuirea umană pe piața respectivă
 * (master prompt, Faza 13; ADR 0033).
 */
export function legalLocale(locale: SiteLocale): "ro" | "en" {
  return locale === "ro" ? "ro" : "en";
}

/** Valoarea pentru `document.cookie`: preferință de limbă, fără date personale, 1 an. */
export function langCookie(locale: SiteLocale, secure: boolean): string {
  return `${LANG_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/**
 * Limba documentului (`<html lang>`): limba aleasă DOAR pe paginile publice ale `saas` și doar cu
 * cookie-ul explicit; orice altceva (aplicația, login, înregistrare, `personal`) rămâne `ro`.
 */
export function documentLocale(
  input: Readonly<{ saas: boolean; publicPath: boolean; cookie: string | null | undefined }>,
): SiteLocale {
  return input.saas && input.publicPath ? parseSiteLocale(input.cookie) : DEFAULT_SITE_LOCALE;
}
