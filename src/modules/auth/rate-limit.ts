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

export type RateLimitKind = "login" | "mobile_login" | "login_email" | "email" | "password_change";

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

export function rateLimitKey(kind: RateLimitKind, ip: string | null, subject: string): string {
  return `finet:${kind}:${ip ?? "unknown"}:${digest(subject)}`;
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
