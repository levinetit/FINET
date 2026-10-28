"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ro } from "@/messages/ro";

import { goToLogin } from "../../_lib/api-client";
import { setUsageStatsEnabled } from "../../_lib/usage-client";
import { useHydrated } from "../../_lib/use-hydrated";
import { useSubmit } from "../../_lib/use-submit";

/**
 * Consimțământul `usage_stats` (6.5, ADR 0005): comutatorul apelează `PUT /api/v1/me/consents`.
 * Doar după acordul confirmat de server browserul trimite antetul `X-FINET-Client`; la retragere
 * antetul nu mai pleacă de la următoarea cerere.
 */
export function UsageConsent({ granted }: Readonly<{ granted: boolean }>) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { submit, pending } = useSubmit();
  const [enabled, setEnabled] = useState(granted);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function toggle(next: boolean) {
    setError(null);
    setInfo(null);
    const result = await submit("/api/v1/me/consents", "PUT", { usageStats: next });
    if (!result) return;
    if (result.status === 401) return goToLogin();
    if (!result.ok) {
      setError(ro.usage.error);
      return;
    }
    setEnabled(next);
    setUsageStatsEnabled(next);
    setInfo(next ? ro.usage.on : ro.usage.off);
    router.refresh();
  }

  return (
    <Card aria-labelledby="usage-title">
      <CardHeader>
        <CardTitle id="usage-title">{ro.usage.title}</CardTitle>
        <CardDescription id="usage-info">{ro.usage.info}</CardDescription>
      </CardHeader>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          role="switch"
          className="size-5 accent-[var(--accent)]"
          checked={enabled}
          disabled={pending || !hydrated}
          aria-describedby="usage-info"
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className="font-medium">{ro.usage.toggle}</span>
      </label>
      {pending ? <p className="mt-2 text-sm text-muted-foreground">{ro.usage.saving}</p> : null}
      <Alert className="mt-3">{error}</Alert>
      <Alert tone="ok" className="mt-3">
        {info}
      </Alert>
    </Card>
  );
}
