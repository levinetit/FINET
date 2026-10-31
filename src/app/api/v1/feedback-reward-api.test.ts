import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db/rls";
import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  createAuthFixture,
  testConfig,
} from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import * as AD from "./_lib/admin-handlers";
import type { ApiDeps } from "./_lib/http";
import { type ApiInit, apiRequest, assertContract, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Handler = (request: Request, deps: ApiDeps, ...rest: string[]) => Promise<Response>;

/**
 * Recompensa pentru feedback validat (12-C, felia 3; ADR 0037) prin API, pe Postgres real: acțiune
 * explicită a administratorului, oprită implicit, o dată pe utilizator, plafon global, fără
 * auto-recompensă, abonamentele manual/fondator neatinse; non-administratorul primește 404.
 */
describe.skipIf(!TEST_ADMIN_URL)("12-C/3: recompensa pentru feedback", () => {
  let fx: AuthFixture;
  let migrator: ReturnType<typeof testClient>;
  let saas: AuthEnv & ApiDeps;
  let personal: AuthEnv & ApiDeps;
  const PASS = "parola-feedback-12c3-1";
  const limits = {
    mutations: { max: 100_000, windowSeconds: 60 },
    exports: { max: 100_000, windowSeconds: 60 },
  };
  let seq = 0;

  async function call(
    deps: ApiDeps,
    handler: Handler,
    path: string,
    init: ApiInit,
    ...rest: string[]
  ) {
    const res = await handler(apiRequest(path, init), deps, ...rest);
    if (res.status === 200) await assertContract(handler, res);
    const text = await res.clone().text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Loose };
  }

  async function person(admin = false) {
    const email = `fb${++seq}-${Date.now().toString(36)}@exemplu.ro`;
    const r = await createUserWithHousehold(fx.db, {
      email,
      name: "Ana",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    if (!r.created) throw new Error("cont neașteptat");
    if (admin)
      await fx.scratch
        .admin`update finet.users set is_platform_admin = true where id = ${r.userId}`;
    const [h] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    const s = await sessionsFor(saas, email, PASS);
    return { userId: r.userId, householdId: h!.household_id, bearer: s.bearer };
  }
  const feedbackOf = async (userId: string) => {
    const [row] = await fx.scratch.admin<{ id: string }[]>`
      insert into finet.feedback (user_id, kind, message) values (${userId}, 'feedback', 'mesaj de test')
      returning id`;
    return row!.id;
  };
  const reward = (bearer: string | undefined, id: string, deps: ApiDeps = saas) =>
    call(
      deps,
      AD.adminRewardFeedbackHandler,
      `/api/v1/admin/feedback/${id}/reward`,
      { method: "POST", ...(bearer ? { bearer } : {}) },
      id,
    );
  const sub = async (householdId: string) => {
    const rows = await migrator<{ provider: string; days: number | null }[]>`
      select provider, round(extract(epoch from (current_period_end - now())) / 86400)::int as days
        from finet.subscriptions where household_id = ${householdId}`;
    return rows[0];
  };
  const configure = (days: number, max: number) =>
    migrator`update finet.referral_settings set reward_plan_code = 'pro',
      feedback_days = ${days}, feedback_max_rewards = ${max}`;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_feedback_reward_12c3");
    migrator = testClient(fx.scratch.migratorUrl, 1);
    saas = { ...authEnv(fx.db, { config: testConfig({ APP_MODE: "saas" }) }), limits };
    personal = { ...authEnv(fx.db), limits };
    await migrator`insert into finet.plans (code, name, limits, features)
      values ('pro', 'Pro', '{}'::jsonb, '{}'::text[])`;
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await fx?.close();
  });

  it("implicit oprit: status disabled, nimic acordat", async () => {
    const admin = await person(true);
    const author = await person();
    const id = await feedbackOf(author.userId);
    const res = await reward(admin.bearer, id);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id, status: "disabled" });
    expect(await sub(author.householdId)).toBeUndefined();
  });

  it("doar administratorul, doar în saas: altfel 404 (și 401 fără sesiune)", async () => {
    const admin = await person(true);
    const user = await person();
    const id = await feedbackOf(user.userId);
    expect((await reward(user.bearer, id)).status).toBe(404);
    expect((await reward(undefined, id)).status).toBe(401);
    expect((await reward(admin.bearer, id, personal)).status).toBe(404);
    await expect(
      withRlsOn(fx.db, { userId: user.userId }, (tx) =>
        tx.execute(sql`select finet.admin_reward_feedback(${id}::uuid)`),
      ),
    ).rejects.toThrow();
  });

  it("acordă o dată pe utilizator, auditat și vizibil în listă; al doilea feedback → already", async () => {
    await configure(14, 10);
    const admin = await person(true);
    const author = await person();
    const first = await feedbackOf(author.userId);
    const res = await reward(admin.bearer, first);
    expect(res.body.data).toEqual({ id: first, status: "ok" });
    expect(await sub(author.householdId)).toMatchObject({ provider: "reward", days: 14 });
    const again = await reward(admin.bearer, await feedbackOf(author.userId));
    expect(again.body.data.status).toBe("already");
    expect((await sub(author.householdId))!.days).toBe(14);
    const audits = await fx.scratch.admin<{ target_id: string }[]>`
      select target_id from finet.audit_events where action = 'admin.feedback_rewarded'`;
    expect(audits.map((a) => a.target_id)).toEqual([first]);
    const list = await call(saas, AD.adminFeedbackHandler, "/api/v1/admin/feedback", {
      bearer: admin.bearer,
    });
    const rows = list.body.data as { id: string; rewarded: boolean }[];
    expect(rows.find((r) => r.id === first)!.rewarded).toBe(true);
  });

  it("plafonul global: după N recompense → capped; auto-recompensa și feedback inexistent", async () => {
    await configure(7, 2);
    const admin = await person(true);
    await fx.scratch.admin`delete from finet.feedback_rewards`;
    const a = await person();
    const b = await person();
    const c = await person();
    expect((await reward(admin.bearer, await feedbackOf(a.userId))).body.data.status).toBe("ok");
    expect((await reward(admin.bearer, await feedbackOf(b.userId))).body.data.status).toBe("ok");
    expect((await reward(admin.bearer, await feedbackOf(c.userId))).body.data.status).toBe(
      "capped",
    );
    expect(await sub(c.householdId)).toBeUndefined();
    await configure(7, 100);
    expect((await reward(admin.bearer, await feedbackOf(admin.userId))).body.data.status).toBe(
      "self",
    );
    const nil = "00000000-0000-4000-8000-000000000000";
    expect((await reward(admin.bearer, nil)).status).toBe(404);
    expect((await reward(admin.bearer, "nu-e-uuid")).status).toBe(404);
  });

  it("abonament manual/fondator: not_applicable, nimic înregistrat, abonamentul neatins", async () => {
    await configure(7, 100);
    const admin = await person(true);
    const author = await person();
    const [plan] = await migrator<{ id: string }[]>`select id from finet.plans where code = 'pro'`;
    await migrator`insert into finet.subscriptions (household_id, plan_id, status, provider)
      values (${author.householdId}, ${plan!.id}, 'active', 'manual')`;
    const id = await feedbackOf(author.userId);
    expect((await reward(admin.bearer, id)).body.data.status).toBe("not_applicable");
    expect(await sub(author.householdId)).toMatchObject({ provider: "manual" });
    expect(
      await migrator`select 1 from finet.feedback_rewards where user_id = ${author.userId}`,
    ).toHaveLength(0);
    // După ce abonamentul dispare, aceeași recompensă se poate acorda.
    await migrator`delete from finet.subscriptions where household_id = ${author.householdId}`;
    expect((await reward(admin.bearer, id)).body.data.status).toBe("ok");
  });
});
