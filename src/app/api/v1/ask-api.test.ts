import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { addMemberByEmail, createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";

import * as AH from "./_lib/ask-handlers";
import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as SM from "./_lib/summary-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// Forma răspunsului e verificată prin contract (`assertContract`); în aserțiuni se citește liber.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

/**
 * „Întreabă FINET” (F10-C; ADR 0025) prin API: handler real, PostgreSQL real, aplicația ca
 * `finet_app`. Cifrele vin din baza de date sub RLS (conturile personale ale altor membri nu
 * intră), interogarea folosită apare în răspuns, întrebările neînțelese primesc un motiv fix, iar
 * textul întrebării nu rămâne nicăieri.
 */

describe.skipIf(!TEST_ADMIN_URL)("POST /api/v1/ask pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // 28 octombrie 2026, 10:00 UTC → azi în București: 2026-10-28.
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let C: Sessions;
  let B: Sessions;
  let groceriesName: string;
  const PASS = "parola-ask-finet-1";

  async function ask(question: unknown, s: Sessions | null = A, deps: ApiDeps = env) {
    const init: ApiInit = { body: { question } as never, ...(s ? { bearer: s.bearer } : {}) };
    const res = await AH.askHandler(apiRequest("/api/v1/ask", init), deps);
    await assertContract(AH.askHandler as never, res);
    const body = await readJson(res);
    return { status: res.status, body, data: (body as { data?: Loose }).data };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_ask");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        exports: { max: 100_000, windowSeconds: 60 },
        ask: { max: 100_000, windowSeconds: 60 },
      },
    };
    const mk = (email: string, name: string) =>
      createUserWithHousehold(fx.db, {
        email,
        name,
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
    const a = await mk("ana@exemplu.ro", "Ana");
    await mk("bogdan@exemplu.ro", "Bogdan");
    const c = await mk("cristi@exemplu.ro", "Cristi");
    await addMemberByEmail(fx.db, a.householdId!, "cristi@exemplu.ro", "member");
    await fx.scratch.admin`delete from finet.households where id = ${c.householdId!}`;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cristi@exemplu.ro", PASS);

    const account = async (body: Record<string, unknown>) =>
      (
        (
          await readJson(
            await L.createAccountHandler(
              apiRequest("/api/v1/accounts", { bearer: A.bearer, body }),
              env,
            ),
          )
        ).data as { id: string }
      ).id;
    const shared = await account({ name: "Card comun", type: "bank", currency: "RON" });
    const personal = await account({
      name: "Personal Ana",
      type: "bank",
      currency: "RON",
      ownerUserId: a.userId,
    });
    const groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
    const salary = (
      await fx.scratch.admin<{ id: string }[]>`
        select id from finet.categories where household_id is null and kind = 'income'
        order by sort_order limit 1`
    )[0]!.id;
    groceriesName = (
      await fx.scratch.admin<
        { name: string }[]
      >`select name from finet.categories where id = ${groceries}`
    )[0]!.name;
    const tx = async (accountId: string, body: Record<string, unknown>) => {
      const r = await L.createTransactionHandler(
        apiRequest("/api/v1/transactions", { bearer: A.bearer, body: { accountId, ...body } }),
        env,
      );
      expect(r.status, await r.clone().text()).toBe(201);
    };
    // Martie 2026
    await tx(shared, {
      type: "expense",
      amountMinor: 1234,
      occurredOn: "2026-03-05",
      categoryId: groceries,
      merchant: "Lidl",
    });
    await tx(shared, {
      type: "expense",
      amountMinor: 5000,
      occurredOn: "2026-03-09",
      categoryId: groceries,
      merchant: "Kaufland",
    });
    await tx(shared, {
      type: "expense",
      amountMinor: 700,
      occurredOn: "2026-03-10",
      merchant: "Chioșc",
    });
    // Septembrie 2026 (luna trecută)
    await tx(shared, {
      type: "expense",
      amountMinor: 10000,
      occurredOn: "2026-09-12",
      categoryId: groceries,
      merchant: "Lidl",
    });
    // Octombrie 2026 (luna curentă)
    await tx(shared, {
      type: "income",
      amountMinor: 500000,
      occurredOn: "2026-10-02",
      categoryId: salary,
      description: "Salariu",
    });
    // Cont personal al Anei: doar ea îl vede
    await tx(personal, {
      type: "expense",
      amountMinor: 99900,
      occurredOn: "2026-09-20",
      merchant: "Secret SRL",
    });
    await fx.scratch.admin`delete from finet.audit_events`;
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("total pe lună și comerciant: cifre exacte, interogarea în răspuns", async () => {
    const r = await ask("Cât am cheltuit la Lidl luna trecută?");
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({
      understood: true,
      query: {
        metric: "expense_total",
        period: { from: "2026-09-01", to: "2026-09-30" },
        merchant: "Lidl",
      },
      answer: { kind: "total", rows: [{ currency: "RON", totalMinor: 10000, count: 1 }] },
    });
    expect(r.data!.queryText).toContain("comerciantul Lidl");
    expect(r.data!.text).toContain("Ai cheltuit");
    expect(r.data!.text).toContain("100,00");
  });

  it("pe categorie și lună numită (anul curent), cu numărul de tranzacții", async () => {
    const r = await ask(`Cât am cheltuit la ${groceriesName} în martie?`);
    expect(r.data).toMatchObject({
      understood: true,
      answer: { kind: "total", rows: [{ currency: "RON", totalMinor: 6234, count: 2 }] },
    });
    expect(r.data!.query.categoryId).toBeTruthy();
  });

  it("venituri, perioada implicită spusă în note", async () => {
    const r = await ask("cât am încasat?");
    expect(r.data).toMatchObject({
      understood: true,
      query: { metric: "income_total", period: { from: "2026-10-01", to: "2026-10-28" } },
      answer: { kind: "total", rows: [{ totalMinor: 500000, count: 1 }] },
    });
    expect(r.data!.notes).toEqual(["Perioada nu a fost menționată: am folosit luna curentă."]);
  });

  it("clasamente: categorii și comercianți, cel mult 5, în ordine descrescătoare", async () => {
    const cats = await ask("pe ce am cheltuit cel mai mult în martie");
    expect(cats.data!.answer.kind).toBe("ranking");
    const items = cats.data!.answer.rows[0].items as { name: string | null; amountMinor: number }[];
    expect(items[0]).toMatchObject({ name: groceriesName, amountMinor: 6234 });
    expect(items[1]).toMatchObject({ name: null, amountMinor: 700 });
    const merchants = await ask("unde am cheltuit cel mai mult în martie");
    const m = merchants.data!.answer.rows[0].items as { name: string; amountMinor: number }[];
    expect(m.map((x) => x.name)).toEqual(["Kaufland", "Lidl", "Chioșc"]);
  });

  it("vizibilitate: cheltuiala din contul personal al Anei nu apare la ceilalți membri", async () => {
    const ana = await ask("cât am cheltuit luna trecută", A);
    expect(ana.data!.answer.rows[0].totalMinor).toBe(10000 + 99900);
    const cristi = await ask("cât am cheltuit luna trecută", C);
    expect(cristi.data!.answer.rows[0].totalMinor).toBe(10000);
    expect(JSON.stringify(cristi.body)).not.toContain("Secret");
    const merchants = await ask("unde am cheltuit cel mai mult luna trecută", C);
    expect(JSON.stringify(merchants.body)).not.toContain("Secret");
  });

  it("izolare: altă gospodărie nu vede nimic al altuia", async () => {
    const r = await ask("cât am cheltuit în martie", B);
    expect(r.data).toMatchObject({ understood: true, answer: { kind: "total", rows: [] } });
    expect(r.data!.text).toContain("Nu ai nicio cheltuială");
  });

  it("întrebări neînțelese: 200 cu motiv fix, fără presupuneri", async () => {
    for (const [question, reason] of [
      ["salut, ce faci?", "metric"],
      ["cât am cheltuit în luna foo", "period"],
      ["   ", "empty"],
    ] as const) {
      const r = await ask(question);
      expect(r.status).toBe(question.trim() === "" ? 400 : 200);
      if (r.status === 200) {
        expect(r.data).toMatchObject({ understood: false, reason });
        expect(r.data!.message).toBeTruthy();
      }
    }
  });

  it("validare: corp invalid, întrebare prea lungă/scurtă, câmpuri necunoscute → 400; 401 fără sesiune", async () => {
    expect((await ask("x".repeat(301))).status).toBe(400);
    expect((await ask("ab")).status).toBe(400);
    expect((await ask(123)).status).toBe(400);
    const extra = await AH.askHandler(
      apiRequest("/api/v1/ask", {
        bearer: A.bearer,
        body: { question: "cât am cheltuit", householdId: "x" } as never,
      }),
      env,
    );
    expect(extra.status).toBe(400);
    expect((await ask("cât am cheltuit", null)).status).toBe(401);
  });

  it("rate limit propriu (429) după plafon", async () => {
    const strict: ApiDeps = {
      ...env,
      limits: { ...env.limits, ask: { max: 2, windowSeconds: 60 } },
      now: () => clock + 5_555_555,
    };
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await ask("cât am cheltuit", A, strict)).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("textul întrebării nu rămâne nicăieri (audit, chei de limită, alte tabele cu text)", async () => {
    const secret = "UNICORN-PIERDUT-9731";
    await ask(`cât am cheltuit la ${secret} luna trecută`);
    await ask(`${secret} fără sens`);
    const audit = await fx.scratch.admin`select count(*)::int as n from finet.audit_events`;
    expect(audit[0]!.n).toBe(0);
    const hits = await fx.scratch.admin<{ t: string }[]>`
      select table_name as t from information_schema.tables where table_schema in ('finet')`;
    for (const { t } of hits) {
      const rows = await fx.scratch.admin.unsafe(
        `select count(*)::int as n from finet."${t}" x where x::text like '%${secret}%'`,
      );
      expect(rows[0]!.n, t).toBe(0);
    }
  });

  describe("rezumatul lunii (GET /api/v1/summary/monthly)", () => {
    async function summary(query: string, s: Sessions | null = A) {
      const res = await SM.monthlySummaryHandler(
        apiRequest(`/api/v1/summary/monthly${query}`, s ? { bearer: s.bearer } : {}),
        env,
      );
      await assertContract(SM.monthlySummaryHandler as never, res);
      const body = await readJson(res);
      return { status: res.status, data: (body as { data?: Loose }).data };
    }
    const textOf = (d: Loose) => (d.lines as { text: string }[]).map((l) => l.text).join("\n");

    it("martie: totaluri, categorii, comerciant, eticheta fixă", async () => {
      const r = await summary("?month=2026-03");
      expect(r.status).toBe(200);
      expect(r.data!.label).toBe("Rezumat automat, nu sfat financiar.");
      const text = textOf(r.data!);
      expect(text).toContain("martie 2026");
      expect(text).toContain("69,34"); // 12,34 + 50,00 + 7,00
      expect(text).toContain("Kaufland");
    });

    it("luna curentă față de cea trecută; cifre din cont personal doar pentru proprietar", async () => {
      const ana = await summary("", A);
      const t = textOf(ana.data!);
      expect(t).toContain("octombrie 2026");
      expect(t).toContain("5.000,00"); // venitul
      expect(t).toContain("cu 100% mai mici");
      const cristi = await summary("?month=2026-09", C);
      expect(textOf(cristi.data!)).toContain("100,00");
      expect(textOf(cristi.data!)).not.toContain("999,00");
      expect(textOf(cristi.data!)).not.toContain("Secret");
      const anaSep = await summary("?month=2026-09", A);
      expect(textOf(anaSep.data!)).toContain("1.099,00");
    });

    it("lună goală, 400 pentru lună nevalidă sau parametri necunoscuți, 401 fără sesiune", async () => {
      expect(textOf((await summary("?month=2026-05")).data!)).toContain(
        "Nu ai tranzacții înregistrate în mai 2026.",
      );
      expect((await summary("?month=2026-13")).status).toBe(400);
      expect((await summary("?x=1")).status).toBe(400);
      expect((await summary("", null)).status).toBe(401);
    });
  });
});
