import "server-only";

import { sql } from "drizzle-orm";

import { type Db, withRlsOn } from "@/db";
import { pgErrorInfo } from "@/db/pg-errors";
import { ForbiddenError } from "@/lib/authz";
import type { AndroidRelease } from "@/modules/app-release/android";

/**
 * Statisticile de utilizare pentru administratorul platformei (master prompt 6.5; F9-B, ADR
 * 0021) și retenția evenimentelor (13 luni → agregat zilnic).
 *
 * Datele vin DOAR din `finet.usage_stats` (SECURITY DEFINER, 0016): numere agregate pe platformă,
 * versiune, zi, eveniment și cod de eroare, din `client_installations`, `app_events`,
 * `app_event_daily`, `app_downloads`, sesiuni, login-urile auditate și `ai_calls`. Funcția NU
 * citește conturi, tranzacții, bonuri sau documente: nicio sumă sau descriere a utilizatorilor nu
 * poate ajunge în răspuns (testat). Costul AI e costul de operare al platformei.
 *
 * Accesul: doar `users.is_platform_admin` activ (verificat în bază; altfel `ForbiddenError` → 403).
 * Lista pe utilizator (nume, ultima activitate, platformă, versiune) doar în modul `personal`
 * (6.5: în `saas` administratorul vede implicit doar agregate).
 */

export type PlatformCount = Readonly<{ platform: string; daily: number; weekly: number; monthly: number }>;

export type UsageStats = Readonly<{
  generatedAt: string;
  activeUsers: PlatformCount[];
  sessionUsers: Readonly<{ daily: number; weekly: number; monthly: number; expiredSessions: number }>;
  installations: Readonly<{
    platform: string;
    appVersion: string | null;
    versionCode: number | null;
    count: number;
    /** Sub `minSupportedVersionCode` (doar Android, dacă există metadatele ultimei versiuni). */
    belowMinimum: boolean;
    /** Sub ultima versiune publicată. */
    outdated: boolean;
  }>[];
  downloads: Readonly<{ version: string; source: string; count: number }>[];
  logins: Readonly<{ day: string; platform: string; count: number }>[];
  features: Readonly<{ name: string; count: number }>[];
  screens: Readonly<{ screen: string; count: number }>[];
  errors: Readonly<{ errorCode: string; appVersion: string | null; count: number }>[];
  ai: Readonly<{ provider: string; result: string; count: number; avgDurationMs: number }>[];
  /** Costul estimat al apelurilor AI pe lună (unități minore, ca șir: sumă de operare). */
  aiCost: Readonly<{ month: string; currency: string; costMinor: string }>[];
  archivedEvents: number;
  latestAndroid: Readonly<{ versionName: string; versionCode: number; minSupportedVersionCode: number }> | null;
  members:
    | Readonly<{
        userId: string;
        name: string;
        lastSeenAt: string | null;
        platform: string | null;
        appVersion: string | null;
        versionCode: number | null;
        belowMinimum: boolean;
        outdated: boolean;
      }>[]
    | null;
}>;

type RawStats = Omit<UsageStats, "latestAndroid" | "installations" | "members"> & {
  installations: Omit<UsageStats["installations"][number], "belowMinimum" | "outdated">[];
  members: Omit<NonNullable<UsageStats["members"]>[number], "belowMinimum" | "outdated">[] | null;
};

function versionFlags(
  platform: string | null,
  versionCode: number | null,
  latest: AndroidRelease | null,
): { belowMinimum: boolean; outdated: boolean } {
  if (platform !== "android" || versionCode === null || latest === null) {
    return { belowMinimum: false, outdated: false };
  }
  return {
    belowMinimum: versionCode < latest.minSupportedVersionCode,
    outdated: versionCode < latest.versionCode,
  };
}

export type StatsOptions = Readonly<{
  appMode: "personal" | "saas";
  /** Metadatele ultimei versiuni Android (ADR 0020), dacă există. */
  latestAndroid: AndroidRelease | null;
}>;

export async function getUsageStats(
  db: Db,
  userId: string,
  options: StatsOptions,
): Promise<UsageStats> {
  let raw: RawStats;
  try {
    raw = await withRlsOn(db, { userId }, async (tx) => {
      const rows = await tx.execute<{ s: RawStats }>(
        sql`select finet.usage_stats(${options.appMode === "personal"}) as s`,
      );
      return rows[0]!.s;
    });
  } catch (error) {
    if (pgErrorInfo(error)?.code === "42501") throw new ForbiddenError();
    throw error;
  }
  const latest = options.latestAndroid;
  return {
    ...raw,
    installations: raw.installations.map((i) => ({
      ...i,
      ...versionFlags(i.platform, i.versionCode, latest),
    })),
    members:
      raw.members === null
        ? null
        : raw.members.map((m) => ({ ...m, ...versionFlags(m.platform, m.versionCode, latest) })),
    latestAndroid: latest
      ? {
          versionName: latest.versionName,
          versionCode: latest.versionCode,
          minSupportedVersionCode: latest.minSupportedVersionCode,
        }
      : null,
  };
}

/** Administratorul activ al platformei (pentru pagina „Statistici”; fără excepții). */
export async function isPlatformAdmin(db: Db, userId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: boolean }>(
    sql`select exists (select 1 from finet.users u
          where u.id = ${userId} and u.is_platform_admin and u.status = 'active') as ok`,
  );
  return rows[0]?.ok === true;
}

/** Lotul maxim al unei treceri (aceeași limită ca funcția din bază). */
export const AGGREGATE_BATCH = 10_000;

/**
 * Retenția (6.5, LOW-2): agregă și șterge evenimentele mai vechi de 13 luni, în loturi, până nu
 * mai rămâne nimic (sau `maxBatches`). Întoarce numărul de evenimente agregate. Comanda
 * `finet-admin aggregate-events` (ca finet_app, fără context: funcția nu are nevoie de el).
 */
export async function aggregateOldAppEvents(
  db: Db,
  options: Readonly<{ batch?: number; maxBatches?: number }> = {},
): Promise<number> {
  const batch = Math.min(Math.max(options.batch ?? AGGREGATE_BATCH, 1), AGGREGATE_BATCH);
  const maxBatches = options.maxBatches ?? 1000;
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await withRlsOn(db, { userId: null }, (tx) =>
      tx.execute<{ n: number }>(sql`select finet.aggregate_app_events(${batch}) as n`),
    );
    const n = Number(rows[0]?.n ?? 0);
    total += n;
    if (n < batch) break;
  }
  return total;
}
