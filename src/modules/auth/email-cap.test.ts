import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";

import type { FinetAuth } from "./auth";
import { handleAuthRequest } from "./handler";
import { rateLimitKey } from "./rate-limit";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  authRequest,
  createAuthFixture,
  login,
  testConfig,
} from "./testing";
import { createUserWithHousehold } from "./users.service";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/** Plafonul pe email (M2): rezervare atomică înainte de Better Auth (fără TOCTOU). */
describe.skipIf(!TEST_ADMIN_URL)("plafonul pe email: rezervare atomică (M2)", () => {
  let fx: AuthFixture;
  let env: AuthEnv;
  const EMAIL = "ana@exemplu.ro";
  const PASSWORD = "parola-cap-12345";
  const capKey = rateLimitKey("login_email", null, EMAIL);

  const capCount = async () =>
    Number(
      (
        await fx.scratch.admin<{ count: number }[]>`
          select count from finet.auth_rate_limits where key = ${capKey}`
      )[0]?.count ?? 0,
    );

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_emailcap");
    // Limita pe IP + email mare: testul măsoară doar plafonul pe email (20).
    env = authEnv(fx.db, { config: testConfig({ AUTH_LOGIN_MAX_ATTEMPTS: "1000" }) });
    await createUserWithHousehold(fx.db, {
      email: EMAIL,
      name: "Ana",
      password: PASSWORD,
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("30 de eșecuri simultane cu plafon 20 → cel mult 20 ajung la Better Auth, restul 429", async () => {
    let reached = 0;
    const counting: AuthEnv = {
      ...env,
      auth: {
        ...env.auth,
        handler: async (request: Request) => {
          reached++;
          return env.auth.handler(request);
        },
      } as FinetAuth,
    };
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        handleAuthRequest(
          authRequest("/api/auth/sign-in/email", {
            body: { email: EMAIL, password: "gresita-12345" },
          }),
          counting,
        ),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(reached).toBeLessThanOrEqual(20);
    expect(statuses.filter((s) => s === 401).length).toBe(reached);
    expect(statuses.filter((s) => s === 429).length).toBe(30 - reached);
    expect(reached).toBe(20);
  });

  it("după un login reușit (aici, după fereastră) contorul revine la 0", async () => {
    // Plafonul e depășit; trecem de fereastra lui (1 h) cu ceasul injectat.
    const later = authEnv(fx.db, {
      config: testConfig({ AUTH_LOGIN_MAX_ATTEMPTS: "1000" }),
      now: () => Date.now() + 61 * 60_000,
    });
    expect((await login(later, EMAIL, PASSWORD)).response.status).toBe(200);
    expect(await capCount()).toBe(0);
  });

  it("un 5xx simulat restituie rezervarea (nu se numără)", async () => {
    await login(env, EMAIL, "gresita-12345");
    expect(await capCount()).toBe(1);
    const broken: AuthEnv = {
      ...env,
      auth: { ...env.auth, handler: async () => new Response(null, { status: 500 }) } as FinetAuth,
    };
    const r = await handleAuthRequest(
      authRequest("/api/auth/sign-in/email", { body: { email: EMAIL, password: "x-12345678" } }),
      broken,
    );
    expect(r.status).toBe(500);
    expect(await capCount()).toBe(1);
  });
});
