import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import { waitForBackgroundMail } from "@/modules/auth/mailer";
import { readRegistrationToken, signRegistrationToken } from "@/modules/auth/registration";
import {
  type AuthEnv,
  type AuthFixture,
  type FakeMailer,
  APP_URL,
  authEnv,
  createAuthFixture,
  fakeMailer,
  testConfig,
} from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";
import { parseRefCode, refCodeFromCookieHeader } from "@/modules/referrals/referrals.service";

import type { ApiDeps } from "./_lib/http";
import * as RF from "./_lib/referral-handlers";
import * as RG from "./_lib/register-handlers";
import { apiRequest, assertContract, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe("12-C: forma codului și cookie-ul", () => {
  it("parseRefCode: normalizează și respinge orice altceva", () => {
    expect(parseRefCode("fin-ab23cd")).toBe("FIN-AB23CD");
    expect(parseRefCode("  FIN-AB23CD ")).toBe("FIN-AB23CD");
    for (const bad of ["", "FIN-AB23C", "FIN-AB23CDE", "FIN-AB23CO", "FIN-AB23C1", "XYZ-AB23CD"]) {
      expect(parseRefCode(bad), bad).toBeNull();
    }
    expect(parseRefCode(undefined)).toBeNull();
    expect(parseRefCode("A".repeat(500))).toBeNull();
  });

  it("refCodeFromCookieHeader: citește doar finet_ref, doar dacă are forma unui cod", () => {
    expect(refCodeFromCookieHeader(null)).toBeNull();
    expect(refCodeFromCookieHeader("a=1; finet_ref=FIN-AB23CD; b=2")).toBe("FIN-AB23CD");
    expect(refCodeFromCookieHeader("finet_ref=garbage")).toBeNull();
    expect(refCodeFromCookieHeader("other=FIN-AB23CD")).toBeNull();
    expect(refCodeFromCookieHeader("finet_ref=%E0%A4%A")).toBeNull();
  });

  it("tokenul de înregistrare poartă codul; un cod stricat în token se ignoră, o semnătură alterată nu trece", () => {
    const secret = "secret-de-test-suficient-de-lung-0123456789";
    const token = signRegistrationToken(secret, "u1", "a@b.ro", Date.now(), "FIN-AB23CD");
    expect(readRegistrationToken(secret, token, Date.now())?.r).toBe("FIN-AB23CD");
    const plain = signRegistrationToken(secret, "u1", "a@b.ro", Date.now());
    expect(readRegistrationToken(secret, plain, Date.now())).not.toHaveProperty("r");
    const [body, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        r: "FIN-ZZZZZZ",
      }),
    ).toString("base64url");
    expect(readRegistrationToken(secret, `${forged}.${sig}`, Date.now())).toBeNull();
  });
});

/**
 * Recomandările prin API (12-C, felia 2; ADR 0037), pe Postgres real: `/referrals/me` (404 în
 * `personal`), codul din cookie ajunge în tokenul de înregistrare și se aplică la confirmare, pe orice
 * dispozitiv; un cod invalid nu strică înregistrarea.
 */
describe.skipIf(!TEST_ADMIN_URL)("12-C: recomandări prin API", () => {
  let fx: AuthFixture;
  let migrator: ReturnType<typeof testClient>;
  let mailer: FakeMailer;
  let saas: AuthEnv & ApiDeps;
  let personal: AuthEnv & ApiDeps;
  const PASS = "parola-recomandari-12c-1";
  const limits = {
    mutations: { max: 100_000, windowSeconds: 60 },
    exports: { max: 100_000, windowSeconds: 60 },
  };
  let counter = 0;
  const fresh = () => `ref${++counter}-${Date.now().toString(36)}@exemplu.ro`;
  const TOKEN_IN_MAIL = /register\/complete\?token=([^\s"&<]+)/;

  async function post(
    deps: ApiDeps,
    handler: typeof RG.registerHandler,
    path: string,
    body: unknown,
    headers = {},
  ) {
    const res = await handler(
      apiRequest(path, { method: "POST", body, headers: { origin: APP_URL, ...headers } }),
      deps,
    );
    const text = await res.clone().text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Loose };
  }
  async function registerAndComplete(email: string, cookie?: string) {
    const r = await post(
      saas,
      RG.registerHandler,
      "/api/v1/register",
      { email, name: "Ana Nouă", acceptTerms: true },
      cookie ? { cookie } : {},
    );
    expect(r.status).toBe(202);
    await waitForBackgroundMail();
    const mail = [...mailer.sent].reverse().find((m) => m.to === email)!;
    const token = decodeURIComponent(TOKEN_IN_MAIL.exec(mail.text)![1]!);
    const done = await post(saas, RG.completeRegisterHandler, "/api/v1/register/complete", {
      token,
      password: PASS,
    });
    return { token, status: done.status };
  }
  async function inviter() {
    const email = fresh();
    const r = await createUserWithHousehold(fx.db, {
      email,
      name: "Invitator",
      password: PASS,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    if (!r.created) throw new Error("cont neașteptat");
    const s = await sessionsFor(saas, email, PASS);
    const [h] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    return { userId: r.userId, householdId: h!.household_id, bearer: s.bearer };
  }
  const me = async (deps: ApiDeps, bearer?: string) => {
    const res = await RF.meReferralHandler(
      apiRequest("/api/v1/referrals/me", { ...(bearer ? { bearer } : {}) }),
      deps,
    );
    if (res.status === 200) await assertContract(RF.meReferralHandler, res);
    const text = await res.clone().text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Loose };
  };
  const rewardOf = async (householdId: string) => {
    const rows = await migrator<{ provider: string; plan: string }[]>`
      select s.provider, p.code as plan from finet.subscriptions s
        join finet.plans p on p.id = s.plan_id where s.household_id = ${householdId}`;
    return rows[0];
  };
  const householdOfEmail = async (email: string) => {
    const [h] = await fx.scratch.admin<{ id: string }[]>`
      select m.household_id as id from finet.household_members m
        join finet.users u on u.id = m.user_id where u.email = ${email} limit 1`;
    return h!.id;
  };

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_referral_api_12c");
    migrator = testClient(fx.scratch.migratorUrl, 1);
    mailer = fakeMailer();
    saas = {
      ...authEnv(fx.db, {
        config: testConfig({ APP_MODE: "saas", SIGNUP_ENABLED: "1" }),
        mailer,
      }),
      mailer,
      limits,
    };
    personal = { ...authEnv(fx.db), limits };
    await migrator`insert into finet.plans (code, name, limits, features)
      values ('pro', 'Pro', '{}'::jsonb, '{}'::text[])`;
    await migrator`update finet.referral_settings set reward_plan_code = 'pro',
      invitee_days = 30, inviter_days = 30, inviter_max_rewards = 5, redeem_window_hours = 72`;
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await fx?.close();
  });

  it("/referrals/me: fără sesiune 401, în personal 404, în saas codul, linkul și contoarele", async () => {
    const a = await inviter();
    expect((await me(saas)).status).toBe(401);
    expect((await me(personal, a.bearer)).status).toBe(404);
    const first = await me(saas, a.bearer);
    expect(first.status).toBe(200);
    expect(first.body.data.code).toMatch(/^FIN-[A-HJ-NP-Z2-9]{6}$/);
    expect(first.body.data.link).toBe(`${APP_URL}/ref/${first.body.data.code}`);
    expect(first.body.data).toMatchObject({ invited: 0, rewarded: 0 });
    expect((await me(saas, a.bearer)).body.data.code).toBe(first.body.data.code);
  });

  it("cookie → token → confirmare: ambele gospodării primesc recompensa; contoarele cresc; pe alt dispozitiv (fără cookie la pasul 2) merge la fel", async () => {
    const a = await inviter();
    const code = (await me(saas, a.bearer)).body.data.code as string;
    const email = fresh();
    const { token, status } = await registerAndComplete(email, `x=1; finet_ref=${code}`);
    expect(status).toBe(200);
    expect(readRegistrationToken(saas.config.auth.secret!, token, Date.now())?.r).toBe(code);
    expect(await rewardOf(a.householdId)).toEqual({ provider: "reward", plan: "pro" });
    expect(await rewardOf(await householdOfEmail(email))).toEqual({
      provider: "reward",
      plan: "pro",
    });
    expect((await me(saas, a.bearer)).body.data).toMatchObject({ invited: 1, rewarded: 1 });
  });

  it("fără cookie, cu cookie stricat sau cu un cod inexistent: înregistrarea reușește, nicio recompensă", async () => {
    for (const cookie of [undefined, "finet_ref=garbage", "finet_ref=FIN-AAAAAA"]) {
      const email = fresh();
      const { status } = await registerAndComplete(email, cookie);
      expect(status, String(cookie)).toBe(200);
      expect(await rewardOf(await householdOfEmail(email)), String(cookie)).toBeUndefined();
    }
  });

  it("recompensele oprite: înregistrarea reușește și nu se acordă nimic", async () => {
    const a = await inviter();
    const code = (await me(saas, a.bearer)).body.data.code as string;
    await migrator`update finet.referral_settings set reward_plan_code = null`;
    try {
      const email = fresh();
      expect((await registerAndComplete(email, `finet_ref=${code}`)).status).toBe(200);
      expect(await rewardOf(a.householdId)).toBeUndefined();
      expect(await rewardOf(await householdOfEmail(email))).toBeUndefined();
    } finally {
      await migrator`update finet.referral_settings set reward_plan_code = 'pro'`;
    }
  });
});
