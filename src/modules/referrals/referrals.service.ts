import "server-only";

import { sql } from "drizzle-orm";

import { type Db, withRlsOn } from "@/db";

/**
 * Recomandările (Faza 12-C, ADR 0037). Regulile (o singură folosire, fără auto-recomandare,
 * plafon, cont confirmat și recent) sunt ÎN BAZA DE DATE (`finet.redeem_referral`); aici doar se
 * apelează funcțiile, ca utilizatorul curent, și se validează forma codului.
 */

/** Cookie-ul setat de `/ref/<cod>` și citit la pasul 1 al înregistrării. */
export const REF_COOKIE = "finet_ref";
export const REF_COOKIE_MAX_AGE_SECONDS = 14 * 24 * 3600;

const REF_CODE = /^FIN-[A-HJ-NP-Z2-9]{6}$/;

/** Codul normalizat (majuscule, fără spații) sau `null` dacă forma nu e a unui cod. */
export function parseRefCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const code = raw.trim().toUpperCase();
  return REF_CODE.test(code) ? code : null;
}

/** Valoarea cookie-ului `finet_ref` dintr-un antet `Cookie`, validată; altfel `null`. */
export function refCodeFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== REF_COOKIE) continue;
    try {
      return parseRefCode(decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      return null;
    }
  }
  return null;
}

export const REDEEM_STATUSES = [
  "ok",
  "disabled",
  "not_eligible",
  "expired",
  "invalid",
  "self",
  "already",
] as const;
export type RedeemStatus = (typeof REDEEM_STATUSES)[number];

/** Folosește codul ca `userId` (invitatul). Un răspuns necunoscut al bazei se tratează ca `invalid`. */
export async function redeemReferral(db: Db, userId: string, code: string): Promise<RedeemStatus> {
  const parsed = parseRefCode(code);
  if (!parsed) return "invalid";
  const rows = await withRlsOn(db, { userId }, (tx) =>
    tx.execute(sql`select finet.redeem_referral(${parsed}) as status`),
  );
  const status = (rows[0] as { status?: unknown } | undefined)?.status;
  return REDEEM_STATUSES.find((s) => s === status) ?? "invalid";
}

export type MyReferral = Readonly<{
  /** `null` dacă utilizatorul nu e activ. */
  code: string | null;
  /** Prietenii care au folosit codul. */
  invited: number;
  /** Din ei, câți au adus o recompensă invitatorului. */
  rewarded: number;
}>;

/** Codul propriu (creat la prima cerere) și contoarele. */
export async function myReferral(db: Db, userId: string): Promise<MyReferral> {
  return withRlsOn(db, { userId }, async (tx) => {
    const codeRows = await tx.execute(sql`select finet.my_referral_code() as code`);
    const counts = await tx.execute(sql`
      select count(*)::int as invited,
             count(*) filter (where inviter_rewarded)::int as rewarded
        from finet.referrals
       where inviter_user_id = ${userId}::uuid`);
    const code = (codeRows[0] as { code?: unknown } | undefined)?.code;
    const row = counts[0] as { invited?: number; rewarded?: number } | undefined;
    return {
      code: typeof code === "string" ? code : null,
      invited: row?.invited ?? 0,
      rewarded: row?.rewarded ?? 0,
    };
  });
}
