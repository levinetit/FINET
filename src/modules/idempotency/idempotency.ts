import "server-only";

import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Db, DbOrTx, Tx } from "@/db";
import { idempotencyKeys } from "@/db/schema";
import { type Actor, withMember } from "@/lib/authz";

/**
 * `Idempotency-Key` pentru mutațiile `POST` (master prompt 6.4, ADR 0005).
 *
 * Reguli:
 * - cheia: 16–128 caractere `[A-Za-z0-9_-]` (un UUID se potrivește); per gospodărie (RLS);
 * - `request_hash` = SHA-256 peste metodă, cale, utilizator și corpul JSON CANONIC (chei sortate
 *   recursiv, deci ordinea cheilor nu contează);
 * - aceeași cheie + aceeași cerere în 24 h → răspunsul inițial (status + corp), fără a doua
 *   scriere; aceeași cheie + altă cerere (alt corp, altă cale sau alt membru al gospodăriei)
 *   → 422 `idempotency_key_reused`;
 * - o cerere cu aceeași cheie aflată ÎN DESFĂȘURARE → 409 `request_in_progress` (lock consultativ
 *   `pg_try_advisory_xact_lock`, fără așteptare);
 * - rezervarea cheii, scrierea serviciului și răspunsul memorat sunt în ACEEAȘI tranzacție:
 *   serviciul rulează într-un savepoint; o eroare de domeniu (4xx) anulează doar savepoint-ul și
 *   se memorează, o eroare neașteptată (5xx) anulează tot (cheia nu rămâne rezervată);
 * - cheile mai vechi de 24 h nu mai contează: rândul expirat se șterge înainte de o nouă
 *   rezervare, iar `finet.purge_idempotency_keys()` (0003) le curăță pe toate.
 */

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidIdempotencyKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** JSON canonic: cheile obiectelor sortate recursiv; `undefined` dispare ca în `JSON.stringify`. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export type RequestFingerprint = Readonly<{
  method: string;
  path: string;
  userId: string;
  body: unknown;
}>;

export function requestHash(f: RequestFingerprint): string {
  const text = canonicalJson([f.method.toUpperCase(), f.path, f.userId, f.body ?? null]);
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Un răspuns memorabil: status + corp JSON (`null` pentru 204). */
export type StoredResponse = Readonly<{ status: number; body: unknown }>;

export type IdempotencyOutcome =
  | Readonly<{ kind: "fresh"; response: StoredResponse }>
  | Readonly<{ kind: "replay"; response: StoredResponse }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ kind: "reused" }>;

/**
 * Rezultatul unei rulări a serviciului: `stored` (succes sau eroare de domeniu, se memorează)
 * sau o excepție (5xx, nu se memorează: se aruncă mai departe și anulează tranzacția).
 */
export type IdempotentRun = (db: DbOrTx) => Promise<StoredResponse>;

/** Cheia lock-ului consultativ (bigint) pentru (gospodărie, cheie). Exportat pentru teste. */
export function lockKeySql(householdId: string, key: string) {
  return sql`hashtextextended(${`finet.idempotency:${householdId}:${key}`}, 0)`;
}

async function findKey(tx: Tx, householdId: string, key: string) {
  const rows = await tx
    .select({
      requestHash: idempotencyKeys.requestHash,
      response: idempotencyKeys.response,
      statusCode: idempotencyKeys.statusCode,
      createdAt: idempotencyKeys.createdAt,
    })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.householdId, householdId), eq(idempotencyKeys.key, key)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Rulează `run` o singură dată pentru (gospodărie, cheie, cerere). `householdId` vine din sesiune;
 * apartenența se verifică în aceeași tranzacție (`withMember`).
 */
export async function runIdempotent(
  db: Db,
  actor: Actor,
  householdId: string,
  key: string,
  hash: string,
  now: number,
  run: IdempotentRun,
): Promise<IdempotencyOutcome> {
  return withMember(
    actor,
    householdId,
    "member",
    async (tx, m) => {
      const hh = m.householdId;
      const [lock] = await tx.execute<{ ok: boolean }>(
        sql`select pg_try_advisory_xact_lock(${lockKeySql(hh, key)}) as ok`,
      );
      if (!lock?.ok) return { kind: "in_progress" } as const;

      const existing = await findKey(tx, hh, key);
      if (existing) {
        if (existing.createdAt.getTime() > now - IDEMPOTENCY_TTL_MS) {
          if (existing.requestHash !== hash) return { kind: "reused" } as const;
          // Un rând fără status nu poate fi vizibil (rezervarea și răspunsul sunt în aceeași
          // tranzacție), dar dacă apare, e tratat ca o cerere în curs.
          if (existing.statusCode === null) return { kind: "in_progress" } as const;
          return {
            kind: "replay",
            response: { status: existing.statusCode, body: existing.response ?? null },
          } as const;
        }
        await tx
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.householdId, hh), eq(idempotencyKeys.key, key)));
      }

      await tx.insert(idempotencyKeys).values({
        householdId: hh,
        key,
        requestHash: hash,
        createdAt: new Date(now),
      });
      const response = await run(tx);
      await tx
        .update(idempotencyKeys)
        .set({ response: response.body ?? null, statusCode: response.status })
        .where(and(eq(idempotencyKeys.householdId, hh), eq(idempotencyKeys.key, key)));
      return { kind: "fresh", response } as const;
    },
    { db },
  );
}

/**
 * Curățarea cheilor mai vechi de 24 h, prin funcția `finet.purge_idempotency_keys()` (0003,
 * SECURITY DEFINER). Întoarce numărul de rânduri șterse. Idempotentă.
 */
export async function purgeIdempotencyKeys(db: DbOrTx): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`select finet.purge_idempotency_keys() as n`);
  return Number(row?.n ?? 0);
}
