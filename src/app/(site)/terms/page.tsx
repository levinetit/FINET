import type { Metadata } from "next";

import { LegalPage } from "@/components/site/legal-page";
import { termsSections } from "@/content/legal";
import { siteConfigOrNotFound } from "@/lib/site";
import { ro } from "@/messages/ro";

export const metadata: Metadata = { title: ro.site.terms.title };

export default function TermsPage() {
  const site = siteConfigOrNotFound();
  return (
    <LegalPage title={ro.site.terms.title} sections={termsSections(site.company)} site={site} />
  );
}
