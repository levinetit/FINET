import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import { parseConfig } from "@/lib/config";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import { UNLIMITED, createEntitlements, householdPlan } from "./index";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const config = parseConfig({
  APP_MODE: "saas",
  NODE_ENV: "test",
  AI_DAILY_DOCUMENT_LIMIT: "9",
  AI_MONTHLY_BUDGET: "25",
  AI_MONTHLY_BUDGET_CURRENCY: "EUR",
  STORAGE_QUOTA_MB: "1234",
});
const personalConfig = parseConfig({ ...{ APP_MODE: "personal", NODE_ENV: "test" } });

/**
 * Planurile și abonamentele (0023, Faza 12-A; ADR 0035) pe Postgres real: planul efectiv al
 * gospodăriei, FAIL CLOSED fără plan, abonament expirat → `read_only`, aplicația nu poate scrie
 * planuri, `personal` nu citește tabelele.
 */
describe.skipIf(!TEST_ADMIN_URL)("planuri și abonamente (Postgres real)", () => {
  let fx: AuthFixture;
  let migrator: ReturnType<typeof testClient>;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_plans_12a");
    migrator = testClient(fx.scratch.migratorUrl, 1);
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await fx?.close();
  });

  const ent = () => createEntitlements("saas", config, fx.db);

  async function household(): Promise<string> {
    const r = await createUserWithHousehold(fx.db, {
      email: `p-${randomUUID().slice(0, 8)}@exemplu.ro`,
      name: "Ana",
      password: null,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    if (!r.created) throw new Error("cont neașteptat");
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    return row!.household_id;
  }

  async function plan(
    code: string,
    values: { limits?: Record<string, unknown>; features?: string[]; isDefault?: boolean },
  ): Promise<string> {
    const [row] = await migrator<{ id: string }[]>`
      insert into finet.plans (code, name, is_default, limits, features)
      values (${code}, ${code}, ${values.isDefault ?? false},
              ${migrator.json((values.limits ?? {}) as never)}, ${values.features ?? []}::text[])
      returning id`;
    return row!.id;
  }

  async function subscribe(
    hh: string,
    planId: string,
    status: string,
    extra: { periodEnd?: string | null; trialEnd?: string | null } = {},
  ) {
    await migrator`
      insert into finet.subscriptions (household_id, plan_id, status, provider, current_period_end, trial_end)
      values (${hh}, ${planId}, ${status}, 'manual', ${extra.periodEnd ?? null}, ${extra.trialEnd ?? null})
      on conflict (household_id) do update
        set plan_id = excluded.plan_id, status = excluded.status,
            current_period_end = excluded.current_period_end, trial_end = excluded.trial_end`;
  }

  it("fără niciun plan în bază: FAIL CLOSED (state none, can false, limit 0), nu aruncă", async () => {
    const hh = await household();
    expect((await householdPlan(fx.db, hh)).state).toBe("none");
    await expect(ent().can(hh, "ask.finet")).resolves.toBe(false);
    await expect(ent().limit(hh, "ai.dailyDocuments")).resolves.toBe(0);
    await expect(ent().limit(hh, "storage.quotaMb")).resolves.toBe(0);
    await expect(ent().limit(hh, "household.maxMembers")).resolves.toBe(0);
    // Bugetul AI e global, nu al planului.
    await expect(ent().limit(hh, "ai.monthlyBudget")).resolves.toEqual({
      amountMinor: 2500n,
      currency: "EUR",
    });
  });

  it("fără abonament, planul implicit decide; limitele lipsă sau invalide din plan valorează 0", async () => {
    await plan("starter", {
      isDefault: true,
      limits: {
        "ai.dailyDocuments": 3,
        "storage.quotaMb": 50,
        "household.maxMembers": -1, // invalid → 0
        "unknown.key": 7,
      },
      features: ["reports.custom"],
    });
    const hh = await household();
    const p = await householdPlan(fx.db, hh);
    expect(p).toMatchObject({ code: "starter", state: "ok" });
    await expect(ent().limit(hh, "ai.dailyDocuments")).resolves.toBe(3);
    await expect(ent().limit(hh, "storage.quotaMb")).resolves.toBe(50);
    await expect(ent().limit(hh, "household.maxMembers")).resolves.toBe(0);
    await expect(ent().can(hh, "reports.custom")).resolves.toBe(true);
    await expect(ent().can(hh, "ask.finet")).resolves.toBe(false);
  });

  it("valorile ne-întregi sau de alt tip din plan se ignoră (0), nu se rotunjesc", async () => {
    const id = await plan("sloppy", {
      limits: { "ai.dailyDocuments": 2.5, "storage.quotaMb": "100", "household.maxMembers": 4 },
    });
    const hh = await household();
    await subscribe(hh, id, "active");
    await expect(ent().limit(hh, "ai.dailyDocuments")).resolves.toBe(0);
    await expect(ent().limit(hh, "storage.quotaMb")).resolves.toBe(0);
    await expect(ent().limit(hh, "household.maxMembers")).resolves.toBe(4);
  });

  it("abonament viu → planul lui; `trialing` expiră la trial_end, `active` la current_period_end", async () => {
    const pro = await plan("pro", {
      limits: { "ai.dailyDocuments": 50, "storage.quotaMb": 5000, "household.maxMembers": 2 },
      features: ["ask.finet"],
    });
    const hh = await household();
    await subscribe(hh, pro, "trialing", { trialEnd: "2999-01-01T00:00:00Z" });
    expect(await householdPlan(fx.db, hh)).toMatchObject({ code: "pro", state: "ok" });
    await expect(ent().limit(hh, "ai.dailyDocuments")).resolves.toBe(50);
    await expect(ent().can(hh, "ask.finet")).resolves.toBe(true);

    await subscribe(hh, pro, "trialing", { trialEnd: "2000-01-01T00:00:00Z" });
    expect((await householdPlan(fx.db, hh)).state).toBe("read_only");

    await subscribe(hh, pro, "active", { periodEnd: "2999-01-01T00:00:00Z" });
    expect((await householdPlan(fx.db, hh)).state).toBe("ok");
    await subscribe(hh, pro, "active", { periodEnd: "2000-01-01T00:00:00Z" });
    expect((await householdPlan(fx.db, hh)).state).toBe("read_only");

    // `past_due` rămâne viu până la sfârșitul perioadei; fără sfârșit (manual, fondator) nu expiră.
    await subscribe(hh, pro, "past_due", { periodEnd: "2999-01-01T00:00:00Z" });
    expect((await householdPlan(fx.db, hh)).state).toBe("ok");
    await subscribe(hh, pro, "active", { periodEnd: null });
    expect((await householdPlan(fx.db, hh)).state).toBe("ok");
  });

  it("abonament anulat sau expirat → read_only: can false, limitele 0 (datele rămân citibile)", async () => {
    const pro = await plan("pro2", {
      limits: { "ai.dailyDocuments": 50 },
      features: ["ask.finet", "reports.custom"],
    });
    for (const status of ["canceled", "expired"]) {
      const hh = await household();
      await subscribe(hh, pro, status);
      expect((await householdPlan(fx.db, hh)).state, status).toBe("read_only");
      await expect(ent().can(hh, "ask.finet"), status).resolves.toBe(false);
      await expect(ent().limit(hh, "ai.dailyDocuments"), status).resolves.toBe(0);
    }
  });

  it("izolare: abonamentul unei gospodării nu schimbă planul alteia", async () => {
    const big = await plan("big", { limits: { "ai.dailyDocuments": 500 } });
    const a = await household();
    const b = await household();
    await subscribe(a, big, "active");
    await expect(ent().limit(a, "ai.dailyDocuments")).resolves.toBe(500);
    await expect(ent().limit(b, "ai.dailyDocuments")).resolves.toBe(3); // planul implicit
  });

  it("un singur plan implicit, activ; codul și numele sunt validate de CHECK-uri", async () => {
    await expect(plan("another-default", { isDefault: true })).rejects.toThrow();
    await expect(plan("Cod Rău", {})).rejects.toThrow();
    await expect(
      migrator`insert into finet.plans (code, name, limits) values ('arr', 'arr', '[1]'::jsonb)`,
    ).rejects.toThrow();
    await expect(
      migrator`insert into finet.plans (code, name, features) values ('bad-f', 'bad', array['ok.fn', 'x y'])`,
    ).rejects.toThrow();
    await expect(
      migrator`insert into finet.plans (code, name, is_default, active) values ('inact', 'i', true, false)`,
    ).rejects.toThrow();
  });

  it("abonamentul Stripe cere id; id-ul furnizorului e unic (upsert idempotent în 12-B)", async () => {
    const p = await plan("stripe-plan", {});
    const a = await household();
    const b = await household();
    await expect(
      migrator`insert into finet.subscriptions (household_id, plan_id, status, provider)
        values (${a}, ${p}, 'active', 'stripe')`,
    ).rejects.toThrow();
    await migrator`insert into finet.subscriptions (household_id, plan_id, status, provider, provider_subscription_id)
      values (${a}, ${p}, 'active', 'stripe', 'sub_test_1')`;
    await expect(
      migrator`insert into finet.subscriptions (household_id, plan_id, status, provider, provider_subscription_id)
        values (${b}, ${p}, 'active', 'stripe', 'sub_test_1')`,
    ).rejects.toThrow();
  });

  it("aplicația (finet_app) nu poate scrie planuri sau abonamente, nici prin RLS, nici prin drepturi", async () => {
    const hh = await household();
    const p = await plan("x-plan", {});
    const app = testClient(fx.scratch.appUrl, 1);
    try {
      await expect(
        app`insert into finet.plans (code, name) values ('hack', 'hack')`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app`insert into finet.subscriptions (household_id, plan_id, status, provider)
          values (${hh}, ${p}, 'active', 'manual')`,
      ).rejects.toThrow(/permission denied/i);
      await expect(app`update finet.plans set limits = '{}'::jsonb`).rejects.toThrow(
        /permission denied/i,
      );
      await expect(app`delete from finet.subscriptions`).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it("citirea directă a abonamentelor: doar membrii gospodăriei (RLS); planurile doar pentru utilizatori autentificați", async () => {
    const mine = await household();
    const theirs = await household();
    const p = await plan("rls-plan", {});
    await subscribe(mine, p, "active");
    await subscribe(theirs, p, "active");
    const [member] = await fx.scratch.admin<{ user_id: string }[]>`
      select user_id from finet.household_members where household_id = ${mine} limit 1`;
    const app = testClient(fx.scratch.appUrl, 1);
    try {
      // Fără context de utilizator: nimic vizibil.
      expect(await app`select household_id from finet.subscriptions`).toHaveLength(0);
      expect(await app`select code from finet.plans`).toHaveLength(0);
      const rows = await app.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${member!.user_id}, true)`;
        return {
          subs: await tx<{ household_id: string }[]>`select household_id from finet.subscriptions`,
          plans: await tx`select code from finet.plans`,
        };
      });
      expect(rows.subs.map((r) => r.household_id)).toEqual([mine]);
      expect(rows.plans.length).toBeGreaterThan(0);
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  it("`personal` nu citește niciodată planurile: limitele vin din configurație, fără bază", async () => {
    const hh = await household();
    // Un client care aruncă la orice interogare: dacă `personal` ar citi planurile, testul pică.
    const exploding = {
      execute: () => {
        throw new Error("personal nu are voie să citească baza");
      },
    } as never;
    const e = createEntitlements("personal", personalConfig, exploding);
    await expect(e.can(hh, "ask.finet")).resolves.toBe(true);
    await expect(e.can(hh, "reports.custom")).resolves.toBe(true);
    await expect(e.limit(hh, "household.maxMembers")).resolves.toBe(UNLIMITED);
    await expect(e.limit(hh, "storage.quotaMb")).resolves.toBe(personalConfig.storage.quotaMb);
  });

  it("`saas` fără client de bază de date aruncă (eroare de programare), nu deschide accesul", async () => {
    const e = createEntitlements("saas", config);
    await expect(e.can(randomUUID(), "ask.finet")).rejects.toBeInstanceOf(TypeError);
    await expect(e.limit(randomUUID(), "storage.quotaMb")).rejects.toBeInstanceOf(TypeError);
  });

  it("household_plan: funcția nu e executabilă de PUBLIC, doar de finet_app", async () => {
    const [row] = await fx.scratch.admin<{ pub: boolean; app: boolean }[]>`
      select has_function_privilege('public', 'finet.household_plan(uuid)', 'execute') as pub,
             has_function_privilege('finet_app', 'finet.household_plan(uuid)', 'execute') as app`;
    expect(row).toEqual({ pub: false, app: true });
  });
});
