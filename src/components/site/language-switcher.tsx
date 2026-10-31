"use client";

import { useRouter } from "next/navigation";

import { SITE_LOCALES, SITE_LOCALE_NAMES, type SiteLocale, langCookie } from "@/lib/site-locale";

/**
 * Comutatorul de limbă al paginilor publice (Faza 11-C3, ADR 0031): scrie cookie-ul de preferință
 * `finet_lang` (fără date personale, cookie strict necesar pentru alegerea făcută) și reîncarcă
 * pagina. Nu depinde de `Accept-Language`.
 */
/** Scrie preferința de limbă (în afara componentei: efect asupra documentului, nu asupra randării). */
function saveLocale(locale: SiteLocale): void {
  document.cookie = langCookie(locale, window.location.protocol === "https:");
}

export function LanguageSwitcher({
  current,
  label,
}: Readonly<{ current: SiteLocale; label: string }>) {
  const router = useRouter();

  function choose(locale: SiteLocale) {
    if (locale === current) return;
    saveLocale(locale);
    router.refresh();
  }

  const options = SITE_LOCALES.map((locale) => ({
    locale,
    text: locale.toUpperCase(),
    name: SITE_LOCALE_NAMES[locale],
  }));
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap gap-1"
      data-testid="language-switcher"
    >
      {options.map((o) => (
        <button
          key={o.locale}
          type="button"
          lang={o.locale}
          aria-label={o.name}
          aria-pressed={o.locale === current}
          data-testid={`lang-${o.locale}`}
          onClick={() => choose(o.locale)}
          className={
            "rounded px-2 py-1 text-sm font-semibold " +
            (o.locale === current ? "bg-primary text-primary-foreground" : "text-primary underline")
          }
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}
