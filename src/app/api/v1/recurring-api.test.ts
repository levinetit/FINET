import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as M from "./_lib/me-handlers";
import * as R from "./_lib/recurring-handlers";
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
 * Acceptarea F5-B prin API (handlere reale, PostgreSQL real, aplicația ca `finet_app`): CRUD-ul
 * regulilor recurente, contorul (reguli active · scadente · total), generarea la cerere
 * (`Idempotency-Key` obligatoriu, replay, a doua generare = 0, limită proprie 429, audit fără sume),
 * pauza/reluarea fără retroactiv, contul arhivat (pauză automată, reluare refuzată), tranzacțiile
 * generate în `GET /transactions?source=recurring` cu `recurringRuleId`, izolarea (404) și
 * contractul OpenAPI pe fiecare răspuns.
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;
type Rule = {
  id: string;
  status: string;
  nextRunOn: string;
  occurrencesCount: number;
  due: boolean;
  lastErrorCode: string | null;
};
type Counts = { active: number; due: number; total: number };
type Generated = { today: string; rules: number; generated: number; failed: number };
type Tx = { id: string; source: string; recurringRuleId: string | null; occurredOn: string };

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1/recurring pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // 28 octombrie 2026, 10:00 UTC → „azi” în București: 2026-10-28.
  const clock = Date.parse("2026-10-28T10:00:00Z");
  const DAY = 24 * 60 * 60 * 1000;
  let A: Sessions; // owner HA
  let B: Sessions; // owner HB
  let accA: string;
  let keySeq = 0;
  const PASS = "parola-recurente-1";
  const newKey = () => `recurente-cheie-${String(++keySeq).padStart(6, "0")}`;

  async function callWith(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ): Promise<{ status: number; body: Body; res: Response }> {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      deps,
      ...rest,
    );
    await assertContract(handler, res);
    const text = await res.clone().text();
    return { status: res.status, body: text ? (JSON.parse(text) as Body) : {}, res };
  }
  const call = (handler: Handler, path: string, init: ApiInit, ...rest: string[]) =>
    callWith(env, handler, path, init, ...rest);
  const at = (ms: number): AuthEnv & ApiDeps => ({ ...env, now: () => ms });

  async function newAccount(s: Sessions, name: string) {
    const r = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: s.bearer,
      body: { name, type: "bank", currency: "RON" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body.data as { id: string }).id;
  }

  async function newRule(s: Sessions, body: Record<string, unknown>, deps: ApiDeps = env) {
    const r = await callWith(deps, R.createRecurringHandler, "/api/v1/recurring", {
      bearer: s.bearer,
      body: { type: "expense", frequency: "monthly", amountMinor: 4999, ...body },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data as Rule;
  }

  function generate(s: Sessions, key: string | null, deps: ApiDeps = env) {
    return callWith(deps, R.generateRecurringHandler, "/api/v1/recurring/generate", {
      bearer: s.bearer,
      method: "POST",
      headers: key === null ? {} : { "idempotency-key": key },
    });
  }

  async function getRule(s: Sessions, id: string, deps: ApiDeps = env) {
    const r = await callWith(
      deps,
      R.getRecurringHandler,
      `/api/v1/recurring/${id}`,
      {
        bearer: s.bearer,
      },
      id,
    );
    expect(r.status).toBe(200);
    return r.body.data as Rule;
  }

  async function recurringTxs(s: Sessions, accountId: string): Promise<Tx[]> {
    const r = await call(
      L.listTransactionsHandler,
      `/api/v1/transactions?source=recurring&accountId=${accountId}&sort=date_asc&limit=100`,
      { bearer: s.bearer },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.data as Tx[];
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_recurring_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: {
        mutations: { max: 100_000, windowSeconds: 60 },
        recurringGenerate: { max: 100_000, windowSeconds: 60 },
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
    await mk("ana@exemplu.ro", "Ana");
    await mk("bogdan@exemplu.ro", "Bogdan");
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
    B = await sessionsFor(env, "bogdan@exemplu.ro", PASS);
    accA = await newAccount(A, "Card Ana");
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune → 401 pe toate rutele noi", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    const cases: [Handler, string, ApiInit, ...string[]][] = [
      [R.listRecurringHandler, "/api/v1/recurring", {}],
      [R.recurringSummaryHandler, "/api/v1/recurring/summary", {}],
      [R.createRecurringHandler, "/api/v1/recurring", { body: {} }],
      [R.generateRecurringHandler, "/api/v1/recurring/generate", { method: "POST" }],
      [R.getRecurringHandler, `/api/v1/recurring/${id}`, {}, id],
      [R.pauseRecurringHandler, `/api/v1/recurring/${id}/pause`, { method: "POST" }, id],
    ];
    for (const [h, path, init, ...rest] of cases) {
      expect((await call(h, path, init, ...rest)).status, path).toBe(401);
    }
  });

  it("validarea creării: descriere obligatorie, interval ≤ 100, rate ≤ 1200, ziua doar lunar/anual, chei străine", async () => {
    const base = { accountId: accA, description: "Abonament", startOn: "2026-10-01" };
    const bad: Record<string, unknown>[] = [
      { ...base, description: "" },
      { ...base, interval: 101 },
      { ...base, maxOccurrences: 1201 },
      { ...base, frequency: "weekly", dayOfMonth: 5 },
      { ...base, householdId: accA },
      { ...base, status: "paused" },
      { ...base, type: "transfer" },
      { ...base, amountMinor: 0 },
      { ...base, endOn: "2026-09-01" },
    ];
    for (const body of bad) {
      const r = await call(R.createRecurringHandler, "/api/v1/recurring", {
        bearer: A.bearer,
        body: { type: "expense", frequency: "monthly", amountMinor: 100, ...body },
      });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error?.code).toBe("invalid_request");
    }
  });

  it("creare cu start în trecut → generare (cheie obligatorie), replay, a doua generare = 0, tranzacțiile cu `recurringRuleId`", async () => {
    const acc = await newAccount(A, "Chirie");
    const rule = await newRule(A, {
      accountId: acc,
      description: "Chirie",
      startOn: "2026-07-15",
    });
    expect(rule).toMatchObject({ status: "active", nextRunOn: "2026-07-15", due: true });

    const summary = await call(R.recurringSummaryHandler, "/api/v1/recurring/summary", {
      bearer: A.bearer,
    });
    expect(summary.status).toBe(200);
    expect((summary.body.data as Counts).due).toBeGreaterThanOrEqual(1);

    // Fără cheie → 400, nimic generat.
    const noKey = await generate(A, null);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error?.fields).toHaveProperty("Idempotency-Key");
    expect(await recurringTxs(A, acc)).toHaveLength(0);

    const key = newKey();
    const first = await generate(A, key);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data as Generated).toMatchObject({ today: "2026-10-28", generated: 4 });

    const replay = await generate(A, key);
    expect(replay.status).toBe(200);
    expect(replay.res.headers.get("idempotent-replay")).toBe("true");
    expect(replay.body).toEqual(first.body);

    const second = await generate(A, newKey());
    expect(second.status).toBe(200);
    expect((second.body.data as Generated).generated).toBe(0);

    const txs = await recurringTxs(A, acc);
    expect(txs.map((t) => t.occurredOn)).toEqual([
      "2026-07-15",
      "2026-08-15",
      "2026-09-15",
      "2026-10-15",
    ]);
    for (const t of txs) expect(t).toMatchObject({ source: "recurring", recurringRuleId: rule.id });
    // Tranzacțiile manuale au `recurringRuleId: null`.
    const manual = await call(L.createTransactionHandler, "/api/v1/transactions", {
      bearer: A.bearer,
      body: { accountId: acc, type: "expense", amountMinor: 100, occurredOn: "2026-10-01" },
    });
    expect(manual.body.data).toMatchObject({ source: "manual", recurringRuleId: null });

    const after = await getRule(A, rule.id);
    expect(after).toMatchObject({
      nextRunOn: "2026-11-15",
      occurrencesCount: 4,
      due: false,
      status: "active",
    });
  });

  it("audit fără sume la generare și limita proprie (429)", async () => {
    await fx.scratch.admin`delete from finet.audit_events where action = 'recurring.generated'`;
    expect((await generate(A, newKey())).status).toBe(200);
    const rows = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events where action = 'recurring.generated'`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!.metadata).sort()).toEqual([
      "failed",
      "generated",
      "rules",
      "skipped",
    ]);

    const strict = {
      ...env,
      limits: { ...env.limits, recurringGenerate: { max: 2, windowSeconds: 60 } },
      now: () => clock + 9_999_999,
    };
    expect((await generate(A, newKey(), strict)).status).toBe(200);
    expect((await generate(A, newKey(), strict)).status).toBe(200);
    const third = await generate(A, newKey(), strict);
    expect(third.status).toBe(429);
    expect(third.body.error?.code).toBe("rate_limited");
    expect(third.res.headers.get("retry-after")).toMatch(/^\d+$/);
    // Restul mutațiilor nu sunt afectate de limita generării.
    const list = await callWith(strict, R.listRecurringHandler, "/api/v1/recurring", {
      bearer: A.bearer,
    });
    expect(list.status).toBe(200);
  });

  it("pauză → reluare fără generarea retroactivă a lunilor sărite", async () => {
    const acc = await newAccount(A, "Abonamente");
    const rule = await newRule(A, {
      accountId: acc,
      description: "Streaming",
      startOn: "2026-10-20",
    });
    expect((await generate(A, newKey())).status).toBe(200);
    expect(await recurringTxs(A, acc)).toHaveLength(1);

    const paused = await call(
      R.pauseRecurringHandler,
      `/api/v1/recurring/${rule.id}/pause`,
      {
        bearer: A.bearer,
        method: "POST",
      },
      rule.id,
    );
    expect(paused.status).toBe(200);
    expect(paused.body.data).toMatchObject({ status: "paused", due: false });

    // Peste ~2 luni: 2026-12-27; scadențele 20 nov și 20 dec au fost sărite.
    const later = at(clock + 60 * DAY);
    expect((await generate(A, newKey(), later)).status).toBe(200);
    expect(await recurringTxs(A, acc)).toHaveLength(1);

    const resumed = await callWith(
      later,
      R.resumeRecurringHandler,
      `/api/v1/recurring/${rule.id}/resume`,
      {
        bearer: A.bearer,
        method: "POST",
      },
      rule.id,
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.data).toMatchObject({
      status: "active",
      nextRunOn: "2027-01-20",
      due: false,
    });
    const g = await generate(A, newKey(), later);
    expect(g.status).toBe(200);
    expect(await recurringTxs(A, acc)).toHaveLength(1);
  });

  it("contul arhivat: generarea pune regula pe pauză (`account_archived`), reluarea → 409", async () => {
    const acc = await newAccount(A, "Cont vechi");
    const rule = await newRule(A, { accountId: acc, description: "Rată", startOn: "2026-10-01" });
    const arch = await call(
      L.archiveAccountHandler,
      `/api/v1/accounts/${acc}/archive`,
      {
        bearer: A.bearer,
        method: "POST",
      },
      acc,
      true as unknown as string,
    );
    expect(arch.status, JSON.stringify(arch.body)).toBe(200);
    expect((await generate(A, newKey())).status).toBe(200);
    expect(await getRule(A, rule.id)).toMatchObject({
      status: "paused",
      lastErrorCode: "account_archived",
    });
    expect(await recurringTxs(A, acc)).toHaveLength(0);
    const resumed = await call(
      R.resumeRecurringHandler,
      `/api/v1/recurring/${rule.id}/resume`,
      {
        bearer: A.bearer,
        method: "POST",
      },
      rule.id,
    );
    expect(resumed.status).toBe(409);
    expect(resumed.body.error?.reason).toBe("account_archived");
  });

  it("listă cu filtru pe stare, contorul pe toate regulile, modificare și ștergere (tranzacțiile rămân)", async () => {
    const acc = await newAccount(A, "Diverse");
    const rule = await newRule(A, {
      accountId: acc,
      description: "Sală",
      startOn: "2026-10-10",
      frequency: "weekly",
      amountMinor: 1500,
    });
    const all = await call(R.listRecurringHandler, "/api/v1/recurring", { bearer: A.bearer });
    const counts = all.body.counts as Counts;
    const paused = await call(R.listRecurringHandler, "/api/v1/recurring?status=paused", {
      bearer: A.bearer,
    });
    expect((paused.body.data as Rule[]).every((r) => r.status === "paused")).toBe(true);
    expect(paused.body.counts).toEqual(counts);
    expect(counts.total).toBe((all.body.data as Rule[]).length);
    const badStatus = await call(R.listRecurringHandler, "/api/v1/recurring?status=x", {
      bearer: A.bearer,
    });
    expect(badStatus.status).toBe(400);

    const patched = await call(
      R.patchRecurringHandler,
      `/api/v1/recurring/${rule.id}`,
      {
        bearer: A.bearer,
        method: "PATCH",
        body: { amountMinor: 1700, description: "Sală (nou)" },
      },
      rule.id,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ amountMinor: 1700, description: "Sală (nou)" });

    expect((await generate(A, newKey())).status).toBe(200);
    const generated = await recurringTxs(A, acc);
    expect(generated.length).toBeGreaterThan(0);

    const del = await call(
      R.deleteRecurringHandler,
      `/api/v1/recurring/${rule.id}`,
      {
        bearer: A.bearer,
        method: "DELETE",
      },
      rule.id,
    );
    expect(del.status).toBe(204);
    const gone = await call(
      R.getRecurringHandler,
      `/api/v1/recurring/${rule.id}`,
      {
        bearer: A.bearer,
      },
      rule.id,
    );
    expect(gone.status).toBe(404);
    const kept = await recurringTxs(A, acc);
    expect(kept).toHaveLength(generated.length);
    for (const t of kept) expect(t.recurringRuleId).toBeNull();
  });

  it("izolare: alt utilizator nu vede, nu modifică și nu generează regulile altei gospodării (404 uniform)", async () => {
    const acc = await newAccount(A, "Privat");
    const rule = await newRule(A, { accountId: acc, description: "Privat", startOn: "2026-10-01" });
    const id = rule.id;
    const cases: [Handler, string, ApiInit][] = [
      [R.getRecurringHandler, `/api/v1/recurring/${id}`, { bearer: B.bearer }],
      [
        R.patchRecurringHandler,
        `/api/v1/recurring/${id}`,
        { bearer: B.bearer, method: "PATCH", body: { description: "x" } },
      ],
      [R.deleteRecurringHandler, `/api/v1/recurring/${id}`, { bearer: B.bearer, method: "DELETE" }],
      [
        R.pauseRecurringHandler,
        `/api/v1/recurring/${id}/pause`,
        { bearer: B.bearer, method: "POST" },
      ],
      [
        R.resumeRecurringHandler,
        `/api/v1/recurring/${id}/resume`,
        { bearer: B.bearer, method: "POST" },
      ],
    ];
    for (const [h, path, init] of cases) {
      const r = await call(h, path, init, id);
      expect(r.status, path).toBe(404);
    }
    // Contul altei gospodării la creare → 404.
    const foreign = await callWith(env, R.createRecurringHandler, "/api/v1/recurring", {
      bearer: B.bearer,
      body: {
        accountId: acc,
        type: "expense",
        frequency: "monthly",
        amountMinor: 100,
        description: "x",
        startOn: "2026-10-01",
      },
    });
    expect(foreign.status).toBe(404);
    const listB = await call(R.listRecurringHandler, "/api/v1/recurring", { bearer: B.bearer });
    expect(listB.body.data).toEqual([]);
    expect(listB.body.counts).toEqual({ active: 0, due: 0, total: 0 });
    const genB = await generate(B, newKey());
    expect(genB.status).toBe(200);
    expect((genB.body.data as Generated).generated).toBe(0);
    expect(await getRule(A, id)).toMatchObject({ due: true, occurrencesCount: 0 });
  });

  it("evenimentele `recurring_created` și `recurring_generated` se acceptă (doar numele)", async () => {
    await call(M.putConsentsHandler, "/api/v1/me/consents", {
      method: "PUT",
      bearer: A.bearer,
      body: { usageStats: true },
    });
    const iso = new Date(clock).toISOString();
    const names = ["recurring_created", "recurring_generated"];
    const ok = await call(M.appEventsHandler, "/api/v1/app/events", {
      bearer: A.bearer,
      body: {
        events: names.map((name) => ({ name, occurredAt: iso, screen: "recurring" })),
      },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(204);
    const extra = await call(M.appEventsHandler, "/api/v1/app/events", {
      bearer: A.bearer,
      body: { events: [{ name: "recurring_created", occurredAt: iso, amountMinor: 1 }] },
    });
    expect(extra.status).toBe(400);
  });
});
