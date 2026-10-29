import { createHash } from "node:crypto";

import { normalizeForDedup } from "./text";
import type { Direction, ParsedLine, StatementBank } from "./types";

/**
 * Cheile de deduplicare (master prompt Faza 7; ADR 0018), deterministe și idempotente:
 *
 * - rând obișnuit: SHA-256 peste (versiune, cont, dată, sens, sumă, descriere normalizată,
 *   referință normalizată, indicele de apariție). Indicele numără rândurile IDENTICE pe restul
 *   tuplului din același fișier (două cafele de 15,00 lei în aceeași zi = două chei diferite),
 *   deci reimportul aceluiași extras dă aceleași chei. Limită documentată: două extrase tăiate
 *   la mijlocul unei zile pot numerota diferit rândurile identice din acea zi.
 * - Revolut: `ID tranzacție` e unic la bancă → cheia = (cont, ID).
 * - schimb valutar: (cont, dată, sens, sumă, indicele de apariție) FĂRĂ descriere, ca piciorul
 *   transferului creat în contul-pereche (alt extras, altă monedă) să aibă aceeași cheie cu
 *   rândul de schimb din extrasul acelui cont (`fxKey`).
 *
 * Tranzacțiile create poartă `external_ref = 'stmt:' + cheie` (unic pe gospodărie, iar cheia
 * include contul, deci unic pe cont).
 */

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export const DEDUP_VERSION = "v1";
export const externalRefOf = (key: string): string => `stmt:${key}`;

export function fxKey(
  accountId: string,
  occurredOn: string,
  direction: Direction,
  amountMinor: bigint,
  occurrence: number,
): string {
  return sha(
    [DEDUP_VERSION, "fx", accountId, occurredOn, direction, amountMinor, occurrence].join("|"),
  );
}

/** `fx` există DOAR pentru rândurile de schimb valutar (`kind = 'fx'`), altfel `null`. */
export type LineKeys = Readonly<{ key: string; fx: string | null }>;

/**
 * Cheile fiecărui rând (aceeași ordine). Cheia „fx” (și indicele ei de apariție) se calculează
 * DOAR printre rândurile de schimb (revizuirea F7-A): un rând obișnuit (de exemplu o rambursare)
 * cu aceeași dată, sens și sumă ca piciorul unui transfer valutar nu e un duplicat al lui.
 */
export function computeKeys(
  accountId: string,
  bank: StatementBank,
  lines: readonly ParsedLine[],
): LineKeys[] {
  const seen = new Map<string, number>();
  const seenFx = new Map<string, number>();
  return lines.map((l) => {
    if (l.kind === "fx") {
      const fxTuple = [l.occurredOn, l.direction, l.amountMinor].join("|");
      const fxOcc = seenFx.get(fxTuple) ?? 0;
      seenFx.set(fxTuple, fxOcc + 1);
      const fx = fxKey(accountId, l.occurredOn, l.direction, l.amountMinor, fxOcc);
      return { key: fx, fx };
    }
    const fx = null;
    if (bank === "revolut" && l.bankReference) {
      return { key: sha([DEDUP_VERSION, "id", accountId, l.bankReference].join("|")), fx };
    }
    const tuple = [
      DEDUP_VERSION,
      accountId,
      l.occurredOn,
      l.direction,
      l.amountMinor,
      normalizeForDedup(l.description),
      normalizeForDedup(l.bankReference ?? ""),
    ].join("|");
    const occ = seen.get(tuple) ?? 0;
    seen.set(tuple, occ + 1);
    return { key: sha(`${tuple}|${occ}`), fx };
  });
}
