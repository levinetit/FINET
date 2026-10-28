import type { ReactNode } from "react";

import { Logo } from "@/app/_components/logo";
import { UsageSync } from "@/components/ledger/usage-sync";

/**
 * Antetul paginii: logo-ul pe telefon (pe desktop e în meniul lateral), eticheta, titlul și
 * acțiunile (de exemplu „Adaugă cheltuială”). `usageStats` (starea consimțământului citită pe
 * server) aliniază antetul `X-FINET-Client` din browser.
 */
export function PageHeader({
  eyebrow,
  title,
  actions,
  usageStats,
}: Readonly<{
  eyebrow?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  usageStats?: boolean;
}>) {
  return (
    <header className="mb-5 flex flex-col gap-1">
      {usageStats === undefined ? null : <UsageSync enabled={usageStats} />}
      <span className="mb-2 md:hidden">
        <Logo className="text-3xl" />
      </span>
      {eyebrow ? (
        <span className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {eyebrow}
        </span>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
