import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { handleAuthRequest } from "@/modules/auth/handler";
import { waitForBackgroundMail } from "@/modules/auth/mailer";
import { rateLimitKey } from "@/modules/auth/rate-limit";
import { verifyPassword } from "@/modules/auth/password";
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
} from "@/modules/auth/testing";
import { findPasswordHash } from "@/modules/auth/users.repo";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import {
  changePasswordHandler,
  deleteSessionHandler,
  getMeHandler,
  listSessionsHandler,
  patchMeHandler,
  revokeOthersHandler,
} from "./_lib/me-handlers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Json = Record<string, unknown> & {
  data?: unknown;
  error?: { code: string; message: string; fields?: Record<string, string> };
};

function api(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    cookie?: string;
    bearer?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) {
    headers.cookie = init.cookie;
    headers.origin ??= APP_URL;
  }
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`${APP_URL}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

describe.skipIf(!TEST_ADMIN_URL)("API /api/v1/me pe PostgreSQL real", () => {
  let fx: AuthFixture;
  let env: AuthEnv;
  let clock = Date.now();
  const PASSWORD = "parola-ana-1234";
  const PASSWORD_B = "parola-bogdan-123";
  let anaId: string;
  let bogdanId: string;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_api");
    env = authEnv(fx.db, { now: () => clock });
    anaId = (
      await createUserWithHousehold(fx.db, {
        email: "ana@exemplu.ro",
        name: "Ana",
        password: PASSWORD,
        firstUserBecomesAdmin: true,
        emailVerified: true,
      })
    ).userId;
    bogdanId = (
      await createUserWithHousehold(fx.db, {
        email: "bogdan@exemplu.ro",
        name: "Bogdan",
        password: PASSWORD_B,
        firstUserBecomesAdmin: true,
        emailVerified: true,
      })
    ).userId;
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("fără sesiune: 401 în formatul de eroare FINET", async () => {
    const r = await getMeHandler(api("/api/v1/me"), env);
    expect(r.status).toBe(401);
    expect((await json(r)).error).toEqual({
      code: "unauthenticated",
      message: "Trebuie să te autentifici.",
    });
    const forged = await getMeHandler(api("/api/v1/me", { bearer: "token-inventat" }), env);
    expect(forged.status).toBe(401);
  });

  it("GET /me: profil, preferințe implicite și gospodăria personală cu rolul owner", async () => {
    const { cookie } = await login(env, "ana@exemplu.ro", PASSWORD);
    const r = await getMeHandler(api("/api/v1/me", { cookie }), env);
    expect(r.status).toBe(200);
    const { data } = (await json(r)) as { data: Record<string, Record<string, unknown>> };
    expect(data.user).toMatchObject({ id: anaId, email: "ana@exemplu.ro", isPlatformAdmin: true });
    expect(data.preferences).toEqual({
      locale: "ro-RO",
      timezone: "Europe/Bucharest",
      defaultCurrency: "RON",
      theme: "system",
    });
    expect(data.household).toMatchObject({ name: "Gospodăria mea", role: "owner" });
    expect(JSON.stringify(data)).not.toMatch(/argon2|password|token/i);
  });

  it("bearer end-to-end: login mobil → set-auth-token → /me; sesiunea apare ca „Telefon Android”", async () => {
    const mobile = await login(env, "ana@exemplu.ro", PASSWORD, {
      "x-finet-client": "android/1.4.2",
    });
    expect(mobile.response.status).toBe(200);
    expect(mobile.bearer).toBeTruthy();
    const me = await getMeHandler(api("/api/v1/me", { bearer: mobile.bearer! }), env);
    expect(me.status).toBe(200);
    const list = await listSessionsHandler(
      api("/api/v1/me/sessions", { bearer: mobile.bearer! }),
      env,
    );
    const { data } = (await json(list)) as {
      data: { id: string; device: string; platform: string; current: boolean }[];
    };
    const current = data.find((s) => s.current)!;
    expect(current).toMatchObject({ device: "Telefon Android", platform: "android" });
    expect(JSON.stringify(data)).not.toMatch(/token/i);

    // Tokenul brut (nesemnat) nu e acceptat: pluginul cere semnătura.
    const raw = decodeURIComponent(mobile.bearer!).split(".")[0]!;
    const unsigned = await getMeHandler(api("/api/v1/me", { bearer: raw }), env);
    expect(unsigned.status).toBe(401);

    // Revocarea din web are efect imediat asupra bearer-ului.
    const web = await login(env, "ana@exemplu.ro", PASSWORD);
    const del = await deleteSessionHandler(
      api(`/api/v1/me/sessions/${current.id}`, { method: "DELETE", cookie: web.cookie }),
      env,
      current.id,
    );
    expect(del.status).toBe(204);
    const after = await getMeHandler(api("/api/v1/me", { bearer: mobile.bearer! }), env);
    expect(after.status).toBe(401);
  });

  it("izolare: A nu vede și nu poate revoca sesiunile lui B (404)", async () => {
    const a = await login(env, "ana@exemplu.ro", PASSWORD);
    const b = await login(env, "bogdan@exemplu.ro", PASSWORD_B);
    const bList = (await json(
      await listSessionsHandler(api("/api/v1/me/sessions", { cookie: b.cookie }), env),
    )) as { data: { id: string }[] };
    const bSession = bList.data[0]!.id;
    const aList = (await json(
      await listSessionsHandler(api("/api/v1/me/sessions", { cookie: a.cookie }), env),
    )) as { data: { id: string }[] };
    expect(aList.data.map((s) => s.id)).not.toContain(bSession);

    for (const id of [bSession, "nu-e-uuid", "00000000-0000-4000-8000-000000000000"]) {
      const r = await deleteSessionHandler(
        api(`/api/v1/me/sessions/${id}`, { method: "DELETE", cookie: a.cookie }),
        env,
        id,
      );
      expect(r.status).toBe(404);
    }
    expect((await getMeHandler(api("/api/v1/me", { cookie: b.cookie }), env)).status).toBe(200);
    const rows = await fx.scratch.admin`select 1 from finet.auth_sessions where id = ${bSession}`;
    expect(rows.length).toBe(1);
  });

  it("revoke-others păstrează doar sesiunea curentă", async () => {
    const first = await login(env, "bogdan@exemplu.ro", PASSWORD_B);
    const second = await login(env, "bogdan@exemplu.ro", PASSWORD_B);
    const r = await revokeOthersHandler(
      api("/api/v1/me/sessions/revoke-others", { body: {}, cookie: second.cookie }),
      env,
    );
    expect(r.status).toBe(200);
    expect(((await json(r)).data as { revoked: number }).revoked).toBeGreaterThan(0);
    expect((await getMeHandler(api("/api/v1/me", { cookie: first.cookie }), env)).status).toBe(401);
    expect((await getMeHandler(api("/api/v1/me", { cookie: second.cookie }), env)).status).toBe(
      200,
    );
    const rows = await fx.scratch.admin`
      select 1 from finet.auth_sessions where user_id = ${bogdanId}`;
    expect(rows.length).toBe(1);
  });

  it("PATCH /me: validare Zod strictă; household_id și is_platform_admin sunt respinse", async () => {
    const { cookie } = await login(env, "ana@exemplu.ro", PASSWORD);
    const okRes = await patchMeHandler(
      api("/api/v1/me", {
        method: "PATCH",
        cookie,
        body: { name: "  Ana Pop ", preferences: { theme: "dark", timezone: "Europe/London" } },
      }),
      env,
    );
    expect(okRes.status).toBe(200);
    const me = (await json(okRes)).data as {
      user: { name: string };
      preferences: { theme: string; timezone: string; locale: string };
    };
    expect(me.user.name).toBe("Ana Pop");
    expect(me.preferences).toMatchObject({
      theme: "dark",
      timezone: "Europe/London",
      locale: "ro-RO",
    });

    for (const body of [
      { household_id: "00000000-0000-4000-8000-000000000000" },
      { householdId: "00000000-0000-4000-8000-000000000000", name: "X" },
      { is_platform_admin: true },
      { isPlatformAdmin: true },
      { email: "alt@exemplu.ro" },
      { preferences: { timezone: "Marte/Olympus" } },
      { preferences: { defaultCurrency: "BTC" } },
      { preferences: { locale: "xx" } },
      { name: "" },
      {},
    ]) {
      const r = await patchMeHandler(api("/api/v1/me", { method: "PATCH", cookie, body }), env);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await json(r)).error?.code).toBe("invalid_request");
    }
    const admin = await fx.scratch.admin<{ is_platform_admin: boolean; email: string }[]>`
      select is_platform_admin, email from finet.users where id = ${anaId}`;
    expect(admin[0]).toEqual({ is_platform_admin: true, email: "ana@exemplu.ro" });
    const fields = (
      await json(
        await patchMeHandler(
          api("/api/v1/me", { method: "PATCH", cookie, body: { household_id: "x" } }),
          env,
        ),
      )
    ).error?.fields;
    expect(fields).toEqual({ household_id: "Câmp nepermis." });
  });

  it("CSRF: o mutație cu cookie fără Origin corect e refuzată (403); bearer e scutit", async () => {
    const web = await login(env, "ana@exemplu.ro", PASSWORD);
    const body = { preferences: { theme: "light" } };
    const noOrigin = await patchMeHandler(
      new Request(`${APP_URL}/api/v1/me`, {
        method: "PATCH",
        headers: { cookie: web.cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    );
    expect(noOrigin.status).toBe(403);
    const evil = await patchMeHandler(
      api("/api/v1/me", {
        method: "PATCH",
        cookie: web.cookie,
        body,
        headers: { origin: "https://atacator.exemplu.invalid" },
      }),
      env,
    );
    expect(evil.status).toBe(403);
    const mobile = await login(env, "ana@exemplu.ro", PASSWORD, {
      "x-finet-client": "android/1.0",
    });
    const viaBearer = await patchMeHandler(
      api("/api/v1/me", { method: "PATCH", bearer: mobile.bearer!, body }),
      env,
    );
    expect(viaBearer.status).toBe(200);
  });

  it("schimbarea parolei: cere parola curentă, aplică politica, revocă celelalte sesiuni, audit", async () => {
    await createUserWithHousehold(fx.db, {
      email: "carmen@exemplu.ro",
      name: "Carmen",
      password: "parola-veche-123",
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    const other = await login(env, "carmen@exemplu.ro", "parola-veche-123");
    const current = await login(env, "carmen@exemplu.ro", "parola-veche-123");
    const post = (body: unknown) =>
      changePasswordHandler(api("/api/v1/me/password", { body, cookie: current.cookie }), env);

    const wrong = await post({
      currentPassword: "nu-e-asta-123",
      newPassword: "parola-noua-12345",
    });
    expect(wrong.status).toBe(400);
    expect((await json(wrong)).error).toMatchObject({
      code: "invalid_password",
      fields: { currentPassword: "Parola curentă nu e corectă." },
    });
    const weak = await post({ currentPassword: "parola-veche-123", newPassword: "scurta" });
    expect(weak.status).toBe(400);
    expect((await json(weak)).error?.code).toBe("weak_password");
    const extra = await post({
      currentPassword: "parola-veche-123",
      newPassword: "parola-noua-12345",
      userId: anaId,
    });
    expect(extra.status).toBe(400);

    const ok = await post({
      currentPassword: "parola-veche-123",
      newPassword: "parola-noua-12345",
    });
    expect(ok.status).toBe(200);
    expect(((await json(ok)).data as { revokedSessions: number }).revokedSessions).toBeGreaterThan(
      0,
    );
    expect((await getMeHandler(api("/api/v1/me", { cookie: other.cookie }), env)).status).toBe(401);
    expect((await getMeHandler(api("/api/v1/me", { cookie: current.cookie }), env)).status).toBe(
      200,
    );
    expect((await login(env, "carmen@exemplu.ro", "parola-veche-123")).response.status).toBe(401);
    expect((await login(env, "carmen@exemplu.ro", "parola-noua-12345")).response.status).toBe(200);

    const audit = await fx.scratch.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from finet.audit_events where action = 'auth.password_changed'`;
    expect(audit.length).toBe(1);
    expect(Object.keys(audit[0]!.metadata)).toEqual(["revokedSessions"]);
  });

  it("schimbarea parolei are rate limiting propriu (per utilizator)", async () => {
    const limitedEnv = authEnv(fx.db, {
      config: testConfig({ AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS: "2" }),
      now: () => clock,
    });
    const { cookie } = await login(limitedEnv, "bogdan@exemplu.ro", PASSWORD_B);
    const post = () =>
      changePasswordHandler(
        api("/api/v1/me/password", {
          body: { currentPassword: "gresita-12345", newPassword: "parola-noua-12345" },
          cookie,
        }),
        limitedEnv,
      );
    expect((await post()).status).toBe(400);
    expect((await post()).status).toBe(400);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  describe("rate limiting la login (IP + email normalizat)", () => {
    it("blochează după limită, cu același răspuns pentru email existent și inexistent; fereastra se resetează", async () => {
      const limited = authEnv(fx.db, {
        config: testConfig({ AUTH_LOGIN_MAX_ATTEMPTS: "3", AUTH_LOGIN_WINDOW_SECONDS: "600" }),
        now: () => clock,
      });
      const attempt = (email: string, password = "gresita-12345") =>
        login(limited, email, password);
      for (let i = 0; i < 3; i++) {
        expect((await attempt("Bogdan@Exemplu.ro ")).response.status).toBe(401);
      }
      // A 4-a încercare (chiar cu parola corectă) e blocată; normalizarea face aceeași cheie.
      const blocked = await attempt("bogdan@exemplu.ro", PASSWORD_B);
      expect(blocked.response.status).toBe(429);
      const blockedBody = await blocked.response.json();

      for (let i = 0; i < 3; i++) await attempt("nimeni-aici@exemplu.ro");
      const blockedUnknown = await attempt("nimeni-aici@exemplu.ro");
      expect(blockedUnknown.response.status).toBe(429);
      expect(await blockedUnknown.response.json()).toEqual(blockedBody);

      // Alt email nu e afectat.
      expect((await login(limited, "ana@exemplu.ro", PASSWORD)).response.status).toBe(200);

      // După fereastră, contorul pornește din nou.
      clock += 601_000;
      expect((await attempt("bogdan@exemplu.ro", PASSWORD_B)).response.status).toBe(200);

      const keys = await fx.scratch.admin<
        { key: string }[]
      >`select key from finet.auth_rate_limits`;
      expect(keys.every((k) => k.key.startsWith("finet:"))).toBe(true);
      expect(JSON.stringify(keys)).not.toContain("@");
    });

    // Access verificat: doar atunci IP-ul (cf-connecting-ip) e de încredere (M2).
    const ACCESS = {
      CF_ACCESS_REQUIRED: "true",
      CF_ACCESS_TEAM_DOMAIN: "echipa-exemplu.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud-fictiv-0123456789",
    };

    it("login-ul mobil are limite proprii doar cu IP de încredere", async () => {
      const limited = authEnv(fx.db, {
        config: testConfig({
          ...ACCESS,
          AUTH_LOGIN_MAX_ATTEMPTS: "1",
          AUTH_MOBILE_LOGIN_MAX_ATTEMPTS: "4",
        }),
        now: () => clock,
      });
      const ip = { "cf-connecting-ip": "203.0.113.20" };
      const mobile = { ...ip, "x-finet-client": "android/1.0" };
      await login(limited, "carmen@exemplu.ro", "gresita-12345", ip);
      expect((await login(limited, "carmen@exemplu.ro", "gresita-12345", ip)).response.status).toBe(
        429,
      );
      for (let i = 0; i < 4; i++) {
        expect(
          (await login(limited, "carmen@exemplu.ro", "gresita-12345", mobile)).response.status,
        ).toBe(401);
      }
      expect(
        (await login(limited, "carmen@exemplu.ro", "gresita-12345", mobile)).response.status,
      ).toBe(429);
      clock += 61 * 60_000;
    });

    it("fără IP de încredere, antetul X-FINET-Client NU dă o găleată mai mare (M2)", async () => {
      const limited = authEnv(fx.db, {
        config: testConfig({ AUTH_LOGIN_MAX_ATTEMPTS: "2", AUTH_MOBILE_LOGIN_MAX_ATTEMPTS: "10" }),
        now: () => clock,
      });
      const mobile = { "x-finet-client": "android/1.0" };
      await login(limited, "carmen@exemplu.ro", "gresita-12345");
      await login(limited, "carmen@exemplu.ro", "gresita-12345", mobile);
      expect(
        (await login(limited, "carmen@exemplu.ro", "gresita-12345", mobile)).response.status,
      ).toBe(429);
      clock += 61 * 60_000;
    });

    it("plafonul pe email (M2): doar eșecurile se numără; 6 IP-uri × 5 → 429 după 20; IP cunoscut trece; fereastra expiră", async () => {
      const limited = authEnv(fx.db, { config: testConfig(ACCESS), now: () => clock });
      const capKey = rateLimitKey("login_email", null, "bogdan@exemplu.ro");
      const capCount = async () =>
        Number(
          (
            await fx.scratch.admin<{ count: number }[]>`
              select count from finet.auth_rate_limits where key = ${capKey}`
          )[0]?.count ?? 0,
        );
      const KNOWN = { "cf-connecting-ip": "203.0.113.200" };

      // Un login reușit nu incrementează plafonul și marchează IP-ul ca „cunoscut”.
      expect((await login(limited, "bogdan@exemplu.ro", PASSWORD_B, KNOWN)).response.status).toBe(
        200,
      );
      expect(await capCount()).toBe(0);
      await login(limited, "bogdan@exemplu.ro", "gresita-12345", KNOWN);
      expect(await capCount()).toBe(1);
      expect((await login(limited, "bogdan@exemplu.ro", PASSWORD_B, KNOWN)).response.status).toBe(
        200,
      );
      expect(await capCount()).toBe(0);

      const attack = async () => {
        const statuses: number[] = [];
        for (let n = 1; n <= 6; n++) {
          for (let i = 0; i < 5; i++) {
            const r = await login(limited, "bogdan@exemplu.ro", "gresita-12345", {
              "cf-connecting-ip": `198.51.100.${n}`,
            });
            statuses.push(r.response.status);
          }
        }
        return statuses;
      };
      const statuses = await attack();
      // Limita pe IP + email (5) nu e atinsă pe niciun IP; plafonul pe email (20 eșecuri) da.
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(20).every((s) => s === 429)).toBe(true);

      // Un IP nou, chiar cu parola corectă, e blocat (429 uniform, cu Retry-After).
      const fresh = await login(limited, "bogdan@exemplu.ro", PASSWORD_B, {
        "cf-connecting-ip": "198.51.100.99",
      });
      expect(fresh.response.status).toBe(429);
      expect(fresh.response.headers.get("retry-after")).toBeTruthy();
      // IP-ul cunoscut (login reușit în ultimele 30 de zile) trece cu parola corectă.
      expect((await login(limited, "bogdan@exemplu.ro", PASSWORD_B, KNOWN)).response.status).toBe(
        200,
      );

      // Din nou blocat de un atac nou (după ce expiră limitele pe IP + email, 15 min, ale
      // primului atac); după fereastra plafonului (1 h) se deblochează.
      clock += 16 * 60_000;
      expect((await attack()).slice(20).every((st) => st === 429)).toBe(true);
      expect(
        (
          await login(limited, "bogdan@exemplu.ro", PASSWORD_B, {
            "cf-connecting-ip": "198.51.100.98",
          })
        ).response.status,
      ).toBe(429);
      clock += 61 * 60_000;
      expect(
        (
          await login(limited, "bogdan@exemplu.ro", PASSWORD_B, {
            "cf-connecting-ip": "198.51.100.98",
          })
        ).response.status,
      ).toBe(200);
      clock += 61 * 60_000;
    });
  });

  describe("magic link și resetarea parolei (SMTP simulat)", () => {
    it("magic link: email doar pentru conturi existente, același răspuns, o singură folosire", async () => {
      const mailEnv = authEnv(fx.db, { now: () => clock });
      const send = (email: string) =>
        handleAuthRequest(
          authRequest("/api/auth/sign-in/magic-link", { body: { email, callbackURL: "/" } }),
          mailEnv,
        );
      const known = await send(" ANA@exemplu.ro");
      const unknown = await send("strain@exemplu.ro");
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await known.json()).toEqual(await unknown.json());
      await waitForBackgroundMail();
      expect(mailEnv.mailer!.sent.length).toBe(1);
      const mail = mailEnv.mailer!.sent[0]!;
      expect(mail.to).toBe("ana@exemplu.ro");
      expect(mail.subject).toContain("Conectare");
      const url = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
      expect(url.pathname).toBe("/api/auth/magic-link/verify");

      const verify = await handleAuthRequest(
        new Request(url, { headers: { origin: APP_URL } }),
        mailEnv,
      );
      expect(verify.status).toBe(302);
      const cookie = cookieHeader(verify);
      expect((await getMeHandler(api("/api/v1/me", { cookie }), mailEnv)).status).toBe(200);
      // A doua folosire: fără sesiune nouă.
      const again = await handleAuthRequest(new Request(url), mailEnv);
      expect(cookieHeader(again)).not.toMatch(/session_token=[^;]+/);
      // Niciun cont creat pentru emailul necunoscut.
      const rows = await fx.scratch
        .admin`select 1 from finet.users where email = 'strain@exemplu.ro'`;
      expect(rows.length).toBe(0);
      const audit = await fx.scratch.admin<{ metadata: { method: string } }[]>`
        select metadata from finet.audit_events
         where action = 'auth.login_succeeded' and metadata->>'method' = 'magic_link'`;
      expect(audit.length).toBe(1);
    });

    it("fără SMTP, magic link-ul și resetarea prin email nu există", async () => {
      const noMail = authEnv(fx.db, { mailer: null, now: () => clock });
      const r = await handleAuthRequest(
        authRequest("/api/auth/sign-in/magic-link", { body: { email: "ana@exemplu.ro" } }),
        noMail,
      );
      expect(r.status).toBe(404);
      const reset = await handleAuthRequest(
        authRequest("/api/auth/request-password-reset", {
          body: { email: "ana@exemplu.ro", redirectTo: "/reset" },
        }),
        noMail,
      );
      expect(reset.ok).toBe(false);
    });

    it("emailurile au rate limiting (IP + email)", async () => {
      const limited = authEnv(fx.db, {
        config: testConfig({ AUTH_EMAIL_MAX_REQUESTS: "2" }),
        now: () => clock,
      });
      const send = () =>
        handleAuthRequest(
          authRequest("/api/auth/sign-in/magic-link", { body: { email: "bogdan@exemplu.ro" } }),
          limited,
        );
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(429);
      await waitForBackgroundMail();
      expect(limited.mailer!.sent.length).toBe(2);
      clock += 61 * 60_000;
    });

    it("resetarea prin email: politica parolei, apoi toate sesiunile revocate", async () => {
      const mailEnv = authEnv(fx.db, { now: () => clock });
      await createUserWithHousehold(fx.db, {
        email: "dan@exemplu.ro",
        name: "Dan",
        password: "parola-dan-12345",
        firstUserBecomesAdmin: false,
        emailVerified: true,
      });
      const session = await login(mailEnv, "dan@exemplu.ro", "parola-dan-12345");
      const req = await handleAuthRequest(
        authRequest("/api/auth/request-password-reset", {
          body: { email: "dan@exemplu.ro", redirectTo: "/resetare" },
        }),
        mailEnv,
      );
      expect(req.status).toBe(200);
      await waitForBackgroundMail();
      const mail = mailEnv.mailer!.sent.at(-1)!;
      expect(mail.subject).toContain("Resetarea parolei");
      const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
      const token = link.pathname.split("/").at(-1)!;

      const weak = await handleAuthRequest(
        authRequest("/api/auth/reset-password", { body: { token, newPassword: "scurta" } }),
        mailEnv,
      );
      expect(weak.status).toBe(400);
      const done = await handleAuthRequest(
        authRequest("/api/auth/reset-password", {
          body: { token, newPassword: "parola-dan-noua-1" },
        }),
        mailEnv,
      );
      expect(done.status).toBe(200);
      expect(
        (await getMeHandler(api("/api/v1/me", { cookie: session.cookie }), mailEnv)).status,
      ).toBe(401);
      const userRow = await fx.scratch.admin<{ id: string }[]>`
        select id from finet.users where email = 'dan@exemplu.ro'`;
      const hash = await findPasswordHash(fx.db, userRow[0]!.id);
      expect(hash?.startsWith("$argon2id$")).toBe(true);
      expect(await verifyPassword(hash!, "parola-dan-noua-1")).toBe(true);
    });
  });
});
