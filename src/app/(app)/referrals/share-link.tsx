"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ro } from "@/messages/ro";

import { useHydrated } from "../../_lib/use-hydrated";

/** Linkul de recomandare: copiere în clipboard și Web Share API (unde există). */
export function ShareLink({ link }: { link: string }) {
  const t = ro.referrals;
  const hydrated = useHydrated();
  const [copied, setCopied] = useState(false);
  const canShare = hydrated && typeof navigator !== "undefined" && "share" in navigator;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  async function share() {
    try {
      await navigator.share({ title: ro.referrals.title, text: t.shareText, url: link });
    } catch {
      // Utilizatorul a închis fereastra de distribuire: nimic de făcut.
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t.linkLabel}</p>
      <input
        readOnly
        value={link}
        aria-label={t.linkLabel}
        className="rounded-md border bg-surface p-2 font-mono text-sm"
        data-testid="referral-link"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={copy} disabled={!hydrated} data-testid="referral-copy">
          {t.copy}
        </Button>
        {canShare ? (
          <Button type="button" variant="secondary" onClick={share} data-testid="referral-share">
            {t.share}
          </Button>
        ) : null}
      </div>
      <p role="status" className="text-sm" aria-live="polite">
        {copied ? t.copied : ""}
      </p>
    </div>
  );
}
