import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db/rls";
import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import { householdPlan } from "./index";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Person = { userId: string; householdId: string };

/**
 * Recomandările (0025, Faza 12-C; ADR 0037) pe Postgres real: regulile sunt în baza de date
 * (`redeem_referral`), recompensele sunt DATE ale operatorului (oprite implicit), un abonament
 * `reward` expirat nu blochează scrierile, iar abonamentele `manual`/`founder` nu sunt atinse.
 */
describe.skipIf(!TEST_ADMIN_URL)("12-C: recomandări (Postgres real)", () => {
  let fx: AuthFixture;
  let migrator: ReturnType<typeof testClient>;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_referrals_12c");
    migrator = testClient(fx.scratch.migratorUrl, 1);
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await fx?.close();
  });

  async function person(verified = true): Promise<Person> {
    const r = await createUserWithHousehold(fx.db, {
      email: `r-${randomUUID().slice(0, 8)}@exemplu.ro`,
      name: "Ana",
      password: null,
      firstUserBecomesAdmin: false,
      emailVerified: verified,
    });
    if (!r.created) throw new Error("cont neașteptat");
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    return { userId: r.userId, householdId: row!.household_id };
  }

  const as = <T>(
    userId: string,
    fn: (tx: Parameters<Parameters<typeof withRlsOn>[2]>[0]) => Promise<T>,
  ) => withRlsOn(fx.db, { userId }, fn);
  const codeOf = async (p: Person): Promise<string> =>
    as(p.userId, async (tx) => {
      const rows = await tx.execute(sql`select finet.my_referral_code() as c`);
      return (rows[0] as { c: string }).c;
    });
  const redeem = async (p: Person, code: string): Promise<string> =>
    as(p.userId, async (tx) => {
      const rows = await tx.execute(sql`select finet.redeem_referral(${code}) as r`);
      return (rows[0] as { r: string }).r;
    });
  const sub = async (householdId: string) => {
    const rows = await migrator<
      { provider: string; status: string; plan: string; days: number | null }[]
    >`
      select s.provider, s.status, p.code as plan,
             round(extract(epoch from (s.current_period_end - now())) / 86400)::int as days
        from finet.subscriptions s join finet.plans p on p.id = s.plan_id
       where s.household_id = ${householdId}`;
    return rows[0];
  };
  async function configure(values: {
    plan?: string | null;
    invitee?: number;
    inviter?: number;
    max?: number;
    window?: number;
  }) {
    await migrator`
      update finet.referral_settings set
        reward_plan_code = ${values.plan === undefined ? "pro" : values.plan},
        invitee_days = ${values.invitee ?? 30}, inviter_days = ${values.inviter ?? 30},
        inviter_max_rewards = ${values.max ?? 5}, redeem_window_hours = ${values.window ?? 24}`;
  }
  async function reset() {
    await migrator`delete from finet.referrals`;
    await migrator`delete from finet.subscriptions`;
    await migrator`update finet.referral_settings set reward_plan_code = null, invitee_days = 0,
      inviter_days = 0, inviter_max_rewards = 0, redeem_window_hours = 24`;
  }

  beforeAll(async () => {
    await migrator`
      insert into finet.plans (code, name, limits, features)
      values ('pro', 'Pro', '{"household.maxMembers": 5}'::jsonb, array['ask.finet'])`;
  });

  it("implicit oprit: fără setări nu se acordă nimic și nu se înregistrează nicio recomandare", async () => {
    await reset();
    const a = await person();
    const b = await person();
    const code = await codeOf(a);
    expect(await redeem(b, code)).toBe("disabled");
    expect((await migrator`select 1 from finet.referrals`).length).toBe(0);
    expect(await sub(a.householdId)).toBeUndefined();
  });

  it("codul propriu: FIN-XXXXXX, stabil, distinct pe utilizator; fără utilizator → eroare", async () => {
    const a = await person();
    const b = await person();
    const ca = await codeOf(a);
    expect(ca).toMatch(/^FIN-[A-HJ-NP-Z2-9]{6}$/);
    expect(await codeOf(a)).toBe(ca);
    expect(await codeOf(b)).not.toBe(ca);
    await expect(
      withRlsOn(fx.db, { userId: null }, (tx) => tx.execute(sql`select finet.my_referral_code()`)),
    ).rejects.toThrow();
  });

  it("recompensă pentru ambii; a doua folosire a unui cod de același invitat → already, fără alt acord", async () => {
    await reset();
    await configure({});
    const a = await person();
    const b = await person();
    const code = await codeOf(a);
    expect(await redeem(b, code.toLowerCase() + " ")).toBe("ok");
    for (const p of [a, b]) {
      const s = await sub(p.householdId);
      expect(s).toMatchObject({ provider: "reward", status: "active", plan: "pro" });
      expect(s!.days).toBe(30);
      expect((await householdPlan(fx.db, p.householdId)).code).toBe("pro");
    }
    const c = await person();
    expect(await redeem(b, await codeOf(c))).toBe("already");
    expect(await sub(c.householdId)).toBeUndefined();
    expect((await sub(b.householdId))!.days).toBe(30);
  });

  it("refuzuri: auto-recomandare, gospodărie comună, cod invalid, cont neconfirmat, fereastră depășită", async () => {
    await reset();
    await configure({});
    const a = await person();
    const code = await codeOf(a);
    expect(await redeem(a, code)).toBe("self");
    // B intră în gospodăria lui A: același nucleu familial → nu poate folosi codul lui A.
    const b = await person();
    await fx.scratch.admin`
      insert into finet.household_members (household_id, user_id, role)
      values (${a.householdId}, ${b.userId}, 'member')`;
    expect(await redeem(b, code)).toBe("self");
    expect(await redeem(await person(), "FIN-AAAAAA")).toBe("invalid");
    expect(await redeem(await person(false), code)).toBe("not_eligible");
    const old = await person();
    await fx.scratch
      .admin`update finet.users set created_at = now() - interval '3 days' where id = ${old.userId}`;
    expect(await redeem(old, code)).toBe("expired");
    expect((await migrator`select 1 from finet.referrals`).length).toBe(0);
    expect(await sub(a.householdId)).toBeUndefined();
  });

  it("plafonul invitatorului: după N recompense invitatul tot primește, invitatorul nu", async () => {
    await reset();
    await configure({ max: 2 });
    const a = await person();
    const code = await codeOf(a);
    const invitees: Person[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await person();
      invitees.push(p);
      expect(await redeem(p, code)).toBe("ok");
    }
    for (const p of invitees) expect((await sub(p.householdId))!.plan).toBe("pro");
    // Invitatorul a primit 2 × 30 de zile, nu 3 × 30.
    expect((await sub(a.householdId))!.days).toBe(60);
    const rows = await migrator<{ inviter_rewarded: boolean }[]>`
      select inviter_rewarded from finet.referrals where inviter_user_id = ${a.userId}`;
    expect(rows.filter((r) => r.inviter_rewarded)).toHaveLength(2);
  });

  it("stările abonamentului invitatorului: fondator/manual (viu sau expirat) neatinse; reward viu se prelungește; reward expirat repornește", async () => {
    await reset();
    await configure({});
    const [free] = await migrator<{ id: string }[]>`
      insert into finet.plans (code, name, limits, features)
      values ('altceva', 'Altceva', '{}'::jsonb, '{}'::text[]) returning id`;
    const mk = async (provider: string, status: string, endExpr: string | null) => {
      const p = await person();
      await migrator.unsafe(
        `insert into finet.subscriptions (household_id, plan_id, status, provider, current_period_end)
         values ('${p.householdId}', '${free!.id}', '${status}', '${provider}', ${endExpr ?? "null"})`,
      );
      return p;
    };
    const founder = await mk("founder", "active", null);
    const manualLive = await mk("manual", "active", "now() + interval '10 days'");
    const manualExpired = await mk("manual", "expired", "now() - interval '5 days'");
    const rewardLive = await mk("reward", "active", "now() + interval '10 days'");
    const rewardExpired = await mk("reward", "active", "now() - interval '5 days'");
    for (const inviter of [founder, manualLive, manualExpired, rewardLive, rewardExpired]) {
      expect(await redeem(await person(), await codeOf(inviter))).toBe("ok");
    }
    expect(await sub(founder.householdId)).toMatchObject({ provider: "founder", plan: "altceva" });
    expect(await sub(manualLive.householdId)).toMatchObject({ provider: "manual", days: 10 });
    expect(await sub(manualExpired.householdId)).toMatchObject({
      provider: "manual",
      status: "expired",
    });
    expect(await sub(rewardLive.householdId)).toMatchObject({
      provider: "reward",
      plan: "pro",
      days: 40,
    });
    expect(await sub(rewardExpired.householdId)).toMatchObject({
      provider: "reward",
      plan: "pro",
      days: 30,
    });
    // Abonamentul manual expirat rămâne doar-citire (decizia operatorului nu e anulată de o recompensă).
    expect((await householdPlan(fx.db, manualExpired.householdId)).state).toBe("read_only");
  });

  it("o recompensă expirată NU blochează scrierile: revine la planul implicit (sau none fără el)", async () => {
    await reset();
    const h = (await person()).householdId;
    const [pro] = await migrator<{ id: string }[]>`select id from finet.plans where code = 'pro'`;
    await migrator`
      insert into finet.subscriptions (household_id, plan_id, status, provider, current_period_end)
      values (${h}, ${pro!.id}, 'active', 'reward', now() - interval '1 day')`;
    expect((await householdPlan(fx.db, h)).state).toBe("none");
    await migrator`
      insert into finet.plans (code, name, is_default, limits, features)
      values ('baza', 'Bază', true, '{}'::jsonb, '{}'::text[])`;
    const after = await householdPlan(fx.db, h);
    expect(after.state).toBe("ok");
    expect(after.code).toBe("baza");
    await migrator`delete from finet.plans where code = 'baza'`;
  });

  it("aplicația nu poate scrie direct și nu poate apela funcția internă; vede doar ce e al ei", async () => {
    await reset();
    await configure({});
    const a = await person();
    const b = await person();
    await redeem(b, await codeOf(a));
    await expect(
      as(a.userId, (tx) =>
        tx.execute(sql`select finet.grant_reward(${a.householdId}::uuid, 9999)`),
      ),
    ).rejects.toThrow();
    await expect(
      as(a.userId, (tx) =>
        tx.execute(
          sql`insert into finet.referrals (invitee_user_id, inviter_user_id) values (${a.userId}, ${b.userId})`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      as(a.userId, (tx) => tx.execute(sql`update finet.referral_settings set invitee_days = 3650`)),
    ).rejects.toThrow();
    await expect(
      as(a.userId, (tx) => tx.execute(sql`select * from finet.referral_settings`)),
    ).rejects.toThrow();
    const mine = await as(b.userId, async (tx) => {
      const codes = await tx.execute(sql`select count(*)::int as n from finet.referral_codes`);
      const refs = await tx.execute(sql`select count(*)::int as n from finet.referrals`);
      return [(codes[0] as { n: number }).n, (refs[0] as { n: number }).n];
    });
    // B nu are cod propriu (nu l-a cerut) și vede propria recomandare.
    expect(mine).toEqual([0, 1]);
  });

  it("migrația fixează valori goale: planul implicit al setărilor e fără recompensă", async () => {
    await reset();
    const [row] = await migrator<{ reward_plan_code: string | null; invitee_days: number }[]>`
      select reward_plan_code, invitee_days from finet.referral_settings`;
    expect(row).toEqual({ reward_plan_code: null, invitee_days: 0 });
  });
});
