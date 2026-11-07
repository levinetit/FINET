import { ro } from "./ro";

/**
 * Stratul de indirecție pentru textele aplicației (modernizare 2026, pasul N; ADR 0052).
 *
 * Decizia operatorului (2026-11-01) e că aplicația autentificată rămâne în română; paginile
 * publice `saas` au deja șase limbi (ADR 0031/0033). Ca o traducere viitoare să nu ceară
 * rescrierea celor ~130 de fișiere care importă `ro` static, componentele NOI folosesc
 * `messagesFor(locale)`, care azi întoarce mereu `ro` (tipul `Messages` e forma lui). Când
 * apare a doua limbă: (1) `en.ts` cu aceeași formă (verificată de tip), (2) `messagesFor`
 * alege după `finet_lang`/preferința contului, (3) fișierele vechi se migrează treptat.
 *
 * Textele NU se traduc aici și nu se schimbă: e doar un punct de intrare.
 */

export type Messages = typeof ro;
export type AppLocale = "ro";
export const APP_LOCALES: readonly AppLocale[] = ["ro"];
export const DEFAULT_APP_LOCALE: AppLocale = "ro";

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (APP_LOCALES as readonly string[]).includes(value);
}

/** Textele pentru limba cerută; orice limbă necunoscută dă româna (implicită, fără excepții). */
export function messagesFor(locale: unknown): Messages {
  return isAppLocale(locale) ? ro : ro;
}

export { ro };
