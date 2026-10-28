import "server-only";

import { sql } from "drizzle-orm";

import { type DbOrTx, withRlsOn } from "@/db";
import { CLIENT_HEADER, type ClientInfo, parseClientInfo } from "@/modules/auth/request";

/**
 * Instalările clienților (6.5, ADR 0005): antetul `X-FINET-Client` (forma completă, cu
 * `installation=<uuid>`) → `finet.client_installations`, cu CEL MULT O SCRIERE PE INSTALARE LA
 * 15 MINUTE: un singur `INSERT ... ON CONFLICT (user_id, installation_id) DO UPDATE ... WHERE
 * last_seen_at <= acum - 15 min` (fără scriere în rest). Fără antet sau cu antet invalid: nimic.
 * Rulează în tranzacția ei (contextul RLS al utilizatorului) și NU aruncă: o eroare aici nu
 * blochează cererea.
 */

export const INSTALLATION_WRITE_INTERVAL_MS = 15 * 60 * 1000;

export type InstallationWrite = "inserted" | "updated" | "skipped" | "none";

export async function upsertInstallation(
  db: DbOrTx,
  userId: string,
  info: ClientInfo,
  now: number,
): Promise<Exclude<InstallationWrite, "none">> {
  // Momentele ca text ISO (postgres.js nu serializează `Date` în `sql` brut fără tip).
  const at = new Date(now).toISOString();
  const before = new Date(now - INSTALLATION_WRITE_INTERVAL_MS).toISOString();
  return withRlsOn(db, { userId }, async (tx) => {
    const rows = await tx.execute<{ inserted: boolean }>(sql`
      insert into finet.client_installations as ci
        (installation_id, user_id, platform, app_version, version_code, os_version, device_model,
         locale, first_seen_at, last_seen_at)
      values (${info.installationId}, ${userId}, ${info.platform}, ${info.appVersion},
              ${info.versionCode}, ${info.osVersion}, ${info.deviceModel}, ${info.locale},
              ${at}::timestamptz, ${at}::timestamptz)
      on conflict (user_id, installation_id) do update set
        platform = excluded.platform,
        app_version = excluded.app_version,
        version_code = excluded.version_code,
        os_version = excluded.os_version,
        device_model = excluded.device_model,
        locale = excluded.locale,
        last_seen_at = excluded.last_seen_at
      where ci.last_seen_at <= ${before}::timestamptz
      returning (xmax = 0) as inserted`);
    const row = rows[0];
    if (!row) return "skipped";
    return row.inserted ? "inserted" : "updated";
  });
}

/** Din antetele cererii; nu aruncă niciodată. */
export async function recordClientInstallation(
  db: DbOrTx,
  userId: string,
  headers: Headers,
  now: number,
): Promise<InstallationWrite> {
  const info = parseClientInfo(headers.get(CLIENT_HEADER));
  if (!info) return "none";
  try {
    return await upsertInstallation(db, userId, info, now);
  } catch {
    console.error("[api] instalarea clientului nu a putut fi înregistrată");
    return "none";
  }
}
