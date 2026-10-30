import type { Metadata } from "next";

import { LegalPage } from "@/components/site/legal-page";
import { termsSections } from "@/content/legal";
import { getSiteI18n } from "@/lib/site-i18n";
import { siteConfigOrNotFound } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getSiteI18n();
  return { title: t.terms.title };
}

export default async function TermsPage() {
  const site = siteConfigOrNotFound();
  const { locale, t } = await getSiteI18n();
  return (
    <LegalPage title={t.terms.title} sections={termsSections(site.company, locale)} site={site} />
  );
}
