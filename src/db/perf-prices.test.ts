import { performance } from "node:perf_hooks";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db/rls";
import * as schema from "@/db/schema";
import { TEST_ADMIN_URL } from "@/db/testing";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import {
  selectCandidateLines,
  selectCoverage,
  selectPriceLines,
} from "@/modules/prices/prices.repo";
import { getInflation, listProducts } from "@/modules/prices/prices.service";
import { runDefinition } from "@/modules/report-definitions/report-definitions.service";
import { SYSTEM_REPORTS } from "@/modules/report-definitions/system-definitions";

/**
 * Performanța prețurilor și rapoartelor (Faza 10, F10-B; `docs/INFRA.md` 4p): ~50.000 de linii de
 * bon (≈ 4.200 de bonuri confirmate pe 3 ani, 5 comercianți, 200 de produse; o parte pe un cont
 * personal), într-o gospodărie, + zgomot într-o alta. Măsurate ca `finet_app` cu RLS; planurile
 * (`EXPLAIN ANALYZE, BUFFERS`) vin din `auto_explain` pe EXACT interogările din `prices.repo.ts`.
 *
 * LENT: rulează doar cu `FINET_PERF=1` (și `DATABASE_URL`):
 *   FINET_PERF=1 DATABASE_URL=<superuser> pnpm exec vitest run src/db/perf-prices.test.ts
 */

const ENABLED = Boolean(TEST_ADMIN_URL && process.env.FINET_PERF);
const RECEIPTS = 4_200;
const LINES_PER_RECEIPT = 12;
const NOW = new Date("2026-10-28T10:00:00Z");

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

async function timed(fn: () => Promise<unknown>, runs = 5) {
  await fn();
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

describe.skipIf(!ENABLED)("performanța prețurilor și rapoartelor (FINET_PERF=1)", () => {
  let f: FamilyFixture;
  const results: Record<string, { medianMs: number; minMs: number }> = {};
  const deps = () => ({ db: f.db, now: () => NOW });

  beforeAll(async () => {
    f = await createFamilyFixture("finet_perf_prices");
    const common = (
      await createAccount(f.deps, f.A, f.HA, { name: "Comun", type: "bank", currency: "RON" })
    ).id;
    const personal = (
      await createAccount(f.deps, f.C, f.HA, {
        name: "Personal C",
        type: "bank",
        currency: "RON",
        ownerUserId: f.C.userId,
      })
    ).id;
    const accB = (
      await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" })
    ).id;
    const names = [
      ...Array.from(
        { length: 150 },
        (_, i) => `produs ${i} ${["500g", "1l", "250g", "2l", "1kg", "6buc"][i % 6]}`,
      ),
      ...Array.from({ length: 40 }, (_, i) => `legume ${i}`),
      "punga rafie",
      "garantie sgr",
      "ciocolata milka 100g",
      "guma orbit",
      "cafea espresso",
      "sampon hair 400ml",
      "apa plata 2l",
      "bere 33cl",
      "detergent vase 1l",
      "pungi menaj 35l",
    ];
    const merchantNames = [
      "LIDL DISCOUNT SRL",
      "KAUFLAND ROMANIA SCS",
      "MEGA IMAGE SRL",
      "PROFI ROM FOOD SRL",
      "CARREFOUR ROMANIA",
    ];
    const merchantCuis = ["RO22891860", "RO15991149", "RO13351812", "RO15298140", "RO11588780"];
    const seed = async (
      hh: string,
      actor: string,
      accounts: string[],
      personalAcc: string | null,
      n: number,
    ) => {
      await f.admin`
        insert into finet.documents (id, household_id, kind, status, detected_mime, size_bytes, sha256, storage_key, uploaded_by_user_id)
        select d, ${hh}::uuid, 'receipt', 'done', 'image/jpeg', 10,
               md5(d::text) || md5(d::text || 'x'), 'households/' || ${hh} || '/documents/' || d, ${actor}::uuid
          from (select md5(${hh} || i::text)::uuid as d from generate_series(1, ${n}) i) s`;
      await f.admin`
        insert into finet.transactions (id, household_id, account_id, type, amount_minor, currency, occurred_on, description, source, created_by_user_id)
        select md5('t' || ${hh} || i::text)::uuid, ${hh}::uuid,
               case when ${personalAcc}::uuid is not null and i % 10 = 0 then ${personalAcc}::uuid
                    else (${accounts}::uuid[])[1 + i % ${accounts.length}] end,
               'expense', 1000, 'RON', date '2023-11-01' + (i % 1095), 'Bon', 'receipt', ${actor}::uuid
          from generate_series(1, ${n}) i`;
      await f.admin`
        insert into finet.receipts (id, household_id, document_id, status, total_minor, currency, occurred_on, merchant_name, merchant_tax_id, transaction_id)
        select md5('r' || ${hh} || i::text)::uuid, ${hh}::uuid, md5(${hh} || i::text)::uuid, 'saved', 1000, 'RON',
               date '2023-11-01' + (i % 1095),
               (${merchantNames}::text[])[1 + i % 5], (${merchantCuis}::text[])[1 + i % 5],
               md5('t' || ${hh} || i::text)::uuid
          from generate_series(1, ${n}) i`;
      await f.admin`
        insert into finet.receipt_lines (receipt_id, household_id, position, raw_name, normalized_name, quantity, line_total_minor, kind)
        select md5('r' || ${hh} || i::text)::uuid, ${hh}::uuid, p, upper(nm), nm,
               (1 + (i + p) % 3)::numeric, 100 + ((i * 31 + p * 17) % 4000),
               case when nm = 'garantie sgr' then 'deposit_sgr' when nm like 'pung%' or nm = 'punga rafie' then 'bag' else 'product' end
          from generate_series(1, ${n}) i
          cross join generate_series(1, ${LINES_PER_RECEIPT}) p
          cross join lateral (select (${names}::text[])[1 + ((i * 7 + p * 13) % ${names.length})] as nm) x`;
    };
    await seed(f.HA, f.A.userId, [common], personal, RECEIPTS);
    await seed(f.HB, f.B.userId, [accB], null, 800);
    await f.admin`analyze finet.receipts`;
    await f.admin`analyze finet.receipt_lines`;
    await f.admin`analyze finet.transactions`;
  });
  afterAll(async () => {
    console.log(
      `[perf] rezultate (ms, mediana din 5 / minim):\n${JSON.stringify(results, null, 2)}`,
    );
    await f?.close();
  });

  it("seed-ul", async () => {
    const [row] = await f.admin<{ r: number; l: number }[]>`
      select (select count(*)::int from finet.receipts where household_id = ${f.HA}::uuid) as r,
             (select count(*)::int from finet.receipt_lines where household_id = ${f.HA}::uuid) as l`;
    expect(row).toEqual({ r: RECEIPTS, l: RECEIPTS * LINES_PER_RECEIPT });
  });

  it("serviciile (RLS, finet_app)", async () => {
    results.productsYear = await timed(() => listProducts(deps(), f.A, f.HA));
    results.productsThreeYears = await timed(() => listProducts(deps(), f.A, f.HA, { months: 36 }));
    results.inflation = await timed(() => getInflation(deps(), f.A, f.HA, { months: 3 }));
    for (const key of ["bags", "drinks", "savings"] as const) {
      const id = SYSTEM_REPORTS.find((r) => r.key === key)!.id;
      results[`run_${key}_all`] = await timed(() => runDefinition(deps(), f.A, f.HA, id));
    }
    const asC = await listProducts(deps(), f.C, f.HA, { months: 36 });
    const asA = await listProducts(deps(), f.A, f.HA, { months: 36 });
    expect(asC.products.reduce((s, p) => s + p.observations, 0)).toBeGreaterThan(
      asA.products.reduce((s, p) => s + p.observations, 0),
    );
    expect(results.productsThreeYears!.medianMs).toBeLessThan(10_000);
  });

  it("planurile (auto_explain)", async () => {
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
      const ctx = { userId: f.A.userId, householdId: f.HA };
      const plan = async (label: string, fn: () => Promise<unknown>) => {
        notices.length = 0;
        await fn();
        const plans = notices.filter((n) => n.includes("receipt_lines") || n.includes("receipts"));
        console.log(`[perf] EXPLAIN ${label}:\n${plans.join("\n---\n")}`);
        expect(plans.length, label).toBeGreaterThan(0);
      };
      await plan("selectPriceLines (12 luni)", () =>
        withRlsOn(db, ctx, (tx) =>
          selectPriceLines(tx, f.HA, { from: "2025-11-01", to: "2026-10-28" }),
        ),
      );
      await plan("selectPriceLines (toată arhiva)", () =>
        withRlsOn(db, ctx, (tx) => selectPriceLines(tx, f.HA, { from: null, to: null })),
      );
      await plan("selectCandidateLines (pungi, toată arhiva)", () =>
        withRlsOn(db, ctx, (tx) =>
          selectCandidateLines(
            tx,
            f.HA,
            { kinds: ["product", "bag", "other"], categoryIds: [], tagIds: [] },
            { from: null, to: null },
          ),
        ),
      );
      await plan("selectCoverage", () =>
        withRlsOn(db, ctx, (tx) => selectCoverage(tx, f.HA, { from: null, to: null })),
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
