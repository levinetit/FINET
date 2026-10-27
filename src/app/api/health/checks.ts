import "server-only";

import { statfs } from "node:fs/promises";

import type postgres from "postgres";

import { createPostgresClient } from "@/lib/db-client";
import { NotImplementedError } from "@/lib/errors";
import type { Storage } from "@/lib/storage";

/**
 * Verificările din `/api/health` (master prompt 6.4). Rezultatul conține doar stări
 * (`ok`/`down`/`unknown`) și, opțional, procentul de disc liber: fără versiuni, căi, nume de
 * host sau mesaje de eroare.
 */

export type CheckStatus = "ok" | "down" | "unknown";
export type OverallStatus = "ok" | "degraded" | "down";

export type HealthReport = {
  status: OverallStatus;
  checks: { db: CheckStatus; storage: CheckStatus; queue: CheckStatus; ai: CheckStatus };
  /** Procentul de spațiu liber pe discul directorului de storage (întreg), dacă e disponibil. */
  diskFreePercent?: number;
};

export type HealthDeps = Readonly<{
  databaseUrl: string | null;
  /** CA-ul bazei de date (PEM, `config.database.ca`), pentru `sslmode=verify-full`. */
  databaseCa?: string | null;
  storage: Storage | null;
  /** Directorul pentru calculul spațiului liber (STORAGE_DIR). */
  diskDir: string | null;
}>;

const CHECK_TIMEOUT_MS = 4000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Un singur client mic (o conexiune), refolosit între cereri; opțiunile (inclusiv TLS și
// `prepare: false` pentru pooler) vin din `src/lib/db-client.ts`.
let db: { url: string; ca: string | null; sql: postgres.Sql } | null = null;

function dbClient(url: string, ca: string | null): postgres.Sql {
  if (db?.url !== url || db.ca !== ca) {
    void db?.sql.end({ timeout: 1 }).catch(() => {});
    db = { url, ca, sql: createPostgresClient(url, { ca, applicationName: "finet-health" }) };
  }
  return db.sql;
}

/** Închide clientul bazei de date (teste, oprire). */
export async function closeHealthDb(): Promise<void> {
  const current = db;
  db = null;
  await current?.sql.end({ timeout: 1 }).catch(() => {});
}

export async function checkDb(url: string | null, ca: string | null = null): Promise<CheckStatus> {
  if (!url) return "unknown";
  try {
    const sql = dbClient(url, ca);
    const rows = await withTimeout(sql`select 1 as ok`, CHECK_TIMEOUT_MS);
    return rows[0]?.ok === 1 ? "ok" : "down";
  } catch {
    return "down";
  }
}

const PROBE = new TextEncoder().encode("finet-health");

/** Scrie, citește și șterge o cheie temporară. Driverul neimplementat (S3) → `unknown`. */
export async function checkStorage(storage: Storage | null): Promise<CheckStatus> {
  if (!storage) return "unknown";
  try {
    return await withTimeout(
      (async (): Promise<CheckStatus> => {
        const key = await storage.put(PROBE, { prefix: "health" });
        try {
          const read = await storage.get(key);
          return read.length === PROBE.length && read.every((b, i) => b === PROBE[i])
            ? "ok"
            : "down";
        } finally {
          await storage.delete(key);
        }
      })(),
      CHECK_TIMEOUT_MS,
    );
  } catch (error) {
    return error instanceof NotImplementedError ? "unknown" : "down";
  }
}

export async function diskFreePercent(dir: string | null): Promise<number | undefined> {
  if (!dir) return undefined;
  try {
    const s = await statfs(dir);
    if (!s.blocks) return undefined;
    return Math.floor((s.bavail / s.blocks) * 100);
  } catch {
    return undefined;
  }
}

/**
 * Starea generală:
 * - `down` dacă oricare verificare e `down`;
 * - `ok` dacă `db` și `storage` sunt `ok` (coada și AI-ul, încă neimplementate, sunt neutre:
 *   apar ca `unknown`, nu ca `ok`);
 * - altfel `degraded`.
 */
export function overallStatus(checks: HealthReport["checks"]): OverallStatus {
  const all = Object.values(checks);
  if (all.includes("down")) return "down";
  return checks.db === "ok" && checks.storage === "ok" ? "ok" : "degraded";
}

export async function runHealthChecks(deps: HealthDeps): Promise<HealthReport> {
  const [dbStatus, storageStatus] = await Promise.all([
    checkDb(deps.databaseUrl, deps.databaseCa ?? null),
    checkStorage(deps.storage),
  ]);
  // După verificarea storage-ului: la prima pornire, directorul abia a fost creat.
  const disk = await diskFreePercent(deps.diskDir);
  // Coada (pg-boss) și furnizorul AI vin în fazele lor; până atunci, `unknown`.
  const checks = { db: dbStatus, storage: storageStatus, queue: "unknown", ai: "unknown" } as const;
  const report: HealthReport = { status: overallStatus(checks), checks: { ...checks } };
  if (disk !== undefined) report.diskFreePercent = disk;
  return report;
}
