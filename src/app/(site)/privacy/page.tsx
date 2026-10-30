import type { Metadata } from "next";

import { LegalPage } from "@/components/site/legal-page";
import { privacySections } from "@/content/legal";
import { siteConfigOrNotFound } from "@/lib/site";
import { ro } from "@/messages/ro";

export const metadata: Metadata = { title: ro.site.privacy.title };

export default function PrivacyPage() {
  const site = siteConfigOrNotFound();
  return (
    <LegalPage title={ro.site.privacy.title} sections={privacySections(site.company)} site={site} />
  );
}
