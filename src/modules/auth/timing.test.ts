import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";

import { handleAuthRequest } from "./handler";
import { type MailMessage, waitForBackgroundMail } from "./mailer";
import {
  type AuthEnv,
  type AuthFixture,
  authEnv,
  authRequest,
  createAuthFixture,
  testConfig,
} from "./testing";
import { createUserWithHousehold } from "./users.service";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

/**
 * M4: cu un SMTP lent (200 ms), timpul răspunsului la magic link / cererea de resetare nu
 * depinde de existența contului (trimiterea e în fundal).
 */
describe.skipIf(!TEST_ADMIN_URL)("fără oracol de timp la emailurile de autentificare (M4)", () => {
  let fx: AuthFixture;
  let env: AuthEnv;
  const sent: MailMessage[] = [];

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_timing");
    const slowMailer = {
      sent,
      send: async (m: MailMessage) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        sent.push(m);
      },
    };
    env = authEnv(fx.db, {
      config: testConfig({ AUTH_EMAIL_MAX_REQUESTS: "1000" }),
      mailer: slowMailer,
    });
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: "parola-timing-1234",
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
  });

  afterAll(async () => {
    await waitForBackgroundMail();
    await fx?.close();
  });

  async function timed(path: string, body: Record<string, unknown>): Promise<number> {
    const start = performance.now();
    const res = await handleAuthRequest(authRequest(path, { body }), env);
    const ms = performance.now() - start;
    expect(res.status).toBe(200);
    await waitForBackgroundMail();
    return ms;
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  for (const [path, extra] of [
    ["/api/auth/sign-in/magic-link", { callbackURL: "/" }],
    ["/api/auth/request-password-reset", { redirectTo: "/resetare" }],
  ] as const) {
    it(`${path}: diferența medie existent/inexistent < 20 ms`, async () => {
      // Încălzire (prima cerere încarcă module și conexiuni).
      await timed(path, { email: "ana@exemplu.ro", ...extra });
      await timed(path, { email: "nimeni@exemplu.ro", ...extra });
      const known: number[] = [];
      const unknown: number[] = [];
      for (let i = 0; i < 8; i++) {
        known.push(await timed(path, { email: "ana@exemplu.ro", ...extra }));
        unknown.push(await timed(path, { email: `nimeni-${i}@exemplu.ro`, ...extra }));
      }
      // Răspunsul nu așteaptă SMTP-ul lent (200 ms).
      expect(mean(known)).toBeLessThan(200);
      expect(Math.abs(mean(known) - mean(unknown))).toBeLessThan(20);
      // Emailurile au plecat totuși, doar pentru contul existent.
      expect(sent.every((m) => m.to === "ana@exemplu.ro")).toBe(true);
      expect(sent.length).toBeGreaterThan(0);
    });
  }
});
