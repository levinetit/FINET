import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";

import { ALLOWED_AUTH_PATHS, DISABLED_AUTH_PATHS, createAuth, isAllowedAuthPath } from "./auth";
import { handleAuthRequest } from "./handler";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  authRequest,
  createAuthFixture,
  fakeMailer,
  login,
  testConfig,
} from "./testing";
import { createUserWithHousehold } from "./users.service";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Toate căile HTTP ale instanței reale (cu magic link, deci cu toate pluginurile FINET). */
function realPaths(): string[] {
  const auth = createAuth({ db: {} as never, config: testConfig(), mailer: fakeMailer() });
  const paths = new Set<string>();
  for (const endpoint of Object.values(auth.api)) {
    const path = (endpoint as { path?: unknown }).path;
    if (typeof path === "string") paths.add(path);
  }
  return [...paths].sort();
}

const concrete = (path: string) => path.replace(/:[a-zA-Z]+/g, "x-param");

describe("lista permisă a căilor Better Auth (M1)", () => {
  it("enumerarea instanței reale găsește căile cunoscute", () => {
    const paths = realPaths();
    expect(paths).toContain("/verify-password");
    expect(paths).toContain("/sign-in/email");
    expect(paths.length).toBeGreaterThan(20);
  });

  it("fiecare cale e fie în lista permisă, fie închisă", () => {
    for (const path of realPaths()) {
      const sub = concrete(path).toLowerCase();
      const allowed = isAllowedAuthPath(sub);
      if (!allowed) continue;
      // Ce e permis e permis explicit (nu printr-o regulă prea largă).
      expect(
        ALLOWED_AUTH_PATHS.has(sub) || path === "/reset-password/:token",
        `cale permisă neașteptat: ${path}`,
      ).toBe(true);
    }
    expect(isAllowedAuthPath("/reset-password/abc/def")).toBe(false);
    for (const p of DISABLED_AUTH_PATHS) expect(isAllowedAuthPath(p)).toBe(false);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("căile închise răspund 404 prin HTTP (M1)", () => {
  let fx: AuthFixture;
  let env: AuthEnv;
  let cookie: string;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_allow");
    env = authEnv(fx.db);
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: "parola-allow-1234",
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
    cookie = (await login(env, "ana@exemplu.ro", "parola-allow-1234")).cookie;
    expect(cookie).toMatch(/session_token=/);
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("POST /api/auth/verify-password cu sesiune validă → 404", async () => {
    const res = await handleAuthRequest(
      authRequest("/api/auth/verify-password", {
        body: { password: "parola-allow-1234" },
        headers: { cookie },
      }),
      env,
    );
    expect(res.status).toBe(404);
  });

  it("orice cale nepermisă din instanța reală dă 404 (GET și POST, cu sesiune)", async () => {
    for (const path of realPaths()) {
      const sub = concrete(path);
      if (isAllowedAuthPath(sub.toLowerCase())) continue;
      for (const method of ["GET", "POST"]) {
        const res = await handleAuthRequest(
          authRequest(`/api/auth${sub}`, {
            method,
            body: method === "POST" ? {} : undefined,
            headers: { cookie },
          }),
          env,
        );
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    }
    // O cale inventată (de exemplu adăugată de un plugin viitor) e tot 404.
    const unknown = await handleAuthRequest(
      authRequest("/api/auth/cale-noua-plugin", { body: {}, headers: { cookie } }),
      env,
    );
    expect(unknown.status).toBe(404);
  });

  it("căile permise rămân funcționale (get-session cu sesiune)", async () => {
    const res = await handleAuthRequest(
      authRequest("/api/auth/get-session", { headers: { cookie } }),
      env,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user?: { email: string } }).user?.email).toBe("ana@exemplu.ro");
  });
});
