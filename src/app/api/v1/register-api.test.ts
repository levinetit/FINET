import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { waitForBackgroundMail } from "@/modules/auth/mailer";
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
import { readRegistrationToken, signRegistrationToken } from "@/modules/auth/registration";

import type { ApiDeps } from "./_lib/http";
import * as RG from "./_lib/register-handlers";
import { apiRequest, assertContract } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Handler = (request: Request, deps: ApiDeps) => Promise<Response>;

const SAME_ORIGIN = { origin: APP_URL };
const TOKEN_IN_MAIL = /register\/complete\?token=([^\s"&<]+)/;

/**
 * Înregistrarea publică (F11-C; ADR 0029) prin API, pe PostgreSQL real: rutele există doar în
 * `saas` cu `SIGNUP_ENABLED=1` și SMTP; parola o alege proprietarul adresei; răspunsul nu depinde de
 * existența adresei; linkul e semnat, expiră și se folosește o singură dată.
 */
describe.skipIf(!TEST_ADMIN_URL)("11-C: înregistrarea publică", () => {
  let fx: AuthFixture;
  let mailer: FakeMailer;
  let open: AuthEnv & ApiDeps;
  let closed: AuthEnv & ApiDeps;
  let personal: AuthEnv & ApiDeps;
  let noMail: AuthEnv & ApiDeps;
  const limits = {
    mutations: { max: 100_000, windowSeconds: 60 },
    exports: { max: 100_000, windowSeconds: 60 },
  };
  let counter = 0;
  const fresh = () => `nou${++counter}-${Date.now().toString(36)}@exemplu.ro`;

  async function call(deps: ApiDeps, handler: Handler, path: string, body: unknown, h = {}) {
    const res = await handler(
      apiRequest(path, { method: "POST", body, headers: { ...SAME_ORIGIN, ...h } }),
      deps,
    );
    await assertContract(handler, res);
    const text = await res.clone().text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Loose, text };
  }
  const register = (deps: ApiDeps, email: string, extra: Loose = {}) =>
    call(deps, RG.registerHandler, "/api/v1/register", {
      email,
      name: "Ana Test",
      acceptTerms: true,
      ...extra,
    });
  const complete = (deps: ApiDeps, token: string, password: string) =>
    call(deps, RG.completeRegisterHandler, "/api/v1/register/complete", { token, password });

  async function mailTo(email: string): Promise<{ subject: string; token: string | null }> {
    await waitForBackgroundMail();
    const mail = [...mailer.sent].reverse().find((m) => m.to === email);
    if (!mail) throw new Error("niciun email trimis");
    const match = TOKEN_IN_MAIL.exec(mail.text);
    return { subject: mail.subject, token: match ? decodeURIComponent(match[1]!) : null };
  }

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_register_11c");
    mailer = fakeMailer();
    const saas = { APP_MODE: "saas", SIGNUP_ENABLED: "1" };
    open = { ...authEnv(fx.db, { config: testConfig(saas), mailer }), mailer, limits };
    closed = {
      ...authEnv(fx.db, { config: testConfig({ APP_MODE: "saas" }), mailer }),
      mailer,
      limits,
    };
    personal = {
      ...authEnv(fx.db, { config: testConfig({ SIGNUP_ENABLED: "1" }), mailer }),
      mailer,
      limits,
    };
    noMail = { ...authEnv(fx.db, { config: testConfig(saas) }), mailer: null, limits };
  });
  afterAll(async () => {
    await fx.close();
  });

  it("există doar în saas cu SIGNUP_ENABLED=1 și cu SMTP: altfel 404", async () => {
    for (const deps of [personal, closed, noMail]) {
      expect((await register(deps, fresh())).status).toBe(404);
      expect((await complete(deps, "x".repeat(40), "parola-lunga-1234")).status).toBe(404);
    }
  });

  it("refuză alt Origin, câmpuri necunoscute, lipsa acceptării și corpul non-JSON", async () => {
    const email = fresh();
    expect(
      (
        await call(
          open,
          RG.registerHandler,
          "/api/v1/register",
          { email, name: "A", acceptTerms: true },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect((await register(open, email, { extra: 1 })).status).toBe(400);
    expect((await register(open, email, { acceptTerms: false })).status).toBe(400);
    expect((await register(open, email, { name: " " })).status).toBe(400);
    expect((await register(open, "nu-e-email")).status).toBe(400);
    const res = await RG.registerHandler(
      apiRequest("/api/v1/register", {
        method: "POST",
        rawBody: "email=a@b.ro",
        headers: { ...SAME_ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      }),
      open,
    );
    expect(res.status).toBe(415);
    const users = await fx.scratch
      .admin`select count(*)::int as n from finet.users where email = ${email}`;
    expect(users[0]!.n).toBe(0);
  });

  it("fluxul complet: cont neverificat fără parolă → link → parolă → login; linkul e de unică folosință", async () => {
    const email = fresh();
    const res = await register(open, email);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { status: "pending" } });

    const row = (
      await fx.scratch
        .admin`select id, email_verified, status, is_platform_admin from finet.users where email = ${email}`
    )[0]!;
    expect(row.email_verified).toBe(false);
    expect(row.status).toBe("active");
    expect(row.is_platform_admin).toBe(false);
    const creds = await fx.scratch
      .admin`select count(*)::int as n from finet.auth_accounts where user_id = ${row.id}`;
    expect(creds[0]!.n).toBe(0);
    const hh = await fx.scratch
      .admin`select count(*)::int as n from finet.household_members where user_id = ${row.id}`;
    expect(hh[0]!.n).toBe(1);

    const { token } = await mailTo(email);
    expect(token).toBeTruthy();

    // O parolă respinsă nu consumă linkul.
    const weak = await complete(open, token!, "scurta");
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe("password");
    const ok = await complete(open, token!, "parola-aleasa-11c-1");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ data: { status: "verified" } });

    const after = (
      await fx.scratch.admin`select email_verified from finet.users where id = ${row.id}`
    )[0]!;
    expect(after.email_verified).toBe(true);
    const audit = await fx.scratch
      .admin`select count(*)::int as n from finet.audit_events where actor_user_id = ${row.id} and action = 'user.email_verified'`;
    expect(audit[0]!.n).toBe(1);

    // Același link a doua oară: 410, parola NU se schimbă.
    const again = await complete(open, token!, "alta-parola-11c-2");
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe("invalid_token");

    // Login cu parola aleasă (nu cu cea de-a doua).
    const { sessionsFor } = await import("./_lib/testing");
    await expect(sessionsFor(open, email, "parola-aleasa-11c-1")).resolves.toBeTruthy();
    await expect(sessionsFor(open, email, "alta-parola-11c-2")).rejects.toThrow();
  });

  it("aceeași formă de răspuns pentru adresă existentă; mesaj „ai deja un cont”, fără cont nou", async () => {
    const email = fresh();
    await register(open, email);
    const { token } = await mailTo(email);
    await complete(open, token!, "parola-existenta-11c");
    const before = (await fx.scratch.admin`select count(*)::int as n from finet.users`)[0]!.n;

    const res = await register(open, email);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ data: { status: "pending" } });
    const mail = await mailTo(email);
    expect(mail.subject).toMatch(/deja un cont/);
    expect(mail.token).toBeNull();
    expect((await fx.scratch.admin`select count(*)::int as n from finet.users`)[0]!.n).toBe(before);
  });

  it("o înregistrare neterminată primește un link nou; vechiul link rămâne bun o singură dată", async () => {
    const email = fresh();
    await register(open, email);
    const first = (await mailTo(email)).token!;
    await register(open, email);
    const second = (await mailTo(email)).token!;
    expect(second).toBeTruthy();
    expect((await complete(open, second, "parola-link-nou-11c")).status).toBe(200);
    // Primul link e același utilizator, dar emailul e deja verificat: nu mai poate schimba parola.
    expect((await complete(open, first, "parola-link-vechi-11c")).status).toBe(410);
  });

  it("tokenul: modificat, de la alt secret sau expirat → 410; semnătura se verifică", async () => {
    const email = fresh();
    await register(open, email);
    const token = (await mailTo(email)).token!;
    const [body, sig] = token.split(".");
    expect(
      (await complete(open, `${body}.${sig!.slice(0, -2)}AA`, "parola-token-11c-1")).status,
    ).toBe(410);
    expect(
      (await complete(open, "nu-e-token-dar-e-destul-de-lung-1", "parola-token-11c-1")).status,
    ).toBe(410);

    const claims = readRegistrationToken(open.config.auth.secret!, token, Date.now())!;
    expect(claims.e).toBe(email);
    const foreign = signRegistrationToken(
      "alt-secret-de-test-foarte-lung-0123456789",
      claims.u,
      email,
      Date.now(),
    );
    expect((await complete(open, foreign, "parola-token-11c-1")).status).toBe(410);
    // Emailul din token trebuie să fie al utilizatorului.
    const wrongEmail = signRegistrationToken(
      open.config.auth.secret!,
      claims.u,
      "altcineva@exemplu.ro",
      Date.now(),
    );
    expect((await complete(open, wrongEmail, "parola-token-11c-1")).status).toBe(410);

    const expired = signRegistrationToken(
      open.config.auth.secret!,
      claims.u,
      email,
      Date.now() - 49 * 3600 * 1000,
    );
    expect((await complete(open, expired, "parola-token-11c-1")).status).toBe(410);
    expect(
      readRegistrationToken(open.config.auth.secret!, token, Date.now() + 49 * 3600 * 1000),
    ).toBeNull();
    // Linkul valid încă funcționează.
    expect((await complete(open, token, "parola-token-11c-1")).status).toBe(200);
  });

  it("niciun cont creat pe această cale nu devine administrator, nici pe o platformă goală", async () => {
    const empty = await createAuthFixture("finet_it_register_11c_empty");
    try {
      const deps = {
        ...authEnv(empty.db, {
          config: testConfig({ APP_MODE: "saas", SIGNUP_ENABLED: "1" }),
          mailer,
        }),
        mailer,
        limits,
      };
      const email = fresh();
      expect((await register(deps, email)).status).toBe(202);
      const row = (
        await empty.scratch.admin`select is_platform_admin from finet.users where email = ${email}`
      )[0]!;
      expect(row.is_platform_admin).toBe(false);
    } finally {
      await empty.close();
    }
  });

  it("Turnstile (F11-C2): cu chei configurate token obligatoriu; fail-closed; fără scriere la respingere", async () => {
    const verifier = vi.fn(async (token: string) => token === "token-bun");
    const guarded = { ...open, turnstile: verifier } as AuthEnv & ApiDeps;
    const email = fresh();
    const count = async () =>
      (
        await fx.scratch.admin`select count(*)::int as n from finet.users where email = ${email}`
      )[0]!.n;

    // Lipsă → 400 `turnstile`, verificatorul nu e chemat, nimic scris, niciun email.
    const sentBefore = mailer.sent.length;
    const missing = await register(guarded, email);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("turnstile");
    expect(verifier).not.toHaveBeenCalled();
    // Token respins → același 400, tot fără scriere.
    const bad = await register(guarded, email, { turnstileToken: "token-prost" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("turnstile");
    expect(await count()).toBe(0);
    await waitForBackgroundMail();
    expect(mailer.sent.length).toBe(sentBefore);
    // Token bun → 202, cont creat.
    const good = await register(guarded, email, { turnstileToken: "token-bun" });
    expect(good.status).toBe(202);
    expect(await count()).toBe(1);
    // Un verificator care aruncă (rețea) trebuie tratat de handler ca respingere? Contractul îl
    // face să întoarcă `false`; aici verificăm că o respingere nu lasă urme.
    const down = { ...open, turnstile: async () => false } as AuthEnv & ApiDeps;
    expect((await register(down, fresh(), { turnstileToken: "orice" })).status).toBe(400);
    // Fără Turnstile configurat, câmpul e ignorat (nu e obligatoriu).
    expect((await register(open, fresh(), { turnstileToken: "orice" })).status).toBe(202);
  });

  it("Turnstile e verificat DUPĂ limitele de rate: IP/email epuizat → 429 fără apel către Cloudflare", async () => {
    const verifier = vi.fn(async () => true);
    const guarded = { ...open, turnstile: verifier } as AuthEnv & ApiDeps;
    const email = fresh();
    for (let i = 0; i < 3; i++) {
      expect((await register(guarded, email, { turnstileToken: "t" })).status).toBe(202);
    }
    verifier.mockClear();
    expect((await register(guarded, email, { turnstileToken: "t" })).status).toBe(429);
    expect(verifier).not.toHaveBeenCalled();
  });

  it("plafon pe adresă, indiferent de IP: peste 5 cereri/oră nu se mai trimite nimic, dar răspunsul rămâne 202", async () => {
    // Plafonul per IP+email dezactivat practic, ca să rămână doar plafonul pe adresă.
    const wide = {
      ...authEnv(fx.db, {
        config: testConfig({
          APP_MODE: "saas",
          SIGNUP_ENABLED: "1",
          AUTH_EMAIL_MAX_REQUESTS: "100",
        }),
        mailer,
      }),
      mailer,
      limits,
    };
    const email = fresh();
    const before = mailer.sent.length;
    for (let i = 0; i < 7; i++) {
      const res = await register(wide, email);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ data: { status: "pending" } });
    }
    await waitForBackgroundMail();
    expect(mailer.sent.filter((m) => m.to === email).length).toBe(5);
    expect(mailer.sent.length - before).toBe(5);
  });

  it("rate limiting pe email: a patra cerere în aceeași oră → 429 cu Retry-After", async () => {
    const email = fresh();
    for (let i = 0; i < 3; i++) expect((await register(open, email)).status).toBe(202);
    const res = await RG.registerHandler(
      apiRequest("/api/v1/register", {
        method: "POST",
        body: { email, name: "Ana", acceptTerms: true },
        headers: SAME_ORIGIN,
      }),
      open,
    );
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
