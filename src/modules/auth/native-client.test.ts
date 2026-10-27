import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";

import { handleAuthRequest } from "./handler";
import {
  APP_URL,
  type AuthEnv,
  type AuthFixture,
  authEnv,
  authRequest,
  createAuthFixture,
  login,
  testConfig,
} from "./testing";
import { createUserWithHousehold } from "./users.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Clientul nativ (Android): fără `Origin`, fără `Sec-Fetch-*`, fără cookie-uri, doar
 * `Authorization: Bearer`. Plus: corpuri non-JSON pe căile limitate, expirarea cu ceas controlat
 * și înregistrarea în `saas`.
 */
describe.skipIf(!TEST_ADMIN_URL)("client nativ, corpuri non-JSON, ceas controlat", () => {
  let fx: AuthFixture;
  let env: AuthEnv;
  const PASSWORD = "parola-nativa-1234";

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_native");
    env = authEnv(fx.db);
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASSWORD,
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("login mobil fără Origin → 200 + set-auth-token; sign-out cu bearer fără Origin șterge sesiunea", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD, {
      origin: "",
      "x-finet-client": "android/1.0",
    });
    expect(r.response.status).toBe(200);
    expect(r.bearer).toBeTruthy();
    const before = await fx.scratch.admin`select id from finet.auth_sessions`;
    const out = await handleAuthRequest(
      authRequest("/api/auth/sign-out", {
        body: {},
        headers: { origin: "", authorization: `Bearer ${r.bearer}` },
      }),
      env,
    );
    expect(out.status).toBe(200);
    const after = await fx.scratch.admin`select id from finet.auth_sessions`;
    expect(after.length).toBe(before.length - 1);
    const session = await handleAuthRequest(
      authRequest("/api/auth/get-session", {
        headers: { origin: "", authorization: `Bearer ${r.bearer}` },
      }),
      env,
    );
    expect(await session.json()).toBeNull();
  });

  it("corpurile non-JSON pe căile limitate sunt refuzate (415), fără să ajungă la Better Auth", async () => {
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/reset-password",
      "/api/auth/sign-in/magic-link",
    ]) {
      const res = await handleAuthRequest(
        new Request(`${APP_URL}${path}`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: APP_URL },
          body: "email=ANA%40exemplu.ro&password=parola-nativa-1234&token=x&newPassword=scurta",
        }),
        env,
      );
      expect(res.status, path).toBe(415);
    }
    // Regula FINET nu se aplică altor căi (sign-out fără corp ajunge la Better Auth).
    const out = await handleAuthRequest(
      new Request(`${APP_URL}/api/auth/sign-out`, { method: "POST", headers: { origin: APP_URL } }),
      env,
    );
    const text = await out.text();
    expect(text).not.toContain("unsupported_media_type");
  });

  it("expirarea sesiunii cu ceas controlat: după 31 de zile get-session dă null", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD);
    expect(r.response.status).toBe(200);
    const check = async () =>
      (await handleAuthRequest(
        authRequest("/api/auth/get-session", { headers: { cookie: r.cookie } }),
        env,
      ).then((res) => res.json())) as unknown;
    expect(await check()).not.toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(await check()).toBeNull();
  });

  it("updateAge: după mai mult de o zi, folosirea sesiunii îi prelungește expirarea", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD);
    const { user } = (await r.response.clone().json()) as { user: { id: string } };
    const read = async () =>
      (
        await fx.scratch.admin<{ expires_at: Date }[]>`
          select expires_at from finet.auth_sessions where user_id = ${user.id}
          order by created_at desc limit 1`
      )[0]!.expires_at.getTime();
    const initial = await read();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await handleAuthRequest(
      authRequest("/api/auth/get-session", { headers: { cookie: r.cookie } }),
      env,
    );
    expect(await read()).toBeGreaterThan(initial + 24 * 60 * 60 * 1000);
  });

  it("saas: sign-up e închis și acolo (404, calea e dezactivată)", async () => {
    const saas = authEnv(fx.db, { config: testConfig({ APP_MODE: "saas" }) });
    const res = await handleAuthRequest(
      authRequest("/api/auth/sign-up/email", {
        body: { email: "nou@exemplu.ro", password: PASSWORD, name: "Nou" },
      }),
      saas,
    );
    expect(res.status).toBe(404);
    const rows = await fx.scratch.admin`select 1 from finet.users where email = 'nou@exemplu.ro'`;
    expect(rows.length).toBe(0);
  });
  it("Better Auth nu poate crea utilizatori în niciun mod (doar CLI-ul)", async () => {
    for (const mode of ["personal", "saas"]) {
      const e = authEnv(fx.db, { config: testConfig({ APP_MODE: mode }) });
      const ctx = await e.auth.$context;
      const created = await ctx.internalAdapter
        .createUser(
          { email: `ba-${mode}@exemplu.ro`, name: "BA", emailVerified: true },
          { method: "magic-link" },
        )
        .catch(() => null);
      expect(created ?? null, mode).toBeNull();
      const rows = await fx.scratch
        .admin`select 1 from finet.users where email = ${`ba-${mode}@exemplu.ro`}`;
      expect(rows.length, mode).toBe(0);
    }
  });
});
