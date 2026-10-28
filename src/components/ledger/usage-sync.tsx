"use client";

import { useEffect } from "react";

import { setUsageStatsEnabled } from "@/app/_lib/usage-client";

/**
 * Aliniază starea consimțământului `usage_stats` din browser cu cea citită pe server la fiecare
 * pagină protejată: antetul `X-FINET-Client` pleacă doar dacă serverul știe acordul activ.
 */
export function UsageSync({ enabled }: Readonly<{ enabled: boolean }>) {
  useEffect(() => {
    setUsageStatsEnabled(enabled);
  }, [enabled]);
  return null;
}
