import { createHash, randomUUID } from "node:crypto";

import type postgres from "postgres";

import { normalizeProductName } from "@/modules/receipts/normalize";

/**
 * Doar pentru testele listelor de cumpărături: un bon (cu documentul lui) și liniile lui, scrise
 * direct ca superuser (ca în `matching.test.ts`). Nu se importă din codul aplicației.
 */
export type SeedLine = readonly [
  rawName: string,
  kind?: "product" | "discount" | "deposit_sgr" | "bag" | "other",
];

export async function seedReceipt(
  admin: postgres.Sql,
  householdId: string,
  uploader: string,
  lines: readonly SeedLine[],
  over: { status?: "saved" | "needs_review"; merchant?: string; on?: string } = {},
): Promise<{ id: string; lineIds: string[] }> {
  const doc = randomUUID();
  await admin`insert into finet.documents (id, household_id, kind, status, detected_mime,
      size_bytes, sha256, storage_key, uploaded_by_user_id)
    values (${doc}, ${householdId}, 'receipt', 'needs_review', 'image/jpeg', 10,
      ${createHash("sha256").update(doc).digest("hex")},
      ${`households/${householdId}/documents/${doc}`}, ${uploader})`;
  const id = randomUUID();
  await admin`insert into finet.receipts (id, household_id, document_id, status, total_minor,
      occurred_on, merchant_name)
    values (${id}, ${householdId}, ${doc}, ${over.status ?? "saved"}, 5000,
      ${over.on ?? "2026-11-02"}, ${over.merchant ?? "MAGAZIN SINTETIC SRL"})`;
  const lineIds: string[] = [];
  let pos = 1;
  for (const [name, kind] of lines) {
    const lineId = randomUUID();
    await admin`insert into finet.receipt_lines (id, receipt_id, household_id, position, raw_name,
        normalized_name, quantity, line_total_minor, kind)
      values (${lineId}, ${id}, ${householdId}, ${pos++}, ${name},
        ${normalizeProductName(name)}, 1, 500, ${kind ?? "product"})`;
    lineIds.push(lineId);
  }
  return { id, lineIds };
}

/** Acordă consimțământul `external_ai` utilizatorului (direct, ca superuser). */
export async function grantExternalAi(admin: postgres.Sql, userId: string): Promise<void> {
  await admin`insert into finet.consents (user_id, kind) values (${userId}, 'external_ai')`;
}
