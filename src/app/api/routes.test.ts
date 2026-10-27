import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDb } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { resetConfigForTests } from "@/lib/config";
import {
  APP_URL,
  type AuthFixture,
  TEST_AUTH_SECRET,
  createAuthFixture,
} from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * Rutele Next reale (`route.ts`), cu `getAuthRuntime()` construit din mediul procesului (ca în
 * producție, dar cu o bază de test și fără Access): verifică legătura rută → handler → Better
 * Auth, nu doar handlerele cu dependențe injectate.
 */
describe.skipIf(!TEST_ADMIN_URL)("rutele /api/auth și /api/v1 (mediul procesului)", () => {
  let fx: AuthFixture;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_routes");
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: "parola-rute-12345",
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
    vi.stubEnv("APP_MODE", "personal");
    vi.stubEnv("FINET_ROLE", "");
    vi.stubEnv("DATABASE_URL", fx.scratch.appUrl);
    vi.stubEnv("WORKER_DATABASE_URL", "");
    vi.stubEnv("MIGRATOR_DATABASE_URL", "");
    vi.stubEnv("APP_URL", APP_URL);
    vi.stubEnv("BETTER_AUTH_SECRET", TEST_AUTH_SECRET);
    vi.stubEnv("CF_ACCESS_REQUIRED", "false");
    vi.stubEnv("SMTP_HOST", "");
    resetConfigForTests();
  });

  afterAll(async () => {
    await closeDb();
    vi.unstubAllEnvs();
    resetConfigForTests();
    await fx?.close();
  });

  it("sign-up → 404, sign-in → 200 cu bearer, /me cu bearer → 200, fără sesiune → 401", async () => {
    const auth = await import("@/app/api/auth/[...all]/route");
    const me = await import("@/app/api/v1/me/route");
    const json = { "content-type": "application/json", origin: APP_URL };

    const signUp = await auth.POST(
      new Request(`${APP_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email: "nou@exemplu.ro", password: "parola-rute-12345", name: "N" }),
      }),
    );
    expect(signUp.status).toBe(404);

    const signIn = await auth.POST(
      new Request(`${APP_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ email: "ana@exemplu.ro", password: "parola-rute-12345" }),
      }),
    );
    expect(signIn.status).toBe(200);
    const bearer = signIn.headers.get("set-auth-token");
    expect(bearer).toBeTruthy();

    const ok = await me.GET(
      new Request(`${APP_URL}/api/v1/me`, { headers: { authorization: `Bearer ${bearer}` } }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { user: { email: string } } }).data.user.email).toBe(
      "ana@exemplu.ro",
    );
    expect((await me.GET(new Request(`${APP_URL}/api/v1/me`))).status).toBe(401);
  });
});
