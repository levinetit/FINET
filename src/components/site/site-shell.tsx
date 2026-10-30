import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/app/_components/logo";
import { buttonClasses } from "@/components/ui/button";
import type { Config } from "@/lib/config";
import { CONSUMER_LINKS } from "@/lib/site-paths";
import { getSiteI18n } from "@/lib/site-i18n";
import type { SiteMessages } from "@/messages/en-site";

import { CookieConsent } from "./cookie-consent";
import { LanguageSwitcher } from "./language-switcher";

/**
 * Structura paginilor publice ale site-ului `saas` (Faza 11, ADR 0027): antet cu navigarea,
 * conținut, subsolul cu datele firmei și legăturile ANPC SAL / SOL (obligatorii pe fiecare pagină)
 * și bannerul de cookie-uri. Datele lipsă se afișează explicit ca „de completat”, niciodată inventate.
 */
export async function SiteShell({
  site,
  children,
}: Readonly<{ site: Config["site"]; children: ReactNode }>) {
  const { locale, t } = await getSiteI18n();
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#continut" className="skip-link">
        {t.nav.skip}
      </a>
      <header className="border-b">
        <nav
          aria-label="Navigare site"
          className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3"
        >
          <Link href="/" aria-label="FINET" className="mr-auto">
            <Logo className="text-2xl" />
          </Link>
          <Link href="/pricing">{t.nav.pricing}</Link>
          <Link href="/terms">{t.nav.terms}</Link>
          <Link href="/privacy">{t.nav.privacy}</Link>
          <Link href="/support">{t.nav.support}</Link>
          <LanguageSwitcher current={locale} label={t.nav.language} />
          <Link href="/login" className={buttonClasses("outline")}>
            {t.nav.login}
          </Link>
        </nav>
      </header>
      <main id="continut" tabIndex={-1} className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        {children}
      </main>
      <LegalFooter site={site} t={t.footer} />
      <CookieConsent analyticsId={site.analyticsId} t={t.consent} />
    </div>
  );
}

function LegalFooter({ site, t }: Readonly<{ site: Config["site"]; t: SiteMessages["footer"] }>) {
  const c = site.company;
  const value = (v: string | null) =>
    v ?? <span className="text-muted-foreground">[{t.missing}]</span>;
  return (
    <footer className="border-t bg-surface-2 text-sm" data-testid="legal-footer">
      <div className="mx-auto grid max-w-5xl gap-4 px-4 py-6 md:grid-cols-2">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="font-semibold">{t.operator}</dt>
          <dd data-testid="footer-company">{value(c.name)}</dd>
          <dt className="font-semibold">{t.taxId}</dt>
          <dd>{value(c.taxId)}</dd>
          <dt className="font-semibold">{t.registration}</dt>
          <dd>{value(c.registrationNo)}</dd>
          <dt className="font-semibold">{t.address}</dt>
          <dd>{value(c.address)}</dd>
          <dt className="font-semibold">{t.contact}</dt>
          <dd>{value(c.email)}</dd>
        </dl>
        <div>
          <p className="mb-1 font-semibold">{t.consumer}</p>
          <ul className="flex flex-col gap-1">
            <li>
              <a href={CONSUMER_LINKS.anpcSal} rel="noopener noreferrer" target="_blank">
                {t.anpcSal}
              </a>
            </li>
            <li>
              <a href={CONSUMER_LINKS.sol} rel="noopener noreferrer" target="_blank">
                {t.sol}
              </a>
            </li>
          </ul>
        </div>
      </div>
    </footer>
  );
}

/** Banner vizibil cât textele juridice sunt ciorne sau datele firmei lipsesc. */
export function DraftBanner({
  site,
  t,
}: Readonly<{ site: Config["site"]; t: SiteMessages["draft"] }>) {
  if (site.legalReviewed) return null;
  const incomplete = Object.values(site.company).some((v) => v === null);
  return (
    <div
      role="note"
      data-testid="draft-banner"
      className="mb-6 rounded-md border border-warn bg-warn-soft p-4"
    >
      <p className="font-semibold">{t.title}</p>
      <p>{t.body}</p>
      {incomplete ? <p className="mt-1">{t.incomplete}</p> : null}
    </div>
  );
}
