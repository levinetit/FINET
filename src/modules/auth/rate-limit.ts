import "server-only";

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { Db } from "@/db";
import type { RateLimitRule } from "@/lib/config";

/**
 * Rate limiting pentru autentificare (master prompt 6.3), cu stocare în `finet.auth_rate_limits`
 * (fără Redis). Fereastră fixă: primul hit deschide fereastra (`last_request` = începutul ei, în
 * ms Unix), următoarele cresc contorul; după expirare, contorul pornește de la 1. Totul într-un
 * singur `INSERT ... ON CONFLICT DO UPDATE`, atomic și pentru cereri concurente.
 *
 * Cheile au prefixul `finet:` (nu se pot ciocni cu cheile Better Auth, de forma `ip|cale`) și nu
 * conțin date personale: emailul intră doar ca rezumat SHA-256 trunchiat.
 *
 * Cheia de bază e „IP de încredere + email normalizat” (`src/modules/auth/request.ts`): fără un
 * IP de încredere, toate cererile aceluiași email împart grupul `unknown`, deci limita rămâne
 * pe email (mai strictă, niciodată mai permisivă).
 */

export type RateLimitKind =
  | "login"
  | "mobile_login"
  | "login_email"
  | "known_ip"
  | "email"
  | "password_change"
  // API `/api/v1` (F2-B): mutațiile și evenimentele de utilizare, pe utilizator.
  | "api_mutation"
  | "app_events"
  // Exporturile CSV (F3-B), pe utilizator.
  | "api_export";

export type RateLimitResult = Readonly<{
  allowed: boolean;
  count: number;
  /** Secunde până se redeschide fereastra (pentru `Retry-After`). */
  retryAfterSeconds: number;
}>;

/** Rezumatul unei valori identificatoare (email, id), fără a o stoca în clar. */
export function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32);
}

/** Lungimea maximă a subiectului (un email are cel mult 254 de caractere) înainte de rezumat. */
export const SUBJECT_MAX_LENGTH = 254;

export function rateLimitKey(kind: RateLimitKind, ip: string | null, subject: string): string {
  return `finet:${kind}:${ip ?? "unknown"}:${digest(subject.slice(0, SUBJECT_MAX_LENGTH))}`;
}

/**
 * Curățarea oportunistă (M3): la un hit, rândurile expirate de același tip (`last_request` mai
 * vechi de 2 × fereastra) se șterg, cel mult o dată pe minut per proces și per tip, cel mult
 * `CLEANUP_BATCH` rânduri pe rulare. Contoarele agregate (`finet:stat:*`) nu sunt atinse.
 */
export const CLEANUP_INTERVAL_MS = 60_000;
export const CLEANUP_BATCH = 500;
const lastCleanup = new Map<string, number>();

/** Doar pentru teste: uită momentul ultimei curățări. */
export function resetCleanupForTests(): void {
  lastCleanup.clear();
}

function kindPrefixOf(key: string): string | null {
  const match = /^finet:([a-z_]{1,32}):/.exec(key);
  if (!match || match[1] === "stat") return null;
  return `finet:${match[1]}:`;
}

/** Curățarea throttled a tipului cheii `key` (vezi sus). */
async function maybeCleanup(db: Db, key: string, windowMs: number, now: number): Promise<void> {
  const prefix = kindPrefixOf(key);
  if (!prefix || now - (lastCleanup.get(prefix) ?? -Infinity) < CLEANUP_INTERVAL_MS) return;
  lastCleanup.set(prefix, now);
  try {
    await cleanupExpired(db, prefix, windowMs, now);
  } catch {
    // Curățarea e oportunistă: o eroare nu blochează limitarea.
  }
}

export async function cleanupExpired(
  db: Db,
  prefix: string,
  windowMs: number,
  now: number,
): Promise<number> {
  const cutoff = now - 2 * windowMs;
  const rows = await db.execute<{ id: string }>(sql`
    delete from finet.auth_rate_limits
     where id in (
       select id from finet.auth_rate_limits
        where left(key, ${prefix.length}) = ${prefix} and last_request < ${cutoff}
        limit ${CLEANUP_BATCH})
    returning id`);
  return rows.length;
}

type Row = { count: number; last_request: string | number };

/** Înregistrează o încercare și spune dacă e permisă. */
export async function hitRateLimit(
  db: Db,
  key: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const windowMs = rule.windowSeconds * 1000;
  const expiredBefore = now - windowMs;
  await maybeCleanup(db, key, windowMs, now);
  const rows = await db.execute<Row>(sql`
    insert into finet.auth_rate_limits (key, count, last_request)
    values (${key}, 1, ${now})
    on conflict (key) do update set
      count = case when finet.auth_rate_limits.last_request <= ${expiredBefore}
                   then 1 else finet.auth_rate_limits.count + 1 end,
      last_request = case when finet.auth_rate_limits.last_request <= ${expiredBefore}
                          then ${now} else finet.auth_rate_limits.last_request end
    returning count, last_request`);
  const row = rows[0];
  const count = Number(row?.count ?? 1);
  const start = Number(row?.last_request ?? now);
  return {
    allowed: count <= rule.max,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)),
  };
}

/**
 * Restituie o rezervare făcută cu `hitRateLimit` (cererea nu a fost o încercare reală, de
 * exemplu un 400 de validare sau un 5xx): `count = greatest(count - 1, 0)`, atomic.
 */
export async function releaseRateLimit(db: Db, key: string): Promise<void> {
  await db.execute(sql`
    update finet.auth_rate_limits set count = greatest(count - 1, 0) where key = ${key}`);
}

/** Marchează o pereche (IP de încredere, email) cu login reușit (`last_request` = acum). */
export async function markKnownIp(
  db: Db,
  key: string,
  ttlMs: number,
  now: number = Date.now(),
): Promise<void> {
  // Rândurile `known_ip` mai vechi de 2 × TTL se curăță la fel ca celelalte.
  await maybeCleanup(db, key, ttlMs, now);
  await db.execute(sql`
    insert into finet.auth_rate_limits (key, count, last_request) values (${key}, 1, ${now})
    on conflict (key) do update set last_request = ${now}`);
}

/** `true` dacă perechea a avut un login reușit în ultimele `withinMs` milisecunde. */
export async function isKnownIp(
  db: Db,
  key: string,
  withinMs: number,
  now: number = Date.now(),
): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(sql`
    select 1 as ok from finet.auth_rate_limits
     where key = ${key} and last_request > ${now - withinMs}`);
  return rows.length > 0;
}

/** Șterge contorul (de exemplu după un login reușit). */
export async function resetRateLimit(db: Db, key: string): Promise<void> {
  await db.execute(sql`delete from finet.auth_rate_limits where key = ${key}`);
}

/**
 * Contor agregat pe zi (UTC), fără date personale: login-urile eșuate (6.5, „eșecuri de
 * autentificare, agregat”). Decizia mea: `audit_events` cere o gospodărie și un actor din
 * contextul RLS, deci eșecurile (inclusiv pentru emailuri inexistente) se numără aici.
 */
export function dailyStatKey(name: "login_failed", now: number = Date.now()): string {
  return `finet:stat:${name}:${new Date(now).toISOString().slice(0, 10)}`;
}

export async function incrementDailyStat(
  db: Db,
  name: "login_failed",
  now: number = Date.now(),
): Promise<void> {
  await db.execute(sql`
    insert into finet.auth_rate_limits (key, count, last_request)
    values (${dailyStatKey(name, now)}, 1, ${now})
    on conflict (key) do update set
      count = finet.auth_rate_limits.count + 1, last_request = ${now}`);
}
