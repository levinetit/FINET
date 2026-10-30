import type { Metadata } from "next";
import type { ReactNode } from "react";

import { SiteShell } from "@/components/site/site-shell";
import { siteConfigOrNotFound } from "@/lib/site";

/**
 * Paginile publice ale `saas` (Faza 11, ADR 0027): 404 în `personal`. Se indexează DOAR când site-ul
 * e gata (datele firmei complete și textele juridice revizuite); până atunci `noindex`.
 */
export async function generateMetadata(): Promise<Metadata> {
  const site = siteConfigOrNotFound();
  return { robots: { index: site.ready, follow: site.ready } };
}

export default function SiteLayout({ children }: Readonly<{ children: ReactNode }>) {
  const site = siteConfigOrNotFound();
  return <SiteShell site={site}>{children}</SiteShell>;
}
