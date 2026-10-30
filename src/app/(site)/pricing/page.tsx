import type { Metadata } from "next";

import { getSiteI18n } from "@/lib/site-i18n";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getSiteI18n();
  return { title: t.pricing.title };
}

export default async function PricingPage() {
  const { t } = await getSiteI18n();
  return (
    <>
      <h1 className="mb-4 text-3xl font-bold">{t.pricing.title}</h1>
      <p data-testid="pricing-body">{t.pricing.body}</p>
    </>
  );
}
