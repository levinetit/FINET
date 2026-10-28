import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { addMemberByEmail, createUserWithHousehold } from "@/modules/auth/users.service";
import { TRANSACTION_COLUMNS } from "@/modules/exports/exports.service";
import { systemCategoryId } from "@/modules/ledger/testing";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as M from "./_lib/me-handlers";
import * as P from "./_lib/planning-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/**
 * Acceptarea F3-B prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`): etichete,
 * bugete (semafor, avertizări), obiective (contribuții, stări), dashboard, raport lunar, exporturi
 * CSV (antete, BOM, escape, injection, izolare, plafon, flux, rate limit, audit), 401, izolare
 * (404), validare (400 cu `fields`), idempotență, plafonul sumelor (400/422).
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;

const NIL = "00000000-0000-4000-8000-000000000000";
const BOM = "﻿";

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1 planificare pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // 28 octombrie 2026, 10:00 UTC → luna curentă în București: 2026-10.
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions; // owner HA
  let B: Sessions; // owner HB
  let C: Sessions; // member HA (doar HA)
  let D: Sessions; // owner HD (debordare)
  let HA: string;
  let groceries: string;
  let salary: string;
  let accRon: string;
  let accEur: string;
  let accRon2: string;
  let keySeq = 0;
  const PASS = "parola-planificare-1";
  const newKey = () => `planificare-cheie-${String(++keySeq).padStart(6, "0")}`;

  async function call(
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ): Promise<{ status: number; body: Body; res: Response; text: string }> {
    return callWith(env, handler, path, init, ...rest);
  }

  async function callWith(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ): Promise<{ status: number; body: Body; res: Response; text: string }> {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      deps,
      ...rest,
    );
    await assertContract(handler, res);
    // Textul cu BOM păstrat (`Response.text()` l-ar elimina).
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      await res.clone().arrayBuffer(),
    );
    const isCsv = (res.headers.get("content-type") ?? "").startsWith("text/csv");
    return {
      status: res.status,
      body: isCsv || !text ? {} : (JSON.parse(text) as Body),
      res,
      text,
    };
  }

  const idOf = (r: { body: Body }) => (r.body.data as { id: string }).id;

  async function newAccount(s: Sessions, name: string, currency = "RON") {
    const r = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: s.bearer,
      body: { name, type: "bank", currency },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return idOf(r);
  }

  async function newTx(s: Sessions, body: Record<string, unknown>) {
    const r = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: s.bearer,
      body: { type: "expense", ...body },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r;
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_planning_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        exports: { max: 100_000, windowSeconds: 60 },
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
    HA = (await mk("ana@exemplu.ro", "Ana")).householdId!;
    await mk("bogdan@exemplu.ro", "Bogdan");
    await mk("dora@exemplu.ro", "Dora");
    // Cristi e membru DOAR în HA (gospodăria personală ștearsă), ca HA să fie cea curentă.
    const c = await mk("cristi@exemplu.ro", "Cristi");
    await addMemberByEmail(fx.db, HA, "cristi@exemplu.ro", "member");
    await fx.scratch.admin`delete from finet.households where id = ${c.householdId!}`;
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    C = await sessionsFor(env, "cristi@exemplu.ro", PASS);
    D = await sessionsFor(env, "dora@exemplu.ro", PASS);
    groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
    salary = (
      await fx.scratch.admin<{ id: string }[]>`
        select id from finet.categories where household_id is null and kind = 'income'
        order by sort_order limit 1`
    )[0]!.id;
    accRon = await newAccount(A, "Card RON");
    accEur = await newAccount(A, "Card EUR", "EUR");
    accRon2 = await newAccount(A, "Economii RON");
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune (și cu bearer inventat): 401 pe FIECARE endpoint nou", async () => {
    const cases: [Handler, string, ApiInit, ...string[]][] = [
      [P.listTagsHandler, "/api/v1/tags", {}],
      [P.createTagHandler, "/api/v1/tags", { body: {} }],
      [P.getTagHandler, `/api/v1/tags/${NIL}`, {}, NIL],
      [P.patchTagHandler, `/api/v1/tags/${NIL}`, { method: "PATCH", body: {} }, NIL],
      [P.deleteTagHandler, `/api/v1/tags/${NIL}`, { method: "DELETE" }, NIL],
      [P.listBudgetsHandler, "/api/v1/budgets", {}],
      [P.createBudgetHandler, "/api/v1/budgets", { body: {} }],
      [P.budgetStatusHandler, "/api/v1/budgets/status", {}],
      [P.getBudgetHandler, `/api/v1/budgets/${NIL}`, {}, NIL],
      [P.patchBudgetHandler, `/api/v1/budgets/${NIL}`, { method: "PATCH", body: {} }, NIL],
      [P.deleteBudgetHandler, `/api/v1/budgets/${NIL}`, { method: "DELETE" }, NIL],
      [P.listGoalsHandler, "/api/v1/goals", {}],
      [P.createGoalHandler, "/api/v1/goals", { body: {} }],
      [P.getGoalHandler, `/api/v1/goals/${NIL}`, {}, NIL],
      [P.patchGoalHandler, `/api/v1/goals/${NIL}`, { method: "PATCH", body: {} }, NIL],
      [P.deleteGoalHandler, `/api/v1/goals/${NIL}`, { method: "DELETE" }, NIL],
      [P.contributeGoalHandler, `/api/v1/goals/${NIL}/contributions`, { body: {} }, NIL],
      [P.abandonGoalHandler, `/api/v1/goals/${NIL}/abandon`, { method: "POST" }, NIL],
      [P.dashboardHandler, "/api/v1/dashboard", {}],
      [P.monthlyReportHandler, "/api/v1/reports/monthly", {}],
      [P.exportTransactionsHandler, "/api/v1/exports/transactions.csv", {}],
      [P.exportGoalsHandler, "/api/v1/exports/goals.csv", {}],
      [P.exportBudgetsHandler, "/api/v1/exports/budgets.csv", {}],
    ];
    for (const [handler, path, init, ...rest] of cases) {
      const r = await call(handler, path, init, ...rest);
      expect(r.status, path).toBe(401);
      expect(r.body.error?.code).toBe("unauthenticated");
      const forged = await call(handler, path, { ...init, bearer: "inventat" }, ...rest);
      expect(forged.status, path).toBe(401);
    }
  });

  it("FIECARE mutație nouă: `householdId` în corp → 400 cu `fields`; cookie fără Origin → 403; 415", async () => {
    const tag = idOf(
      await call(P.createTagHandler, "/api/v1/tags", { bearer: A.bearer, body: { name: "Val" } }),
    );
    const budget = idOf(
      await call(P.createBudgetHandler, "/api/v1/budgets", {
        bearer: A.bearer,
        body: { amountMinor: 100, currency: "USD" },
      }),
    );
    const goal = idOf(
      await call(P.createGoalHandler, "/api/v1/goals", {
        bearer: A.bearer,
        body: { name: "Validare", targetMinor: 100, currency: "RON" },
      }),
    );
    const withBody: [Handler, string, string, Record<string, unknown>, ...string[]][] = [
      [P.createTagHandler, "POST", "/api/v1/tags", { name: "x" }],
      [P.patchTagHandler, "PATCH", "/api/v1/tags/t", { name: "y" }, tag],
      [P.createBudgetHandler, "POST", "/api/v1/budgets", { amountMinor: 1, currency: "EUR" }],
      [P.patchBudgetHandler, "PATCH", "/api/v1/budgets/b", { amountMinor: 2 }, budget],
      [
        P.createGoalHandler,
        "POST",
        "/api/v1/goals",
        { name: "x", targetMinor: 1, currency: "RON" },
      ],
      [P.patchGoalHandler, "PATCH", "/api/v1/goals/g", { name: "y" }, goal],
      [
        P.contributeGoalHandler,
        "POST",
        "/api/v1/goals/g/contributions",
        { direction: "add", amountMinor: 1 },
        goal,
      ],
    ];
    for (const [handler, method, path, body, ...rest] of withBody) {
      const r = await call(
        handler,
        path,
        {
          method,
          bearer: A.bearer,
          body: { ...body, householdId: NIL },
          headers: { "idempotency-key": newKey() },
        },
        ...rest,
      );
      expect(r.status, path).toBe(400);
      expect(r.body.error?.fields, path).toBeDefined();
      const csrf = await call(
        handler,
        path,
        { method, cookie: A.cookie, body, headers: { origin: "" } },
        ...rest,
      );
      expect(csrf.status, path).toBe(403);
      const media = await call(
        handler,
        path,
        { method, bearer: A.bearer, rawBody: "name=x", headers: { "content-type": "text/plain" } },
        ...rest,
      );
      expect(media.status, path).toBe(415);
    }
    // Mutațiile fără corp: cookie fără Origin → 403.
    for (const [handler, method, path, id] of [
      [P.deleteTagHandler, "DELETE", "/api/v1/tags/t", tag],
      [P.deleteBudgetHandler, "DELETE", "/api/v1/budgets/b", budget],
      [P.deleteGoalHandler, "DELETE", "/api/v1/goals/g", goal],
      [P.abandonGoalHandler, "POST", "/api/v1/goals/g/abandon", goal],
    ] as [Handler, string, string, string][]) {
      const r = await call(
        handler,
        path,
        { method, cookie: A.cookie, headers: { origin: "" } },
        id,
      );
      expect(r.status, path).toBe(403);
    }
    // Parametri necunoscuți sau repetați → 400.
    for (const [handler, path] of [
      [P.listTagsHandler, "/api/v1/tags?x=1"],
      [P.listBudgetsHandler, "/api/v1/budgets?includeArchived=da"],
      [P.listGoalsHandler, "/api/v1/goals?status=gata"],
      [P.dashboardHandler, "/api/v1/dashboard?month=2026-10&month=2026-09"],
      [P.dashboardHandler, "/api/v1/dashboard?topCategories=0"],
      [P.monthlyReportHandler, "/api/v1/reports/monthly?an=2026"],
      [P.exportGoalsHandler, "/api/v1/exports/goals.csv?dialect=excel"],
      [P.exportTransactionsHandler, "/api/v1/exports/transactions.csv?sort=date_desc"],
      [P.exportTransactionsHandler, "/api/v1/exports/transactions.csv?limit=10"],
    ] as [Handler, string][]) {
      const r = await call(handler, path, { bearer: A.bearer });
      expect(r.status, path).toBe(400);
      expect(r.body.error?.fields, path).toBeDefined();
    }
  });

  it("luna: format strict și interval (ultimele 60 de luni … luna curentă) pe toate rutele lunare", async () => {
    const monthly: [Handler, string][] = [
      [P.dashboardHandler, "/api/v1/dashboard"],
      [P.monthlyReportHandler, "/api/v1/reports/monthly"],
      [P.budgetStatusHandler, "/api/v1/budgets/status"],
      [P.exportBudgetsHandler, "/api/v1/exports/budgets.csv"],
    ];
    for (const [handler, base] of monthly) {
      for (const bad of ["2026-13", "2026-1", "26-10", "2026-10-01", "2026-11", "2021-09"]) {
        const r = await call(handler, `${base}?month=${bad}`, { bearer: A.bearer });
        expect(r.status, `${base} ${bad}`).toBe(400);
        expect(r.body.error?.fields?.month, `${base} ${bad}`).toBeDefined();
      }
      for (const ok of ["2026-10", "2021-10"]) {
        const r = await call(handler, `${base}?month=${ok}`, { bearer: A.bearer });
        expect(r.status, `${base} ${ok}`).toBe(200);
      }
    }
    // Implicit: luna curentă în Europe/Bucharest (31 dec 22:30 UTC = deja ianuarie local).
    const nye = { ...env, now: () => Date.parse("2026-12-31T22:30:00Z") };
    const r = await callWith(nye, P.dashboardHandler, "/api/v1/dashboard", { bearer: A.bearer });
    expect((r.body.data as { month: string }).month).toBe("2027-01");
    const def = await call(P.dashboardHandler, "/api/v1/dashboard", { bearer: A.bearer });
    expect((def.body.data as { month: string; previousMonth: string }).month).toBe("2026-10");
  });

  it("etichete: CRUD, sistem doar ascundere, nume unic, tags în răspunsul tranzacției, filtre", async () => {
    const list = await call(P.listTagsHandler, "/api/v1/tags", { bearer: A.bearer });
    const tags = list.body.data as { id: string; systemKey: string | null; isSystem: boolean }[];
    const gift = tags.find((t) => t.systemKey === "gift")!;
    expect(gift.isSystem).toBe(true);

    const created = await call(P.createTagHandler, "/api/v1/tags", {
      bearer: A.bearer,
      body: { name: "Vacanța 2027", color: "#AA00FF" },
    });
    expect(created.status).toBe(201);
    const vac = created.body.data as { id: string; color: string; usageCount: number };
    expect(vac.color).toBe("#aa00ff");
    const dup = await call(P.createTagHandler, "/api/v1/tags", {
      bearer: C.bearer,
      body: { name: "vacanța 2027" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.reason).toBe("tag_name_taken");
    const sysName = await call(P.createTagHandler, "/api/v1/tags", {
      bearer: A.bearer,
      body: { name: "cadou" },
    });
    expect(sysName.body.error?.reason).toBe("tag_name_taken");

    // Eticheta de sistem: rename → 409, ascundere → OK (dispare din listă, rămâne cu includeHidden).
    const rename = await call(
      P.patchTagHandler,
      `/api/v1/tags/${gift.id}`,
      { method: "PATCH", bearer: A.bearer, body: { name: "Daruri" } },
      gift.id,
    );
    expect(rename.body.error?.reason).toBe("system_tag");
    const hide = await call(
      P.patchTagHandler,
      `/api/v1/tags/${gift.id}`,
      { method: "PATCH", bearer: A.bearer, body: { hidden: true } },
      gift.id,
    );
    expect((hide.body.data as { hidden: boolean }).hidden).toBe(true);
    const visible = await call(P.listTagsHandler, "/api/v1/tags", { bearer: A.bearer });
    expect((visible.body.data as { id: string }[]).some((t) => t.id === gift.id)).toBe(false);
    const all = await call(P.listTagsHandler, "/api/v1/tags?includeHidden=true", {
      bearer: A.bearer,
    });
    expect((all.body.data as { id: string }[]).some((t) => t.id === gift.id)).toBe(true);
    const delSys = await call(
      P.deleteTagHandler,
      `/api/v1/tags/${gift.id}`,
      { method: "DELETE", bearer: A.bearer },
      gift.id,
    );
    expect(delSys.body.error?.reason).toBe("system_tag");

    // Tranzacții cu etichete: `tags: [{id,name,color}]` la creare, GET, PATCH, listă.
    const t1 = await newTx(A, {
      accountId: accRon,
      amountMinor: 1500,
      occurredOn: "2026-06-03",
      merchant: "Agenția Soare",
      tagIds: [vac.id, gift.id],
    });
    const t1Data = t1.body.data as { id: string; tags: { id: string; name: string }[] };
    expect(t1Data.tags.map((t) => t.name)).toEqual(["Cadou", "Vacanța 2027"]);
    expect(t1Data.tags[1]).toEqual({ id: vac.id, name: "Vacanța 2027", color: "#aa00ff" });
    await newTx(A, {
      accountId: accRon,
      amountMinor: 900,
      occurredOn: "2026-06-04",
      merchant: "Brutăria Soare",
    });
    const got = await call(
      L.getTransactionHandler,
      `/api/v1/transactions/${t1Data.id}`,
      { bearer: A.bearer },
      t1Data.id,
    );
    expect((got.body.data as { tags: unknown[] }).tags).toHaveLength(2);
    // Faza 4: `tagMatch=all` cere TOATE etichetele (t1 le are pe ambele acum).
    const listIds = async (search: string) => {
      const r = await call(
        L.listTransactionsHandler,
        `/api/v1/transactions?${search}&dateFrom=2026-06-01&dateTo=2026-06-30`,
        { bearer: A.bearer },
      );
      expect(r.status, search).toBe(200);
      return (r.body.data as { id: string }[]).map((t) => t.id);
    };
    expect(await listIds(`tagIds=${vac.id},${gift.id}&tagMatch=all`)).toEqual([t1Data.id]);
    expect(await listIds(`tagIds=${vac.id}&tagMatch=all`)).toEqual([t1Data.id]);
    const patched = await call(
      L.patchTransactionHandler,
      `/api/v1/transactions/${t1Data.id}`,
      { method: "PATCH", bearer: A.bearer, body: { tagIds: [vac.id] } },
      t1Data.id,
    );
    expect((patched.body.data as { tags: { id: string }[] }).tags.map((t) => t.id)).toEqual([
      vac.id,
    ]);

    const byTag = await call(
      L.listTransactionsHandler,
      `/api/v1/transactions?tagIds=${vac.id},${gift.id}&dateFrom=2026-06-01&dateTo=2026-06-30`,
      { bearer: A.bearer },
    );
    expect((byTag.body.data as { id: string }[]).map((t) => t.id)).toEqual([t1Data.id]);
    // După PATCH t1 are doar `vac`: „oricare” îl găsește, „toate” nu.
    expect(await listIds(`tagIds=${vac.id},${gift.id}&tagMatch=any`)).toEqual([t1Data.id]);
    expect(await listIds(`tagIds=${vac.id},${gift.id}&tagMatch=all`)).toEqual([]);
    for (const bad of ["tagMatch=all", "tagMatch=toate", `tagIds=${vac.id}&tagMatch=`]) {
      const r = await call(L.listTransactionsHandler, `/api/v1/transactions?${bad}`, {
        bearer: A.bearer,
      });
      expect(r.status, bad).toBe(400);
    }
    const byMerchant = await call(
      L.listTransactionsHandler,
      "/api/v1/transactions?merchant=soare&dateFrom=2026-06-01&dateTo=2026-06-30",
      { bearer: A.bearer },
    );
    expect(byMerchant.body.data as unknown[]).toHaveLength(2);
    const byAmount = await call(
      L.listTransactionsHandler,
      "/api/v1/transactions?merchant=soare&amountMinMinor=1000&amountMaxMinor=2000",
      { bearer: A.bearer },
    );
    expect((byAmount.body.data as { id: string }[]).map((t) => t.id)).toEqual([t1Data.id]);
    for (const bad of ["tagIds=", "tagIds=nu-e-uuid", `tagIds=${vac.id},${vac.id}`]) {
      const r = await call(L.listTransactionsHandler, `/api/v1/transactions?${bad}`, {
        bearer: A.bearer,
      });
      expect(r.status, bad).toBe(400);
      expect(
        Object.keys(r.body.error?.fields ?? {}).some((k) => k.startsWith("tagIds")),
        bad,
      ).toBe(true);
    }

    // Transferurile din listă au `tags: []`.
    await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: A.bearer,
      body: {
        fromAccountId: accRon,
        toAccountId: accRon2,
        amountMinor: 10,
        occurredOn: "2026-06-05",
      },
    });
    const withTransfer = await call(
      L.listTransactionsHandler,
      "/api/v1/transactions?type=transfer&dateFrom=2026-06-05&dateTo=2026-06-05",
      { bearer: A.bearer },
    );
    const rows = withTransfer.body.data as { tags: unknown[] }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tags.length === 0)).toBe(true);

    // Ștergerea etichetei proprii scoate legăturile.
    const delVac = await call(
      P.deleteTagHandler,
      `/api/v1/tags/${vac.id}`,
      { method: "DELETE", bearer: A.bearer },
      vac.id,
    );
    expect(delVac.status).toBe(204);
    const after = await call(
      L.getTransactionHandler,
      `/api/v1/transactions/${t1Data.id}`,
      { bearer: A.bearer },
      t1Data.id,
    );
    expect((after.body.data as { tags: unknown[] }).tags).toEqual([]);
    const gone = await call(
      P.getTagHandler,
      `/api/v1/tags/${vac.id}`,
      { bearer: A.bearer },
      vac.id,
    );
    expect(gone.status).toBe(404);
  });

  it("izolare: B nu vede/modifică etichetele, bugetele, obiectivele lui A (404 uniform)", async () => {
    const tag = idOf(
      await call(P.createTagHandler, "/api/v1/tags", {
        bearer: A.bearer,
        body: { name: "Secret" },
      }),
    );
    const budget = idOf(
      await call(P.createBudgetHandler, "/api/v1/budgets", {
        bearer: A.bearer,
        body: { categoryId: groceries, amountMinor: 5000, currency: "EUR" },
      }),
    );
    const goal = idOf(
      await call(P.createGoalHandler, "/api/v1/goals", {
        bearer: A.bearer,
        body: { name: "Mașină", targetMinor: 1000, currency: "RON" },
      }),
    );
    const cases: [Handler, string, ApiInit, string][] = [
      [P.getTagHandler, `/api/v1/tags/${tag}`, {}, tag],
      [P.patchTagHandler, `/api/v1/tags/${tag}`, { method: "PATCH", body: { name: "x" } }, tag],
      [P.deleteTagHandler, `/api/v1/tags/${tag}`, { method: "DELETE" }, tag],
      [P.getBudgetHandler, `/api/v1/budgets/${budget}`, {}, budget],
      [
        P.patchBudgetHandler,
        `/api/v1/budgets/${budget}`,
        { method: "PATCH", body: { amountMinor: 1 } },
        budget,
      ],
      [P.deleteBudgetHandler, `/api/v1/budgets/${budget}`, { method: "DELETE" }, budget],
      [P.getGoalHandler, `/api/v1/goals/${goal}`, {}, goal],
      [P.patchGoalHandler, `/api/v1/goals/${goal}`, { method: "PATCH", body: { name: "x" } }, goal],
      [P.deleteGoalHandler, `/api/v1/goals/${goal}`, { method: "DELETE" }, goal],
      [
        P.contributeGoalHandler,
        `/api/v1/goals/${goal}/contributions`,
        { body: { direction: "add", amountMinor: 5 }, headers: { "idempotency-key": newKey() } },
        goal,
      ],
      [P.abandonGoalHandler, `/api/v1/goals/${goal}/abandon`, { method: "POST" }, goal],
      [P.getTagHandler, "/api/v1/tags/nu-e-uuid", {}, "nu-e-uuid"],
    ];
    for (const [handler, path, init, id] of cases) {
      const r = await call(handler, path, { ...init, bearer: B.bearer }, id);
      expect(r.status, path).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    // Eticheta lui A pe o tranzacție a lui B → 404; listele lui B nu conțin nimic al lui A.
    const accB = await newAccount(B, "Cont B");
    const foreign = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: B.bearer,
      body: {
        accountId: accB,
        type: "expense",
        amountMinor: 1,
        occurredOn: "2026-10-01",
        tagIds: [tag],
      },
    });
    expect(foreign.status).toBe(404);
    const foreignFilter = await call(
      L.listTransactionsHandler,
      `/api/v1/transactions?tagIds=${tag}`,
      {
        bearer: B.bearer,
      },
    );
    expect(foreignFilter.body.data).toEqual([]);
    const tagsB = await call(P.listTagsHandler, "/api/v1/tags?includeHidden=true", {
      bearer: B.bearer,
    });
    expect((tagsB.body.data as { id: string }[]).some((t) => t.id === tag)).toBe(false);
    const budgetsB = await call(P.listBudgetsHandler, "/api/v1/budgets", { bearer: B.bearer });
    expect(budgetsB.body.data).toEqual([]);
    const goalsB = await call(P.listGoalsHandler, "/api/v1/goals", { bearer: B.bearer });
    expect(goalsB.body.data).toEqual([]);
    // A rămâne neatins.
    const still = await call(P.getGoalHandler, `/api/v1/goals/${goal}`, { bearer: A.bearer }, goal);
    expect((still.body.data as { savedMinor: number; status: string }).savedMinor).toBe(0);
  });

  it("bugete: semafor la 79/80/100/101%, procent trunchiat, rămas negativ, avertizări, buget personal", async () => {
    const created = await call(P.createBudgetHandler, "/api/v1/budgets", {
      bearer: A.bearer,
      body: { categoryId: groceries, amount: "100,00", currency: "RON" },
    });
    expect(created.status).toBe(201);
    const budget = created.body.data as { id: string; amountMinor: number; warnPct: number };
    expect(budget.amountMinor).toBe(10000);
    expect(budget.warnPct).toBe(80);
    const general = idOf(
      await call(P.createBudgetHandler, "/api/v1/budgets", {
        bearer: A.bearer,
        body: { amountMinor: 1_000_000, currency: "RON" },
      }),
    );
    const exists = await call(P.createBudgetHandler, "/api/v1/budgets", {
      bearer: A.bearer,
      body: { categoryId: groceries, amountMinor: 1, currency: "RON" },
    });
    expect(exists.status).toBe(409);
    expect(exists.body.error?.reason).toBe("budget_exists");

    const spends: [string, number][] = [
      ["2026-07", 7900],
      ["2026-08", 8000],
      ["2026-09", 10000],
      ["2026-10", 10001],
    ];
    for (const [month, amountMinor] of spends) {
      await newTx(A, {
        accountId: accRon,
        amountMinor,
        occurredOn: `${month}-15`,
        categoryId: groceries,
      });
    }
    // Transferul și venitul nu contează; nici cheltuiala în EUR.
    await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: A.bearer,
      body: {
        fromAccountId: accRon,
        toAccountId: accRon2,
        amountMinor: 50000,
        occurredOn: "2026-07-16",
      },
    });
    await newTx(A, {
      accountId: accEur,
      amountMinor: 99999,
      occurredOn: "2026-07-17",
      categoryId: groceries,
    });

    const expected: Record<string, [string, number, number]> = {
      "2026-07": ["green", 79, 2100],
      "2026-08": ["yellow", 80, 2000],
      "2026-09": ["yellow", 100, 0],
      "2026-10": ["red", 100, -1],
    };
    for (const [month, [status, percent, remaining]] of Object.entries(expected)) {
      const r = await call(P.budgetStatusHandler, `/api/v1/budgets/status?month=${month}`, {
        bearer: A.bearer,
      });
      expect(r.status).toBe(200);
      expect(r.body.month).toBe(month);
      const s = (
        r.body.data as {
          id: string;
          status: string;
          percent: number;
          remainingMinor: number;
          spentMinor: number;
        }[]
      ).find((x) => x.id === budget.id)!;
      expect([s.status, s.percent, s.remainingMinor], month).toEqual([status, percent, remaining]);
      const alerts = r.body.alerts as { budgetId: string; status: string }[];
      expect(
        alerts.some((a) => a.budgetId === budget.id),
        month,
      ).toBe(status !== "green");
      expect(alerts.some((a) => a.budgetId === general)).toBe(false);
    }
    // Implicit = luna curentă (2026-10), roșu primul.
    const cur = await call(P.budgetStatusHandler, "/api/v1/budgets/status", { bearer: A.bearer });
    expect(cur.body.month).toBe("2026-10");
    expect((cur.body.alerts as { status: string }[])[0]?.status).toBe("red");

    // Bugetul personal al lui Cristi: invizibil Anei (404 / absent din liste).
    const personal = await call(P.createBudgetHandler, "/api/v1/budgets", {
      bearer: C.bearer,
      body: { amountMinor: 500, currency: "RON", scope: "personal" },
    });
    expect(personal.status).toBe(201);
    const pid = idOf(personal);
    expect((personal.body.data as { scope: string; userId: string | null }).userId).not.toBeNull();
    const hidden = await call(
      P.getBudgetHandler,
      `/api/v1/budgets/${pid}`,
      { bearer: A.bearer },
      pid,
    );
    expect(hidden.status).toBe(404);
    const listA = await call(P.listBudgetsHandler, "/api/v1/budgets", { bearer: A.bearer });
    expect((listA.body.data as { id: string }[]).some((b) => b.id === pid)).toBe(false);

    // PATCH (sumă, arhivare), includeArchived, DELETE.
    const patched = await call(
      P.patchBudgetHandler,
      `/api/v1/budgets/${general}`,
      { method: "PATCH", bearer: A.bearer, body: { warnPct: 50, archived: true } },
      general,
    );
    expect(
      (patched.body.data as { warnPct: number; archivedAt: string | null }).archivedAt,
    ).not.toBeNull();
    const active = await call(P.listBudgetsHandler, "/api/v1/budgets", { bearer: A.bearer });
    expect((active.body.data as { id: string }[]).some((b) => b.id === general)).toBe(false);
    const withArch = await call(P.listBudgetsHandler, "/api/v1/budgets?includeArchived=true", {
      bearer: A.bearer,
    });
    expect((withArch.body.data as { id: string }[]).some((b) => b.id === general)).toBe(true);
    const nothing = await call(
      P.patchBudgetHandler,
      `/api/v1/budgets/${general}`,
      { method: "PATCH", bearer: A.bearer, body: {} },
      general,
    );
    expect(nothing.status).toBe(400);
    const del = await call(
      P.deleteBudgetHandler,
      `/api/v1/budgets/${general}`,
      { method: "DELETE", bearer: A.bearer },
      general,
    );
    expect(del.status).toBe(204);
    const again = await call(
      P.deleteBudgetHandler,
      `/api/v1/budgets/${general}`,
      { method: "DELETE", bearer: A.bearer },
      general,
    );
    expect(again.status).toBe(404);
    const [audit] = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events where action = 'budget.deleted' and target_id = ${general}`;
    expect(audit?.metadata).toEqual({ scope: "household" });
  });

  it("obiective: contribuții (cheie obligatorie, reluare), achieved reversibil, sub 0 → 409, abandon/reluare, ștergere", async () => {
    const created = await call(P.createGoalHandler, "/api/v1/goals", {
      bearer: A.bearer,
      body: {
        name: "Vacanță",
        target: "1.000,00",
        currency: "RON",
        deadline: "2027-06-30",
        accountId: accRon2,
      },
    });
    expect(created.status).toBe(201);
    const goal = created.body.data as {
      id: string;
      targetMinor: number;
      status: string;
      progressPct: number;
    };
    expect([goal.targetMinor, goal.status, goal.progressPct]).toEqual([100000, "active", 0]);
    const g = goal.id;
    const path = `/api/v1/goals/${g}/contributions`;
    const contribute = (body: Record<string, unknown>, key: string | null, s = A) =>
      call(
        P.contributeGoalHandler,
        path,
        { bearer: s.bearer, body, headers: key === null ? {} : { "idempotency-key": key } },
        g,
      );

    const noKey = await contribute({ direction: "add", amountMinor: 100 }, null);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error?.fields?.["Idempotency-Key"]).toBeDefined();

    const k1 = newKey();
    const first = await contribute({ direction: "add", amountMinor: 99999 }, k1);
    expect(first.status).toBe(200);
    expect((first.body.data as { savedMinor: number; progressPct: number }).progressPct).toBe(99);
    const replay = await contribute({ direction: "add", amountMinor: 99999 }, k1);
    expect(replay.status).toBe(200);
    expect(replay.res.headers.get("idempotent-replay")).toBe("true");
    const reused = await contribute({ direction: "add", amountMinor: 1 }, k1);
    expect(reused.status).toBe(422);
    const afterReplay = await call(P.getGoalHandler, `/api/v1/goals/${g}`, { bearer: A.bearer }, g);
    expect((afterReplay.body.data as { savedMinor: number }).savedMinor).toBe(99999);

    const reach = await contribute({ direction: "add", amount: "0,01" }, newKey());
    expect((reach.body.data as { status: string; progressPct: number }).status).toBe("achieved");
    const back = await contribute({ direction: "withdraw", amountMinor: 1 }, newKey());
    expect((back.body.data as { status: string }).status).toBe("active");
    const negative = await contribute({ direction: "withdraw", amountMinor: 100000 }, newKey());
    expect(negative.status).toBe(409);
    expect(negative.body.error?.reason).toBe("goal_saved_negative");
    const overCap = await contribute(
      { direction: "add", amountMinor: 10_000_000_000_001 },
      newKey(),
    );
    expect(overCap.status).toBe(400);
    expect(overCap.body.error?.fields?.amountMinor).toBeDefined();
    const both = await contribute({ direction: "add", amountMinor: 1, amount: "1" }, newKey());
    expect(both.status).toBe(400);

    const abandoned = await call(
      P.abandonGoalHandler,
      `/api/v1/goals/${g}/abandon`,
      { method: "POST", bearer: A.bearer },
      g,
    );
    expect((abandoned.body.data as { status: string }).status).toBe("abandoned");
    const blocked = await contribute({ direction: "add", amountMinor: 1 }, newKey());
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.reason).toBe("goal_abandoned");
    const listAb = await call(P.listGoalsHandler, "/api/v1/goals?status=abandoned", {
      bearer: A.bearer,
    });
    expect((listAb.body.data as { id: string }[]).map((x) => x.id)).toContain(g);
    const resumed = await call(
      P.patchGoalHandler,
      `/api/v1/goals/${g}`,
      { method: "PATCH", bearer: A.bearer, body: { status: "active", targetMinor: 50000 } },
      g,
    );
    expect((resumed.body.data as { status: string; progressPct: number }).status).toBe("achieved");
    const badStatus = await call(
      P.patchGoalHandler,
      `/api/v1/goals/${g}`,
      { method: "PATCH", bearer: A.bearer, body: { status: "achieved" } },
      g,
    );
    expect(badStatus.status).toBe(400);
    const badCurrency = await call(P.createGoalHandler, "/api/v1/goals", {
      bearer: A.bearer,
      body: { name: "EUR pe RON", targetMinor: 1, currency: "EUR", accountId: accRon },
    });
    expect([404, 409, 400]).toContain(badCurrency.status);

    const del = await call(
      P.deleteGoalHandler,
      `/api/v1/goals/${g}`,
      { method: "DELETE", bearer: A.bearer },
      g,
    );
    expect(del.status).toBe(204);
    const gone = await call(P.getGoalHandler, `/api/v1/goals/${g}`, { bearer: A.bearer }, g);
    expect(gone.status).toBe(404);
    const [audit] = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events where action = 'goal.deleted' and target_id = ${g}`;
    expect(audit?.metadata).toEqual({ status: "achieved" });
  });

  it("idempotență pe POST /tags, /budgets, /goals: aceeași cheie → un singur rând, răspuns reluat", async () => {
    const cases: [Handler, string, Record<string, unknown>, string][] = [
      [P.createTagHandler, "/api/v1/tags", { name: "Idem tag" }, "tags"],
      [
        P.createBudgetHandler,
        "/api/v1/budgets",
        { amountMinor: 700, currency: "EUR", scope: "personal" },
        "budgets",
      ],
      [
        P.createGoalHandler,
        "/api/v1/goals",
        { name: "Idem goal", targetMinor: 5, currency: "USD" },
        "goals",
      ],
    ];
    for (const [handler, path, body, table] of cases) {
      const key = newKey();
      const count = async () =>
        (
          await fx.scratch.admin.unsafe<{ n: number }[]>(
            `select count(*)::int as n from finet.${table} where household_id = $1`,
            [HA],
          )
        )[0]!.n;
      const before = await count();
      const a = await call(handler, path, {
        bearer: A.bearer,
        body,
        headers: { "idempotency-key": key },
      });
      const b = await call(handler, path, {
        bearer: A.bearer,
        body,
        headers: { "idempotency-key": key },
      });
      expect(a.status, path).toBe(201);
      expect(b.status, path).toBe(201);
      expect(b.res.headers.get("idempotent-replay"), path).toBe("true");
      expect(b.body, path).toEqual(a.body);
      expect(await count(), path).toBe(before + 1);
      const other = await call(handler, path, {
        bearer: A.bearer,
        body: { ...body, name: "alt" },
        headers: { "idempotency-key": key },
      });
      expect(other.status, path).toBe(422);
    }
  });

  it("dashboard: pe monedă, comparație cu luna anterioară (0 → null), transferuri excluse, onboarding", async () => {
    const r = await call(P.dashboardHandler, "/api/v1/dashboard?month=2026-07", {
      bearer: A.bearer,
    });
    expect(r.status).toBe(200);
    const d = r.body.data as {
      month: string;
      previousMonth: string;
      currencies: {
        currency: string;
        totals: {
          incomeMinor: number;
          expenseMinor: number;
          netMinor: number;
          transactionCount: number;
        };
        previous: { expenseMinor: number };
        comparison: { expense: { diffMinor: number; percent: number | null } };
        byCategory: { categoryId: string | null; amountMinor: number }[];
        monthly: { month: string }[];
        daily: { date: string; expenseMinor: number }[];
      }[];
      onboarding: { hasAccount: boolean; hasBudget: boolean; hasGoal: boolean };
    };
    expect([d.month, d.previousMonth]).toEqual(["2026-07", "2026-06"]);
    expect(d.currencies.map((c) => c.currency)).toEqual(["EUR", "RON"]);
    const ron = d.currencies.find((c) => c.currency === "RON")!;
    // Iulie RON: doar cheltuiala de 7900 (transferul de 50000 nu contează).
    expect(ron.totals).toEqual({
      incomeMinor: 0,
      expenseMinor: 7900,
      netMinor: -7900,
      transactionCount: 1,
    });
    expect(ron.previous.expenseMinor).toBe(2400);
    expect(ron.comparison.expense).toEqual({ diffMinor: 5500, percent: 229 });
    expect(ron.byCategory[0]).toMatchObject({ categoryId: groceries, amountMinor: 7900 });
    expect(ron.monthly).toHaveLength(12);
    expect(ron.daily).toHaveLength(31);
    expect(ron.daily.find((p) => p.date === "2026-07-15")?.expenseMinor).toBe(7900);
    expect(ron.daily.find((p) => p.date === "2026-07-16")?.expenseMinor).toBe(0);
    const eur = d.currencies.find((c) => c.currency === "EUR")!;
    expect(eur.totals.expenseMinor).toBe(99999);
    expect(eur.comparison.expense.percent).toBeNull();
    expect(d.onboarding).toMatchObject({ hasAccount: true, hasBudget: true });

    // Venit + topCategories=1: o felie de top + „Altele”.
    await newTx(A, {
      accountId: accRon,
      type: "income",
      amountMinor: 20000,
      occurredOn: "2026-05-02",
      categoryId: salary,
    });
    const may = await call(P.dashboardHandler, "/api/v1/dashboard?month=2026-05&topCategories=1", {
      bearer: A.bearer,
    });
    const mayRon = (may.body.data as typeof d).currencies.find((c) => c.currency === "RON")!;
    expect(mayRon.totals).toMatchObject({
      incomeMinor: 20000,
      netMinor: 20000,
      transactionCount: 1,
    });

    // B are dashboard gol (izolare), cu onboarding nefinalizat.
    const rb = await call(P.dashboardHandler, "/api/v1/dashboard?month=2026-07", {
      bearer: B.bearer,
    });
    expect((rb.body.data as typeof d).currencies).toEqual([]);
  });

  it("raport lunar: totaluri, categorii cu subcategorii, top comercianți, bugete și obiective", async () => {
    await newTx(A, {
      accountId: accRon,
      amountMinor: 300,
      occurredOn: "2026-04-10",
      merchant: "Piața Mare",
      categoryId: groceries,
    });
    await newTx(A, {
      accountId: accRon,
      amountMinor: 200,
      occurredOn: "2026-04-11",
      merchant: " piața mare ",
      categoryId: groceries,
    });
    await newTx(A, {
      accountId: accRon,
      amountMinor: 100,
      occurredOn: "2026-04-12",
      merchant: "Chioșc",
    });
    const r = await call(P.monthlyReportHandler, "/api/v1/reports/monthly?month=2026-04", {
      bearer: A.bearer,
    });
    expect(r.status).toBe(200);
    const rep = r.body.data as {
      month: string;
      currencies: {
        currency: string;
        totals: { expenseMinor: number; transactionCount: number };
        byCategory: { categoryId: string | null; amountMinor: number; count: number }[];
        topMerchants: { merchant: string; amountMinor: number; count: number }[];
      }[];
      budgets: { id: string; month: string }[];
      goals: unknown[];
    };
    expect(rep.month).toBe("2026-04");
    const ron = rep.currencies.find((c) => c.currency === "RON")!;
    expect(ron.totals).toMatchObject({ expenseMinor: 600, transactionCount: 3 });
    expect(ron.byCategory.map((c) => [c.categoryId, c.amountMinor, c.count])).toEqual([
      [groceries, 500, 2],
      [null, 100, 1],
    ]);
    expect(ron.topMerchants[0]).toMatchObject({ amountMinor: 500, count: 2 });
    expect(rep.budgets.every((b) => b.month === "2026-04")).toBe(true);
    const rb = await call(P.monthlyReportHandler, "/api/v1/reports/monthly?month=2026-04", {
      bearer: B.bearer,
    });
    expect((rb.body.data as typeof rep).currencies).toEqual([]);
    expect((rb.body.data as typeof rep).budgets).toEqual([]);
  });

  it("export tranzacții: antete, BOM, coloane, escape, injection, filtre, dialect, izolare", async () => {
    await newTx(A, {
      accountId: accRon,
      amountMinor: 1234,
      occurredOn: "2026-03-05",
      merchant: "=cmd|' /C calc'!A0",
      description: 'Spune "da", apoi; virgulă, linie\r\nnouă',
      notes: "@SUM(A1)",
    });
    await newTx(A, {
      accountId: accRon,
      type: "income",
      amountMinor: 5,
      occurredOn: "2026-03-06",
      description: "-2+3",
    });
    // Date ale lui B în aceeași perioadă: nu apar.
    const accB = await newAccount(B, "Cont B export");
    await newTx(B, {
      accountId: accB,
      amountMinor: 777,
      occurredOn: "2026-03-05",
      merchant: "B-ul",
    });

    const path = "/api/v1/exports/transactions.csv?dateFrom=2026-03-01&dateTo=2026-03-31";
    const r = await call(P.exportTransactionsHandler, path, { bearer: A.bearer });
    expect(r.status).toBe(200);
    expect(r.res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.res.headers.get("content-disposition")).toBe(
      'attachment; filename="finet-tranzactii.csv"',
    );
    expect(r.res.headers.get("cache-control")).toBe("no-store");
    expect(r.res.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await r.res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text.startsWith(BOM)).toBe(true);
    const lines = r.text.slice(1).split("\r\n");
    expect(lines[0]).toBe(TRANSACTION_COLUMNS.join(","));
    expect(r.text).not.toContain("B-ul");
    expect(r.text).not.toContain("777");
    expect(r.text).toContain(`,'=cmd|' /C calc'!A0,`);
    expect(r.text).toContain(`"Spune ""da"", apoi; virgulă, linie\r\nnouă"`);
    expect(r.text).toContain("'@SUM(A1)");
    expect(r.text).toContain("'-2+3");
    expect(r.text).toContain(",1234,RON,12.34,");
    // Două rânduri de date + antet + linie goală finală (CRLF) + linia din interiorul ghilimelelor.
    expect(r.text.endsWith("\r\n")).toBe(true);

    const income = await call(P.exportTransactionsHandler, `${path}&type=income`, {
      bearer: A.bearer,
    });
    expect(income.text).not.toContain("1234");
    expect(income.text).toContain("'-2+3");

    const ro = await call(P.exportTransactionsHandler, `${path}&dialect=ro`, { bearer: A.bearer });
    expect(ro.text.slice(1).split("\r\n")[0]).toBe(TRANSACTION_COLUMNS.join(";"));
    expect(ro.text).toContain(";1234;RON;12,34;");

    const rb = await call(P.exportTransactionsHandler, path, { bearer: B.bearer });
    expect(rb.text).toContain("B-ul");
    expect(rb.text).not.toContain("1234");

    const badDialect = await call(P.exportTransactionsHandler, `${path}&dialect=excel`, {
      bearer: A.bearer,
    });
    expect(badDialect.status).toBe(400);
    expect(badDialect.body.error?.fields?.dialect).toBeDefined();
  });

  it("export tranzacții: plafon de rânduri → 409 JSON (fără conținut parțial); flux pe pagini = același conținut", async () => {
    const path = "/api/v1/exports/transactions.csv?dateFrom=2026-03-01&dateTo=2026-03-31";
    const capped = await callWith({ ...env, exportMaxRows: 1 }, P.exportTransactionsHandler, path, {
      bearer: A.bearer,
    });
    expect(capped.status).toBe(409);
    expect(capped.res.headers.get("content-type")).toContain("application/json");
    expect(capped.body.error?.reason).toBe("export_too_large");
    const atCap = await callWith({ ...env, exportMaxRows: 2 }, P.exportTransactionsHandler, path, {
      bearer: A.bearer,
    });
    expect(atCap.status).toBe(200);
    const full = await call(P.exportTransactionsHandler, path, { bearer: A.bearer });
    const paged = await callWith({ ...env, exportPageSize: 1 }, P.exportTransactionsHandler, path, {
      bearer: A.bearer,
    });
    expect(paged.text).toBe(full.text);
    expect(atCap.text).toBe(full.text);
    // Clientul care închide fluxul după primul fragment: fără erori, fără scrieri după închidere.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await P.exportTransactionsHandler(apiRequest(path, { bearer: A.bearer }), {
      ...env,
      exportPageSize: 1,
    });
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 200));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("export obiective și bugete: antete, conținut, injection în nume, izolare, luna", async () => {
    await call(P.createGoalHandler, "/api/v1/goals", {
      bearer: A.bearer,
      body: { name: "+Fond urgență", targetMinor: 250050, currency: "RON" },
    });
    const goals = await call(P.exportGoalsHandler, "/api/v1/exports/goals.csv", {
      bearer: A.bearer,
    });
    expect(goals.status).toBe(200);
    expect(goals.res.headers.get("content-disposition")).toBe(
      'attachment; filename="finet-obiective.csv"',
    );
    expect(goals.text.startsWith(BOM)).toBe(true);
    expect(goals.text).toContain(",'+Fond urgență,active,RON,250050,2500.50,0,0.00,0,");
    const goalsB = await call(P.exportGoalsHandler, "/api/v1/exports/goals.csv", {
      bearer: B.bearer,
    });
    expect(
      goalsB.text
        .slice(1)
        .split("\r\n")
        .filter((l) => l !== ""),
    ).toHaveLength(1);

    const budgets = await call(
      P.exportBudgetsHandler,
      "/api/v1/exports/budgets.csv?month=2026-08&dialect=ro",
      {
        bearer: A.bearer,
      },
    );
    expect(budgets.res.headers.get("content-disposition")).toBe(
      'attachment; filename="finet-bugete.csv"',
    );
    expect(budgets.text).toContain(";2026-08;household;");
    expect(budgets.text).toContain(";RON;10000;100,00;80;8000;80,00;2000;20,00;80;yellow");
    const budgetsB = await call(P.exportBudgetsHandler, "/api/v1/exports/budgets.csv", {
      bearer: B.bearer,
    });
    expect(
      budgetsB.text
        .slice(1)
        .split("\r\n")
        .filter((l) => l !== ""),
    ).toHaveLength(1);
  });

  it("export: audit fără date financiare (tip + număr de rânduri) și rate limit propriu (429)", async () => {
    await fx.scratch.admin`delete from finet.audit_events where action = 'export.downloaded'`;
    await call(
      P.exportTransactionsHandler,
      "/api/v1/exports/transactions.csv?dateFrom=2026-03-01&dateTo=2026-03-31",
      {
        bearer: A.bearer,
      },
    );
    await call(P.exportGoalsHandler, "/api/v1/exports/goals.csv", { bearer: A.bearer });
    await call(P.exportBudgetsHandler, "/api/v1/exports/budgets.csv?month=2026-08", {
      bearer: A.bearer,
    });
    const rows = await fx.scratch.admin<
      { metadata: Record<string, unknown>; household_id: string; target_type: string | null }[]
    >`
      select metadata, household_id, target_type from finet.audit_events
       where action = 'export.downloaded' order by created_at, id`;
    expect(rows.map((r) => r.metadata.kind).sort()).toEqual(["budgets", "goals", "transactions"]);
    for (const r of rows) {
      expect(Object.keys(r.metadata).sort()).toEqual(["kind", "rows"]);
      expect(typeof r.metadata.rows).toBe("number");
      expect(r.household_id).toBe(HA);
    }
    expect(rows.find((r) => r.metadata.kind === "transactions")?.metadata.rows).toBe(2);

    const strict = {
      ...env,
      limits: { ...env.limits, exports: { max: 2, windowSeconds: 60 } },
      now: () => clock + 9_999_999,
    };
    const get = () =>
      callWith(strict, P.exportGoalsHandler, "/api/v1/exports/goals.csv", { bearer: C.bearer });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const third = await get();
    expect(third.status).toBe(429);
    expect(third.res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(third.body.error?.code).toBe("rate_limited");
    // Exportul refuzat nu e auditat; alte citiri nu sunt limitate.
    const dash = await callWith(strict, P.dashboardHandler, "/api/v1/dashboard", {
      bearer: C.bearer,
    });
    expect(dash.status).toBe(200);
  });

  it("export cu cookie: doar `Sec-Fetch-Site` same-origin/none; cross-site, same-site, lipsă → 403; bearer permis", async () => {
    const exports: [Handler, string][] = [
      [P.exportTransactionsHandler, "/api/v1/exports/transactions.csv"],
      [P.exportGoalsHandler, "/api/v1/exports/goals.csv"],
      [P.exportBudgetsHandler, "/api/v1/exports/budgets.csv"],
    ];
    for (const [handler, path] of exports) {
      // Refuzurile vin înaintea rate limit-ului și a oricărei citiri de date.
      for (const site of ["cross-site", "same-site", ""]) {
        const r = await call(handler, path, {
          cookie: D.cookie,
          headers: { "sec-fetch-site": site },
        });
        expect(r.status, `${path} ${site || "lipsă"}`).toBe(403);
        expect(r.body.error?.code, path).toBe("forbidden");
        expect(r.res.headers.get("content-type"), path).not.toContain("text/csv");
      }
      for (const site of ["same-origin", "none"]) {
        const r = await call(handler, path, {
          cookie: D.cookie,
          headers: { "sec-fetch-site": site },
        });
        expect(r.status, `${path} ${site}`).toBe(200);
      }
      // Bearer (aplicația mobilă, clienți non-browser): fără antet → permis.
      const bearer = await call(handler, path, { bearer: D.bearer });
      expect(bearer.status, `${path} bearer`).toBe(200);
    }
  });

  it("rate limit pe mutațiile noi (429) și plafonul sumelor: peste 10^13 → 400; total peste 2^53 → 422", async () => {
    const strict = {
      ...env,
      limits: { mutations: { max: 1, windowSeconds: 60 } },
      now: () => clock + 5_555_555,
    };
    const post = (n: number) =>
      callWith(strict, P.createTagHandler, "/api/v1/tags", {
        bearer: D.bearer,
        body: { name: `RL ${n}` },
      });
    expect((await post(1)).status).toBe(201);
    expect((await post(2)).status).toBe(429);

    const big = await call(P.createBudgetHandler, "/api/v1/budgets", {
      bearer: D.bearer,
      body: { amountMinor: 10_000_000_000_001, currency: "RON" },
    });
    expect(big.status).toBe(400);
    expect(big.body.error?.fields?.amountMinor).toBeDefined();
    const atCap = await call(P.createGoalHandler, "/api/v1/goals", {
      bearer: D.bearer,
      body: { name: "Plafon", targetMinor: 10_000_000_000_000, currency: "RON" },
    });
    expect(atCap.status).toBe(201);

    // 1000 de cheltuieli la plafon pe două conturi (inserate direct): totalul lunii > 2^53 − 1.
    const accD1 = await newAccount(D, "D1");
    const accD2 = await newAccount(D, "D2");
    const [hd] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.accounts where id = ${accD1}`;
    for (const acc of [accD1, accD2]) {
      await fx.scratch.admin`
        insert into finet.transactions (household_id, account_id, type, amount_minor, currency, occurred_on)
        select ${hd!.household_id}, ${acc}, 'expense', 10000000000000, 'RON', '2026-10-02'
          from generate_series(1, 500)`;
    }
    for (const [handler, path] of [
      [P.dashboardHandler, "/api/v1/dashboard"],
      [P.monthlyReportHandler, "/api/v1/reports/monthly"],
    ] as [Handler, string][]) {
      const r = await call(handler, path, { bearer: D.bearer });
      expect(r.status, path).toBe(422);
      expect(r.body.error?.code).toBe("amount_out_of_range");
    }
  });

  it("evenimentele noi de utilizare se acceptă (cu consimțământ), fără câmpuri în plus", async () => {
    await call(M.putConsentsHandler, "/api/v1/me/consents", {
      method: "PUT",
      bearer: A.bearer,
      body: { usageStats: true },
    });
    const iso = new Date(clock).toISOString();
    const names = [
      "dashboard_viewed",
      "budget_created",
      "goal_created",
      "goal_contribution_added",
      "tag_created",
      "report_viewed",
      "export_downloaded",
    ];
    const ok = await call(M.appEventsHandler, "/api/v1/app/events", {
      bearer: A.bearer,
      body: { events: names.map((name) => ({ name, occurredAt: iso })) },
    });
    expect(ok.status).toBe(204);
    const stored = await fx.scratch.admin<{ name: string }[]>`
      select name from finet.app_events where name = any(${names}) order by name`;
    expect(stored.map((r) => r.name)).toEqual([...names].sort());
    const extra = await call(M.appEventsHandler, "/api/v1/app/events", {
      bearer: A.bearer,
      body: { events: [{ name: "export_downloaded", occurredAt: iso, rows: 12 }] },
    });
    expect(extra.status).toBe(400);
  });
});
