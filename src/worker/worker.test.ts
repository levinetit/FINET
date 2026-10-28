import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { createAccount } from "@/modules/accounts/accounts.service";
import { type LedgerFixture, createLedgerFixture } from "@/modules/ledger/testing";
import { createRecurringRule } from "@/modules/recurring/recurring.service";

import { PgTlsConfigError, bossOptions, pgConnectionOptions } from "./boss";
import { main } from "./cli";
import { HEARTBEAT_STALE_SECONDS, queueStateOf } from "./heartbeat";
import { handleGenerate, handleGenerateNow } from "./jobs";
import { errorCode } from "./main";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const CA = "-----BEGIN CERTIFICATE-----\nfictiv\n-----END CERTIFICATE-----\n";

describe("opțiunile pg-boss (fără rețea): TLS fail-closed", () => {
  const BASE = "postgres://u:p@db.exemplu.invalid:5432/postgres";
  const prod = { production: true } as const;
  const dev = { production: false } as const;

  it("verify-full + CA: CA-ul explicit, sslmode scos din URL (altfel `pg` l-ar suprascrie)", () => {
    for (const env of [prod, dev]) {
      const o = pgConnectionOptions(`${BASE}?sslmode=verify-full&application_name=x`, CA, env);
      expect(o.ssl).toEqual({ ca: CA, rejectUnauthorized: true });
      expect(o.connectionString).not.toMatch(/ssl/i);
      expect(o.connectionString).toContain("application_name=x");
    }
  });

  it("producție: fără CA, disable, require sau fără sslmode → eroare (niciodată TLS oprit)", () => {
    for (const [query, ca] of [
      ["?sslmode=verify-full", null],
      ["?sslmode=disable", CA],
      ["?sslmode=require", CA],
      ["", CA],
    ] as const) {
      expect(() => pgConnectionOptions(BASE + query, ca, prod)).toThrow(PgTlsConfigError);
    }
  });

  it("oriunde: sslmode gol/necunoscut/altă grafie/duplicat, `ssl=…`, alți parametri TLS → eroare", () => {
    for (const env of [prod, dev]) {
      for (const query of [
        "?sslmode=",
        "?sslmode=no-verify",
        "?sslmode=prefer",
        "?sslmode=allow",
        "?sslmode=Verify-Full",
        "?SSLMODE=Disable",
        "?sslmode=verify-full&sslmode=disable",
        "?sslmode=disable&sslmode=disable",
        "?ssl=false",
        "?ssl=0",
        "?ssl=true",
        "?sslmode=verify-full&sslrootcert=/ca.crt",
        "?sslmode=verify-full&uselibpqcompat=true",
        "?sslmode=verify-full&SSLNegotiation=direct",
      ]) {
        expect(() => pgConnectionOptions(BASE + query, CA, env), query).toThrow(PgTlsConfigError);
      }
    }
  });

  it("în afara producției: disable/lipsă → fără TLS, require → TLS fără lanț, verify-ca fără CA → trust store", () => {
    expect(pgConnectionOptions(`${BASE}?sslmode=disable`, null, dev).ssl).toBe(false);
    expect(pgConnectionOptions(BASE, null, dev).ssl).toBe(false);
    expect(pgConnectionOptions(`${BASE}?sslmode=require`, null, dev).ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(pgConnectionOptions(`${BASE}?sslmode=verify-ca`, null, dev).ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("eroarea nu conține URL-ul sau parola", () => {
    try {
      pgConnectionOptions("postgres://u:parola-secreta@h.invalid/d?sslmode=gresit", CA, prod);
      throw new Error("trebuia să arunce");
    } catch (error) {
      expect(String((error as Error).message)).not.toMatch(/parola-secreta|h\.invalid|gresit/);
    }
  });

  it("constructorul: fără DDL la rulare (migrate/createSchema/reindex/statistici oprite), schema pgboss", () => {
    const o = bossOptions(`${BASE}?sslmode=verify-full`, CA, prod);
    expect(o).toMatchObject({
      schema: "pgboss",
      migrate: false,
      createSchema: false,
      reindex: false,
      persistQueueStats: false,
      persistWarnings: false,
      supervise: true,
      schedule: true,
      ssl: { ca: CA, rejectUnauthorized: true },
    });
    expect(o.max).toBeLessThanOrEqual(3);
  });
});

describe("semnalul cozii și codurile de eroare", () => {
  it("queueStateOf: fără rând/oprit → unknown, proaspăt → ok, vechi → degraded", () => {
    expect(queueStateOf(null)).toBe("unknown");
    expect(queueStateOf({ ageSeconds: 5, stopped: true })).toBe("unknown");
    expect(queueStateOf({ ageSeconds: 5, stopped: false })).toBe("ok");
    expect(queueStateOf({ ageSeconds: HEARTBEAT_STALE_SECONDS + 1, stopped: false })).toBe(
      "degraded",
    );
  });

  it("errorCode nu întoarce mesaje (pot conține valori)", () => {
    expect(errorCode({ code: "42501", message: "x 4999 lei" })).toBe("42501");
    expect(errorCode(new Error("postgres://u:secret@h"))).toBe("unknown");
    expect(errorCode({ code: "a b; drop" })).toBe("unknown");
  });
});

describe("CLI-ul workerului (fără bază)", () => {
  it("alt rol decât worker → cod 1, fără URL în log", async () => {
    const out: string[] = [];
    const r = await main({
      env: { APP_MODE: "personal", FINET_ROLE: "web", DATABASE_URL: "postgres://u:secret@h/d" },
      out: (l) => out.push(l),
      onSignal: () => {},
    });
    expect(r.code).toBe(1);
    expect(out.join("\n")).toContain("role_not_worker");
    expect(out.join("\n")).not.toContain("secret");
  });

  it("worker cu URL-ul altui rol → eroare de configurare, fără valori", async () => {
    const out: string[] = [];
    const r = await main({
      env: {
        APP_MODE: "personal",
        FINET_ROLE: "worker",
        WORKER_DATABASE_URL: "postgres://u:secret@h/d",
        MIGRATOR_DATABASE_URL: "postgres://m:secret2@h/d",
      },
      out: (l) => out.push(l),
      onSignal: () => {},
    });
    expect(r.code).toBe(1);
    expect(out.join("\n")).toContain("MIGRATOR_DATABASE_URL");
    expect(out.join("\n")).not.toMatch(/secret/);
  });
});

describe.skipIf(!TEST_ADMIN_URL)("handlerele joburilor (Postgres real, apelate direct)", () => {
  let f: LedgerFixture;
  const logs: Record<string, unknown>[] = [];
  const now = () => new Date("2026-03-15T10:00:00Z");

  beforeAll(async () => {
    f = await createLedgerFixture("finet_it_worker");
    const acc = (
      await createAccount(f.deps, f.A, f.HA, { name: "Card", type: "bank", currency: "RON" })
    ).id;
    await createRecurringRule(f.deps, f.A, f.HA, {
      accountId: acc,
      type: "expense",
      amountMinor: 123_456,
      description: "Netflix Secret",
      merchant: "Netflix",
      frequency: "monthly",
      startOn: "2026-01-10",
    });
  });
  afterAll(async () => {
    await f?.close();
  });

  it("recurring.generate: generează scadențele; logul are doar contoare, fără sume/descrieri/id-uri", async () => {
    const s = await handleGenerate({ db: f.db, now, log: (e) => logs.push({ ...e }) });
    expect(s).toMatchObject({ rules: 1, generated: 3, failed: 0 });
    const again = await handleGenerate({ db: f.db, now, log: (e) => logs.push({ ...e }) });
    expect(again.generated).toBe(0);
    const text = JSON.stringify(logs);
    for (const leak of ["123456", "1234,56", "Netflix", "Secret", f.HA, f.A.userId]) {
      expect(text).not.toContain(leak);
    }
  });

  it("recurring.generate-now: date invalide sau membru străin → respins, fără efect", async () => {
    const deps = { db: f.db, now };
    expect(await handleGenerateNow(deps, { householdId: "x" })).toEqual({
      rejected: "invalid_data",
    });
    expect(
      await handleGenerateNow(deps, { householdId: f.HA, userId: f.A.userId, extra: 1 }),
    ).toEqual({ rejected: "invalid_data" });
    expect(await handleGenerateNow(deps, { householdId: f.HA, userId: f.B.userId })).toEqual({
      rejected: "not_member",
    });
    const ok = await handleGenerateNow(deps, { householdId: f.HA, userId: f.C.userId });
    expect(ok).toMatchObject({ rules: 0, generated: 0 });
  });
});
