import { createHash, randomUUID } from "node:crypto";

import type postgres from "postgres";

import { normalizeProductName } from "@/modules/receipts/normalize";

/**
 * Doar pentru testele de integrare ale prețurilor și rapoartelor (Faza 10, F10-B): inserează
 * direct (ca superuser, ocolind RLS) un bon CONFIRMAT cu tranzacția lui și liniile lui. Nu se
 * importă din codul aplicației.
 */

export type SeedLine = Readonly<{
  name: string;
  quantity?: string | null;
  totalMinor: number;
  kind?: "product" | "discount" | "deposit_sgr" | "bag" | "other";
  categoryId?: string | null;
}>;

export type SeedReceipt = Readonly<{
  householdId: string;
  accountId: string;
  actorId: string;
  on: string;
  merchant?: string | null;
  cui?: string | null;
  currency?: "RON" | "EUR";
  lines: readonly SeedLine[];
  /** Implicit `saved`; alte stări pentru a verifica excluderea bonurilor neconfirmate. */
  status?: "saved" | "needs_review";
  /** `false`: bon confirmat fără tranzacție (ca după ștergerea tranzacției). */
  withTransaction?: boolean;
}>;

export type SeededReceipt = Readonly<{ receiptId: string; transactionId: string | null }>;

export async function seedReceipt(admin: postgres.Sql, r: SeedReceipt): Promise<SeededReceipt> {
  const currency = r.currency ?? "RON";
  const total = r.lines.reduce(
    (s, l) => s + (l.kind === "discount" ? -l.totalMinor : l.totalMinor),
    0,
  );
  const docId = randomUUID();
  await admin`insert into finet.documents (id, household_id, kind, status, detected_mime,
      size_bytes, sha256, storage_key, uploaded_by_user_id)
    values (${docId}, ${r.householdId}, 'receipt', 'done', 'image/jpeg', 10,
      ${createHash("sha256").update(docId).digest("hex")},
      ${`households/${r.householdId}/documents/${docId}`}, ${r.actorId})`;
  const saved = (r.status ?? "saved") === "saved";
  let transactionId: string | null = null;
  if (saved && r.withTransaction !== false) {
    transactionId = randomUUID();
    await admin`insert into finet.transactions (id, household_id, account_id, type, amount_minor,
        currency, occurred_on, description, source, created_by_user_id)
      values (${transactionId}, ${r.householdId}, ${r.accountId}, 'expense', ${Math.max(total, 1)},
        ${currency}, ${r.on}, 'Bon', 'receipt', ${r.actorId})`;
  }
  const receiptId = randomUUID();
  await admin`insert into finet.receipts (id, household_id, document_id, status, total_minor,
      currency, occurred_on, merchant_name, merchant_tax_id, transaction_id)
    values (${receiptId}, ${r.householdId}, ${docId}, ${r.status ?? "saved"}, ${Math.max(total, 0)},
      ${currency}, ${r.on}, ${r.merchant ?? null}, ${r.cui ?? null}, ${transactionId})`;
  let position = 0;
  for (const l of r.lines) {
    position += 1;
    await admin`insert into finet.receipt_lines (receipt_id, household_id, position, raw_name,
        normalized_name, quantity, unit_price_minor, line_total_minor, kind, category_id)
      values (${receiptId}, ${r.householdId}, ${position}, ${l.name},
        ${normalizeProductName(l.name)}, ${l.quantity ?? "1"}, null, ${l.totalMinor},
        ${l.kind ?? "product"}, ${l.categoryId ?? null})`;
  }
  return { receiptId, transactionId };
}
