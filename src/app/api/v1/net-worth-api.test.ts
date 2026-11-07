import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as N from "./_lib/net-worth-handlers";
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
 * Averea netă și evaluările prin API (modernizare 2026, pasul G; ADR 0046), pe PostgreSQL real
 * ca `finet_app`: tipurile noi de cont trec de CHECK-ul rescris, evaluările (creare, listă,
 * ștergere, 400 pe conturi tranzacționale, 409 pe aceeași zi, data în viitor), averea netă din
 * solduri + evaluări cu istoric lunar, izolarea între gospodării (404 pe contul altuia).
 */

type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;
type Body = Awaited<ReturnType<typeof readJson>>;

type NetWorthJson = {
  asOf: string;
  currencies: {
    currency: string;
    current: { assetsMinor: number; liabilitiesMinor: number; netMinor: number };
    byType: {
      type: string;
      kind: string;
      valueMinor: number;
      accounts: { name: string; basis: string; valuedOn: string | null }[];
    }[];
    history: { asOf: string; netMinor: number }[];
  }[];
};

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1/net-worth și evaluări pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  // 28 octombrie 2026, 10:00 UTC → azi în București: 2026-10-28.
  const clock = Date.parse("2026-10-28T10:00:00Z");
  let A: Sessions;
  let B: Sessions;
  let bank: string;
  let flat: string;
  let loan: string;
  let keySeq = 0;
  const PASS = "parola-avere-1";
  const newKey = () => `avere-cheie-${String(++keySeq).padStart(6, "0")}`;

  async function call(handler: Handler, path: string, init: ApiInit, ...rest: string[]) {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      env,
      ...rest,
    );
    await assertContract(handler, res);
    const text = await res.clone().text();
    const body = (text ? JSON.parse(text) : {}) as Body;
    return { status: res.status, body, res };
  }
  const idOf = (r: { body: Body }) => (r.body.data as { id: string }).id;

  async function newAccount(s: Sessions, name: string, type: string, openingBalance: string) {
    const r = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: s.bearer,
      body: { name, type, currency: "RON", openingBalance },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return idOf(r);
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_net_worth_api");
    env = {
      ...authEnv(fx.db, { now: () => clock }),
      limits: { mutations: { max: 100_000, windowSeconds: 60 } },
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
    bank = await newAccount(A, "Bancă", "bank", "1000");
    flat = await newAccount(A, "Apartament", "property", "0");
    loan = await newAccount(A, "Credit", "loan", "-100000");
    await newAccount(A, "Card", "credit_card", "-200");
    // O cheltuială în septembrie și un venit în octombrie, pe contul bancar.
    for (const [type, amount, occurredOn] of [
      ["expense", "300", "2026-09-10"],
      ["income", "500", "2026-10-05"],
    ] as const) {
      const r = await call(L.createTransactionHandler, "/api/v1/transactions", {
        bearer: A.bearer,
        headers: { "idempotency-key": newKey() },
        body: { type, accountId: bank, amount, occurredOn, description: "x" },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("evaluări: 400 pe cont tranzacțional, 201 cu Idempotency-Key, 409 pe aceeași zi, 400 în viitor, 404 pentru alt membru", async () => {
    const onBank = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${bank}/valuations`,
      {
        bearer: A.bearer,
        body: { valuedOn: "2026-10-01", value: "5000" },
      },
      bank,
    );
    expect(onBank.status).toBe(400);
    expect(onBank.body.error?.fields).toHaveProperty("accountId");

    const key = newKey();
    const first = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
        headers: { "idempotency-key": key },
        body: { valuedOn: "2026-06-30", value: "400000" },
      },
      flat,
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((first.body.data as { valueMinor: number }).valueMinor).toBe(40000000);
    const replay = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
        headers: { "idempotency-key": key },
        body: { valuedOn: "2026-06-30", value: "400000" },
      },
      flat,
    );
    expect(replay.status).toBe(201);
    expect(idOf(replay)).toBe(idOf(first));

    const dup = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
        body: { valuedOn: "2026-06-30", valueMinor: 41000000 },
      },
      flat,
    );
    expect(dup.status).toBe(409);
    expect(dup.body.error?.reason).toBe("valuation_exists");

    const future = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
        body: { valuedOn: "2026-10-29", valueMinor: 41000000 },
      },
      flat,
    );
    expect(future.status).toBe(400);
    expect(future.body.error?.fields).toHaveProperty("valuedOn");

    const second = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
        body: { valuedOn: "2026-09-15", valueMinor: 42000000, note: " reevaluare " },
      },
      flat,
    );
    expect(second.status).toBe(201);
    expect((second.body.data as { note: string }).note).toBe("reevaluare");
    const loanVal = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${loan}/valuations`,
      {
        bearer: A.bearer,
        body: { valuedOn: "2026-10-01", value: "-95000" },
      },
      loan,
    );
    expect(loanVal.status).toBe(201);

    const list = await call(
      N.listValuationsHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
      },
      flat,
    );
    expect(list.status).toBe(200);
    expect((list.body.data as { valuedOn: string }[]).map((v) => v.valuedOn)).toEqual([
      "2026-09-15",
      "2026-06-30",
    ]);

    // Bogdan nu vede contul Anei: 404 uniform la listă, creare și ștergere.
    const other = await call(
      N.listValuationsHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: B.bearer,
      },
      flat,
    );
    expect(other.status).toBe(404);
    const otherCreate = await call(
      N.createValuationHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: B.bearer,
        body: { valuedOn: "2026-10-01", valueMinor: 1 },
      },
      flat,
    );
    expect(otherCreate.status).toBe(404);
    const otherDelete = await call(
      N.deleteValuationHandler,
      `/api/v1/accounts/${flat}/valuations/${idOf(first)}`,
      { bearer: B.bearer, method: "DELETE" },
      flat,
      idOf(first),
    );
    expect(otherDelete.status).toBe(404);
  });

  it("averea netă: solduri + evaluări, active/pasive, istoric lunar; Bogdan vede doar ale lui", async () => {
    const r = await call(N.netWorthHandler, "/api/v1/net-worth?months=4", { bearer: A.bearer });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const data = r.body.data as NetWorthJson;
    expect(data.asOf).toBe("2026-10-28");
    const ron = data.currencies.find((c) => c.currency === "RON")!;
    // Bancă 1.000 − 300 + 500 = 1.200; apartament 420.000; credit −95.000; card −200.
    expect(ron.current).toMatchObject({
      assetsMinor: 120000 + 42000000,
      liabilitiesMinor: 9500000 + 20000,
      netMinor: 120000 + 42000000 - 9500000 - 20000,
    });
    expect(ron.byType.map((b) => [b.type, b.kind, b.valueMinor])).toEqual([
      ["bank", "asset", 120000],
      ["property", "asset", 42000000],
      ["credit_card", "liability", -20000],
      ["loan", "liability", -9500000],
    ]);
    expect(ron.byType[1]!.accounts[0]).toMatchObject({
      basis: "valuation",
      valuedOn: "2026-09-15",
    });
    expect(ron.history.map((p) => p.asOf)).toEqual([
      "2026-07-31",
      "2026-08-31",
      "2026-09-30",
      "2026-10-28",
    ]);
    // Iulie: bancă 1.000, apartament 400.000 (evaluarea din iunie), credit −100.000 (sold inițial), card −200.
    expect(ron.history[0]!.netMinor).toBe(100000 + 40000000 - 10000000 - 20000);
    // Septembrie: bancă 700, apartament 420.000, credit −100.000, card −200.
    expect(ron.history[2]!.netMinor).toBe(70000 + 42000000 - 10000000 - 20000);
    expect(ron.history[3]!.netMinor).toBe(ron.current.netMinor);

    const b = await call(N.netWorthHandler, "/api/v1/net-worth", { bearer: B.bearer });
    expect(b.status).toBe(200);
    expect((b.body.data as NetWorthJson).currencies).toEqual([]);

    const bad = await call(N.netWorthHandler, "/api/v1/net-worth?months=0", { bearer: A.bearer });
    expect(bad.status).toBe(400);
    const none = await call(N.netWorthHandler, "/api/v1/net-worth", {});
    expect(none.status).toBe(401);
  });

  it("ștergerea unei evaluări recalculează averea; 404 la a doua ștergere", async () => {
    const list = await call(
      N.listValuationsHandler,
      `/api/v1/accounts/${flat}/valuations`,
      {
        bearer: A.bearer,
      },
      flat,
    );
    const latest = (list.body.data as { id: string; valuedOn: string }[])[0]!;
    expect(latest.valuedOn).toBe("2026-09-15");
    const del = await call(
      N.deleteValuationHandler,
      `/api/v1/accounts/${flat}/valuations/${latest.id}`,
      { bearer: A.bearer, method: "DELETE" },
      flat,
      latest.id,
    );
    expect(del.status).toBe(204);
    const again = await call(
      N.deleteValuationHandler,
      `/api/v1/accounts/${flat}/valuations/${latest.id}`,
      { bearer: A.bearer, method: "DELETE" },
      flat,
      latest.id,
    );
    expect(again.status).toBe(404);
    const r = await call(N.netWorthHandler, "/api/v1/net-worth?months=1", { bearer: A.bearer });
    const ron = (r.body.data as NetWorthJson).currencies[0]!;
    expect(ron.byType.find((b) => b.type === "property")!.valueMinor).toBe(40000000);
  });
});
