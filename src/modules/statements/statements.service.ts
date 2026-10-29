import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Tx } from "@/db";
import { statementImports, statementLines, statementUsageDaily, transactions } from "@/db/schema";
import { type Actor, NotFoundError } from "@/lib/authz";
import { DEFAULT_TIME_ZONE, type Month, localDateOf } from "@/lib/calendar";
import { ConflictError, ValidationError } from "@/lib/errors";
import type { Currency } from "@/lib/money";
import { insertAudit } from "@/modules/auth/audit";
import { type LedgerDeps, inHousehold } from "@/modules/ledger/context";
import { isValidId, parseInput } from "@/modules/ledger/input";
import { assertAccountsWithinJsonRange } from "@/modules/ledger/range-guard";
import { requireOpenAccount } from "@/modules/transactions/transactions.service";

import { type BalanceReason, checkBalances } from "./balances";
import { type CoverageCell, coverageForMonth, monthsBetween } from "./coverage";
import { computeKeys, externalRefOf, fxKey } from "./dedup";
import {
  cancelImportSchema,
  confirmImportSchema,
  coverageSchema,
  listImportsSchema,
} from "./statements.schema";
import type { ParsedStatement } from "./types";

/**
 * Serviciile importului de extrase (ADR 0018): previzualizare (fără scriere în registru),
 * confirmare (tranzacțiile și importul în aceeași tranzacție SQL, idempotentă), anulare,
 * listare/detaliu, acoperire pe luni. Totul sub RLS-ul membrului (`inHousehold`): un import pe un
 * cont personal e vizibil doar proprietarului; orice resursă invizibilă = 404 uniform. Erorile au
 * coduri fixe; auditul nu conține sume, descrieri sau IBAN-uri.
 */

export type StatementDeps = LedgerDeps &
  Readonly<{
    now?: () => Date;
    /** Previzualizări pe zi și gospodărie (contor doar crescător). */
    dailyLimit?: number;
    /**
     * Cota a fost deja consumată pentru această parte, ÎNAINTE de citirea fișierului (încărcarea
     * prin API și workerul PDF; revizuirea F7-A): previzualizarea nu o mai incrementează.
     */
    quotaCharged?: boolean;
  }>;

/** Plafonul zilnic implicit al previzualizărilor (decizia mea, ADR 0018). */
export const STATEMENT_DAILY_LIMIT = 50;
const PARSER_VERSION_MAX = 1000;

export type StatementLineView = Readonly<{
  rowNo: number;
  occurredOn: string;
  direction: "debit" | "credit";
  amountMinor: bigint;
  description: string;
  bankReference: string | null;
  kind: "movement" | "fx";
  fxAmountMinor: bigint | null;
  fxCurrency: Currency | null;
  balanceAfterMinor: bigint | null;
  state: "new" | "duplicate" | "imported" | "skipped" | "cancelled";
  transactionId: string | null;
}>;

export type StatementImportView = Readonly<{
  id: string;
  accountId: string;
  currency: Currency;
  bank: string;
  format: string;
  status: "previewed" | "imported" | "failed" | "cancelled";
  periodStart: string | null;
  periodEnd: string | null;
  openingBalanceMinor: bigint | null;
  closingBalanceMinor: bigint | null;
  computedClosingMinor: bigint | null;
  balanceStatus: "ok" | "mismatch" | "unknown";
  lineCount: number;
  newCount: number;
  duplicateCount: number;
  pendingCount: number;
  importedCount: number;
  warnings: readonly string[];
  createdAt: Date;
  importedAt: Date | null;
  cancelledAt: Date | null;
  lines?: readonly StatementLineView[];
}>;

export type PreviewResult = Readonly<{
  import: StatementImportView;
  /** Același fișier era deja importat pe acest cont (nimic nou creat). */
  alreadyImported: boolean;
  balanceReasons: readonly BalanceReason[];
}>;

type ImportRow = typeof statementImports.$inferSelect;
type LineRow = typeof statementLines.$inferSelect;

function toView(r: ImportRow, lines?: readonly LineRow[]): StatementImportView {
  return {
    id: r.id,
    accountId: r.accountId,
    currency: r.currency,
    bank: r.bank,
    format: r.format,
    status: r.status,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    openingBalanceMinor: r.openingBalanceMinor,
    closingBalanceMinor: r.closingBalanceMinor,
    computedClosingMinor: r.computedClosingMinor,
    balanceStatus: r.balanceStatus,
    lineCount: r.lineCount,
    newCount: r.newCount,
    duplicateCount: r.duplicateCount,
    pendingCount: r.pendingCount,
    importedCount: r.importedCount,
    warnings: r.warningCodes ? r.warningCodes.split(",") : [],
    createdAt: r.createdAt,
    importedAt: r.importedAt,
    cancelledAt: r.cancelledAt,
    ...(lines
      ? {
          lines: lines.map((l) => ({
            rowNo: l.rowNo,
            occurredOn: l.occurredOn,
            direction: l.direction,
            amountMinor: l.amountMinor,
            description: l.description,
            bankReference: l.bankReference,
            kind: l.kind,
            fxAmountMinor: l.fxAmountMinor,
            fxCurrency: l.fxCurrency,
            balanceAfterMinor: l.balanceAfterMinor,
            state: l.state,
            transactionId: l.transactionId,
          })),
        }
      : {}),
  };
}

/** Serializează importurile pe același cont (previzualizare, confirmare, anulare). */
async function lockAccount(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`finet.statement:${accountId}`}, 0))`,
  );
}

async function loadImport(tx: Tx, householdId: string, id: string, lock = false) {
  const q = tx
    .select()
    .from(statementImports)
    .where(and(eq(statementImports.householdId, householdId), eq(statementImports.id, id)))
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  if (!row) throw new NotFoundError();
  return row;
}

async function loadLines(tx: Tx, importId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(statementLines)
    .where(eq(statementLines.importId, importId))
    .orderBy(statementLines.rowNo);
}

/**
 * Cheile deja prezente pe cont: rânduri importate (din importuri neanulate; o tranzacție ștearsă
 * manual nu se recreează la reimport) și tranzacții cu aceeași `external_ref` (inclusiv
 * piciorul unui transfer valutar creat din extrasul celuilalt cont: cheia `fx`).
 */
async function existingKeys(
  tx: Tx,
  householdId: string,
  accountId: string,
  keys: readonly string[],
  fxKeys: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  if (keys.length === 0) return found;
  const lines = await tx
    .select({ key: statementLines.dedupKey })
    .from(statementLines)
    .where(
      and(
        eq(statementLines.accountId, accountId),
        eq(statementLines.state, "imported"),
        inArray(statementLines.dedupKey, [...keys]),
      ),
    );
  for (const l of lines) found.add(l.key);
  const refs = [...keys, ...fxKeys].map(externalRefOf);
  const txs = await tx
    .select({ ref: transactions.externalRef, type: transactions.type })
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.accountId, accountId),
        inArray(transactions.externalRef, refs),
      ),
    );
  for (const t of txs) {
    const key = t.ref!.slice(5);
    // Cheia `fx` contează doar pentru picioarele de transfer (altfel ar potrivi orice rând cu
    // aceeași dată și sumă).
    if (keys.includes(key) || t.type === "transfer") found.add(key);
  }
  return found;
}

/**
 * Cota zilnică (contor doar crescător, verificat și incrementat atomic; triggerul din 0014 refuză
 * scăderea). Se consumă ÎNAINTE de orice citire a fișierului: un fișier refuzat sau care nu se
 * poate citi consumă și el din cotă.
 */
export async function chargeStatementQuota(
  tx: Tx,
  householdId: string,
  parts: number,
  now: Date,
  limit: number = STATEMENT_DAILY_LIMIT,
): Promise<void> {
  if (!(Number.isSafeInteger(parts) && parts >= 1 && parts <= 100)) {
    throw new ValidationError({ _: "Număr de fișiere invalid." });
  }
  const day = localDateOf(now, DEFAULT_TIME_ZONE);
  const [usage] = await tx
    .insert(statementUsageDaily)
    .values({ householdId, day, count: parts })
    .onConflictDoUpdate({
      target: [statementUsageDaily.householdId, statementUsageDaily.day],
      set: { count: sql`${statementUsageDaily.count} + ${parts}`, updatedAt: now },
    })
    .returning({ count: statementUsageDaily.count });
  if ((usage?.count ?? 0) > limit) {
    throw new ConflictError("statement_daily_limit", "S-a atins limita zilnică de extrase.");
  }
}

// ---------------------------------------------------------------------------------------------
// Previzualizare
// ---------------------------------------------------------------------------------------------

export async function createStatementPreview(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  input: Readonly<{ accountId: string; sourceSha256: string; parsed: ParsedStatement }>,
): Promise<PreviewResult> {
  if (!isValidId(input.accountId)) throw new NotFoundError();
  if (!/^[0-9a-f]{64}$/.test(input.sourceSha256)) {
    throw new ValidationError({ sourceSha256: "Amprenta fișierului e invalidă." });
  }
  const parsed = input.parsed;
  if (!(parsed.parserVersion >= 1 && parsed.parserVersion <= PARSER_VERSION_MAX)) {
    throw new ValidationError({ parsed: "Versiunea parserului e invalidă." });
  }
  const now = (deps.now ?? (() => new Date()))();
  const limit = deps.dailyLimit ?? STATEMENT_DAILY_LIMIT;
  const accountId = input.accountId.toLowerCase();

  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const account = await requireOpenAccount(tx, m.householdId, accountId);
    if (account.currency !== parsed.currency) {
      throw new ConflictError(
        "statement_currency_mismatch",
        "Extrasul e în altă monedă decât contul.",
      );
    }
    await lockAccount(tx, account.id);

    // Același fișier pe același cont: previzualizarea existentă (idempotent) sau „deja importat”.
    const [same] = await tx
      .select()
      .from(statementImports)
      .where(
        and(
          eq(statementImports.accountId, account.id),
          eq(statementImports.sourceSha256, input.sourceSha256),
          inArray(statementImports.status, ["previewed", "imported"]),
        ),
      )
      .limit(1);
    if (same) {
      return {
        import: toView(same, await loadLines(tx, same.id)),
        alreadyImported: same.status === "imported",
        balanceReasons: [],
      };
    }

    if (!deps.quotaCharged) await chargeStatementQuota(tx, m.householdId, 1, now, limit);

    const keys = computeKeys(account.id, parsed.bank, parsed.lines);
    const existing = await existingKeys(
      tx,
      m.householdId,
      account.id,
      keys.map((k) => k.key),
      keys.flatMap((k) => (k.fx ? [k.fx] : [])),
    );
    // A doua apariție a aceleiași chei în ACELAȘI fișier (de exemplu un `ID tranzacție` Revolut
    // repetat) e un duplicat încă din previzualizare (revizuirea F7-A), nu o eroare la confirmare.
    const inFile = new Set<string>();
    const states = keys.map((k): "new" | "duplicate" => {
      const dup = existing.has(k.key) || (k.fx !== null && existing.has(k.fx)) || inFile.has(k.key);
      inFile.add(k.key);
      return dup ? "duplicate" : "new";
    });
    const balance = checkBalances(parsed);
    const warnings = new Set(parsed.warnings);
    for (const r of balance.reasons) warnings.add(r);
    // Suprapunere cu importuri confirmate pe același cont (perioadă comună).
    if (parsed.periodStart && parsed.periodEnd) {
      const overlap = await tx
        .select({ id: statementImports.id })
        .from(statementImports)
        .where(
          and(
            eq(statementImports.accountId, account.id),
            eq(statementImports.status, "imported"),
            sql`${statementImports.periodStart} <= ${parsed.periodEnd}`,
            sql`${statementImports.periodEnd} >= ${parsed.periodStart}`,
          ),
        )
        .limit(1);
      if (overlap.length) warnings.add("overlapping_import");
    }
    if (states.some((s) => s === "duplicate")) warnings.add("duplicates_found");
    const newCount = states.filter((s) => s === "new").length;
    const id = randomUUID();
    const [row] = await tx
      .insert(statementImports)
      .values({
        id,
        householdId: m.householdId,
        accountId: account.id,
        currency: account.currency,
        createdByUserId: actor.userId,
        bank: parsed.bank,
        format: parsed.format,
        status: "previewed",
        parserVersion: parsed.parserVersion,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        openingBalanceMinor: parsed.openingBalanceMinor,
        closingBalanceMinor: parsed.closingBalanceMinor,
        computedClosingMinor: balance.computedClosingMinor,
        balanceStatus: balance.status,
        sourceSha256: input.sourceSha256,
        lineCount: parsed.lines.length,
        newCount,
        duplicateCount: parsed.lines.length - newCount,
        pendingCount: parsed.pendingCount,
        warningCodes: warnings.size ? [...warnings].slice(0, 20).join(",") : null,
      })
      .returning();
    if (parsed.lines.length) {
      await tx.insert(statementLines).values(
        parsed.lines.map((l, i) => ({
          householdId: m.householdId,
          importId: id,
          accountId: account.id,
          currency: account.currency,
          rowNo: l.rowNo,
          occurredOn: l.occurredOn,
          direction: l.direction,
          amountMinor: l.amountMinor,
          description: l.description,
          bankReference: l.bankReference,
          dedupKey: keys[i]!.key,
          kind: l.kind,
          fxAmountMinor: l.fxAmountMinor,
          fxCurrency: l.fxCurrency,
          balanceAfterMinor: l.balanceAfterMinor,
          state: states[i]!,
        })),
      );
    }
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "statement.previewed",
      targetType: "statement_import",
      targetId: id,
      metadata: { lines: parsed.lines.length, new: newCount, pending: parsed.pendingCount },
    });
    return {
      import: toView(row!, await loadLines(tx, id)),
      alreadyImported: false,
      balanceReasons: balance.reasons,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Confirmare
// ---------------------------------------------------------------------------------------------

export async function confirmStatementImport(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  importId: string,
  rawInput: unknown = {},
): Promise<StatementImportView> {
  if (!isValidId(importId)) throw new NotFoundError();
  const input = parseInput(confirmImportSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const head = await loadImport(tx, m.householdId, importId.toLowerCase());
    await lockAccount(tx, head.accountId);
    const imp = await loadImport(tx, m.householdId, head.id, true);
    // Idempotent: o a doua confirmare întoarce rezultatul primei.
    if (imp.status === "imported") return toView(imp, await loadLines(tx, imp.id));
    if (imp.status !== "previewed") throw new ConflictError("statement_import_not_previewed");
    if (imp.balanceStatus === "mismatch" && !input.acknowledgeBalanceMismatch) {
      throw new ConflictError(
        "statement_balance_mismatch",
        "Soldurile extrasului nu se potrivesc; confirmă explicit după verificare.",
      );
    }
    const account = await requireOpenAccount(tx, m.householdId, imp.accountId);
    const lines = await loadLines(tx, imp.id);
    const byRow = new Map(lines.map((l) => [l.rowNo, l]));
    for (const r of input.skipRows ?? [])
      if (!byRow.has(r)) throw new ValidationError({ skipRows: "Rând inexistent." });
    const fxByRow = new Map((input.fx ?? []).map((d) => [d.rowNo, d]));
    for (const r of fxByRow.keys()) {
      if (byRow.get(r)?.kind !== "fx")
        throw new ValidationError({ fx: "Rândul nu e un schimb valutar." });
    }
    const skip = new Set(input.skipRows ?? []);

    // Recontrolul duplicatelor (un alt import a putut ajunge între previzualizare și confirmare).
    const pending = lines.filter((l) => l.state === "new" && !skip.has(l.rowNo));
    const fxOf = (l: LineRow, occ: number) =>
      fxKey(account.id, l.occurredOn, l.direction, l.amountMinor, occ);
    // Cheia `fx` și indicele ei: DOAR printre rândurile de schimb (ca în `computeKeys`).
    const fxOcc = new Map<string, number>();
    const fxKeys = new Map<number, string>();
    for (const l of lines) {
      if (l.kind !== "fx") continue;
      const t = `${l.occurredOn}|${l.direction}|${l.amountMinor}`;
      const n = fxOcc.get(t) ?? 0;
      fxOcc.set(t, n + 1);
      fxKeys.set(l.rowNo, fxOf(l, n));
    }
    const existing = await existingKeys(
      tx,
      m.householdId,
      account.id,
      pending.map((l) => l.dedupKey),
      pending.flatMap((l) => {
        const k = fxKeys.get(l.rowNo);
        return k ? [k] : [];
      }),
    );

    // Indicele de apariție al picioarelor din conturile-pereche (două schimburi identice în
    // aceeași zi primesc chei diferite, ca rândurile din extrasul celuilalt cont).
    const counterpartOcc = new Map<string, number>();
    const touchedAccounts = new Set<string>([account.id]);
    let imported = 0;
    let duplicates = lines.filter((l) => l.state === "duplicate").length;
    const common = {
      householdId: m.householdId,
      createdByUserId: actor.userId,
      source: "statement" as const,
    };
    for (const l of lines) {
      if (l.state !== "new") continue;
      if (skip.has(l.rowNo)) {
        await setLineState(tx, l.id, "skipped", null);
        continue;
      }
      const lineFx = fxKeys.get(l.rowNo);
      if (existing.has(l.dedupKey) || (lineFx !== undefined && existing.has(lineFx))) {
        await setLineState(tx, l.id, "duplicate", null);
        duplicates++;
        continue;
      }
      let transactionId: string;
      if (l.kind === "fx") {
        const d = fxByRow.get(l.rowNo);
        if (!d)
          throw new ValidationError({ fx: "Alege ce se întâmplă cu fiecare schimb valutar." });
        if (d.mode === "skip") {
          await setLineState(tx, l.id, "skipped", null);
          continue;
        }
        if (d.mode === "transfer") {
          transactionId = await insertFxTransfer(tx, account, l, d, common, counterpartOcc);
          touchedAccounts.add(d.counterpartAccountId!.toLowerCase());
          await setLineState(tx, l.id, "imported", transactionId);
          imported++;
          continue;
        }
      }
      const [row] = await tx
        .insert(transactions)
        .values({
          ...common,
          accountId: account.id,
          type: l.direction === "credit" ? "income" : "expense",
          amountMinor: l.amountMinor,
          currency: account.currency,
          occurredOn: l.occurredOn,
          description: l.description,
          externalRef: externalRefOf(l.dedupKey),
        })
        .returning({ id: transactions.id });
      transactionId = row!.id;
      await setLineState(tx, l.id, "imported", transactionId);
      imported++;
    }
    await assertAccountsWithinJsonRange(tx, m.householdId, [...touchedAccounts]);
    const newCount = lines.length - duplicates;
    const [done] = await tx
      .update(statementImports)
      .set({
        status: "imported",
        importedAt: new Date(),
        importedCount: imported,
        duplicateCount: duplicates,
        newCount: newCount < 0 ? 0 : newCount,
        updatedAt: new Date(),
      })
      .where(eq(statementImports.id, imp.id))
      .returning();
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "statement.imported",
      targetType: "statement_import",
      targetId: imp.id,
      metadata: { imported, duplicates },
    });
    return toView(done!, await loadLines(tx, imp.id));
  });
}

async function setLineState(
  tx: Tx,
  lineId: string,
  state: "imported" | "skipped" | "duplicate" | "cancelled",
  transactionId: string | null,
): Promise<void> {
  await tx
    .update(statementLines)
    .set(transactionId ? { state, transactionId } : { state })
    .where(eq(statementLines.id, lineId));
}

/**
 * Schimbul valutar ca TRANSFER între conturile pe monede (5.1: ambele sume explicite). Piciorul
 * din contul extrasului poartă cheia rândului; piciorul din contul-pereche poartă cheia `fx`
 * pe care o va calcula rândul de schimb din extrasul acelui cont, ca reimportul lui să-l vadă
 * ca duplicat.
 */
async function insertFxTransfer(
  tx: Tx,
  account: { id: string; currency: Currency },
  l: LineRow,
  d: { counterpartAccountId?: string; counterAmountMinor?: number },
  common: { householdId: string; createdByUserId: string; source: "statement" },
  counterpartOcc: Map<string, number>,
): Promise<string> {
  if (!d.counterpartAccountId) {
    throw new ValidationError({ fx: "Alege contul în cealaltă monedă." });
  }
  const other = await requireOpenAccount(
    tx,
    common.householdId,
    d.counterpartAccountId.toLowerCase(),
  );
  if (other.id === account.id || other.currency === account.currency) {
    throw new ValidationError({ fx: "Contul-pereche trebuie să fie în altă monedă." });
  }
  if (l.fxCurrency && l.fxCurrency !== other.currency) {
    throw new ValidationError({ fx: "Contul-pereche e în altă monedă decât schimbul." });
  }
  const counter =
    l.fxAmountMinor ?? (d.counterAmountMinor !== undefined ? BigInt(d.counterAmountMinor) : null);
  if (counter === null) throw new ValidationError({ fx: "Suma în cealaltă monedă lipsește." });
  const groupId = randomUUID();
  const thisDir = l.direction === "debit" ? "out" : "in";
  const otherDir = thisDir === "out" ? "in" : "out";
  const otherLineDir = l.direction === "debit" ? "credit" : "debit";
  const tuple = `${other.id}|${l.occurredOn}|${otherLineDir}|${counter}`;
  const occ = counterpartOcc.get(tuple) ?? 0;
  counterpartOcc.set(tuple, occ + 1);
  const otherRef = externalRefOf(fxKey(other.id, l.occurredOn, otherLineDir, counter, occ));
  // Schimbul a fost deja importat din extrasul celuilalt cont (ca venit/cheltuială): fără
  // dublură; utilizatorul alege `plain` sau `skip` pentru acest rând.
  const [clash] = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.householdId, common.householdId), eq(transactions.externalRef, otherRef)),
    )
    .limit(1);
  if (clash) {
    throw new ConflictError(
      "statement_fx_counterpart_exists",
      "Schimbul valutar e deja importat în celălalt cont; alege „venit/cheltuială” sau „sari”.",
    );
  }
  const base = {
    ...common,
    type: "transfer" as const,
    occurredOn: l.occurredOn,
    description: l.description,
    transferGroupId: groupId,
  };
  const [mine] = await tx
    .insert(transactions)
    .values({
      ...base,
      accountId: account.id,
      currency: account.currency,
      amountMinor: l.amountMinor,
      transferDirection: thisDir,
      externalRef: externalRefOf(l.dedupKey),
    })
    .returning({ id: transactions.id });
  await tx.insert(transactions).values({
    ...base,
    accountId: other.id,
    currency: other.currency,
    amountMinor: counter,
    transferDirection: otherDir,
    externalRef: otherRef,
  });
  return mine!.id;
}

// ---------------------------------------------------------------------------------------------
// Anulare, renunțare, listare, detaliu
// ---------------------------------------------------------------------------------------------

/**
 * Anularea unui import confirmat: șterge DOAR tranzacțiile create de el. O tranzacție modificată
 * după import (editată, cu etichete, împărțită, legată de un bon) nu se atinge fără decizia
 * explicită a utilizatorului (`editedPolicy`): `keep` o păstrează (rămâne cu `external_ref`, deci
 * un reimport n-o dublează), `delete` o șterge și pe ea. Fără decizie → conflict cu numărul lor.
 */
export async function cancelStatementImport(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  importId: string,
  rawInput: unknown = {},
): Promise<StatementImportView & { keptEdited: number }> {
  if (!isValidId(importId)) throw new NotFoundError();
  const input = parseInput(cancelImportSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const head = await loadImport(tx, m.householdId, importId.toLowerCase());
    await lockAccount(tx, head.accountId);
    const imp = await loadImport(tx, m.householdId, head.id, true);
    if (imp.status === "cancelled")
      return { ...toView(imp, await loadLines(tx, imp.id)), keptEdited: 0 };
    if (imp.status !== "imported") throw new ConflictError("statement_import_not_imported");
    // „Modificată” se evaluează pe TOATE rândurile grupului unui transfer (revizuirea F7-A):
    // piciorul din contul-pereche editat păstrează tot transferul. `visible_legs` < 2 = piciorul
    // e într-un cont personal invizibil apelantului (anularea o poate face doar proprietarul).
    const rows = await tx.execute<{
      id: string;
      group_id: string | null;
      touched: boolean;
      visible_legs: number;
    }>(sql`
      select t.id, t.transfer_group_id as group_id,
             exists (select 1 from finet.transactions x
                      where (x.id = t.id or x.transfer_group_id = t.transfer_group_id)
                        and (x.updated_at > x.created_at
                             or exists (select 1 from finet.transaction_tags g
                                         where g.transaction_id = x.id)
                             or exists (select 1 from finet.transaction_splits s
                                         where s.transaction_id = x.id)
                             or exists (select 1 from finet.receipts r
                                         where r.transaction_id = x.id))) as touched,
             (select count(*)::int from finet.transactions y
               where y.transfer_group_id = t.transfer_group_id) as visible_legs
        from finet.statement_lines l
        join finet.transactions t on t.id = l.transaction_id
       where l.import_id = ${imp.id} and l.state = 'imported'`);
    if (rows.some((r) => r.group_id !== null && r.visible_legs < 2)) {
      throw new ConflictError(
        "statement_import_counterpart_hidden",
        "Un transfer valutar al importului e legat de un cont pe care nu îl vezi; anularea o poate face proprietarul acelui cont.",
      );
    }
    const touched = rows.filter((r) => r.touched);
    if (touched.length > 0 && !input.editedPolicy) {
      throw new ConflictError(
        "statement_import_has_edited",
        `Unele tranzacții (${touched.length}) au fost modificate după import.`,
      );
    }
    const remove = input.editedPolicy === "delete" ? rows : rows.filter((r) => !r.touched);
    // Rândurile trec în `cancelled` cât importul e încă `imported` (ordinea cerută de trigger).
    await tx
      .update(statementLines)
      .set({ state: "cancelled" })
      .where(and(eq(statementLines.importId, imp.id), eq(statementLines.state, "imported")));
    const ids = remove.filter((r) => !r.group_id).map((r) => r.id);
    const groups = remove.flatMap((r) => (r.group_id ? [r.group_id] : []));
    if (ids.length) {
      await tx
        .delete(transactions)
        .where(and(eq(transactions.householdId, m.householdId), inArray(transactions.id, ids)));
    }
    if (groups.length) {
      await tx
        .delete(transactions)
        .where(
          and(
            eq(transactions.householdId, m.householdId),
            inArray(transactions.transferGroupId, groups),
          ),
        );
    }
    const [done] = await tx
      .update(statementImports)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancelledByUserId: actor.userId,
        updatedAt: new Date(),
      })
      .where(eq(statementImports.id, imp.id))
      .returning();
    const kept = rows.length - remove.length;
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "statement.cancelled",
      targetType: "statement_import",
      targetId: imp.id,
      metadata: { deleted: remove.length, kept },
    });
    return { ...toView(done!, await loadLines(tx, imp.id)), keptEdited: kept };
  });
}

/** Renunțarea la o previzualizare neconfirmată (o șterge cu rândurile ei). */
export async function discardStatementPreview(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  importId: string,
): Promise<void> {
  if (!isValidId(importId)) throw new NotFoundError();
  await inHousehold(deps, actor, householdId, async (tx, m) => {
    const imp = await loadImport(tx, m.householdId, importId.toLowerCase(), true);
    if (imp.status !== "previewed" && imp.status !== "failed") {
      throw new ConflictError("statement_import_not_previewed");
    }
    await tx.delete(statementImports).where(eq(statementImports.id, imp.id));
    await insertAudit(tx, actor.userId, m.householdId, {
      action: "statement.discarded",
      targetType: "statement_import",
      targetId: imp.id,
    });
  });
}

export async function getStatementImport(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  importId: string,
): Promise<StatementImportView> {
  if (!isValidId(importId)) throw new NotFoundError();
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const imp = await loadImport(tx, m.householdId, importId.toLowerCase());
    return toView(imp, await loadLines(tx, imp.id));
  });
}

export async function listStatementImports(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown = {},
): Promise<StatementImportView[]> {
  const input = parseInput(listImportsSchema, rawInput);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await tx
      .select()
      .from(statementImports)
      .where(
        and(
          eq(statementImports.householdId, m.householdId),
          input.accountId ? eq(statementImports.accountId, input.accountId) : undefined,
        ),
      )
      .orderBy(desc(statementImports.createdAt), desc(statementImports.id))
      .limit(input.limit);
    return rows.map((r) => toView(r));
  });
}

// ---------------------------------------------------------------------------------------------
// Acoperire pe luni
// ---------------------------------------------------------------------------------------------

export type CoverageRow = Readonly<{
  accountId: string;
  accountName: string;
  currency: Currency;
  months: readonly CoverageCell[];
  /** Lunile fără niciun extras între primul import confirmat și luna curentă (avertizare). */
  missingMonths: readonly Month[];
}>;

export async function getStatementCoverage(
  deps: StatementDeps,
  actor: Actor,
  householdId: string,
  rawInput: unknown,
): Promise<CoverageRow[]> {
  const input = parseInput(coverageSchema, rawInput);
  const months = monthsBetween(input.from, input.to);
  const today = localDateOf((deps.now ?? (() => new Date()))(), DEFAULT_TIME_ZONE);
  const todayMonth = today.slice(0, 7);
  return inHousehold(deps, actor, householdId, async (tx, m) => {
    const rows = await tx.execute<{
      account_id: string;
      name: string;
      currency: Currency;
      start: string | null;
      end: string | null;
    }>(sql`
      select a.id as account_id, a.name, a.currency,
             i.period_start::text as start, i.period_end::text as end
        from finet.accounts a
        left join finet.statement_imports i
          on i.account_id = a.id and i.status = 'imported'
         and i.period_start is not null and i.period_end is not null
       where a.household_id = ${m.householdId} and a.archived_at is null and a.type <> 'cash'
       order by a.name, a.id`);
    const byAccount = new Map<
      string,
      { name: string; currency: Currency; periods: { start: string; end: string }[] }
    >();
    for (const r of rows) {
      const acc = byAccount.get(r.account_id) ?? {
        name: r.name,
        currency: r.currency,
        periods: [],
      };
      if (r.start && r.end) acc.periods.push({ start: r.start, end: r.end });
      byAccount.set(r.account_id, acc);
    }
    return [...byAccount.entries()].map(([accountId, a]) => {
      const cells = months.map((mo) => coverageForMonth(a.periods, mo, today));
      const firstCovered = a.periods.length
        ? a.periods
            .map((p) => p.start)
            .sort()[0]!
            .slice(0, 7)
        : null;
      const missingMonths = firstCovered
        ? cells
            .filter(
              (c) => c.status === "missing" && c.month >= firstCovered && c.month <= todayMonth,
            )
            .map((c) => c.month)
        : [];
      return { accountId, accountName: a.name, currency: a.currency, months: cells, missingMonths };
    });
  });
}
