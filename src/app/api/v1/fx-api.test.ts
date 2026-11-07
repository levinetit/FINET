import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { upsertRates } from "@/modules/fx/fx.service";

import type { ApiDeps } from "./_lib/http";
import * as I from "./_lib/intelligence-handlers";
import * as L from "./_lib/ledger-handlers";
import {
  type ApiInit,
  type Sessions,
  apiRequest,
  assertContract,
  readJson,
  sessionsFor,
} from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** `GET /api/v1/fx/rates` (ADR 0049) și conturile în HUF/GBP (CHECK-urile rescrise de 0029). */
type Handler = (request: Request, deps: ApiDeps, ...rest: never[]) => Promise<Response>;

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1/fx/rates și monedele noi (Postgres real)", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  let A: Sessions;
  const PASS = "parola-curs-1";

  async function call(handler: Handler, path: string, init: ApiInit) {
    const res = await (handler as (...a: unknown[]) => Promise<Response>)(
      apiRequest(path, init),
      env,
    );
    await assertContract(handler, res);
    return { status: res.status, body: await readJson(res) };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_fx_api");
    env = { ...authEnv(fx.db, { now: () => Date.parse("2026-10-28T10:00:00Z") }) };
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    A = await sessionsFor(env, "ana@exemplu.ro", PASS);
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("fără cursuri → 404; cu cursuri → tabela zilei, EUR inclus; ?date= și validarea ei", async () => {
    const none = await call(I.fxRatesHandler, "/api/v1/fx/rates", { bearer: A.bearer });
    expect(none.status).toBe(404);
    await upsertRates(
      fx.db,
      [
        { date: "2026-10-27", currency: "RON", rateMicro: 4_960_000n },
        { date: "2026-10-28", currency: "RON", rateMicro: 4_970_000n },
        { date: "2026-10-28", currency: "HUF", rateMicro: 410_250_000n },
      ],
      new Date(),
    );
    const r = await call(I.fxRatesHandler, "/api/v1/fx/rates", { bearer: A.bearer });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({
      base: "EUR",
      date: "2026-10-28",
      rates: { RON: 4_970_000, EUR: 1_000_000, HUF: 410_250_000 },
    });
    const old = await call(I.fxRatesHandler, "/api/v1/fx/rates?date=2026-10-27", {
      bearer: A.bearer,
    });
    expect((old.body.data as { date: string }).date).toBe("2026-10-27");
    const bad = await call(I.fxRatesHandler, "/api/v1/fx/rates?date=ieri", { bearer: A.bearer });
    expect(bad.status).toBe(400);
    const none2 = await call(I.fxRatesHandler, "/api/v1/fx/rates", {});
    expect(none2.status).toBe(401);
  });

  it("conturile în HUF și GBP trec de CHECK-urile rescrise", async () => {
    for (const currency of ["HUF", "GBP"]) {
      const r = await call(L.createAccountHandler, "/api/v1/accounts", {
        bearer: A.bearer,
        body: { name: `Cont ${currency}`, type: "bank", currency, openingBalance: "1000" },
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((r.body.data as { currency: string }).currency).toBe(currency);
    }
    const bad = await call(L.createAccountHandler, "/api/v1/accounts", {
      bearer: A.bearer,
      body: { name: "Cont CHF", type: "bank", currency: "CHF" },
    });
    expect(bad.status).toBe(400);
  });
});
