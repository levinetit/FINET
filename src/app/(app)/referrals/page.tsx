import type { Metadata } from "next";

import { Card, CardContent } from "@/components/ui/card";
import { getConfig } from "@/lib/config";
import { siteConfigOrNotFound } from "@/lib/site";
import { ro } from "@/messages/ro";
import { myReferral } from "@/modules/referrals/referrals.service";

import { load, requireLedgerPage } from "../../_lib/ledger-page";
import { PageHeader } from "../page-header";

import { ShareLink } from "./share-link";

export const metadata: Metadata = { title: ro.referrals.title };

/** Recomandări (F12-C, ADR 0037): doar `saas` (404 altfel). Codul se creează la prima deschidere. */
export default async function ReferralsPage() {
  // Întâi sesiunea: anonimul ajunge la /login; abia apoi 404 în `personal`.
  const page = await requireLedgerPage("/referrals");
  siteConfigOrNotFound();
  const t = ro.referrals;
  const me = await load(() => myReferral(page.session.runtime.db, page.actor.userId));
  const origin = new URL(getConfig().appUrl ?? "http://localhost:3000").origin;
  return (
    <>
      <PageHeader eyebrow={t.eyebrow} title={t.title} usageStats={page.usageStats} />
      <p className="mb-4 text-muted-foreground">{t.intro}</p>
      {!me.ok || !me.value.code ? (
        <p role="alert">{t.unavailable}</p>
      ) : (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t.codeLabel}</p>
            <p className="font-mono text-xl" data-testid="referral-code">
              {me.value.code}
            </p>
            <ShareLink link={`${origin}/ref/${me.value.code}`} />
            <dl className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted-foreground">{t.invited}</dt>
                <dd className="text-xl" data-testid="referral-invited">
                  {me.value.invited}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted-foreground">{t.rewarded}</dt>
                <dd className="text-xl" data-testid="referral-rewarded">
                  {me.value.rewarded}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </>
  );
}
