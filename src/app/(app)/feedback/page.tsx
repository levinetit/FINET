import type { Metadata } from "next";

import { siteConfigOrNotFound } from "@/lib/site";
import { ro } from "@/messages/ro";

import { requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { FeedbackForm } from "./feedback-form";

export const metadata: Metadata = { title: ro.feedback.title };

/** Feedback și bug-uri (F11-B, ADR 0028): doar `saas` (404 altfel), fără date financiare. */
export default async function FeedbackPage() {
  siteConfigOrNotFound();
  const page = await requireLedgerPage("/feedback");
  const t = ro.feedback;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      <FeedbackForm />
    </>
  );
}
