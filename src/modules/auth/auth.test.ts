import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { isRequestAllowed } from "@/lib/access";

import { SESSION_EXPIRES_IN_SECONDS } from "./auth";
import { authSubpath, handleAuthRequest } from "./handler";
import { dailyStatKey } from "./rate-limit";
import {
  APP_URL,
  type AuthEnv,
  type AuthFixture,
  authEnv,
  authRequest,
  cookieHeader,
  createAuthFixture,
  login,
  testConfig,
} from "./testing";
import { createUserWithHousehold } from "./users.service";

// Argon2id (19 MiB) și Better Auth pe o bază reală: câteva secunde pe test pe CI încărcat.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("authSubpath", () => {
  it("normalizează calea (majuscule, `/` final, `//`)", () => {
    expect(authSubpath("/api/auth/sign-up/email")).toBe("/sign-up/email");
    expect(authSubpath("/API/AUTH/Sign-Up/Email/")).toBe("/sign-up/email");
    expect(authSubpath("/api/auth//sign-up")).toBe("/sign-up");
    expect(authSubpath("/api/auth/sign-%75p/email")).toBe("/sign-up/email");
    expect(authSubpath("/api/v1/me")).toBeNull();
  });
});

describe("proxy: /api/auth/* trece tot prin JWT Access", () => {
  it("fără JWT, cu Access obligatoriu, cererea e refuzată", async () => {
    for (const pathname of ["/api/auth/sign-in/email", "/api/auth/get-session", "/api/v1/me"]) {
      expect(
        await isRequestAllowed(
          { method: "POST", pathname, headers: new Headers() },
          { required: true, verify: async () => ({}), healthToken: null },
        ),
      ).toBe(false);
    }
  });
});

describe.skipIf(!TEST_ADMIN_URL)("Better Auth pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv;
  const PASSWORD = "parola-corecta-123";
  let anaId: string;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_auth");
    env = authEnv(fx.db);
    const ana = await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASSWORD,
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
    anaId = ana.userId;
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("login cu parolă (email cu spații și majuscule) → cookie HttpOnly, SameSite=Lax", async () => {
    const r = await login(env, "  ANA@Exemplu.ro ", PASSWORD);
    expect(r.response.status).toBe(200);
    const body = (await r.response.json()) as { user: { id: string; email: string } };
    expect(body.user.id).toBe(anaId);
    const setCookie = r.response.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/finet\.session_token=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // Răspunsul nu conține hash-ul parolei.
    expect(JSON.stringify(body)).not.toContain("argon2");
  });

  it("cu APP_URL https, cookie-ul de sesiune e Secure (prefix __Secure-)", async () => {
    const httpsEnv = authEnv(fx.db, {
      config: testConfig({ APP_URL: "https://finet.exemplu.invalid" }),
    });
    const r = await handleAuthRequest(
      new Request("https://finet.exemplu.invalid/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://finet.exemplu.invalid" },
        body: JSON.stringify({ email: "ana@exemplu.ro", password: PASSWORD }),
      }),
      httpsEnv,
    );
    expect(r.status).toBe(200);
    const setCookie = r.headers.getSetCookie().find((c) => c.includes("session_token="))!;
    expect(setCookie).toMatch(/^__Secure-finet\.session_token=/);
    expect(setCookie).toMatch(/; Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });

  it("parolă greșită și email inexistent dau același răspuns (401), numărate agregat", async () => {
    const before = await fx.scratch.admin`
      select count from finet.auth_rate_limits where key = ${dailyStatKey("login_failed")}`;
    const wrong = await login(env, "ana@exemplu.ro", "parola-gresita-123");
    const unknown = await login(env, "nimeni@exemplu.ro", "parola-gresita-123");
    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(await wrong.response.json()).toEqual(await unknown.response.json());
    expect(wrong.cookie).toBe("");
    const after = await fx.scratch.admin`
      select count from finet.auth_rate_limits where key = ${dailyStatKey("login_failed")}`;
    expect(Number(after[0]!.count) - Number(before[0]?.count ?? 0)).toBe(2);
  });

  it("personal: POST /api/auth/sign-up/* → 404, oricum ar fi scrisă calea", async () => {
    for (const path of [
      "/api/auth/sign-up/email",
      "/api/auth/SIGN-UP/email/",
      "/api/auth/sign-up",
      "/api/auth//sign-up/email",
    ]) {
      const res = await handleAuthRequest(
        authRequest(path, { body: { email: "nou@exemplu.ro", password: PASSWORD, name: "Nou" } }),
        env,
      );
      expect(res.status, path).toBe(404);
    }
    const rows = await fx.scratch.admin`select 1 from finet.users where email = 'nou@exemplu.ro'`;
    expect(rows.length).toBe(0);
  });

  it("logout (sign-out) șterge sesiunea din bază", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD);
    const token = r.cookie.match(/finet\.session_token=([^.;]+)/)![1]!;
    const out = await handleAuthRequest(
      authRequest("/api/auth/sign-out", { body: {}, headers: { cookie: r.cookie } }),
      env,
    );
    expect(out.status).toBe(200);
    const rows = await fx.scratch
      .admin`select 1 from finet.auth_sessions where token = ${decodeURIComponent(token)}`;
    expect(rows.length).toBe(0);
    const session = await handleAuthRequest(
      authRequest("/api/auth/get-session", { headers: { cookie: r.cookie } }),
      env,
    );
    expect(await session.json()).toBeNull();
  });

  it("sesiunea expiră după 30 de zile (expires_at în bază) și e respinsă după expirare", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD);
    const { user } = (await r.response.clone().json()) as { user: { id: string } };
    const rows = await fx.scratch.admin<{ id: string; expires_at: Date }[]>`
      select id, expires_at from finet.auth_sessions where user_id = ${user.id}
      order by created_at desc limit 1`;
    const ms = rows[0]!.expires_at.getTime() - Date.now();
    expect(Math.abs(ms - SESSION_EXPIRES_IN_SECONDS * 1000)).toBeLessThan(60_000);
    await fx.scratch.admin`
      update finet.auth_sessions set expires_at = now() - interval '1 second' where id = ${rows[0]!.id}`;
    const session = await handleAuthRequest(
      authRequest("/api/auth/get-session", { headers: { cookie: r.cookie } }),
      env,
    );
    expect(await session.json()).toBeNull();
  });

  it("căile închise (list-sessions, change-password, update-user) răspund 404", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD);
    for (const path of [
      "/api/auth/list-sessions",
      "/api/auth/change-password",
      "/api/auth/update-user",
    ]) {
      const res = await handleAuthRequest(
        authRequest(path, { body: {}, headers: { cookie: r.cookie } }),
        env,
      );
      expect(res.status, path).toBe(404);
    }
  });

  it("un utilizator dezactivat nu se poate autentifica (același mesaj)", async () => {
    await createUserWithHousehold(fx.db, {
      email: "dez@exemplu.ro",
      name: "Dez",
      password: PASSWORD,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    await fx.scratch
      .admin`update finet.users set status = 'disabled' where email = 'dez@exemplu.ro'`;
    const r = await login(env, "dez@exemplu.ro", PASSWORD);
    expect(r.response.status).toBe(401);
    expect(r.cookie).toBe("");
  });

  it("IP-ul sesiunii vine doar din cf-connecting-ip cu Access verificat; antetele clientului sunt ignorate", async () => {
    // Fără Access: antetul intern trimis de client nu ajunge în sesiune.
    const spoof = await login(env, "ana@exemplu.ro", PASSWORD, {
      "x-finet-client-ip": "198.51.100.9",
      "cf-connecting-ip": "198.51.100.10",
    });
    expect(spoof.response.status).toBe(200);
    const accessEnv = authEnv(fx.db, {
      config: testConfig({
        CF_ACCESS_REQUIRED: "true",
        CF_ACCESS_TEAM_DOMAIN: "echipa-exemplu.cloudflareaccess.com",
        CF_ACCESS_AUD: "aud-fictiv-0123456789",
      }),
    });
    const real = await login(accessEnv, "ana@exemplu.ro", PASSWORD, {
      "x-finet-client-ip": "198.51.100.9",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(real.response.status).toBe(200);
    const ips = await fx.scratch.admin<{ ip_address: string | null }[]>`
      select ip_address from finet.auth_sessions where user_id = ${anaId}`;
    const values = ips.map((r) => r.ip_address);
    expect(values).toContain("203.0.113.7");
    expect(values).not.toContain("198.51.100.9");
    expect(values).not.toContain("198.51.100.10");
  });

  it("login reușit scrie în audit (fără date personale)", async () => {
    await login(env, "ana@exemplu.ro", PASSWORD);
    const rows = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events
       where actor_user_id = ${anaId} and action = 'auth.login_succeeded'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.metadata).toEqual({ method: "password", platform: "web" });
    expect(JSON.stringify(rows)).not.toContain("ana@");
  });

  it("cookie-ul de sesiune e respins dacă Origin e străin (CSRF pe /api/auth)", async () => {
    const r = await login(env, "ana@exemplu.ro", PASSWORD);
    const res = await handleAuthRequest(
      authRequest("/api/auth/sign-out", {
        body: {},
        headers: { cookie: r.cookie, origin: "https://atacator.exemplu.invalid" },
      }),
      env,
    );
    expect(res.status).toBe(403);
  });

  it("APP_URL e originea de încredere", () => {
    expect(env.config.appUrl).toBe(APP_URL);
    expect(cookieHeader(new Response(null))).toBe("");
  });
});
