import "server-only";

import { sql } from "drizzle-orm";

import { type DbOrTx, type Tx, withRlsOn } from "@/db";
import { CLIENT_HEADER, type ClientInfo, parseClientInfo } from "@/modules/auth/request";

import { hasActiveConsent } from "./consents";

/**
 * Instalările clienților (6.5, ADR 0005): antetul `X-FINET-Client` (forma completă, cu
 * `installation=<uuid>`) → `finet.client_installations`. Reguli:
 * - DOAR cu consimțământul `usage_stats` activ (verificat în aceeași tranzacție); fără acord nu
 *   se scrie nimic (revizuirea F2, MEDIUM-1);
 * - CEL MULT O SCRIERE PE INSTALARE LA 15 MINUTE: `INSERT ... ON CONFLICT (user_id,
 *   installation_id) DO UPDATE ... WHERE last_seen_at <= acum - 15 min`;
 * - cel mult `MAX_INSTALLATIONS_PER_USER` instalări per utilizator (MEDIUM-3): o instalare nouă
 *   peste plafon o înlocuiește pe cea văzută cel mai demult (serializat per utilizator).
 * Fără antet sau cu antet invalid: nimic. Rulează în tranzacția ei (contextul RLS al
 * utilizatorului) și NU aruncă: o eroare aici nu blochează cererea.
 */

export const INSTALLATION_WRITE_INTERVAL_MS = 15 * 60 * 1000;
export const MAX_INSTALLATIONS_PER_USER = 20;

export type InstallationWrite = "inserted" | "updated" | "skipped" | "none";

const COLUMNS = sql`(installation_id, user_id, platform, app_version, version_code, os_version,
  device_model, locale, first_seen_at, last_seen_at)`;

function values(userId: string, info: ClientInfo, at: string) {
  return sql`(${info.installationId}, ${userId}, ${info.platform}, ${info.appVersion},
    ${info.versionCode}, ${info.osVersion}, ${info.deviceModel}, ${info.locale},
    ${at}::timestamptz, ${at}::timestamptz)`;
}

async function insertWithCap(tx: Tx, userId: string, info: ClientInfo, at: string) {
  // Serializat per utilizator: două instalări noi simultane nu depășesc plafonul.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`finet.installations:${userId}`}, 0))`,
  );
  await tx.execute(sql`
    delete from finet.client_installations
     where id in (
       select id from finet.client_installations
        where user_id = ${userId}
        order by last_seen_at desc, id desc
        offset ${MAX_INSTALLATIONS_PER_USER - 1})`);
  const rows = await tx.execute<{ id: string }>(sql`
    insert into finet.client_installations ${COLUMNS} values ${values(userId, info, at)}
    on conflict (user_id, installation_id) do nothing
    returning id`);
  return rows.length > 0 ? ("inserted" as const) : ("skipped" as const);
}

export async function upsertInstallation(
  db: DbOrTx,
  userId: string,
  info: ClientInfo,
  now: number,
): Promise<InstallationWrite> {
  // Momentele ca text ISO (postgres.js nu serializează `Date` în `sql` brut fără tip).
  const at = new Date(now).toISOString();
  const before = new Date(now - INSTALLATION_WRITE_INTERVAL_MS).toISOString();
  return withRlsOn(db, { userId }, async (tx) => {
    if (!(await hasActiveConsent(tx, userId, "usage_stats"))) return "none";
    const existing = await tx.execute<{ id: string }>(sql`
      select id from finet.client_installations
       where user_id = ${userId} and installation_id = ${info.installationId}`);
    if (existing.length === 0) return insertWithCap(tx, userId, info, at);
    const rows = await tx.execute<{ id: string }>(sql`
      update finet.client_installations set
        platform = ${info.platform},
        app_version = ${info.appVersion},
        version_code = ${info.versionCode},
        os_version = ${info.osVersion},
        device_model = ${info.deviceModel},
        locale = ${info.locale},
        last_seen_at = ${at}::timestamptz
      where user_id = ${userId} and installation_id = ${info.installationId}
        and last_seen_at <= ${before}::timestamptz
      returning id`);
    return rows.length > 0 ? "updated" : "skipped";
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
