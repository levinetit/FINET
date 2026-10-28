import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import type { ClientInfo } from "@/modules/auth/request";
import { type AuthFixture, createAuthFixture } from "@/modules/auth/testing";

import { hasActiveConsent, lockUserUsage, setConsents } from "./consents";
import { upsertInstallation } from "./installations";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** O promisiune controlată din afară (poarta dintre cele două tranzacții). */
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Revizuirea F2, LOW-1: o scriere a statisticilor de utilizare care a verificat acordul înaintea
 * revocării nu supraviețuiește revocării. Două tranzacții intercalate pe conexiuni diferite.
 */
describe.skipIf(!TEST_ADMIN_URL)("consimțământ vs. scrieri concurente (LOW-1)", () => {
  let fx: AuthFixture;
  const U = randomUUID();
  const info = (installationId: string): ClientInfo => ({
    platform: "android",
    installationId,
    appVersion: "1.0.0",
    versionCode: 1,
    osVersion: null,
    deviceModel: null,
    locale: null,
  });

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_cons_lock");
    await fx.db.execute(
      sql`insert into finet.users (id, email, name) values (${U}, 'lock@exemplu.ro', 'L')`,
    );
  });
  afterAll(async () => {
    await fx?.close();
  });

  const installations = async () =>
    (
      await fx.scratch.admin<{ n: number }[]>`
        select count(*)::int as n from finet.client_installations where user_id = ${U}`
    )[0]!.n;

  it("revocarea așteaptă scrierea în curs și îi șterge apoi rândul", async () => {
    await setConsents(fx.db, U, { usageStats: true });
    const held = gate();
    const release = gate();
    // Scrierea în curs: același protocol ca upsertInstallation (lacăt → acord → inserare).
    const writer = withRlsOn(fx.db, { userId: U }, async (tx) => {
      await lockUserUsage(tx, U);
      expect(await hasActiveConsent(tx, U, "usage_stats")).toBe(true);
      await tx.execute(sql`
        insert into finet.client_installations (installation_id, user_id, platform)
        values (${randomUUID()}, ${U}, 'android')`);
      held.open();
      await release.promise;
    });
    await held.promise;
    let revoked = false;
    const revocation = setConsents(fx.db, U, { usageStats: false }).then(() => {
      revoked = true;
    });
    await pause(400);
    // Revocarea e blocată de lacătul scrierii în curs.
    expect(revoked).toBe(false);
    release.open();
    await writer;
    await revocation;
    expect(revoked).toBe(true);
    // Rândul scris concurent NU a supraviețuit revocării.
    expect(await installations()).toBe(0);
  });

  it("o scriere care așteaptă lacătul vede acordul revocat între timp → nimic scris", async () => {
    await setConsents(fx.db, U, { usageStats: true });
    const held = gate();
    const release = gate();
    // Tranzacția „revocării” ține lacătul și revocă acordul înainte de COMMIT.
    const revoker = withRlsOn(fx.db, { userId: U }, async (tx) => {
      await lockUserUsage(tx, U);
      held.open();
      await release.promise;
      await tx.execute(
        sql`update finet.consents set revoked_at = now()
             where user_id = ${U} and kind = 'usage_stats' and revoked_at is null`,
      );
    });
    await held.promise;
    const write = upsertInstallation(fx.db, U, info(randomUUID()), Date.now());
    await pause(300);
    release.open();
    await revoker;
    expect(await write).toBe("none");
    expect(await installations()).toBe(0);
  });
});
