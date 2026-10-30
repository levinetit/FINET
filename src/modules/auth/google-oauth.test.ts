import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";

import { enabledOAuthProviders, isOAuthAuthPath } from "./auth";
import { handleAuthRequest } from "./handler";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  authRequest,
  cookieHeader,
  createAuthFixture,
  testConfig,
} from "./testing";
import { createUserWithHousehold } from "./users.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const CLIENT_ID = "client-id-fals-0123456789.apps.googleusercontent.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PASS = "parola-google-11c-1";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

type Claims = Readonly<{
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}>;

/** Un id_token necesemnat: în fluxul cu cod, Better Auth îl decodează (jetonul vine direct de la Google, prin TLS). */
function idToken(claims: Claims): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    iat: now,
    exp: now + 3600,
    name: "Utilizator Google",
    ...claims,
  })}.sig`;
}

/** Furnizorul simulat: răspunde doar la schimbul de cod; orice alt apel extern eșuează testul. */
function stubGoogle(claims: Claims) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    calls.push(url);
    if (url !== TOKEN_URL) throw new Error(`apel extern neașteptat: ${url}`);
    return Response.json({
      access_token: "at-fals",
      refresh_token: "rt-fals",
      id_token: idToken(claims),
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid email profile",
    });
  });
  return calls;
}

describe("autentificarea cu Google: căile (fără bază de date)", () => {
  it("căile OAuth sunt permise doar cu furnizor configurat, pe id-ul lui", () => {
    expect(isOAuthAuthPath("/sign-in/social", [])).toBe(false);
    expect(isOAuthAuthPath("/callback/google", [])).toBe(false);
    expect(isOAuthAuthPath("/sign-in/social", ["google"])).toBe(true);
    expect(isOAuthAuthPath("/callback/google", ["google"])).toBe(true);
    for (const p of ["/callback/facebook", "/callback/", "/callback/google/x", "/link-social"]) {
      expect(isOAuthAuthPath(p, ["google"]), p).toBe(false);
    }
  });

  it("furnizorul e activ doar în saas cu ID și secret", () => {
    const keys = { GOOGLE_CLIENT_ID: CLIENT_ID };
    expect(enabledOAuthProviders(testConfig())).toEqual([]);
    expect(enabledOAuthProviders(testConfig({ APP_MODE: "saas" }))).toEqual([]);
    // Secretul vine doar din fișier: fără fișier, configurația refuză (vezi config.test.ts).
    expect(() => testConfig({ ...keys, APP_MODE: "saas" })).toThrow();
  });
});

describe.skipIf(!TEST_ADMIN_URL)(
  "autentificarea cu Google: conturi existente, fără creare (F11-C2)",
  () => {
    let fx: AuthFixture;
    let env: AuthEnv;
    let plain: AuthEnv;
    let counter = 0;
    const fresh = (label: string) => `${label}${++counter}-${Date.now().toString(36)}@exemplu.ro`;

    beforeAll(async () => {
      fx = await createAuthFixture("finet_it_google_11c");
      // Config cu Google: secretul se citește dintr-un fișier simulat (ca în producție).
      const { parseConfig } = await import("@/lib/config");
      const config = parseConfig(
        {
          APP_MODE: "saas",
          NODE_ENV: "test",
          APP_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET: "secret-de-test-finet-0123456789-abcdefghij",
          GOOGLE_CLIENT_ID: CLIENT_ID,
          GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/google",
          AUTH_LOGIN_MAX_ATTEMPTS: "10000",
        },
        { readSecret: () => "secret-client-fals-0123456789" },
      );
      env = authEnv(fx.db, { config });
      plain = authEnv(fx.db, { config: testConfig({ APP_MODE: "saas" }) });
    });
    afterAll(async () => {
      await fx.close();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function mk(email: string, verified: boolean) {
      return createUserWithHousehold(fx.db, {
        email,
        name: "Ana Google",
        password: PASS,
        firstUserBecomesAdmin: false,
        emailVerified: verified,
      });
    }

    /** Pornește fluxul și întoarce starea + cookie-urile (cum ar face browserul). */
    async function start(target: AuthEnv) {
      const res = await handleAuthRequest(
        authRequest("/api/auth/sign-in/social", {
          body: { provider: "google", callbackURL: "/dashboard", errorCallbackURL: "/login" },
        }),
        target,
      );
      return { res, cookie: cookieHeader(res) };
    }

    async function callback(target: AuthEnv, claims: Claims, tamperState = false) {
      const begun = await start(target);
      expect(begun.res.status, await begun.res.clone().text()).toBe(200);
      const url = new URL(((await begun.res.json()) as { url: string }).url);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      // Doar domeniile de bază: nu cerem alte permisiuni decât identitatea.
      expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
        "email",
        "openid",
        "profile",
      ]);
      const state = tamperState ? "stare-falsificata" : url.searchParams.get("state")!;
      const calls = stubGoogle(claims);
      const res = await handleAuthRequest(
        authRequest(`/api/auth/callback/google?code=cod-fals&state=${state}`, {
          headers: { cookie: begun.cookie },
        }),
        target,
      );
      return { res, calls, sessionCookie: cookieHeader(res) };
    }

    const hasSession = (cookie: string) => cookie.includes("finet.session_token=");
    const count = async (sql: string, ...values: string[]) =>
      (await fx.scratch.admin.unsafe(sql, values))[0]!.n as number;

    it("fără furnizor configurat: pornirea și întoarcerea dau 404", async () => {
      const begin = await handleAuthRequest(
        authRequest("/api/auth/sign-in/social", { body: { provider: "google", callbackURL: "/" } }),
        plain,
      );
      expect(begin.status).toBe(404);
      const back = await handleAuthRequest(
        authRequest("/api/auth/callback/google?code=x&state=y"),
        plain,
      );
      expect(back.status).toBe(404);
    });

    it("cont existent cu email verificat: se leagă și se deschide sesiunea; jetoanele NU se păstrează", async () => {
      const email = fresh("ana");
      const user = await mk(email, true);
      const out = await callback(env, { sub: "g-111", email, email_verified: true });
      expect(out.res.status).toBe(302);
      expect(out.res.headers.get("location")).toBe("/dashboard");
      expect(hasSession(out.sessionCookie)).toBe(true);
      // Un singur apel extern: schimbul de cod.
      expect(out.calls).toEqual([TOKEN_URL]);

      const acc = (
        await fx.scratch
          .admin`select provider_id, account_id, access_token, refresh_token, id_token, scope from finet.auth_accounts where user_id = ${user.userId} and provider_id = 'google'`
      )[0]!;
      expect(acc.account_id).toBe("g-111");
      expect(acc.access_token).toBeNull();
      expect(acc.refresh_token).toBeNull();
      expect(acc.id_token).toBeNull();
      expect(acc.scope).toBeNull();
      // Contul cu parolă rămâne neatins.
      expect(
        await count(
          "select count(*)::int as n from finet.auth_accounts where user_id = $1 and provider_id = 'credential'",
          user.userId,
        ),
      ).toBe(1);

      // Sesiunea e validă și auditată ca autentificare Google.
      const me = await handleAuthRequest(
        authRequest("/api/auth/get-session", { headers: { cookie: out.sessionCookie } }),
        env,
      );
      expect(((await me.json()) as { user: { email: string } }).user.email).toBe(email);
      const audit = await fx.scratch
        .admin`select metadata from finet.audit_events where actor_user_id = ${user.userId} and action = 'auth.login_succeeded' order by created_at desc limit 1`;
      expect(audit[0]!.metadata).toMatchObject({ method: "google" });

      // A doua autentificare (cont deja legat) funcționează fără scrieri interzise.
      const again = await callback(env, { sub: "g-111", email, email_verified: true });
      expect(hasSession(again.sessionCookie)).toBe(true);
      expect(
        await count(
          "select count(*)::int as n from finet.auth_accounts where user_id = $1 and provider_id = 'google'",
          user.userId,
        ),
      ).toBe(1);
    });

    it("email necunoscut: niciun utilizator creat, nicio sesiune, înapoi la /login cu eroare", async () => {
      const before = await count("select count(*)::int as n from finet.users");
      const email = fresh("necunoscut");
      const out = await callback(env, { sub: "g-222", email, email_verified: true });
      expect(hasSession(out.sessionCookie)).toBe(false);
      expect(out.res.headers.get("location")).toBe("/login?error=signup_disabled");
      expect(await count("select count(*)::int as n from finet.users")).toBe(before);
      expect(
        await count(
          "select count(*)::int as n from finet.auth_accounts where account_id = $1",
          "g-222",
        ),
      ).toBe(0);
    });

    it("cont FINET cu email neverificat (înregistrare neterminată): nu se leagă și nu se deschide sesiune", async () => {
      const email = fresh("neverificat");
      const user = await mk(email, false);
      const out = await callback(env, { sub: "g-333", email, email_verified: true });
      expect(hasSession(out.sessionCookie)).toBe(false);
      expect(out.res.headers.get("location")).toBe("/login?error=account_not_linked");
      expect(
        await count(
          "select count(*)::int as n from finet.auth_accounts where user_id = $1 and provider_id = 'google'",
          user.userId,
        ),
      ).toBe(0);
      const row = (
        await fx.scratch.admin`select email_verified from finet.users where id = ${user.userId}`
      )[0]!;
      expect(row.email_verified).toBe(false);
    });

    it("Google declară emailul neverificat: nu se leagă, chiar dacă contul local e verificat", async () => {
      const email = fresh("gneverificat");
      const user = await mk(email, true);
      const out = await callback(env, { sub: "g-444", email, email_verified: false });
      expect(hasSession(out.sessionCookie)).toBe(false);
      expect(
        await count(
          "select count(*)::int as n from finet.auth_accounts where user_id = $1 and provider_id = 'google'",
          user.userId,
        ),
      ).toBe(0);
    });

    it("cont dezactivat: nicio sesiune", async () => {
      const email = fresh("dezactivat");
      const user = await mk(email, true);
      await fx.scratch.admin`update finet.users set status = 'disabled' where id = ${user.userId}`;
      const out = await callback(env, { sub: "g-555", email, email_verified: true });
      expect(hasSession(out.sessionCookie)).toBe(false);
    });

    it("starea falsificată sau lipsă respinge întoarcerea; contul Google nu se mută pe alt utilizator", async () => {
      const email = fresh("stare");
      await mk(email, true);
      const bad = await callback(env, { sub: "g-666", email, email_verified: true }, true);
      expect(hasSession(bad.sessionCookie)).toBe(false);
      expect(bad.calls).toEqual([]);
      const missing = await handleAuthRequest(authRequest("/api/auth/callback/google?code=x"), env);
      expect(hasSession(cookieHeader(missing))).toBe(false);

      // Același cont Google (sub) cu alt email local: se autentifică ca proprietarul legat, nu ca altul.
      const a = fresh("prop");
      const b = fresh("alt");
      const owner = await mk(a, true);
      await mk(b, true);
      await callback(env, { sub: "g-777", email: a, email_verified: true });
      const takeover = await callback(env, { sub: "g-777", email: b, email_verified: true });
      const me = await handleAuthRequest(
        authRequest("/api/auth/get-session", { headers: { cookie: takeover.sessionCookie } }),
        env,
      );
      const body = (await me.json()) as { user?: { id: string } } | null;
      if (body?.user) expect(body.user.id).toBe(owner.userId);
    });

    it("pornirea fluxului are rate limiting (găleata de login, pe IP)", async () => {
      await fx.scratch.admin`delete from finet.auth_rate_limits`;
      const { parseConfig } = await import("@/lib/config");
      const tight = parseConfig(
        {
          APP_MODE: "saas",
          NODE_ENV: "test",
          APP_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET: "secret-de-test-finet-0123456789-abcdefghij",
          GOOGLE_CLIENT_ID: CLIENT_ID,
          GOOGLE_CLIENT_SECRET_FILE: "/run/secrets/google",
          AUTH_LOGIN_MAX_ATTEMPTS: "3",
        },
        { readSecret: () => "secret-client-fals-0123456789" },
      );
      const limited = authEnv(fx.db, { config: tight });
      let status = 200;
      for (let i = 0; i < 30 && status !== 429; i++) {
        status = (await start(limited)).res.status;
      }
      expect(status).toBe(429);
    });
  },
);
