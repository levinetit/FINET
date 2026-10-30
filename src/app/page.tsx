import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SiteShell } from "@/components/site/site-shell";
import { buttonClasses } from "@/components/ui/button";
import { getConfig } from "@/lib/config";
import { isSaasMode } from "@/lib/site";
import { getSiteI18n } from "@/lib/site-i18n";

import { DEFAULT_AFTER_LOGIN } from "./_lib/next-path";
import { getPageSession } from "./_lib/session";

export async function generateMetadata(): Promise<Metadata> {
  if (!isSaasMode()) return {};
  const ready = getConfig().site.ready;
  const { t } = await getSiteI18n();
  return { title: t.landing.title, robots: { index: ready, follow: ready } };
}

/**
 * `/`: cu sesiune, spre dashboard. Fără sesiune: în `personal`, spre login (ca până acum); în
 * `saas` (Faza 11, ADR 0027), pagina publică de prezentare.
 */
export default async function HomePage() {
  const session = await getPageSession();
  if (session) redirect(DEFAULT_AFTER_LOGIN);
  if (!isSaasMode()) redirect("/login");
  const { t: all } = await getSiteI18n();
  const t = all.landing;
  return (
    <SiteShell site={getConfig().site}>
      <h1 className="mb-3 text-4xl font-bold">{t.title}</h1>
      <p className="mb-6 text-lg text-muted-foreground">{t.lead}</p>
      <ul className="mb-8 list-disc space-y-2 pl-5" data-testid="landing-features">
        {t.features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Link href="/register" className={buttonClasses()} data-testid="landing-register">
          {t.cta}
        </Link>
        <Link href="/login" className={buttonClasses("outline")}>
          {t.secondary}
        </Link>
      </div>
    </SiteShell>
  );
}
