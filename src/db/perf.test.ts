import { performance } from "node:perf_hooks";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db/rls";
import * as schema from "@/db/schema";
import { TEST_ADMIN_URL } from "@/db/testing";
import { createAccount } from "@/modules/accounts/accounts.service";
import {
  selectDailyTotals,
  selectExpenseByCategory,
  selectMonthlyTotals,
  selectTopMerchants,
} from "@/modules/dashboard/dashboard.repo";
import { getDashboard } from "@/modules/dashboard/dashboard.service";
import { collectCsv, exportTransactionsCsv } from "@/modules/exports/exports.service";
import {
  type LedgerFixture,
  createLedgerFixture,
  systemCategoryId,
} from "@/modules/ledger/testing";
import { createTag } from "@/modules/tags/tags.service";
import { listTransactions } from "@/modules/transactions/transactions.service";

/**
 * Performanța pe volum (Faza 4, `docs/PERFORMANCE.md` 2): 50.000 de tranzacții pe 12 luni într-o
 * gospodărie (+ 5.000 în alta, ca filtrul pe gospodărie să conteze), măsurate ca `finet_app` cu
 * RLS activ: dashboard-ul, lista paginată (prima pagină, pagina 2, filtre) și exportul CSV complet.
 * Planurile (`EXPLAIN ANALYZE, BUFFERS`) vin din `auto_explain` (nivel NOTICE, doar baza de test),
 * pe EXACT interogările din `dashboard.repo.ts` / `transactions.repo.ts`, nu pe copii ale lor.
 *
 * LENT: rulează doar cu `FINET_PERF=1` (și `DATABASE_URL`), în afara suitei standard:
 *   FINET_PERF=1 DATABASE_URL=<superuser> pnpm exec vitest run src/db/perf.test.ts
 */

const ENABLED = Boolean(TEST_ADMIN_URL && process.env.FINET_PERF);
const ROWS = 50_000;
const NOISE_ROWS = 5_000;
const NOW = new Date("2026-10-28T10:00:00Z");

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

async function timed(
  fn: () => Promise<unknown>,
  runs = 5,
): Promise<{ medianMs: number; minMs: number }> {
  await fn(); // încălzire (cache, plan)
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: Math.round(times[Math.floor(runs / 2)]! * 10) / 10,
    minMs: Math.round(times[0]! * 10) / 10,
  };
}

describe.skipIf(!ENABLED)("performanța pe 50.000 de tranzacții (FINET_PERF=1)", () => {
  let f: LedgerFixture;
  let tagId: string;
  const results: Record<string, { medianMs: number; minMs: number }> = {};
  const deps = () => ({ ...f.deps, now: () => NOW });

  beforeAll(async () => {
    f = await createLedgerFixture("finet_perf");
    const acc = (h: string, actor: typeof f.A, name: string) =>
      createAccount(f.deps, actor, h, { name, type: "bank", currency: "RON" }).then((a) => a.id);
    const accA = [await acc(f.HA, f.A, "Banca"), await acc(f.HA, f.A, "Numerar")];
    const accB = await acc(f.HB, f.B, "Banca B");
    const expense: string[] = [];
    for (const key of [
      "groceries",
      "restaurants",
      "transport",
      "health",
      "clothing",
      "children",
      "utilities",
    ]) {
      expense.push(await systemCategoryId(f.admin, `expense.${key}`));
    }
    const salary = await systemCategoryId(f.admin, "income.salary");
    tagId = (await createTag(f.deps, f.A, f.HA, { name: "Perf" })).id;
    const merchants = Array.from({ length: 40 }, (_, i) => `Comerciant ${i}`);

    // Superuser (fără RLS) pentru seed; triggerele de verificare rulează oricum, rând cu rând.
    // ~10 % venituri; sume 1,00–500,99 lei; zilele 2025-11-01 … 2026-10-31.
    const seed = (h: string, accounts: string[], rows: number) => f.admin`
      insert into finet.transactions
        (household_id, account_id, category_id, created_by_user_id, type, amount_minor, currency,
         occurred_on, merchant, description)
      select ${h}::uuid,
             (${accounts}::uuid[])[1 + i % ${accounts.length}],
             case when i % 10 = 0 then ${salary}::uuid
                  else (${expense}::uuid[])[1 + i % ${expense.length}] end,
             ${f.A.userId}::uuid,
             case when i % 10 = 0 then 'income' else 'expense' end,
             100 + (i * 7919) % 50000,
             'RON',
             date '2025-11-01' + (i % 365),
             (${merchants}::text[])[1 + (i * 31) % ${merchants.length}],
             'perf ' || i
        from generate_series(1, ${rows}) as i`;
    await seed(f.HA, accA, ROWS);
    // Gospodăria B: alt utilizator creator (B), deci un update după inserare.
    await seed(f.HB, [accB], NOISE_ROWS);
    await f.admin`update finet.transactions set created_by_user_id = ${f.B.userId}::uuid
                   where household_id = ${f.HB}::uuid`;
    // Eticheta pe ~10 % din cheltuieli.
    await f.admin`
      insert into finet.transaction_tags (transaction_id, tag_id, household_id)
      select id, ${tagId}::uuid, household_id from finet.transactions
       where household_id = ${f.HA}::uuid and type = 'expense' and description like '%3'`;
    await f.admin`analyze finet.transactions`;
    await f.admin`analyze finet.transaction_tags`;
  });

  afterAll(async () => {
    console.log(
      `[perf] rezultate (ms, mediana din 5 / minim):\n${JSON.stringify(results, null, 2)}`,
    );
    await f?.close();
  });

  it("seed-ul: 50.000 în A, izolate de B", async () => {
    const [row] = await f.admin<{ a: number; b: number }[]>`
      select count(*) filter (where household_id = ${f.HA}::uuid)::int as a,
             count(*) filter (where household_id = ${f.HB}::uuid)::int as b
        from finet.transactions`;
    expect(row).toEqual({ a: ROWS, b: NOISE_ROWS });
  });

  it("dashboard-ul lunii (12 luni, trend zilnic, top categorii)", async () => {
    const view = await getDashboard(deps(), f.A, f.HA, { month: "2026-10" });
    expect(view.currencies[0]?.monthly).toHaveLength(12);
    results.dashboard = await timed(() => getDashboard(deps(), f.A, f.HA, { month: "2026-10" }));
    expect(results.dashboard.medianMs).toBeLessThan(5_000);
  });

  it("lista paginată: prima pagină, pagina 2, filtre", async () => {
    const first = await listTransactions(f.deps, f.A, f.HA, { limit: 50 });
    expect(first.data).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    results.listFirst = await timed(() => listTransactions(f.deps, f.A, f.HA, { limit: 50 }));
    results.listSecond = await timed(() =>
      listTransactions(f.deps, f.A, f.HA, { limit: 50, cursor: first.nextCursor! }),
    );
    results.listAmountDesc = await timed(() =>
      listTransactions(f.deps, f.A, f.HA, { limit: 50, sort: "amount_desc" }),
    );
    results.listTag = await timed(() =>
      listTransactions(f.deps, f.A, f.HA, { limit: 50, tagIds: [tagId] }),
    );
    results.listTagAll = await timed(() =>
      listTransactions(f.deps, f.A, f.HA, { limit: 50, tagIds: [tagId], tagMatch: "all" }),
    );
    results.listSearch = await timed(() =>
      listTransactions(f.deps, f.A, f.HA, { limit: 50, q: "perf 4999" }),
    );
    results.listMonth = await timed(() =>
      listTransactions(f.deps, f.A, f.HA, {
        limit: 50,
        dateFrom: "2026-10-01",
        dateTo: "2026-10-31",
      }),
    );
    for (const r of Object.values(results)) expect(r.medianMs).toBeLessThan(5_000);
  });

  it("exportul CSV complet (50.000 de rânduri)", async () => {
    const csv = await collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, {}));
    expect(csv.split("\r\n").length - 2).toBe(ROWS); // antet + rândul gol final
    results.exportAll = await timed(
      () => collectCsv(exportTransactionsCsv(deps(), f.A, f.HA, {})),
      2,
    );
    expect(results.exportAll.medianMs).toBeLessThan(60_000);
  });

  it("planurile interogărilor dashboard-ului și ale listei (auto_explain)", async () => {
    const name = f.fx.scratch.name;
    await f.admin.unsafe(`alter database "${name}" set session_preload_libraries = 'auto_explain'`);
    for (const [k, v] of [
      ["log_min_duration", "0"],
      ["log_analyze", "on"],
      ["log_buffers", "on"],
      ["log_level", "notice"],
    ]) {
      await f.admin.unsafe(`alter database "${name}" set auto_explain.${k} = '${v}'`);
    }
    const notices: string[] = [];
    const client = postgres(f.fx.scratch.appUrl, {
      max: 1,
      prepare: false,
      onnotice: (n) => notices.push(String(n.message)),
    });
    try {
      const db = drizzle({ client, schema });
      const plan = async (label: string, fn: () => Promise<unknown>) => {
        notices.length = 0;
        await fn();
        const plans = notices.filter(
          (n) => n.includes("finet.transactions") || n.includes("transactions"),
        );
        console.log(`[perf] EXPLAIN ${label}:\n${plans.join("\n---\n")}`);
        // Planurile se citesc în raport (docs/PERFORMANCE.md); aici doar că există.
        expect(plans.length, label).toBeGreaterThan(0);
      };
      const ctx = { userId: f.A.userId, householdId: f.HA };
      await plan("monthly (12 luni)", () =>
        withRlsOn(db, ctx, (tx) => selectMonthlyTotals(tx, f.HA, "2025-11-01", "2026-10-31")),
      );
      await plan("daily (octombrie)", () =>
        withRlsOn(db, ctx, (tx) => selectDailyTotals(tx, f.HA, "2026-10-01", "2026-10-31")),
      );
      await plan("categorii (octombrie)", () =>
        withRlsOn(db, ctx, (tx) => selectExpenseByCategory(tx, f.HA, "2026-10-01", "2026-10-31")),
      );
      await plan("comercianți (octombrie)", () =>
        withRlsOn(db, ctx, (tx) => selectTopMerchants(tx, f.HA, "2026-10-01", "2026-10-31", 5)),
      );
      await plan("lista, prima pagină", () => listTransactions({ db }, f.A, f.HA, { limit: 50 }));
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
