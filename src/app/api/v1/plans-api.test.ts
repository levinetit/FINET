import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  createAuthFixture,
  testConfig,
} from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import * as A from "./_lib/ask-handlers";
import * as F from "./_lib/family-handlers";
import * as G from "./_lib/gdpr-handlers";
import type { ApiDeps } from "./_lib/http";
import * as L from "./_lib/ledger-handlers";
import * as M from "./_lib/me-handlers";
import * as P from "./_lib/prices-handlers";
import * as PL from "./_lib/planning-handlers";
import { type ApiInit, type Sessions, apiRequest, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Handler = (request: Request, deps: ApiDeps, ...rest: string[]) => Promise<Response>;

/**
 * Planurile prin API (Faza 12-A; ADR 0035), pe PostgreSQL real, `saas`: un abonament expirat lasă
 * citirea și exportul, dar blochează scrierile (402), cu excepțiile explicite; fără plan
 * configurat scrierile sunt refuzate (503); limita de membri și funcțiile legate de plan se
 * aplică pe server; `personal` nu e afectat.
 */
describe.skipIf(!TEST_ADMIN_URL)("12-A: planuri și blocarea scrierilor", () => {
  let fx: AuthFixture;
  let migrator: ReturnType<typeof testClient>;
  let saas: AuthEnv & ApiDeps;
  let personal: AuthEnv & ApiDeps;
  const PASS = "parola-planuri-12a-1";
  const limits = {
    mutations: { max: 100_000, windowSeconds: 60 },
    exports: { max: 100_000, windowSeconds: 60 },
    inviteAccept: { max: 1000, windowSeconds: 60 },
  };

  async function call(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ) {
    const res = await handler(apiRequest(path, init), deps, ...rest);
    const text = await res.clone().text();
    return { status: res.status, body: (text ? safeJson(text) : {}) as Loose };
  }
  const safeJson = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return {};
    }
  };

  let seq = 0;
  async function user(name: string) {
    const email = `u${++seq}-${name}@exemplu.ro`;
    const r = await createUserWithHousehold(fx.db, {
      email,
      name,
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    if (!r.created) throw new Error("cont neașteptat");
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    const s = await sessionsFor(saas, email, PASS);
    return { userId: r.userId, householdId: row!.household_id, s, email };
  }

  async function plan(
    code: string,
    values: { limits?: Record<string, number>; features?: string[]; isDefault?: boolean } = {},
  ) {
    const [row] = await migrator<{ id: string }[]>`
      insert into finet.plans (code, name, is_default, limits, features)
      values (${code}, ${code}, ${values.isDefault ?? false},
              ${migrator.json((values.limits ?? {}) as never)}, ${values.features ?? []}::text[])
      returning id`;
    return row!.id;
  }
  async function subscribe(householdId: string, planId: string, status: string) {
    await migrator`
      insert into finet.subscriptions (household_id, plan_id, status, provider)
      values (${householdId}, ${planId}, ${status}, 'manual')
      on conflict (household_id) do update set plan_id = excluded.plan_id, status = excluded.status`;
  }

  const newAccount = (deps: ApiDeps, s: Sessions, name: string) =>
    call(deps, L.createAccountHandler, "/api/v1/accounts", {
      bearer: s.bearer,
      body: { name, type: "bank", currency: "RON" },
    });

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_plans_api_12a");
    migrator = testClient(fx.scratch.migratorUrl, 1);
    saas = {
      ...authEnv(fx.db, { config: testConfig({ APP_MODE: "saas" }) }),
      limits,
    };
    personal = { ...authEnv(fx.db), limits };
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await fx?.close();
  });

  it("fără niciun plan configurat: scrierile sunt refuzate (503), citirea merge, ruta de cont rămâne deschisă", async () => {
    const u = await user("fara-plan");
    const write = await newAccount(saas, u.s, "Cont");
    expect(write.status).toBe(503);
    expect(write.body.error.code).toBe("plans_not_configured");
    expect(
      (await call(saas, L.listAccountsHandler, "/api/v1/accounts", { bearer: u.s.bearer })).status,
    ).toBe(200);
    // Excepțiile: GDPR și contul propriu rămân disponibile.
    expect(
      (await call(saas, G.deletionPreviewHandler, "/api/v1/me/deletion", { bearer: u.s.bearer }))
        .status,
    ).toBe(200);
    expect(
      (
        await call(saas, M.patchMeHandler, "/api/v1/me", {
          bearer: u.s.bearer,
          method: "PATCH",
          body: { name: "Ana Nouă" },
        })
      ).status,
    ).toBe(200);
  });

  it("planul implicit: scrierile merg", async () => {
    await plan("starter", {
      isDefault: true,
      limits: { "ai.dailyDocuments": 1, "storage.quotaMb": 10, "household.maxMembers": 2 },
    });
    const u = await user("implicit");
    expect((await newAccount(saas, u.s, "Cont")).status).toBe(201);
  });

  it("abonament expirat/anulat: scrierile → 402; citirea, exportul și excepțiile merg", async () => {
    const pro = await plan("pro", {
      limits: { "ai.dailyDocuments": 50, "household.maxMembers": 5 },
      features: ["ask.finet", "reports.custom"],
    });
    const u = await user("expirat");
    await subscribe(u.householdId, pro, "active");
    expect((await newAccount(saas, u.s, "Înainte")).status).toBe(201);

    for (const status of ["expired", "canceled"]) {
      await subscribe(u.householdId, pro, status);
      const blocked = await newAccount(saas, u.s, `Cont ${status}`);
      expect(blocked.status, status).toBe(402);
      expect(blocked.body.error.code).toBe("subscription_required");
      // Alte tipuri de scriere trec prin același punct de control.
      const tag = await call(saas, PL.createTagHandler, "/api/v1/tags", {
        bearer: u.s.bearer,
        body: { name: "x" },
      });
      expect(tag.status, status).toBe(402);
      // Citire și export.
      expect(
        (await call(saas, L.listAccountsHandler, "/api/v1/accounts", { bearer: u.s.bearer }))
          .status,
      ).toBe(200);
      expect(
        (
          await call(saas, PL.exportTransactionsHandler, "/api/v1/exports/transactions.csv", {
            bearer: u.s.bearer,
          })
        ).status,
      ).toBe(200);
      // Excepții: export GDPR, previzualizarea ștergerii, contul propriu, ștergerea contului.
      expect(
        (await call(saas, G.dataExportHandler, "/api/v1/me/export", { bearer: u.s.bearer })).status,
      ).toBe(200);
      expect(
        (await call(saas, G.deletionPreviewHandler, "/api/v1/me/deletion", { bearer: u.s.bearer }))
          .status,
      ).toBe(200);
      expect(
        (
          await call(saas, M.patchMeHandler, "/api/v1/me", {
            bearer: u.s.bearer,
            method: "PATCH",
            body: { name: "Ana" },
          })
        ).status,
      ).toBe(200);
      // Funcțiile legate de plan sunt oprite și ele (403, nu 402: nu sunt scrieri).
      expect(
        (
          await call(saas, A.askHandler, "/api/v1/ask", {
            bearer: u.s.bearer,
            body: { question: "Cât am cheltuit?" },
          })
        ).status,
      ).toBe(403);
    }
    // Reînnoit: scrierile merg din nou.
    await subscribe(u.householdId, pro, "active");
    expect((await newAccount(saas, u.s, "După reînnoire")).status).toBe(201);
  });

  it("`ask.finet` și `reports.custom` cer funcția în plan (403 fără ea)", async () => {
    const basic = await plan("basic-nofeat", { limits: { "household.maxMembers": 1 } });
    const u = await user("fara-functii");
    await subscribe(u.householdId, basic, "active");
    const ask = await call(saas, A.askHandler, "/api/v1/ask", {
      bearer: u.s.bearer,
      body: { question: "Ceva?" },
    });
    expect(ask.status).toBe(403);
    const report = await call(saas, P.createReportDefinitionHandler, "/api/v1/report-definitions", {
      bearer: u.s.bearer,
      body: { name: "R", rules: [] },
    });
    expect(report.status).toBe(403);
    expect(report.body.error.code).toBe("forbidden");
  });

  it("limita de membri: invitațiile (membri + invitații active) și acceptarea respectă planul", async () => {
    const two = await plan("two-members", { limits: { "household.maxMembers": 2 } });
    const owner = await user("proprietar");
    await subscribe(owner.householdId, two, "active");
    const guest = await user("invitat");

    const inv = await call(saas, F.createInviteHandler, "/api/v1/family/invites", {
      bearer: owner.s.bearer,
      method: "POST",
    });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    // 1 membru + 1 invitație activă = 2 → a doua invitație nu mai încape.
    const second = await call(saas, F.createInviteHandler, "/api/v1/family/invites", {
      bearer: owner.s.bearer,
      method: "POST",
    });
    expect(second.status).toBe(409);
    expect(second.body.error.reason ?? second.body.error.code).toMatch(/household_full/);

    // Coboară plafonul la 1 după emiterea invitației: acceptarea trebuie refuzată și anulată.
    await migrator`update finet.plans set limits = '{"household.maxMembers": 1}'::jsonb where code = 'two-members'`;
    const token = (inv.body.data as { token: string }).token;
    const accepted = await call(saas, F.acceptInviteHandler, "/api/v1/invites/accept", {
      bearer: guest.s.bearer,
      body: { token },
    });
    expect(accepted.status).toBe(409);
    const members = await fx.scratch.admin<{ n: number }[]>`
      select count(*)::int as n from finet.household_members where household_id = ${owner.householdId}`;
    expect(members[0]?.n).toBe(1);

    // Cu plafonul la 2, aceeași invitație (neconsumată) se acceptă.
    await migrator`update finet.plans set limits = '{"household.maxMembers": 2}'::jsonb where code = 'two-members'`;
    const ok = await call(saas, F.acceptInviteHandler, "/api/v1/invites/accept", {
      bearer: guest.s.bearer,
      body: { token },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("`personal`: niciun plan, nicio blocare — scrierile merg fără tabelele de planuri populate", async () => {
    const email = `personal-${++seq}@exemplu.ro`;
    const r = await createUserWithHousehold(fx.db, {
      email,
      name: "Personal",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    if (!r.created) throw new Error("cont neașteptat");
    const s = await sessionsFor(personal, email, PASS);
    // Chiar dacă gospodăria ar avea un abonament expirat, `personal` îl ignoră.
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    const [p] = await migrator<{ id: string }[]>`select id from finet.plans limit 1`;
    await subscribe(row!.household_id, p!.id, "expired");
    expect((await newAccount(personal, s, "Cont personal")).status).toBe(201);
  });
});
