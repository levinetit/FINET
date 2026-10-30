import "server-only";

import { z } from "zod";

import type { Actor } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { ExportTable } from "@/lib/export-table";
import { daysInclusive } from "@/lib/periods";
import { selectAccounts } from "@/modules/accounts/accounts.repo";
import type { PlanningDeps } from "@/modules/budgets/budgets.service";
import { categoryNames } from "@/modules/dashboard/dashboard.service";
import { inHousehold } from "@/modules/ledger/context";
import { dateSchema, parseInput } from "@/modules/ledger/input";

import { type AccountingReceipt, accountingTable, receiptListTable } from "./accounting";
import {
  countAccountingReceipts,
  selectAccountingGroups,
  selectAccountingReceipts,
  selectTransactionLinks,
} from "./accounting.repo";
import { type ExportFormat, MAX_EXPORT_ROWS, auditExport } from "./exports.service";

/**
 * Exportul pentru contabil și lista bonurilor (Faza 10, F10-C; ADR 0024): un tabel (`ExportTable`)
 * pe o perioadă aleasă, scris apoi ca CSV, Excel sau PDF de apelant. Perioada e obligatorie, cel
 * mult `MAX_SPAN_DAYS` de zile, iar numărul de bonuri e plafonat (peste plafon: 409
 * `export_too_large`, fără conținut parțial). Auditul păstrează doar tipul, formatul și numărul.
 */

export const MAX_SPAN_DAYS = 1_100;

const querySchema = z
  .strictObject({ from: dateSchema, to: dateSchema })
  .refine((q) => q.from <= q.to, {
    message: "Data de început trebuie să fie înaintea celei de sfârșit.",
  });

export type AccountingKind = "accounting" | "receipts";

export type AccountingOptions = Readonly<{
  format: ExportFormat;
  maxRows?: number;
}>;

export async function exportAccountingTable(
  deps: PlanningDeps,
  actor: Actor,
  householdId: string,
  kind: AccountingKind,
  rawQuery: unknown,
  options: AccountingOptions,
): Promise<ExportTable> {
  const query = parseInput(querySchema, rawQuery);
  if (!query) throw new ValidationError({ _: "Alege perioada exportului." });
  if (daysInclusive(query.from, query.to) > MAX_SPAN_DAYS) {
    throw new ValidationError({ to: "Perioada poate avea cel mult 1.100 de zile." });
  }
  const maxRows = options.maxRows ?? MAX_EXPORT_ROWS;
  const window = { from: query.from, to: query.to };
  const now = deps.now ?? (() => new Date());

  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const total = await countAccountingReceipts(tx, m.householdId, window);
    if (total > maxRows) {
      throw new ConflictError(
        "export_too_large",
        `Exportul are peste ${maxRows} de rânduri; restrânge perioada.`,
      );
    }
    await auditExport(tx, actor, m.householdId, kind, total, options.format);
    const rows = await selectAccountingReceipts(tx, m.householdId, window, maxRows);
    const groups = new Map<string, { rate: string | null; grossMinor: bigint }[]>();
    for (const g of await selectAccountingGroups(tx, m.householdId, window)) {
      const list = groups.get(g.receiptId) ?? [];
      list.push({ rate: g.rate, grossMinor: BigInt(g.gross) });
      groups.set(g.receiptId, list);
    }
    const links = new Map(
      (await selectTransactionLinks(tx, m.householdId, window)).map((l) => [l.id, l]),
    );
    const accountNames = new Map(
      (await selectAccounts(tx, m.householdId, { includeArchived: true })).map((a) => [
        a.id,
        a.name,
      ]),
    );
    const categories = await categoryNames(tx, m.householdId);
    const receipts: AccountingReceipt[] = rows.map((r) => {
      const link = r.transactionId ? links.get(r.transactionId) : undefined;
      return {
        id: r.id,
        occurredOn: r.occurredOn!,
        number: r.number,
        merchantName: r.merchantName,
        merchantTaxId: r.merchantTaxId,
        currency: r.currency,
        totalMinor: r.totalMinor,
        vatTotalMinor: r.vatTotalMinor,
        accountName: link ? (accountNames.get(link.accountId) ?? null) : null,
        categoryName: link?.categoryId ? (categories.get(link.categoryId) ?? null) : null,
        groups: groups.get(r.id) ?? [],
      };
    });
    const context = [
      `Perioada: ${query.from} – ${query.to}`,
      `Generat la ${now().toISOString().slice(0, 10)}`,
    ];
    return kind === "accounting"
      ? accountingTable(receipts, context)
      : receiptListTable(receipts, context);
  });
}
