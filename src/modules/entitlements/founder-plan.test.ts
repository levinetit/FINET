import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL, testClient } from "@/db/testing";
import { parseConfig } from "@/lib/config";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import { UNLIMITED, createEntitlements, householdPlan, receiptHistoryMonths } from "./index";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const config = parseConfig({ APP_MODE: "saas", NODE_ENV: "test" });
/** Scriptul se rulează cu psql; aici fără metacomenzi (`\\...`), cu `:'cutoff'` înlocuit literal. */
const script = (name: string, cutoff = "infinity") =>
  readFileSync(join(process.cwd(), "ops/saas", name), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("\\"))
    .join("\n")
    .replaceAll(":'cutoff'", `'${cutoff}'`);

/**
 * Planul „fondator” (12-D; ADR 0036): `ops/saas/founder-plan.sql` rulat ca `finet_migrator` pe
 * Postgres real. Acordă planul gospodăriilor fără abonament, nu atinge abonamentele existente,
 * e idempotent și nu rescrie un plan modificat de operator.
 */
describe.skipIf(!TEST_ADMIN_URL)("12-D: planul fondator (Postgres real)", () => {
  let fx: AuthFixture;
  let migrator: ReturnType<typeof testClient>;

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_founder_12d");
    migrator = testClient(fx.scratch.migratorUrl, 1);
  });
  afterAll(async () => {
    await migrator?.end({ timeout: 5 });
    await fx?.close();
  });

  async function household(): Promise<string> {
    const r = await createUserWithHousehold(fx.db, {
      email: `f-${randomUUID().slice(0, 8)}@exemplu.ro`,
      name: "Ana",
      password: null,
      firstUserBecomesAdmin: false,
      emailVerified: true,
    });
    if (!r.created) throw new Error("cont neașteptat");
    const [row] = await fx.scratch.admin<{ household_id: string }[]>`
      select household_id from finet.household_members where user_id = ${r.userId} limit 1`;
    return row!.household_id;
  }

  const counts = async () => {
    const [row] = await migrator.unsafe(script("founder-plan-check.sql"));
    return row as Record<string, string>;
  };
  const apply = (cutoff?: string) => migrator.unsafe(script("founder-plan.sql", cutoff));
  const ent = () => createEntitlements("saas", config, fx.db);

  it("acordă fondatorul doar gospodăriilor fără abonament; cele cu abonament rămân neatinse", async () => {
    const bare = await household();
    const paid = await household();
    const [other] = await migrator<{ id: string }[]>`
      insert into finet.plans (code, name, limits, features)
      values ('plata', 'Plătit', '{"household.maxMembers": 3}'::jsonb, array['ask.finet'])
      returning id`;
    await migrator`
      insert into finet.subscriptions (household_id, plan_id, status, provider)
      values (${paid}, ${other!.id}, 'active', 'manual')`;

    const before = await counts();
    expect(before.plan_fondator_exista).toBe("0");
    expect(Number(before.fara_abonament)).toBeGreaterThanOrEqual(1);

    await apply();

    const after = await counts();
    expect(after.fara_abonament).toBe("0");
    expect(after.plan_fondator_exista).toBe("1");

    const founder = await householdPlan(fx.db, bare);
    expect(founder.code).toBe("founder");
    expect(founder.state).toBe("ok");
    const e = ent();
    expect(await e.limit(bare, "household.maxMembers")).toBe(UNLIMITED);
    expect(await e.limit(bare, "storage.quotaMb")).toBe(UNLIMITED);
    expect(await e.limit(bare, "ai.dailyDocuments")).toBe(UNLIMITED);
    expect(await e.limit(bare, "documents.maxFileMb")).toBe(UNLIMITED);
    expect(await e.limit(bare, "queue.priority")).toBe(0);
    for (const f of ["ask.finet", "reports.custom", "documents.pdf", "documents.jpeg"] as const) {
      expect(await e.can(bare, f), f).toBe(true);
    }
    expect(await receiptHistoryMonths("saas", fx.db, bare)).toBeNull();

    // Abonamentul existent rămâne cel plătit.
    const kept = await householdPlan(fx.db, paid);
    expect(kept.code).toBe("plata");
    expect(await e.limit(paid, "household.maxMembers")).toBe(3);
  });

  const founderSubs = async () => {
    const rows = await migrator<{ n: number }[]>`
      select count(*)::int as n from finet.subscriptions where provider = 'founder'`;
    return rows[0]!.n;
  };

  it("e idempotent și nu rescrie un plan modificat de operator", async () => {
    await migrator`update finet.plans set limits = '{"household.maxMembers": 7}'::jsonb where code = 'founder'`;
    const before = await founderSubs();
    await apply();
    await apply();
    expect(await founderSubs()).toBe(before);
    const rows = await migrator<{ limits: Record<string, number> }[]>`
      select limits from finet.plans where code = 'founder'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.limits["household.maxMembers"]).toBe(7);
  });

  it("gospodăria creată DUPĂ rulare nu primește fondator (fără plan implicit: none, fail closed)", async () => {
    const existing = await household();
    await apply();
    const late = await household();
    expect((await householdPlan(fx.db, existing)).code).toBe("founder");
    const plan = await householdPlan(fx.db, late);
    expect(plan.state).toBe("none");
    expect(plan.code).toBeNull();
    expect(await ent().can(late, "ask.finet")).toBe(false);
    expect(await ent().limit(late, "household.maxMembers")).toBe(0);
  });

  it("pragul `cutoff`: o gospodărie creată după prag nu primește fondator nici la o rerulare", async () => {
    const early = await household();
    const cutoff = new Date(Date.now() + 1000).toISOString();
    await new Promise((r) => setTimeout(r, 1500));
    const late = await household();
    await apply(cutoff);
    await apply(cutoff);
    expect((await householdPlan(fx.db, early)).code).toBe("founder");
    expect((await householdPlan(fx.db, late)).state).toBe("none");
  });

  it("scriptul cere `cutoff` (altfel psql se oprește înainte de orice scriere)", () => {
    const raw = readFileSync(join(process.cwd(), "ops/saas/founder-plan.sql"), "utf8");
    expect(raw).toContain("\\if :{?cutoff}");
    expect(raw).toContain("\\quit 3");
    expect(raw).toContain("h.created_at <= :'cutoff'::timestamptz");
  });

  it("verificarea nu scrie nimic", async () => {
    const [a] = await migrator<{ n: number }[]>`select count(*)::int as n from finet.subscriptions`;
    await counts();
    await counts();
    const [b] = await migrator<{ n: number }[]>`select count(*)::int as n from finet.subscriptions`;
    expect(b!.n).toBe(a!.n);
  });
});
