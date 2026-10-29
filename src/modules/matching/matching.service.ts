import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import {
  documents,
  processingBatches,
  receiptLines,
  receiptMatchRejections,
  receipts,
  transactions,
} from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { ConflictError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { dominantCategory } from "@/modules/receipts/receipts.service";

import { matchDecisionSchema, matchQueueSchema } from "./matching.schema";
import { MATCH_MAX_DAYS, MATCH_PROBABLE, type MatchReason, rankCandidates } from "./score";

/**
 * Potrivirea bon ↔ tranzacție (F7-B; ADR 0019). Totul sub RLS-ul membrului: candidații sunt doar
 * tranzacțiile pe care le VEDE (un cont personal al altui membru nu apare și nu se poate lega:
 * serviciul re-citește tranzacția sub RLS, iar triggerul `receipts_check_transaction` din 0014 o
 * refuză oricum). Candidați: cheltuieli din extras (`source = 'statement'`), aceeași monedă, suma
 * EXACTĂ, ±3 zile, nelegate deja de un alt bon, nerespinse pentru acest bon.
 *
 * Confirmarea NU creează o tranzacție nouă (niciodată două tranzacții pentru aceeași cheltuială):
 * - bon nesalvat (`needs_review`): bonul se leagă de tranzacția din extras și devine `saved`;
 * - bon deja salvat cu tranzacția LUI (`source = 'receipt'`): legătura trece pe tranzacția din
 *   extras, iar tranzacția bonului (duplicatul) se șterge — doar dacă e vizibilă și nemodificată
 *   (fără etichete, fără împărțire); altfel conflict, utilizatorul rezolvă manual.
 * Categoria tranzacției din extras se completează din bon doar dacă lipsește.
 */

export type MatchDeps = LedgerDeps;

export type MatchCandidate = Readonly<{
  transactionId: string;
  accountId: string;
  occurredOn: string;
  amountMinor: bigint;
  currency: Currency;
  description: string | null;
  score: number;
  probable: boolean;
  reasons: readonly MatchReason[];
}>;

export type ReceiptMatches = Readonly<{
  receiptId: string;
  status: "needs_review" | "saved";
  merchantName: string | null;
  occurredOn: string;
  totalMinor: bigint;
  currency: Currency;
  ambiguous: boolean;
  candidates: readonly MatchCandidate[];
}>;

type ReceiptRow = typeof receipts.$inferSelect;
const CANDIDATE_LIMIT = 20;

/** Bonul e eligibil: total și dată cunoscute; salvat doar cu tranzacția creată din el. */
async function eligibleReceipt(tx: Tx, householdId: string, r: ReceiptRow) {
  if (r.totalMinor === null || r.totalMinor <= 0n || r.occurredOn === null) return null;
  if (r.status === "needs_review" && r.transactionId === null) return { own: null };
  if (r.status !== "saved" || r.transactionId === null) return null;
  const [own] = await tx
    .select({ id: transactions.id, source: transactions.source })
    .from(transactions)
    .where(and(eq(transactions.householdId, householdId), eq(transactions.id, r.transactionId)))
    .limit(1);
  // Tranzacția bonului e invizibilă (cont personal al altui membru) sau e deja una din extras.
  if (!own || own.source !== "receipt") return null;
  return { own: own.id };
}

async function candidatesFor(tx: Tx, householdId: string, r: ReceiptRow) {
  const from = sql`${r.occurredOn}::date - ${MATCH_MAX_DAYS}::int`;
  const to = sql`${r.occurredOn}::date + ${MATCH_MAX_DAYS}::int`;
  const rows = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      occurredOn: transactions.occurredOn,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      description: transactions.description,
      merchant: transactions.merchant,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.type, "expense"),
        eq(transactions.source, "statement"),
        eq(transactions.currency, r.currency),
        eq(transactions.amountMinor, r.totalMinor!),
        sql`${transactions.occurredOn} >= ${from}`,
        sql`${transactions.occurredOn} <= ${to}`,
        sql`not exists (select 1 from finet.receipts x where x.transaction_id = ${transactions.id})`,
        sql`not exists (select 1 from finet.receipt_match_rejections j
                         where j.receipt_id = ${r.id} and j.transaction_id = ${transactions.id})`,
      ),
    )
    .limit(100);
  const { ranked, ambiguous } = rankCandidates(
    {
      totalMinor: r.totalMinor!,
      currency: r.currency,
      occurredOn: r.occurredOn!,
      merchantName: r.merchantName,
      merchantTaxId: r.merchantTaxId,
    },
    rows,
  );
  return {
    ambiguous,
    candidates: ranked.slice(0, CANDIDATE_LIMIT).map((c): MatchCandidate => ({
      transactionId: c.item.id,
      accountId: c.item.accountId,
      occurredOn: c.item.occurredOn,
      amountMinor: c.item.amountMinor,
      currency: c.item.currency as Currency,
      description: c.item.description,
      score: c.score,
      probable: c.score >= MATCH_PROBABLE,
      reasons: c.reasons,
    })),
  };
}

async function loadReceipt(tx: Tx, householdId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(receipts)
    .where(and(eq(receipts.householdId, householdId), eq(receipts.id, id)))
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError();
  return row;
}

function view(r: ReceiptRow, c: Awaited<ReturnType<typeof candidatesFor>>): ReceiptMatches {
  return {
    receiptId: r.id,
    status: r.status as "needs_review" | "saved",
    merchantName: r.merchantName,
    occurredOn: r.occurredOn!,
    totalMinor: r.totalMinor!,
    currency: r.currency as Currency,
    ambiguous: c.ambiguous,
    candidates: c.candidates,
  };
}

/** Sugestiile pentru un bon (listă goală dacă bonul nu e eligibil). */
export async function getReceiptMatches(
  deps: MatchDeps,
  actor: Actor,
  householdId: string,
  receiptId: string,
): Promise<ReceiptMatches | null> {
  if (!isValidId(receiptId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const r = await loadReceipt(tx, m.householdId, receiptId.toLowerCase());
    if (!(await eligibleReceipt(tx, m.householdId, r))) return null;
    return view(r, await candidatesFor(tx, m.householdId, r));
  });
}

/** Coada: bonurile eligibile (cele mai noi întâi) care au cel puțin un candidat. */
export async function listMatchQueue(
  deps: MatchDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<ReceiptMatches[]> {
  const input = parseInput(matchQueueSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    // Preselecție în SQL: doar bonurile pentru care există o cheltuială din extras cu aceeași
    // sumă și monedă în fereastră (fără a citi toate bonurile).
    const rows = await tx
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.householdId, m.householdId),
          inArray(receipts.status, ["needs_review", "saved"]),
          sql`${receipts.totalMinor} > 0 and ${receipts.occurredOn} is not null`,
          sql`exists (select 1 from finet.transactions t
                       where t.household_id = ${receipts.householdId}
                         and t.type = 'expense' and t.source = 'statement'
                         and t.currency = ${receipts.currency}
                         and t.amount_minor = ${receipts.totalMinor}
                         and t.occurred_on >= ${receipts.occurredOn} - ${MATCH_MAX_DAYS}::int
                         and t.occurred_on <= ${receipts.occurredOn} + ${MATCH_MAX_DAYS}::int
                         and not exists (select 1 from finet.receipts x
                                          where x.transaction_id = t.id))`,
        ),
      )
      .orderBy(sql`${receipts.occurredOn} desc`, sql`${receipts.id}`)
      .limit(input.limit * 2);
    const out: ReceiptMatches[] = [];
    for (const r of rows) {
      if (out.length >= input.limit) break;
      if (!(await eligibleReceipt(tx, m.householdId, r))) continue;
      const c = await candidatesFor(tx, m.householdId, r);
      if (c.candidates.length) out.push(view(r, c));
    }
    return out;
  });
}

export type MatchDecisionResult = Readonly<{
  receiptId: string;
  transactionId: string;
  decision: "confirm" | "reject";
  /** Tranzacția creată anterior din bon, ștearsă ca duplicat (doar la confirmare). */
  removedTransactionId: string | null;
}>;

export async function decideReceiptMatch(
  deps: MatchDeps,
  actor: Actor,
  householdId: string,
  receiptId: string,
  rawInput: unknown,
): Promise<MatchDecisionResult> {
  if (!isValidId(receiptId)) throw new NotFoundError();
  const input = parseInput(matchDecisionSchema, rawInput);
  const txId = input.transactionId.toLowerCase();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const hh = m.householdId;
    const r = await loadReceipt(tx, hh, receiptId.toLowerCase(), true);
    const eligible = await eligibleReceipt(tx, hh, r);
    // Tranzacția trebuie să fie un candidat VALID acum (vizibilă, aceeași sumă/monedă, ±3 zile,
    // nelegată, nerespinsă): un id ghicit sau străin dă 404 uniform.
    const { candidates } = eligible ? await candidatesFor(tx, hh, r) : { candidates: [] };
    if (!candidates.some((c) => c.transactionId === txId)) {
      if (input.decision === "reject") {
        // Idempotent: respingerea deja memorată.
        const [done] = await tx
          .select({ id: receiptMatchRejections.transactionId })
          .from(receiptMatchRejections)
          .where(
            and(
              eq(receiptMatchRejections.receiptId, r.id),
              eq(receiptMatchRejections.transactionId, txId),
            ),
          )
          .limit(1);
        if (done) {
          return {
            receiptId: r.id,
            transactionId: txId,
            decision: "reject",
            removedTransactionId: null,
          };
        }
      } else if (r.transactionId === txId) {
        // Idempotent: confirmarea deja aplicată.
        return {
          receiptId: r.id,
          transactionId: txId,
          decision: input.decision,
          removedTransactionId: null,
        };
      }
      throw new NotFoundError();
    }
    if (input.decision === "reject") {
      await tx
        .insert(receiptMatchRejections)
        .values({
          householdId: hh,
          receiptId: r.id,
          transactionId: txId,
          rejectedByUserId: actor.userId,
        })
        .onConflictDoNothing();
      await insertAudit(tx, actor.userId, hh, {
        action: "receipt.match_rejected",
        targetType: "receipt",
        targetId: r.id,
      });
      return {
        receiptId: r.id,
        transactionId: txId,
        decision: "reject",
        removedTransactionId: null,
      };
    }

    const [target] = await tx
      .select({
        id: transactions.id,
        categoryId: transactions.categoryId,
        merchant: transactions.merchant,
      })
      .from(transactions)
      .where(and(eq(transactions.householdId, hh), eq(transactions.id, txId)))
      .for("update")
      .limit(1);
    if (!target) throw new NotFoundError();

    let categoryId: string | null = null;
    let removed: string | null = null;
    if (eligible!.own) {
      // Duplicatul (tranzacția creată din bon): doar dacă e nemodificat.
      const [own] = await tx.execute<{ category_id: string | null; touched: boolean }>(sql`
        select t.category_id,
               (exists (select 1 from finet.transaction_tags g where g.transaction_id = t.id)
                or exists (select 1 from finet.transaction_splits s where s.transaction_id = t.id))
                 as touched
          from finet.transactions t
         where t.id = ${eligible!.own} and t.household_id = ${hh}
         for update`);
      if (!own) throw new NotFoundError();
      if (own.touched) {
        throw new ConflictError(
          "receipt_transaction_edited",
          "Tranzacția bonului are etichete sau e împărțită; leagă manual.",
        );
      }
      categoryId = own.category_id;
      removed = eligible!.own;
    } else {
      const lines = await tx
        .select({
          kind: receiptLines.kind,
          categoryId: receiptLines.categoryId,
          lineTotalMinor: receiptLines.lineTotalMinor,
        })
        .from(receiptLines)
        .where(and(eq(receiptLines.householdId, hh), eq(receiptLines.receiptId, r.id)));
      categoryId = dominantCategory(lines);
    }

    // Legătura trece pe tranzacția din extras (indexul unic: o tranzacție, un bon) ÎNAINTE de
    // ștergerea duplicatului.
    await tx
      .update(receipts)
      .set({ status: "saved", transactionId: txId, updatedAt: new Date() })
      .where(and(eq(receipts.householdId, hh), eq(receipts.id, r.id)));
    if (removed) {
      await tx
        .delete(transactions)
        .where(and(eq(transactions.householdId, hh), eq(transactions.id, removed)));
    }
    const patch: { categoryId?: string; merchant?: string; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (target.categoryId === null && categoryId !== null) patch.categoryId = categoryId;
    if (target.merchant === null && r.merchantName) patch.merchant = r.merchantName.slice(0, 200);
    if (patch.categoryId !== undefined || patch.merchant !== undefined) {
      await tx
        .update(transactions)
        .set(patch)
        .where(and(eq(transactions.householdId, hh), eq(transactions.id, txId)));
    }
    if (r.status === "needs_review") {
      await tx
        .update(documents)
        .set({ status: "done", updatedAt: new Date() })
        .where(
          and(
            eq(documents.householdId, hh),
            r.batchId === null ? eq(documents.id, r.documentId!) : eq(documents.batchId, r.batchId),
          ),
        );
      if (r.batchId !== null) {
        await tx
          .update(processingBatches)
          .set({ status: "done", updatedAt: new Date() })
          .where(and(eq(processingBatches.householdId, hh), eq(processingBatches.id, r.batchId)));
      }
    }
    await insertAudit(tx, actor.userId, hh, {
      action: "receipt.matched",
      targetType: "receipt",
      targetId: r.id,
      metadata: { replacedOwn: removed !== null },
    });
    return {
      receiptId: r.id,
      transactionId: txId,
      decision: "confirm",
      removedTransactionId: removed,
    };
  });
}
