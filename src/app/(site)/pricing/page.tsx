import type { Metadata } from "next";

import { ro } from "@/messages/ro";

export const metadata: Metadata = { title: ro.site.pricing.title };

export default function PricingPage() {
  return (
    <>
      <h1 className="mb-4 text-3xl font-bold">{ro.site.pricing.title}</h1>
      <p data-testid="pricing-body">{ro.site.pricing.body}</p>
    </>
  );
}
