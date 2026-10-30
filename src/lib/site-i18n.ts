import "server-only";

import { cookies } from "next/headers";

import { enSite, type SiteMessages } from "@/messages/en-site";
import { ro } from "@/messages/ro";

import { LANG_COOKIE, type SiteLocale, parseSiteLocale } from "./site-locale";

/**
 * Limba și textele paginilor publice (Faza 11-C3, ADR 0031), citite din cookie-ul explicit
 * `finet_lang`. Româna e implicită; `Accept-Language` nu se folosește niciodată.
 */
export async function getSiteI18n(): Promise<{ locale: SiteLocale; t: SiteMessages }> {
  const locale = parseSiteLocale((await cookies()).get(LANG_COOKIE)?.value);
  return { locale, t: locale === "en" ? enSite : (ro.site as SiteMessages) };
}
