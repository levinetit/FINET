import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { ForbiddenError, NotFoundError } from "@/lib/authz";
import { ConflictError, ValidationError } from "@/lib/errors";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type FamilyFixture, createFamilyFixture } from "@/modules/family/testing";
import { seedReceipt } from "@/modules/prices/testing";
import { systemCategoryId } from "@/modules/ledger/testing";

import {
  createDefinition,
  exportDefinitionCsv,
  getDefinition,
  listDefinitions,
  previewRules,
  removeDefinition,
  runDefinition,
  updateReportDefinition,
} from "./report-definitions.service";
import { SYSTEM_REPORTS } from "./system-definitions";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SYS = Object.fromEntries(SYSTEM_REPORTS.map((r) => [r.key, r.id])) as Record<string, string>;

const rules = (over: Record<string, unknown> = {}) => ({
  v: 1,
  combine: "any",
  include: [{ type: "token", value: "ciocolata" }],
  exclude: [],
  kinds: ["product"],
  categoryIds: [],
  tagIds: [],
  ...over,
});

describe.skipIf(!TEST_ADMIN_URL)("rapoarte de micro-cheltuieli (Postgres real, finet_app)", () => {
  let f: FamilyFixture;
  let commonA: string;
  let personalC: string;
  let personalA: string;
  let hbAccount: string;
  const now = () => new Date("2026-10-29T10:00:00Z");
  const deps = () => ({ db: f.db, now });

  beforeAll(async () => {
    f = await createFamilyFixture("finet_it_repdef");
    commonA = (
      await createAccount(f.deps, f.A, f.HA, { name: "Comun", type: "bank", currency: "RON" })
    ).id;
    personalC = (
      await createAccount(f.deps, f.C, f.HA, {
        name: "Personal C",
        type: "bank",
        currency: "RON",
        ownerUserId: f.C.userId,
      })
    ).id;
    personalA = (
      await createAccount(f.deps, f.A, f.HA, {
        name: "Personal A",
        type: "bank",
        currency: "RON",
        ownerUserId: f.A.userId,
      })
    ).id;
    hbAccount = (
      await createAccount(f.deps, f.B, f.HB, { name: "B", type: "bank", currency: "RON" })
    ).id;
    const base = { householdId: f.HA, actorId: f.A.userId };
    // Bonuri comune (vizibile ambilor membri)
    await seedReceipt(f.admin, {
      ...base,
      accountId: commonA,
      on: "2026-09-10",
      merchant: "LIDL DISCOUNT SRL",
      cui: "RO22891860",
      lines: [
        { name: "PUNGA RAFIE", quantity: "1", totalMinor: 50, kind: "bag" },
        { name: "PUNGI MENAJ 35L", quantity: "1", totalMinor: 399, kind: "bag" },
        { name: "CIOCOLATA MILKA 100G", quantity: "2", totalMinor: 1000 },
        { name: "GARANTIE SGR", quantity: "4", totalMinor: 200, kind: "deposit_sgr" },
      ],
    });
    await seedReceipt(f.admin, {
      ...base,
      accountId: commonA,
      on: "2026-10-12",
      merchant: "KAUFLAND ROMANIA SCS",
      cui: "RO15991149",
      lines: [
        { name: "PUNGA RAFIE", quantity: "1", totalMinor: 50, kind: "bag" },
        { name: "REDUCERE CARD", quantity: null, totalMinor: 500, kind: "discount" },
        { name: "RETUR SGR", quantity: null, totalMinor: 100, kind: "discount" },
      ],
    });
    // Bon pe contul PERSONAL al lui C: invizibil pentru A, vizibil pentru C
    await seedReceipt(f.admin, {
      householdId: f.HA,
      actorId: f.C.userId,
      accountId: personalC,
      on: "2026-10-15",
      merchant: "KAUFLAND ROMANIA SCS",
      cui: "RO15991149",
      lines: [{ name: "PUNGA RAFIE", quantity: "3", totalMinor: 150, kind: "bag" }],
    });
    // Bon pe contul personal al lui A: vizibil pentru A, nu pentru C
    await seedReceipt(f.admin, {
      ...base,
      accountId: personalA,
      on: "2026-10-16",
      merchant: "KAUFLAND ROMANIA SCS",
      cui: "RO15991149",
      lines: [{ name: "PUNGA RAFIE", quantity: "2", totalMinor: 100, kind: "bag" }],
    });
    // Nu intră: neconfirmat; confirmat fără tranzacție (rămâne comun)
    await seedReceipt(f.admin, {
      ...base,
      accountId: commonA,
      on: "2026-10-17",
      status: "needs_review",
      lines: [{ name: "PUNGA RAFIE", quantity: "9", totalMinor: 900, kind: "bag" }],
    });
    await seedReceipt(f.admin, {
      ...base,
      accountId: commonA,
      on: "2026-10-18",
      withTransaction: false,
      lines: [{ name: "PUNGA RAFIE", quantity: "1", totalMinor: 25, kind: "bag" }],
    });
    // Altă gospodărie
    await seedReceipt(f.admin, {
      householdId: f.HB,
      actorId: f.B.userId,
      accountId: hbAccount,
      on: "2026-10-12",
      lines: [{ name: "PUNGA RAFIE", quantity: "1", totalMinor: 7777, kind: "bag" }],
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  const total = (r: Awaited<ReturnType<typeof runDefinition>>) =>
    r.run.currencies.map((c) => [c.currency, c.totalMinor]);

  describe("rapoartele de sistem", () => {
    it("rândurile din bază sunt identice cu constanta din cod", async () => {
      const rows = await f.admin<
        {
          id: string;
          name: string;
          description: string;
          advice: string;
          rules: unknown;
          is_system: boolean;
          household_id: string | null;
        }[]
      >`select id, name, description, advice, rules, is_system, household_id
          from finet.report_definitions where is_system order by id`;
      expect(rows).toHaveLength(SYSTEM_REPORTS.length);
      for (const [i, row] of rows.entries()) {
        const r = [...SYSTEM_REPORTS].sort((a, b) => a.id.localeCompare(b.id))[i]!;
        expect(row).toMatchObject({
          id: r.id,
          name: r.name,
          description: r.description,
          advice: r.advice,
          is_system: true,
          household_id: null,
        });
        expect(row.rules).toEqual(JSON.parse(JSON.stringify(r.rules)));
      }
    });

    it("citibile de toți membrii (ambele gospodării); nu se pot modifica sau șterge", async () => {
      const a = await listDefinitions(deps(), f.A, f.HA);
      const b = await listDefinitions(deps(), f.B, f.HB);
      expect(a.filter((d) => d.isSystem)).toHaveLength(6);
      expect(b.filter((d) => d.isSystem)).toHaveLength(6);
      // sistemul primele, după nume
      expect(a.slice(0, 6).map((d) => d.name)).toEqual([
        "Cafea și băuturi la bucată",
        "Cumpărături de la casă",
        "Economii din reduceri și carduri",
        "Garanția SGR: plătită și recuperată",
        "Nealimentare la supermarket",
        "Pungi și sacoșe",
      ]);
      await expect(
        updateReportDefinition(deps(), f.A, f.HA, SYS.bags!, { name: "Altceva" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(removeDefinition(deps(), f.A, f.HA, SYS.bags!)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      // La nivel de bază: aplicația nu poate scrie rânduri de sistem (RLS + drepturi)
      await withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, async (tx) => {
        const upd = await tx.execute(
          sql`update finet.report_definitions set name = 'x' where id = ${SYS.bags}`,
        );
        expect(upd.count).toBe(0);
        const del = await tx.execute(
          sql`delete from finet.report_definitions where id = ${SYS.bags}`,
        );
        expect(del.count).toBe(0);
      });
      await expect(
        withRlsOn(f.db, { userId: f.A.userId, householdId: f.HA }, (tx) =>
          tx.execute(sql`insert into finet.report_definitions (id, household_id, name, rules, is_system, created_by_user_id)
            values (${randomUUID()}, null, 'Fals', '{"v":1}'::jsonb, true, null)`),
        ),
      ).rejects.toThrow();
    });
  });

  describe("rularea pe bonuri confirmate, cu conturi personale", () => {
    it("pungi: totalul exclude pungile de menaj, bonurile neconfirmate, conturile personale ale altora și gospodăria străină", async () => {
      const asA = await runDefinition(deps(), f.A, f.HA, SYS.bags!);
      // A vede: 50 + 50 (comune) + 100 (contul lui personal) + 25 (confirmat fără tranzacție) = 225
      expect(total(asA)).toEqual([["RON", 225n]]);
      expect(asA.run.matchedLines).toBe(4);
      const asC = await runDefinition(deps(), f.C, f.HA, SYS.bags!);
      // C vede: 50 + 50 + 150 (contul lui personal) + 25 = 275
      expect(total(asC)).toEqual([["RON", 275n]]);
      const asB = await runDefinition(deps(), f.B, f.HB, SYS.bags!);
      expect(total(asB)).toEqual([["RON", 7777n]]);
      // Un membru al altei gospodării nu poate rula în HA (404 uniform)
      await expect(runDefinition(deps(), f.B, f.HA, SYS.bags!)).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("SGR și economii: plătit vs. recuperat, reduceri fără retururi SGR", async () => {
      const sgr = await runDefinition(deps(), f.A, f.HA, SYS.sgr!);
      expect(sgr.run.currencies[0]).toMatchObject({
        chargedMinor: 200n,
        creditMinor: 100n,
        netMinor: 100n,
      });
      const savings = await runDefinition(deps(), f.A, f.HA, SYS.savings!);
      expect(savings.run.currencies[0]).toMatchObject({ mode: "savings", totalMinor: 500n });
    });

    it("perioade: luna curentă, luna trecută, ultimele 3 luni, anul; toate în fusul gospodăriei", async () => {
      const q = (period: string) =>
        runDefinition(deps(), f.A, f.HA, SYS.bags!, { period }).then(total);
      expect(await q("this_month")).toEqual([["RON", 175n]]); // 50 + 100 + 25 din octombrie
      expect(await q("last_month")).toEqual([["RON", 50n]]); // septembrie
      expect(await q("last_3_months")).toEqual([["RON", 225n]]);
      expect(await q("this_year")).toEqual([["RON", 225n]]);
      await expect(
        runDefinition(deps(), f.A, f.HA, SYS.bags!, { period: "ieri" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        runDefinition(deps(), f.A, f.HA, SYS.bags!, { extra: 1 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("acoperirea proiecției ține cont de vizibilitate (bonurile personale ale altora nu contează)", async () => {
      const asA = await runDefinition(deps(), f.A, f.HA, SYS.bags!);
      const asC = await runDefinition(deps(), f.C, f.HA, SYS.bags!);
      // A: 2026-09-10 … 2026-10-18; bonuri vizibile: 2 comune + 1 al lui A + 1 fără tranzacție = 4
      expect(asA.coverage).toEqual({ firstOn: "2026-09-10", lastOn: "2026-10-18", receipts: 4 });
      expect(asC.coverage).toEqual({ firstOn: "2026-09-10", lastOn: "2026-10-18", receipts: 4 });
      expect(asA.run.currencies[0]!.projection.status).toBe("insufficient");
    });
  });

  describe("definiții proprii", () => {
    let own: string;
    it("creează, citește, actualizează, arhivează, șterge; izolat pe gospodărie", async () => {
      const created = await createDefinition(deps(), f.A, f.HA, {
        name: "  Dulciuri  ",
        description: "Ciocolată",
        advice: null,
        rules: rules(),
      });
      own = created.id;
      expect(created).toMatchObject({ name: "Dulciuri", isSystem: false, archived: false });
      // C (alt membru al aceleiași gospodării) o vede; B (altă gospodărie) nu
      expect((await listDefinitions(deps(), f.C, f.HA)).map((d) => d.id)).toContain(own);
      expect((await listDefinitions(deps(), f.B, f.HB)).map((d) => d.id)).not.toContain(own);
      await expect(getDefinition(deps(), f.B, f.HB, own)).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        updateReportDefinition(deps(), f.B, f.HB, own, { name: "X" }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(removeDefinition(deps(), f.B, f.HB, own)).rejects.toBeInstanceOf(NotFoundError);
      const run = await runDefinition(deps(), f.A, f.HA, own);
      expect(run.run.currencies[0]).toMatchObject({
        totalMinor: 1000n,
        piecesMilli: 2000n,
        avgUnitMinor: 500n,
      });
      const upd = await updateReportDefinition(deps(), f.C, f.HA, own, {
        description: null,
        advice: "Verifică lista.",
        rules: rules({ include: [{ type: "contains", value: "milka" }] }),
      });
      expect(upd).toMatchObject({ description: null, advice: "Verifică lista." });
      const archived = await updateReportDefinition(deps(), f.A, f.HA, own, { archived: true });
      expect(archived.archived).toBe(true);
      expect((await listDefinitions(deps(), f.A, f.HA)).map((d) => d.id)).not.toContain(own);
      expect(
        (await listDefinitions(deps(), f.A, f.HA, { includeArchived: true })).map((d) => d.id),
      ).toContain(own);
      await removeDefinition(deps(), f.A, f.HA, own);
      await expect(getDefinition(deps(), f.A, f.HA, own)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("nume unic (fără diferență de litere) printre cele active; reutilizabil după arhivare", async () => {
      const first = await createDefinition(deps(), f.A, f.HA, { name: "Cafea", rules: rules() });
      const dup = createDefinition(deps(), f.C, f.HA, { name: "cafea", rules: rules() });
      await expect(dup).rejects.toMatchObject({ reason: "report_name_taken" });
      await expect(dup).rejects.toBeInstanceOf(ConflictError);
      // același nume în ALTĂ gospodărie e permis
      await createDefinition(deps(), f.B, f.HB, { name: "Cafea", rules: rules() });
      await updateReportDefinition(deps(), f.A, f.HA, first.id, { archived: true });
      await createDefinition(deps(), f.C, f.HA, { name: "CAFEA", rules: rules() });
      // dezarhivarea peste un nume activ → conflict
      await expect(
        updateReportDefinition(deps(), f.A, f.HA, first.id, { archived: false }),
      ).rejects.toMatchObject({ reason: "report_name_taken" });
    });

    it("validare strictă: chei necunoscute, reguli invalide, referințe inexistente", async () => {
      const bad = [
        { name: "A", rules: rules(), householdId: f.HB },
        { name: "A", rules: rules(), isSystem: true },
        { name: "", rules: rules() },
        { name: "A", rules: rules({ include: [{ type: "regex", value: "x.*" }] }) },
        { name: "A", rules: { ...rules(), v: 2 } },
        { name: "x".repeat(81), rules: rules() },
      ];
      for (const input of bad) {
        await expect(
          createDefinition(deps(), f.A, f.HA, input),
          JSON.stringify(input),
        ).rejects.toBeInstanceOf(ValidationError);
      }
      await expect(
        createDefinition(deps(), f.A, f.HA, {
          name: "Ref",
          rules: rules({ categoryIds: [randomUUID()] }),
        }),
      ).rejects.toMatchObject({ fields: { "rules.categoryIds": "Categorie inexistentă." } });
      await expect(
        createDefinition(deps(), f.A, f.HA, {
          name: "Ref",
          rules: rules({ tagIds: [randomUUID()] }),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      // categoria de sistem există
      const groceries = await systemCategoryId(f.admin, "expense.groceries");
      const ok = await createDefinition(deps(), f.A, f.HA, {
        name: "Alimente",
        rules: rules({ include: [], categoryIds: [groceries] }),
      });
      expect(ok.rules.categoryIds).toEqual([groceries]);
    });

    it("plafonul de definiții pe gospodărie (100) → report_limit", async () => {
      const counted = await f.admin<{ n: number }[]>`
        select count(*)::int as n from finet.report_definitions where household_id = ${f.HB}`;
      for (let i = counted[0]!.n; i < 100; i++) {
        await f.admin`insert into finet.report_definitions (household_id, name, rules, created_by_user_id)
          values (${f.HB}, ${`Umplutură ${i}`}, '{"v":1}'::jsonb, ${f.B.userId})`;
      }
      await expect(
        createDefinition(deps(), f.B, f.HB, { name: "Peste plafon", rules: rules() }),
      ).rejects.toMatchObject({ reason: "report_limit" });
    });
  });

  describe("previzualizare și export", () => {
    it("previzualizarea rulează regulile primite și nu salvează nimic", async () => {
      const before = await f.admin`select count(*)::int as n from finet.report_definitions`;
      const r = await previewRules(deps(), f.A, f.HA, {
        rules: rules({ include: [{ type: "prefix", value: "ciocolata" }] }),
        period: "this_year",
      });
      expect(r.definition).toBeNull();
      expect(total(r)).toEqual([["RON", 1000n]]);
      const after = await f.admin`select count(*)::int as n from finet.report_definitions`;
      expect(after[0]!.n).toBe(before[0]!.n);
      await expect(
        previewRules(deps(), f.A, f.HA, { rules: rules(), extra: 1 }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("export CSV: toate liniile potrivite, protecție de formule pe text liber, audit fără conținut", async () => {
      await seedReceipt(f.admin, {
        householdId: f.HA,
        actorId: f.A.userId,
        accountId: commonA,
        on: "2026-10-20",
        merchant: '=HYPERLINK("http://x")',
        lines: [{ name: "-2+3 PUNGA INJECTIE", quantity: "1", totalMinor: 10, kind: "bag" }],
      });
      const out = await exportDefinitionCsv(deps(), f.A, f.HA, SYS.bags!, { period: "this_month" });
      const rows = out.csv.replace(/^﻿/, "").trim().split("\r\n");
      expect(rows[0]).toBe(
        "line_id,receipt_id,occurred_on,merchant,name,kind,quantity,currency,line_total_minor,line_total",
      );
      expect(out.rows).toBe(rows.length - 1);
      expect(out.csv.startsWith("﻿")).toBe(true);
      // text liber neutralizat cu apostrof
      expect(out.csv).toContain("'=HYPERLINK");
      expect(out.csv).toContain("'-2+3 PUNGA INJECTIE");
      const [audit] = await f.admin<{ metadata: unknown; target_type: string | null }[]>`
        select metadata, target_type from finet.audit_events
         where action = 'export.downloaded' order by created_at desc limit 1`;
      expect(audit!.metadata).toEqual({ kind: "report", rows: out.rows });
      // sume zecimale exacte
      expect(rows.some((r) => r.endsWith(",50,0.50"))).toBe(true);
      // C nu vede în export bonul personal al lui A și invers
      const asC = await exportDefinitionCsv(deps(), f.C, f.HA, SYS.bags!);
      expect(asC.csv).toContain(",150,1.50");
      expect(asC.csv).not.toContain(",100,1.00\r\n");
    });
  });
});
