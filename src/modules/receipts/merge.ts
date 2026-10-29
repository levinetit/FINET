import type { ExtractedLine, ExtractedReceipt } from "./extraction.schema";
import { linesSum } from "./checks";

/**
 * Unirea unui bon lung din 2–4 poze (master prompt Faza 6, 3.6: „unire algoritmică, fără LLM”;
 * ADR 0014). Funcție pură.
 *
 * - Fiecare poză e citită separat (un `ExtractedReceipt` pe poză, în ordinea dată).
 * - La fiecare graniță dintre două poze consecutive se elimină CEA MAI LUNGĂ suprapunere: cel mai
 *   lung șir de linii identice între sfârșitul liniilor păstrate până acum și începutul pozei
 *   următoare. Liniile identice din alte locuri ale bonului rămân (doar granița se taie).
 * - Identitatea unei linii: numele normalizat (sau cel brut), tipul, cantitatea și totalul liniei.
 * - Ordinea: antetul (comerciant sau CUI) trebuie să fie pe prima poză, iar totalul pe ultima; o
 *   poză din mijloc nu are voie să aibă nici antet, nici total. Altfel: eroare `order` și
 *   ordinea propusă („Ordonează automat”): prima permutare (din cel mult 4! = 24) care respectă
 *   regula, păstrând cât mai mult ordinea dată.
 * - Rezultatul: liniile păstrate, cele eliminate cu motiv (poza și poziția în poză), antetul din
 *   prima poză, totalul și TVA-ul din ultima, suma liniilor păstrate comparată cu totalul.
 */

export type RemovedLine = Readonly<{
  /** Indicele pozei (0..3) și poziția liniei în poză (1..n). */
  part: number;
  position: number;
  reason: "overlap";
}>;

export type MergeResult =
  | Readonly<{
      ok: true;
      receipt: ExtractedReceipt;
      removed: readonly RemovedLine[];
      /** Suma liniilor păstrate − total (0n = potrivire; `null` fără total). */
      difference: bigint | null;
      /** Pozele au CUI-uri sau numere de bon diferite. */
      mismatch: boolean;
    }>
  | Readonly<{ ok: false; error: "order"; suggestedOrder: readonly number[] | null }>
  | Readonly<{ ok: false; error: "parts" }>;

export const MIN_PARTS = 2;
export const MAX_PARTS = 4;

function lineKey(l: ExtractedLine): string {
  return [
    l.normalizedName ?? l.rawName,
    l.kind,
    l.quantity ?? "",
    l.lineTotalMinor.toString(),
  ].join("\u0000");
}

const hasHeader = (r: ExtractedReceipt) => r.merchantName !== null || r.merchantTaxId !== null;
const hasTotal = (r: ExtractedReceipt) => r.totalMinor !== null;

/** Ordinea e corectă: antet doar pe prima, total doar pe ultima. */
export function orderValid(parts: readonly ExtractedReceipt[]): boolean {
  const last = parts.length - 1;
  return parts.every((p, i) => {
    if (i === 0) return hasHeader(p) && (last === 0 || !hasTotal(p));
    if (i === last) return hasTotal(p) && !hasHeader(p);
    return !hasHeader(p) && !hasTotal(p);
  });
}

function permutations(n: number): number[][] {
  if (n === 1) return [[0]];
  const out: number[][] = [];
  for (const rest of permutations(n - 1)) {
    for (let k = 0; k <= rest.length; k++) out.push([...rest.slice(0, k), n - 1, ...rest.slice(k)]);
  }
  // Ordinea lexicografică: permutările apropiate de ordinea dată apar primele.
  return out.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  });
}

/** „Ordonează automat”: prima ordine validă sau `null` dacă nu există. */
export function suggestOrder(parts: readonly ExtractedReceipt[]): number[] | null {
  for (const order of permutations(parts.length)) {
    if (orderValid(order.map((i) => parts[i]!))) return order;
  }
  return null;
}

/** Lungimea celei mai lungi suprapuneri: sfârșitul lui `a` = începutul lui `b`. */
export function overlapLength(a: readonly string[], b: readonly string[]): number {
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    let same = true;
    for (let j = 0; j < k; j++) {
      if (a[a.length - k + j] !== b[j]) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

export function mergeReceiptParts(parts: readonly ExtractedReceipt[]): MergeResult {
  if (parts.length < MIN_PARTS || parts.length > MAX_PARTS) return { ok: false, error: "parts" };
  if (!orderValid(parts)) return { ok: false, error: "order", suggestedOrder: suggestOrder(parts) };

  const kept: ExtractedLine[] = [...parts[0]!.lines];
  const keptKeys = kept.map(lineKey);
  const removed: RemovedLine[] = [];
  for (let p = 1; p < parts.length; p++) {
    const lines = parts[p]!.lines;
    const keys = lines.map(lineKey);
    const k = overlapLength(keptKeys, keys);
    for (let j = 0; j < k; j++) removed.push({ part: p, position: j + 1, reason: "overlap" });
    kept.push(...lines.slice(k));
    keptKeys.push(...keys.slice(k));
  }

  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const taxIds = new Set(parts.map((p) => p.merchantTaxId).filter((x): x is string => x !== null));
  const numbers = new Set(parts.map((p) => p.receiptNumber).filter((x): x is string => x !== null));
  const receipt: ExtractedReceipt = {
    merchantName: first.merchantName,
    merchantTaxId: first.merchantTaxId,
    merchantTaxIdMalformed: first.merchantTaxIdMalformed,
    storeAddress: first.storeAddress,
    receiptNumber: first.receiptNumber ?? last.receiptNumber,
    occurredOn: first.occurredOn ?? last.occurredOn,
    paymentMethod: last.paymentMethod ?? first.paymentMethod,
    currency: first.currency,
    totalMinor: last.totalMinor,
    vatTotalMinor: last.vatTotalMinor,
    lines: kept,
  };
  return {
    ok: true,
    receipt,
    removed,
    difference: last.totalMinor === null ? null : linesSum(kept) - last.totalMinor,
    mismatch: taxIds.size > 1 || numbers.size > 1 || new Set(parts.map((p) => p.currency)).size > 1,
  };
}
