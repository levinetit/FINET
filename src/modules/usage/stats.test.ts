import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { withRlsOn } from "@/db";
import { TEST_ADMIN_URL } from "@/db/testing";
import { ForbiddenError } from "@/lib/authz";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type LedgerFixture, createLedgerFixture, sqlState } from "@/modules/ledger/testing";
import { createTransaction } from "@/modules/transactions/transactions.service";

import { aggregateOldAppEvents, getUsageStats, isPlatformAdmin } from "./stats";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const SECRET_AMOUNT = 987_654_321;
const SECRET_TEXT = "Cumpărături-SECRETE-xyz";

describe.skipIf(!TEST_ADMIN_URL)("statisticile și retenția (Postgres real, finet_app)", () => {
  let f: LedgerFixture;
  const INST = randomUUID();
  const latest = {
    versionName: "1.2.0",
    versionCode: 120,
    minSupportedVersionCode: 110,
    url: "https://exemplu.ro/app.apk",
    sha256: "a".repeat(64),
    sizeBytes: 1000,
    notes: "",
  };

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_stats");
    // A = administratorul platformei (doar operatorul/CLI-ul îl poate face; aici superuser).
    await f.admin`update finet.users set is_platform_admin = true where id = ${f.A.userId}`;
    // Date financiare care NU au voie să apară în statistici.
    const acc = await createAccount(f.deps, f.A, f.HA, { name: "Cont", type: "cash", currency: "RON" });
    await createTransaction(f.deps, f.A, f.HA, {
      accountId: acc.id,
      type: "expense",
      amountMinor: SECRET_AMOUNT,
      occurredOn: "2026-10-10",
      description: SECRET_TEXT,
      merchant: SECRET_TEXT,
    });
    // Instalări, evenimente (recente și vechi), sesiuni, login-uri, apeluri AI.
    await f.admin`insert into finet.client_installations
        (installation_id, user_id, platform, app_version, version_code, last_seen_at, first_seen_at)
      values (${INST}, ${f.C.userId}, 'android', '1.0.5', 105, now(), now() - interval '20 days'),
             (${randomUUID()}, ${f.A.userId}, 'web', null, null, now() - interval '3 days', now() - interval '3 days')`;
    await f.admin`insert into finet.app_events (user_id, household_id, installation_id, name, screen, error_code, app_version, occurred_at)
      values (${f.C.userId}, ${f.HA}, ${INST}, 'receipt_uploaded', null, null, '1.0.5', now() - interval '1 day'),
             (${f.C.userId}, ${f.HA}, ${INST}, 'screen_view', 'dashboard', null, '1.0.5', now() - interval '1 day'),
             (${f.C.userId}, ${f.HA}, ${INST}, 'error_shown', 'import', 'network_error', '1.0.5', now() - interval '2 days'),
             (${f.C.userId}, ${f.HA}, ${INST}, 'app_open', null, null, '1.0.1', now() - interval '14 months'),
             (${f.C.userId}, ${f.HA}, ${INST}, 'app_open', null, null, '1.0.1', now() - interval '14 months'),
             (${f.A.userId}, ${f.HA}, null, 'login', null, null, null, now() - interval '400 days')`;
    await f.admin`insert into finet.audit_events (household_id, actor_user_id, action, target_type, metadata)
      values (${f.HA}, ${f.C.userId}, 'auth.login_succeeded', 'session', '{"method":"password","platform":"android"}'::jsonb)`;
    await f.admin`insert into finet.ai_calls (household_id, task, model_alias, provider, duration_ms, result, cost_estimate_minor, cost_currency)
      values (${f.HA}, 'receipt_extract', 'finet-vision-external', 'external', 1200, 'ok', 3, 'RON')`;
  });
  afterAll(async () => {
    await f?.close();
  });

  it("doar administratorul platformei: altfel ForbiddenError (42501 în bază)", async () => {
    expect(await isPlatformAdmin(f.db, f.A.userId)).toBe(true);
    expect(await isPlatformAdmin(f.db, f.C.userId)).toBe(false);
    await expect(
      getUsageStats(f.db, f.C.userId, { appMode: "personal", latestAndroid: null }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: null }, (tx) => tx.execute(sql`select finet.usage_stats(true)`)),
      ),
    ).toBe("42501");
    // Un administrator dezactivat nu mai are acces.
    await f.admin`update finet.users set status = 'disabled' where id = ${f.A.userId}`;
    try {
      await expect(
        getUsageStats(f.db, f.A.userId, { appMode: "personal", latestAndroid: null }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await f.admin`update finet.users set status = 'active' where id = ${f.A.userId}`;
    }
  });

  it("datele reale din Faza 2, fără nicio sumă, descriere sau comerciant; membrii doar în `personal`", async () => {
    const s = await getUsageStats(f.db, f.A.userId, { appMode: "personal", latestAndroid: latest });
    expect(s.activeUsers).toEqual([
      { platform: "android", daily: 1, weekly: 1, monthly: 1 },
      { platform: "web", daily: 0, weekly: 1, monthly: 1 },
    ]);
    expect(s.installations).toContainEqual({
      platform: "android",
      appVersion: "1.0.5",
      versionCode: 105,
      count: 1,
      belowMinimum: true,
      outdated: true,
    });
    expect(s.features).toEqual([{ name: "receipt_uploaded", count: 1 }]);
    expect(s.screens).toEqual([{ screen: "dashboard", count: 1 }]);
    expect(s.errors).toEqual([{ errorCode: "network_error", appVersion: "1.0.5", count: 1 }]);
    expect(s.logins).toEqual([expect.objectContaining({ platform: "android", count: 1 })]);
    expect(s.ai).toEqual([
      { provider: "external", result: "ok", count: 1, avgDurationMs: 1200 },
    ]);
    expect(s.members?.map((m) => m.name).sort()).toEqual(["A", "B", "C"]);
    const c = s.members!.find((m) => m.userId === f.C.userId)!;
    expect(c).toMatchObject({ platform: "android", appVersion: "1.0.5", belowMinimum: true });
    // Confidențialitatea: nicio valoare financiară a utilizatorilor.
    const text = JSON.stringify(s);
    expect(text).not.toContain(String(SECRET_AMOUNT));
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toMatch(/exemplu\.ro/); // nici emailuri
    expect(text).not.toMatch(/amount|description|merchant|ocr/i);

    const saas = await getUsageStats(f.db, f.A.userId, { appMode: "saas", latestAndroid: null });
    expect(saas.members).toBeNull();
  });

  it("retenția: evenimentele > 13 luni se agregă pe zi/versiune/platformă și se șterg; cele recente rămân; repetarea nu dublează", async () => {
    const before = await f.admin<{ n: number }[]>`select count(*)::int as n from finet.app_events`;
    expect(await aggregateOldAppEvents(f.db, { batch: 2 })).toBe(3);
    expect(await aggregateOldAppEvents(f.db)).toBe(0);
    const [after] = await f.admin<{ n: number }[]>`select count(*)::int as n from finet.app_events`;
    expect(after!.n).toBe(before[0]!.n - 3);
    const daily = await f.admin<
      { name: string; platform: string; app_version: string; count: string }[]
    >`select name, platform, app_version, count::text from finet.app_event_daily order by name`;
    expect(daily).toEqual([
      { name: "app_open", platform: "android", app_version: "1.0.1", count: "2" },
      { name: "login", platform: "unknown", app_version: "", count: "1" },
    ]);
    // Agregatul nu are coloane de utilizator, instalare sau gospodărie.
    const cols = await f.admin<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'finet' and table_name = 'app_event_daily'`;
    expect(cols.map((c) => c.column_name)).not.toEqual(
      expect.arrayContaining(["user_id"]),
    );
    const s = await getUsageStats(f.db, f.A.userId, { appMode: "personal", latestAndroid: null });
    expect(s.archivedEvents).toBe(3);
  });

  it("aplicația nu are niciun drept direct pe app_event_daily și nu vede evenimentele altora", async () => {
    expect(
      await sqlState(() =>
        withRlsOn(f.db, { userId: f.A.userId }, (tx) =>
          tx.execute(sql`select count(*) from finet.app_event_daily`),
        ),
      ),
    ).toBe("42501");
    const rows = await withRlsOn(f.db, { userId: f.A.userId }, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from finet.app_events where user_id <> ${f.A.userId}`),
    );
    expect(rows[0]?.n).toBe(0);
    // Variabila de scope setată de aplicație nu deschide nimic (politicile sunt doar ale proprietarului).
    const leaked = await withRlsOn(f.db, { userId: f.A.userId }, async (tx) => {
      await tx.execute(sql`select set_config('finet.definer_scope', 'usage_stats', true)`);
      return tx.execute<{ n: number }>(sql`select count(*)::int as n from finet.app_events where user_id <> ${f.A.userId}`);
    });
    expect(leaked[0]?.n).toBe(0);
  });
});
