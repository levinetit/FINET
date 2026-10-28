import "server-only";

import { notFound, unstable_rethrow } from "next/navigation";

import { withRlsOn } from "@/db";
import { type Actor, NotFoundError } from "@/lib/authz";
import { currentHouseholdIdOf } from "@/modules/auth/audit";
import { getConsents } from "@/modules/usage/consents";

import { type PageSession, requirePageSession } from "./session";

/**
 * Contextul unei pagini protejate a registrului (F2-C): sesiunea (`requirePageSession(path)`,
 * apelată de FIECARE pagină), gospodăria curentă din BAZĂ (ca `/api/v1`, ADR 0005; niciodată din
 * URL) și starea consimțământului `usage_stats` (pentru antetul `X-FINET-Client`, `UsageSync`).
 * Datele se citesc direct din servicii, pe server, cu aceleași verificări (`withMember` + RLS).
 */

export type LedgerPage = Readonly<{
  session: PageSession;
  actor: Actor;
  householdId: string | null;
  usageStats: boolean;
}>;

export async function requireLedgerPage(path: string): Promise<LedgerPage> {
  const session = await requirePageSession(path);
  const { db } = session.runtime;
  const actor: Actor = { userId: session.userId };
  const [householdId, consents] = await Promise.all([
    withRlsOn(db, { userId: actor.userId }, (tx) => currentHouseholdIdOf(tx, actor.userId)),
    getConsents(db, actor.userId).catch(() => []),
  ]);
  return {
    session,
    actor,
    householdId,
    usageStats: consents.some((c) => c.kind === "usageStats" && c.granted),
  };
}

export type Loaded<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

/**
 * Rulează o citire pentru pagină: `NotFoundError` (resursă străină sau inexistentă) → pagina 404
 * uniformă; altă eroare → `{ ok: false }` (pagina afișează starea de eroare, fără detalii).
 * Excepțiile de control ale Next (redirect, notFound) trec mai departe.
 */
export async function load<T>(fn: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof NotFoundError) notFound();
    console.error("[ui] datele paginii nu au putut fi încărcate");
    return { ok: false };
  }
}
