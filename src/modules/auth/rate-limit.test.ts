import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";

import {
  CLEANUP_INTERVAL_MS,
  dailyStatKey,
  hitRateLimit,
  rateLimitKey,
  resetCleanupForTests,
} from "./rate-limit";
import { type AuthFixture, createAuthFixture } from "./testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("cheile de rate limiting", () => {
  it("subiectul e trunchiat la 254 de caractere înainte de rezumat (M3)", () => {
    const long = `${"a".repeat(254)}@exemplu.ro`;
    expect(rateLimitKey("login", null, long)).toBe(rateLimitKey("login", null, long.slice(0, 254)));
    expect(rateLimitKey("login", null, "x".repeat(20_000)).length).toBeLessThan(80);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("curățarea `auth_rate_limits` (M3)", () => {
  let fx: AuthFixture;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_rlclean");
  });

  afterAll(async () => {
    await fx?.close();
  });

  it("șterge cheile expirate (> 2 × fereastra) ale tipului, păstrează cele active și statisticile", async () => {
    const now = Date.UTC(2026, 9, 28, 12);
    const windowMs = 900_000;
    const old = now - 3 * windowMs;
    const recent = now - windowMs;
    await fx.scratch.admin`
      insert into finet.auth_rate_limits (key, count, last_request) values
        ('finet:login:unknown:expirat1', 3, ${old}),
        ('finet:login:unknown:expirat2', 1, ${old}),
        ('finet:login:unknown:activ', 2, ${recent}),
        ('finet:email:unknown:alt-tip-expirat', 1, ${old}),
        (${dailyStatKey("login_failed", old)}, 7, ${old}),
        ('127.0.0.1|/sign-in/email', 1, ${old})`;
    resetCleanupForTests();
    const r = await hitRateLimit(
      fx.db,
      rateLimitKey("login", null, "ana@exemplu.ro"),
      { max: 5, windowSeconds: windowMs / 1000 },
      now,
    );
    expect(r.allowed).toBe(true);
    const keys = (
      await fx.scratch.admin<{ key: string }[]>`select key from finet.auth_rate_limits order by key`
    ).map((k) => k.key);
    expect(keys).not.toContain("finet:login:unknown:expirat1");
    expect(keys).not.toContain("finet:login:unknown:expirat2");
    expect(keys).toContain("finet:login:unknown:activ");
    // Alt tip, statistici și cheile Better Auth nu sunt atinse de curățarea tipului `login`.
    expect(keys).toContain("finet:email:unknown:alt-tip-expirat");
    expect(keys).toContain(dailyStatKey("login_failed", old));
    expect(keys).toContain("127.0.0.1|/sign-in/email");
  });

  it("rulează cel mult o dată pe minut per tip", async () => {
    const now = Date.UTC(2026, 9, 29, 12);
    resetCleanupForTests();
    const rule = { max: 5, windowSeconds: 60 };
    await hitRateLimit(fx.db, rateLimitKey("email", null, "a@exemplu.ro"), rule, now);
    await fx.scratch.admin`
      insert into finet.auth_rate_limits (key, count, last_request)
      values ('finet:email:unknown:vechi', 1, ${now - 10 * 60_000})`;
    await hitRateLimit(fx.db, rateLimitKey("email", null, "b@exemplu.ro"), rule, now + 1000);
    const still = await fx.scratch
      .admin`select 1 from finet.auth_rate_limits where key = 'finet:email:unknown:vechi'`;
    expect(still.length).toBe(1);
    await hitRateLimit(
      fx.db,
      rateLimitKey("email", null, "c@exemplu.ro"),
      rule,
      now + CLEANUP_INTERVAL_MS,
    );
    const gone = await fx.scratch
      .admin`select 1 from finet.auth_rate_limits where key = 'finet:email:unknown:vechi'`;
    expect(gone.length).toBe(0);
  });
});
