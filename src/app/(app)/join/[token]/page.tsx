import type { Metadata } from "next";

import { ro } from "@/messages/ro";

import { requireLedgerPage } from "../../../_lib/ledger-page";
import { PageHeader } from "../../page-header";

import { AcceptInvite } from "./accept-invite";

// Linkul conține tokenul: nu se indexează și nu se trimite ca `Referer` nicăieri.
export const metadata: Metadata = {
  title: ro.join.title,
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * Acceptarea unei invitații (Faza 8, ADR 0016). Pagina cere autentificarea (fără sesiune →
 * login cu revenire aici). La DESCHIDERE nu se consumă nimic și nu se verifică tokenul (o
 * previzualizare a linkului sau un prefetch nu poate folosi invitația, iar pagina nu spune dacă
 * tokenul există); acceptarea e un `POST` la apăsarea butonului. Numele gospodăriei NU apare
 * înainte de acceptare. Tokenul nu e logat și nu ajunge în stocarea browserului.
 */
export default async function JoinPage({
  params,
}: Readonly<{ params: Promise<{ token: string }> }>) {
  const { token } = await params;
  // Doar forma lungimii/caracterelor intră în `next` (validat oricum de `safeNextPath`).
  const safe = /^[A-Za-z0-9_-]{1,64}$/.test(token) ? token : "";
  const page = await requireLedgerPage(`/join/${safe}`);
  return (
    <>
      <PageHeader title={ro.join.title} usageStats={page.usageStats} />
      <AcceptInvite token={safe} />
    </>
  );
}
