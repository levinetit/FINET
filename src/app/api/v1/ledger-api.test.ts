import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { addMemberByEmail, createUserWithHousehold } from "@/modules/auth/users.service";
import { systemCategoryId } from "@/modules/ledger/testing";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as M from "./_lib/me-handlers";
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
 * Acceptarea Fazei 2 prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`):
 * 401, izolarea între gospodării (404), validarea (400 cu `fields`), 415/413, cursorul, soldurile
 * după tranzacții și transferuri (inclusiv rollback), CSRF pe cookie și bearer.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1 registru pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let B: Sessions;
  let C: Sessions;
  let HA: string;
  let HB: string;
  let groceries: string;
  const PASS = { a: "parola-ana-api-123", b: "parola-bogdan-api-1", c: "parola-cristi-api-1" };

  async function call(
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: (string | boolean)[]
  ): Promise<{ status: number; body: Awaited<ReturnType<typeof readJson>>; res: Response }> {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      env,
      ...rest,
    );
    await assertContract(handler, res);
    return { status: res.status, body: await readJson(res.clone()), res };
  }

  async function newAccount(s: Sessions, name: string, extra: Record<string, unknown> = {}) {
    const r = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: s.bearer,
      body: { name, type: "bank", currency: "RON", ...extra },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body.data as { id: string }).id;
  }

  async function balanceOf(s: Sessions, id: string): Promise<number> {
    const r = await call(L.getAccountHandler, `/api/v1/accounts/${id}`, { bearer: s.bearer }, id);
    return (r.body.data as { balanceMinor: number }).balanceMinor;
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_ledger_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
    };
    const a = await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASS.a,
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
    const b = await createUserWithHousehold(fx.db, {
      email: "bogdan@exemplu.ro",
      name: "Bogdan",
      password: PASS.b,
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
    await createUserWithHousehold(fx.db, {
      email: "cristi@exemplu.ro",
      name: "Cristi",
      password: PASS.c,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    HA = a.householdId!;
    HB = b.householdId!;
    // Cristi are gospodăria lui personală (mai veche), deci API-ul lucrează în aceea; îl adăugăm
    // în HA doar pentru lista de gospodării.
    await addMemberByEmail(fx.db, HA, "cristi@exemplu.ro", "member");
    A = await sessionsFor(env, "ana@exemplu.ro", PASS.a);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS.b);
    C = await sessionsFor(env, "cristi@exemplu.ro", PASS.c);
    groceries = await systemCategoryId(fx.scratch.admin, "expense.groceries");
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune: 401 pe FIECARE endpoint", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const cases: [Handler, string, ApiInit, ...(string | boolean)[]][] = [
      [L.listHouseholdsHandler, "/api/v1/households", {}],
      [L.getHouseholdHandler, `/api/v1/households/${id}`, {}, id],
      [L.listAccountsHandler, "/api/v1/accounts", {}],
      [L.createAccountHandler, "/api/v1/accounts", { body: {} }],
      [L.getAccountHandler, `/api/v1/accounts/${id}`, {}, id],
      [L.patchAccountHandler, `/api/v1/accounts/${id}`, { method: "PATCH", body: {} }, id],
      [L.deleteAccountHandler, `/api/v1/accounts/${id}`, { method: "DELETE" }, id],
      [L.archiveAccountHandler, `/api/v1/accounts/${id}/archive`, { method: "POST" }, id, true],
      [L.archiveAccountHandler, `/api/v1/accounts/${id}/unarchive`, { method: "POST" }, id, false],
      [L.listCategoriesHandler, "/api/v1/categories", {}],
      [L.createCategoryHandler, "/api/v1/categories", { body: {} }],
      [L.getCategoryHandler, `/api/v1/categories/${id}`, {}, id],
      [L.patchCategoryHandler, `/api/v1/categories/${id}`, { method: "PATCH", body: {} }, id],
      [L.deleteCategoryHandler, `/api/v1/categories/${id}`, { method: "DELETE" }, id],
      [L.setCategoryHiddenHandler, `/api/v1/categories/${id}/hide`, { method: "POST" }, id, true],
      [
        L.setCategoryHiddenHandler,
        `/api/v1/categories/${id}/unhide`,
        { method: "POST" },
        id,
        false,
      ],
      [L.listTransactionsHandler, "/api/v1/transactions", {}],
      [L.createTransactionHandler, "/api/v1/transactions", { body: {} }],
      [L.getTransactionHandler, `/api/v1/transactions/${id}`, {}, id],
      [L.patchTransactionHandler, `/api/v1/transactions/${id}`, { method: "PATCH", body: {} }, id],
      [L.deleteTransactionHandler, `/api/v1/transactions/${id}`, { method: "DELETE" }, id],
      [L.createTransferHandler, "/api/v1/transfers", { body: {} }],
      [L.getTransferHandler, `/api/v1/transfers/${id}`, {}, id],
      [L.patchTransferHandler, `/api/v1/transfers/${id}`, { method: "PATCH", body: {} }, id],
      [L.deleteTransferHandler, `/api/v1/transfers/${id}`, { method: "DELETE" }, id],
      [M.getConsentsHandler, "/api/v1/me/consents", {}],
      [M.putConsentsHandler, "/api/v1/me/consents", { method: "PUT", body: { usageStats: true } }],
      [M.appEventsHandler, "/api/v1/app/events", { body: { events: [] } }],
    ];
    for (const [handler, path, init, ...rest] of cases) {
      const r = await call(handler, path, init, ...rest);
      expect(r.status, path).toBe(401);
      expect(r.body.error?.code).toBe("unauthenticated");
      const forged = await call(handler, path, { ...init, bearer: "inventat" }, ...rest);
      expect(forged.status, path).toBe(401);
    }
  });

  it("FIECARE mutație: `householdId` în corp → 400 cu `fields`; cookie fără Origin → 403", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const acc = await newAccount(A, "Validare toate");
    const tx = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: A.bearer,
      body: { accountId: acc, type: "expense", amountMinor: 1, occurredOn: "2026-10-01" },
    });
    const txId = (tx.body.data as { id: string }).id;
    const cat = await call(L.createCategoryHandler, "/api/v1/categories", {
      bearer: A.bearer,
      body: { name: "Validare", kind: "expense" },
    });
    const catId = (cat.body.data as { id: string }).id;
    const acc2 = await newAccount(A, "Validare 2");
    const tr = await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: A.bearer,
      body: { fromAccountId: acc, toAccountId: acc2, amountMinor: 1, occurredOn: "2026-10-01" },
    });
    const trId = (tr.body.data as { id: string }).id;
    const withBody: [Handler, string, string, Record<string, unknown>, ...string[]][] = [
      [
        L.createAccountHandler,
        "POST",
        "/api/v1/accounts",
        { name: "x", type: "cash", currency: "RON" },
      ],
      [L.patchAccountHandler, "PATCH", "/api/v1/accounts/a", { name: "y" }, acc],
      [L.createCategoryHandler, "POST", "/api/v1/categories", { name: "x", kind: "expense" }],
      [L.patchCategoryHandler, "PATCH", "/api/v1/categories/c", { name: "y" }, catId],
      [
        L.createTransactionHandler,
        "POST",
        "/api/v1/transactions",
        { accountId: acc, type: "expense", amountMinor: 1, occurredOn: "2026-10-01" },
      ],
      [L.patchTransactionHandler, "PATCH", "/api/v1/transactions/t", { amountMinor: 2 }, txId],
      [
        L.createTransferHandler,
        "POST",
        "/api/v1/transfers",
        { fromAccountId: acc, toAccountId: acc2, amountMinor: 1, occurredOn: "2026-10-01" },
      ],
      [L.patchTransferHandler, "PATCH", "/api/v1/transfers/g", { amountMinor: 2 }, trId],
      [M.patchMeHandler, "PATCH", "/api/v1/me", { name: "Ana" }],
      [M.putConsentsHandler, "PUT", "/api/v1/me/consents", { usageStats: true }],
    ];
    for (const [handler, method, path, body, ...rest] of withBody) {
      const r = await call(
        handler,
        path,
        { bearer: A.bearer, method, body: { ...body, householdId: HB } },
        ...rest,
      );
      expect(r.status, path).toBe(400);
      expect(r.body.error?.fields?.householdId, path).toBe("Câmp nepermis.");
    }
    const events = await call(M.appEventsHandler, "/api/v1/app/events", {
      bearer: A.bearer,
      body: {
        events: [{ name: "app_open", occurredAt: new Date(clock).toISOString(), householdId: HB }],
      },
    });
    expect(events.status).toBe(400);
    expect(events.body.error?.fields?.["events.0.householdId"]).toBe("Câmp nepermis.");

    // CSRF: aceleași mutații (și cele fără corp) cu cookie, dar fără Origin → 403, nimic scris.
    const mutations: [
      Handler,
      string,
      string,
      Record<string, unknown> | undefined,
      ...(string | boolean)[],
    ][] = [
      ...withBody.map(
        ([h, m, p, b, ...r]) =>
          [h, m, p, b, ...r] as [Handler, string, string, Record<string, unknown>, ...string[]],
      ),
      [L.deleteAccountHandler, "DELETE", "/api/v1/accounts/a", undefined, id],
      [L.archiveAccountHandler, "POST", "/api/v1/accounts/a/archive", undefined, acc, true],
      [L.archiveAccountHandler, "POST", "/api/v1/accounts/a/unarchive", undefined, acc, false],
      [L.deleteCategoryHandler, "DELETE", "/api/v1/categories/c", undefined, catId],
      [L.setCategoryHiddenHandler, "POST", "/api/v1/categories/c/hide", undefined, catId, true],
      [L.setCategoryHiddenHandler, "POST", "/api/v1/categories/c/unhide", undefined, catId, false],
      [L.deleteTransactionHandler, "DELETE", "/api/v1/transactions/t", undefined, txId],
      [L.deleteTransferHandler, "DELETE", "/api/v1/transfers/g", undefined, trId],
      [
        M.appEventsHandler,
        "POST",
        "/api/v1/app/events",
        { events: [{ name: "app_open", occurredAt: new Date(clock).toISOString() }] },
      ],
      [M.revokeOthersHandler, "POST", "/api/v1/me/sessions/revoke-others", undefined],
    ];
    for (const [handler, method, path, body, ...rest] of mutations) {
      const r = await call(
        handler,
        path,
        { cookie: A.cookie, headers: { origin: "" }, method, body },
        ...rest,
      );
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect((await call(L.getTransactionHandler, "", { bearer: A.bearer }, txId)).status).toBe(200);
    expect((await call(L.getTransferHandler, "", { bearer: A.bearer }, trId)).status).toBe(200);
  });

  it("gospodăriile: doar ale mele, rolul, membrii fără emailuri; străină → 404", async () => {
    const list = await call(L.listHouseholdsHandler, "/api/v1/households", { cookie: A.cookie });
    expect(list.status).toBe(200);
    const data = list.body.data as { id: string; role: string; current: boolean }[];
    expect(data).toEqual([expect.objectContaining({ id: HA, role: "owner", current: true })]);

    const cList = await call(L.listHouseholdsHandler, "/api/v1/households", { bearer: C.bearer });
    const cData = cList.body.data as { id: string; role: string; current: boolean }[];
    expect(cData).toHaveLength(2);
    expect(cData.find((h) => h.id === HA)).toMatchObject({ role: "member", current: false });

    const detail = await call(
      L.getHouseholdHandler,
      `/api/v1/households/${HA}`,
      { bearer: A.bearer },
      HA,
    );
    expect(detail.status).toBe(200);
    const members = (detail.body.data as { members: { name: string; role: string }[] }).members;
    expect(members.map((m) => m.name).sort()).toEqual(["Ana", "Cristi"]);
    expect(JSON.stringify(detail.body)).not.toContain("@");

    for (const id of [HB, "nu-e-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const r = await call(
        L.getHouseholdHandler,
        `/api/v1/households/${id}`,
        { bearer: A.bearer },
        id,
      );
      expect(r.status, id).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    const unknown = await call(L.listHouseholdsHandler, "/api/v1/households?x=1", {
      bearer: A.bearer,
    });
    expect(unknown.status).toBe(400);
  });

  it("conturi: CRUD, arhivare, ștergere doar goale, totaluri pe monedă", async () => {
    const id = await newAccount(A, "Card ING", { openingBalanceMinor: 10_000 });
    await newAccount(A, "Euro", { currency: "EUR", openingBalance: "50,25" });
    const list = await call(L.listAccountsHandler, "/api/v1/accounts", { cookie: A.cookie });
    expect(list.status).toBe(200);
    expect(list.body.totals).toEqual(
      expect.arrayContaining([
        { amountMinor: 5025, currency: "EUR" },
        expect.objectContaining({ currency: "RON" }),
      ]),
    );
    const patched = await call(
      L.patchAccountHandler,
      `/api/v1/accounts/${id}`,
      { cookie: A.cookie, method: "PATCH", body: { name: "Card ING Ana" } },
      id,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ name: "Card ING Ana", balanceMinor: 10_000 });

    // Fără corp și fără Content-Type: acceptat (archive/unarchive).
    const arch = await call(
      L.archiveAccountHandler,
      `/api/v1/accounts/${id}/archive`,
      { bearer: A.bearer, method: "POST" },
      id,
      true,
    );
    expect(arch.status).toBe(200);
    expect(arch.body.data).toMatchObject({ archived: true });
    const hidden = await call(L.listAccountsHandler, "/api/v1/accounts", { bearer: A.bearer });
    expect((hidden.body.data as { id: string }[]).map((a) => a.id)).not.toContain(id);
    const all = await call(L.listAccountsHandler, "/api/v1/accounts?includeArchived=true", {
      bearer: A.bearer,
    });
    expect((all.body.data as { id: string }[]).map((a) => a.id)).toContain(id);
    const un = await call(
      L.archiveAccountHandler,
      `/api/v1/accounts/${id}/unarchive`,
      { bearer: A.bearer, method: "POST" },
      id,
      false,
    );
    expect(un.body.data).toMatchObject({ archived: false });

    const empty = await newAccount(A, "De șters");
    const del = await call(
      L.deleteAccountHandler,
      `/api/v1/accounts/${empty}`,
      { bearer: A.bearer, method: "DELETE" },
      empty,
    );
    expect(del.status).toBe(204);
    expect(await del.res.text()).toBe("");

    await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: A.bearer,
      body: { accountId: id, type: "expense", amountMinor: 100, occurredOn: "2026-10-01" },
    });
    const notEmpty = await call(
      L.deleteAccountHandler,
      `/api/v1/accounts/${id}`,
      { bearer: A.bearer, method: "DELETE" },
      id,
    );
    expect(notEmpty.status).toBe(409);
    expect(notEmpty.body.error).toMatchObject({ code: "conflict", reason: "account_not_empty" });
  });

  it("validare: 400 cu `fields`, fără ecou; householdId în corp respins; 415, 413, JSON invalid", async () => {
    const bad = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "X", type: "bank", currency: "RON", householdId: HB, openingBalanceMinor: 1.5 },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe("invalid_request");
    expect(bad.body.error?.fields).toMatchObject({
      householdId: "Câmp nepermis.",
      openingBalanceMinor: expect.any(String),
    });
    expect(JSON.stringify(bad.body)).not.toContain(HB);

    const text = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      rawBody: "name=x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(text.status).toBe(415);
    expect(text.body.error?.code).toBe("unsupported_media_type");

    const big = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "x".repeat(20_000) },
    });
    expect(big.status).toBe(413);

    const broken = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      rawBody: "{nu e json",
      headers: { "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);

    const textOnArchive = await call(
      L.archiveAccountHandler,
      "/api/v1/accounts/x/archive",
      {
        bearer: A.bearer,
        method: "POST",
        rawBody: "abc",
        headers: { "content-type": "text/plain" },
      },
      "00000000-0000-4000-8000-000000000000",
      true,
    );
    expect(textOnArchive.status).toBe(415);

    const query = await call(L.listTransactionsHandler, "/api/v1/transactions?limit=abc&foo=1", {
      bearer: A.bearer,
    });
    expect(query.status).toBe(400);
    expect(query.body.error?.fields).toMatchObject({
      limit: "Valoare invalidă.",
      foo: "Parametru nepermis.",
    });
  });

  it("CSRF: mutație cu cookie fără Origin sau cu Origin străin → 403; bearer fără Origin → OK", async () => {
    for (const origin of ["", "https://atacator.example"]) {
      const r = await call(L.createAccountHandler, "/api/v1/accounts", {
        cookie: A.cookie,
        headers: { origin },
        body: { name: `CSRF ${origin}`, type: "cash", currency: "RON" },
      });
      expect(r.status, origin).toBe(403);
    }
    const ok = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "Bearer fără Origin", type: "cash", currency: "RON" },
    });
    expect(ok.status).toBe(201);
    const rows = await fx.scratch.admin`select 1 from finet.accounts where name like 'CSRF%'`;
    expect(rows).toHaveLength(0);
  });

  it("izolare: A nu vede și nu modifică resursele lui B (404 uniform), nici prin referințe", async () => {
    const bAcc = await newAccount(B, "Contul lui B");
    const bAcc2 = await newAccount(B, "Contul 2 al lui B");
    const bTx = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: B.bearer,
      body: { accountId: bAcc, type: "income", amountMinor: 5000, occurredOn: "2026-10-02" },
    });
    const bTxId = (bTx.body.data as { id: string }).id;
    const bCat = await call(L.createCategoryHandler, "/api/v1/categories", {
      bearer: B.bearer,
      body: { name: "Categoria lui B", kind: "expense" },
    });
    const bCatId = (bCat.body.data as { id: string }).id;
    const bTr = await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: B.bearer,
      body: { fromAccountId: bAcc, toAccountId: bAcc2, amountMinor: 100, occurredOn: "2026-10-02" },
    });
    expect(bTr.status).toBe(201);
    const bTrId = (bTr.body.data as { id: string }).id;

    const s = { bearer: A.bearer };
    const attempts: [Handler, string, ApiInit, ...(string | boolean)[]][] = [
      [L.getAccountHandler, "", s, bAcc],
      [L.patchAccountHandler, "", { ...s, method: "PATCH", body: { name: "furat" } }, bAcc],
      [L.deleteAccountHandler, "", { ...s, method: "DELETE" }, bAcc],
      [L.archiveAccountHandler, "", { ...s, method: "POST" }, bAcc, true],
      [L.getTransactionHandler, "", s, bTxId],
      [L.patchTransactionHandler, "", { ...s, method: "PATCH", body: { amountMinor: 1 } }, bTxId],
      [L.deleteTransactionHandler, "", { ...s, method: "DELETE" }, bTxId],
      [L.getCategoryHandler, "", s, bCatId],
      [L.patchCategoryHandler, "", { ...s, method: "PATCH", body: { name: "furat" } }, bCatId],
      [L.deleteCategoryHandler, "", { ...s, method: "DELETE" }, bCatId],
      [L.setCategoryHiddenHandler, "", { ...s, method: "POST" }, bCatId, true],
      [L.getTransferHandler, "", s, bTrId],
      [L.patchTransferHandler, "", { ...s, method: "PATCH", body: { amountMinor: 1 } }, bTrId],
      [L.deleteTransferHandler, "", { ...s, method: "DELETE" }, bTrId],
      [
        L.createTransactionHandler,
        "",
        {
          ...s,
          body: { accountId: bAcc, type: "expense", amountMinor: 1, occurredOn: "2026-10-02" },
        },
      ],
      [
        L.createTransferHandler,
        "",
        {
          ...s,
          body: {
            fromAccountId: bAcc,
            toAccountId: bAcc2,
            amountMinor: 1,
            occurredOn: "2026-10-02",
          },
        },
      ],
    ];
    for (const [handler, , init, ...rest] of attempts) {
      const r = await call(handler, "/api/v1/x", init, ...rest);
      expect(r.status, `${handler.name} ${JSON.stringify(r.body)}`).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    // Nimic din HB nu apare în listele lui A, iar datele lui B au rămas neschimbate.
    const aTx = await call(L.listTransactionsHandler, "/api/v1/transactions?limit=100", s);
    expect(JSON.stringify(aTx.body)).not.toContain(bTxId);
    const aAcc = await call(L.listAccountsHandler, "/api/v1/accounts", s);
    expect(JSON.stringify(aAcc.body)).not.toContain(bAcc);
    const aCat = await call(L.listCategoriesHandler, "/api/v1/categories?includeHidden=true", s);
    expect(JSON.stringify(aCat.body)).not.toContain(bCatId);
    expect(await balanceOf(B, bAcc)).toBe(5000 - 100);
    const [count] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where household_id = ${HB}`;
    expect(count?.n).toBe(3);
  });

  it("solduri după venituri, cheltuieli și transferuri; transferul eșuat nu lasă nimic (rollback)", async () => {
    const cur = await newAccount(A, "Curent solduri", { openingBalanceMinor: 100_000 });
    const sav = await newAccount(A, "Economii solduri");
    const eur = await newAccount(A, "EUR solduri", { currency: "EUR" });
    const post = (body: Record<string, unknown>) =>
      call(L.createTransactionHandler, "/api/v1/transactions", { bearer: A.bearer, body });
    expect(
      (
        await post({
          accountId: cur,
          type: "income",
          amountMinor: 250_000,
          occurredOn: "2026-10-03",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post({
          accountId: cur,
          type: "expense",
          amount: "1.234,56",
          occurredOn: "2026-10-04",
          categoryId: groceries,
        })
      ).status,
    ).toBe(201);
    const tr = await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: A.bearer,
      body: { fromAccountId: cur, toAccountId: sav, amountMinor: 50_000, occurredOn: "2026-10-05" },
    });
    expect(tr.status).toBe(201);
    const fx2 = await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: A.bearer,
      body: {
        fromAccountId: cur,
        toAccountId: eur,
        amountFromMinor: 49_750,
        amountToMinor: 1_000,
        occurredOn: "2026-10-05",
      },
    });
    expect(fx2.status).toBe(201);
    expect(await balanceOf(A, cur)).toBe(100_000 + 250_000 - 123_456 - 50_000 - 49_750);
    expect(await balanceOf(A, sav)).toBe(50_000);
    expect(await balanceOf(A, eur)).toBe(1_000);

    // Transfer spre un cont arhivat: 409, niciun rând nou, soldurile neschimbate.
    await call(L.archiveAccountHandler, "", { bearer: A.bearer, method: "POST" }, sav, true);
    const [before] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where household_id = ${HA}`;
    const failed = await call(L.createTransferHandler, "/api/v1/transfers", {
      bearer: A.bearer,
      body: { fromAccountId: cur, toAccountId: sav, amountMinor: 10, occurredOn: "2026-10-06" },
    });
    expect(failed.status).toBe(409);
    expect(failed.body.error?.reason).toBe("account_archived");
    const [after] = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.transactions where household_id = ${HA}`;
    expect(after?.n).toBe(before?.n);
    expect(await balanceOf(A, cur)).toBe(126_794);
    await call(L.archiveAccountHandler, "", { bearer: A.bearer, method: "POST" }, sav, false);

    // Transferul: GET, PATCH, DELETE (ambele rânduri dispar, soldurile revin).
    const trId = (tr.body.data as { id: string }).id;
    const got = await call(L.getTransferHandler, "", { bearer: A.bearer }, trId);
    expect(got.body.data).toMatchObject({
      id: trId,
      from: { accountId: cur, amountMinor: 50_000 },
    });
    const patched = await call(
      L.patchTransferHandler,
      "",
      { bearer: A.bearer, method: "PATCH", body: { amountMinor: 40_000 } },
      trId,
    );
    expect(patched.status).toBe(200);
    expect(await balanceOf(A, sav)).toBe(40_000);
    const del = await call(
      L.deleteTransferHandler,
      "",
      { bearer: A.bearer, method: "DELETE" },
      trId,
    );
    expect(del.status).toBe(204);
    expect(await balanceOf(A, sav)).toBe(0);
    expect(await balanceOf(A, cur)).toBe(126_794 + 50_000);
    const gone = await call(L.getTransferHandler, "", { bearer: A.bearer }, trId);
    expect(gone.status).toBe(404);
  });

  it("tranzacții: cursor (parcurgere completă fără duplicate), filtre, căutare, GET/PATCH/DELETE", async () => {
    const acc = await newAccount(A, "Cursor");
    const ids: string[] = [];
    for (let i = 1; i <= 7; i++) {
      const r = await call(L.createTransactionHandler, "/api/v1/transactions", {
        bearer: A.bearer,
        body: {
          accountId: acc,
          type: "expense",
          amountMinor: 100 * i,
          occurredOn: `2026-09-0${(i % 3) + 1}`,
          merchant: i === 4 ? "Mega Image" : "Altul",
        },
      });
      ids.push((r.body.data as { id: string }).id);
    }
    for (const sort of ["date_desc", "date_asc", "amount_desc", "amount_asc"]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const qs = new URLSearchParams({ accountId: acc, limit: "3", sort });
        if (cursor) qs.set("cursor", cursor);
        const r = await call(L.listTransactionsHandler, `/api/v1/transactions?${qs}`, {
          bearer: A.bearer,
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        seen.push(...(r.body.data as { id: string }[]).map((t) => t.id));
        cursor = r.body.nextCursor ?? null;
        pages++;
      } while (cursor && pages < 10);
      expect(new Set(seen).size, sort).toBe(7);
      expect(seen.sort()).toEqual([...ids].sort());
    }
    const search = await call(L.listTransactionsHandler, "/api/v1/transactions?q=mega", {
      bearer: A.bearer,
    });
    expect((search.body.data as { id: string }[]).map((t) => t.id)).toEqual([ids[3]]);
    const range = await call(
      L.listTransactionsHandler,
      `/api/v1/transactions?accountId=${acc}&amountMinMinor=200&amountMaxMinor=400`,
      { bearer: A.bearer },
    );
    expect((range.body.data as { amountMinor: number }[]).map((t) => t.amountMinor).sort()).toEqual(
      [200, 300, 400],
    );
    const badCursor = await call(L.listTransactionsHandler, "/api/v1/transactions?cursor=xyz", {
      bearer: A.bearer,
    });
    expect(badCursor.status).toBe(400);

    const id = ids[0]!;
    const one = await call(L.getTransactionHandler, "", { bearer: A.bearer }, id);
    expect(one.body.data).toMatchObject({
      id,
      amountMinor: 100,
      currency: "RON",
      occurredOn: "2026-09-02",
    });
    const patched = await call(
      L.patchTransactionHandler,
      "",
      { bearer: A.bearer, method: "PATCH", body: { amountMinor: 150, notes: "corectat" } },
      id,
    );
    expect(patched.body.data).toMatchObject({ amountMinor: 150, notes: "corectat" });
    const del = await call(
      L.deleteTransactionHandler,
      "",
      { bearer: A.bearer, method: "DELETE" },
      id,
    );
    expect(del.status).toBe(204);
    expect((await call(L.getTransactionHandler, "", { bearer: A.bearer }, id)).status).toBe(404);
  });

  it("categorii: creare, ascundere/afișare de sistem, ștergere cu reassignToId", async () => {
    const created = await call(L.createCategoryHandler, "/api/v1/categories", {
      cookie: A.cookie,
      body: { name: "Hobby", kind: "expense", color: "#AABBCC" },
    });
    expect(created.status).toBe(201);
    const hobby = (created.body.data as { id: string; color: string }).id;
    expect(created.body.data).toMatchObject({ color: "#aabbcc", isSystem: false });

    const hide = await call(
      L.setCategoryHiddenHandler,
      "",
      { bearer: A.bearer, method: "POST" },
      groceries,
      true,
    );
    expect(hide.status).toBe(200);
    expect(hide.body.data).toMatchObject({ id: groceries, hidden: true, isSystem: true });
    const visible = await call(
      L.listCategoriesHandler,
      "/api/v1/categories?kind=expense&includeHidden=false",
      {
        bearer: A.bearer,
      },
    );
    expect((visible.body.data as { id: string }[]).map((c) => c.id)).not.toContain(groceries);
    // Ascunderea e per gospodărie: B o vede în continuare.
    const bCats = await call(L.listCategoriesHandler, "/api/v1/categories", { bearer: B.bearer });
    expect((bCats.body.data as { id: string }[]).map((c) => c.id)).toContain(groceries);
    const unhide = await call(
      L.setCategoryHiddenHandler,
      "",
      { bearer: A.bearer, method: "POST" },
      groceries,
      false,
    );
    expect(unhide.body.data).toMatchObject({ hidden: false });
    const sysPatch = await call(
      L.patchCategoryHandler,
      "",
      { bearer: A.bearer, method: "PATCH", body: { name: "Altceva" } },
      groceries,
    );
    expect(sysPatch.status).toBe(409);

    const acc = await newAccount(A, "Categorii");
    await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: A.bearer,
      body: {
        accountId: acc,
        type: "expense",
        amountMinor: 700,
        occurredOn: "2026-10-07",
        categoryId: hobby,
      },
    });
    const inUse = await call(
      L.deleteCategoryHandler,
      "",
      { bearer: A.bearer, method: "DELETE" },
      hobby,
    );
    expect(inUse.status).toBe(409);
    const reassigned = await call(
      L.deleteCategoryHandler,
      `/api/v1/categories/${hobby}?reassignToId=${groceries}`,
      { bearer: A.bearer, method: "DELETE" },
      hobby,
    );
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.data).toEqual({ reassigned: 1 });
    expect((await call(L.getCategoryHandler, "", { bearer: A.bearer }, hobby)).status).toBe(404);
  });

  it("rate limiting pe mutații (per utilizator): 429 cu Retry-After", async () => {
    const strict = {
      ...env,
      limits: { mutations: { max: 2, windowSeconds: 60 } },
      now: () => clock + 7_777_777,
    };
    const post = (n: number) =>
      strict.limits &&
      L.createCategoryHandler(
        apiRequest("/api/v1/categories", {
          bearer: C.bearer,
          body: { name: `RL ${n}`, kind: "income" },
        }),
        strict,
      );
    expect((await post(1))!.status).toBe(201);
    expect((await post(2))!.status).toBe(201);
    const third = (await post(3))!;
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await readJson(third)).error?.code).toBe("rate_limited");
    // Citirile nu sunt limitate.
    const get = await L.listCategoriesHandler(
      apiRequest("/api/v1/categories", { bearer: C.bearer }),
      strict,
    );
    expect(get.status).toBe(200);
  });
});
