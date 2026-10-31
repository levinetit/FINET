import "server-only";

import { cookies } from "next/headers";

import { deSite } from "@/messages/de-site";
import { enSite, type SiteMessages } from "@/messages/en-site";
import { esSite } from "@/messages/es-site";
import { frSite } from "@/messages/fr-site";
import { itSite } from "@/messages/it-site";
import { plSite } from "@/messages/pl-site";
import { ro } from "@/messages/ro";
import { trSite } from "@/messages/tr-site";

import { LANG_COOKIE, type SiteLocale, parseSiteLocale } from "./site-locale";

/** Textele fiecărei limbi; `Record<SiteLocale, …>` face ca o limbă fără texte să nu compileze. */
export const SITE_MESSAGES: Readonly<Record<SiteLocale, SiteMessages>> = {
  ro: ro.site as SiteMessages,
  en: enSite,
  es: esSite,
  fr: frSite,
  de: deSite,
  it: itSite,
  pl: plSite,
  tr: trSite,
};

/**
 * Limba și textele paginilor publice (Faza 11-C3, ADR 0031; Faza 13, ADR 0033), citite din
 * cookie-ul explicit `finet_lang`. Româna e implicită; `Accept-Language` nu se folosește niciodată.
 */
export async function getSiteI18n(): Promise<{ locale: SiteLocale; t: SiteMessages }> {
  const locale = parseSiteLocale((await cookies()).get(LANG_COOKIE)?.value);
  return { locale, t: SITE_MESSAGES[locale] };
}
