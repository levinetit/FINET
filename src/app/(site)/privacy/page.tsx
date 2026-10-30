import type { Metadata } from "next";

import { LegalPage } from "@/components/site/legal-page";
import { privacySections } from "@/content/legal";
import { getSiteI18n } from "@/lib/site-i18n";
import { siteConfigOrNotFound } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getSiteI18n();
  return { title: t.privacy.title };
}

export default async function PrivacyPage() {
  const site = siteConfigOrNotFound();
  const { locale, t } = await getSiteI18n();
  return (
    <LegalPage
      title={t.privacy.title}
      sections={privacySections(site.company, locale)}
      site={site}
    />
  );
}
