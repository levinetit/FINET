import { readFileSync } from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { checkDb, closeHealthDb } from "@/app/api/health/checks";
import { postgresOptions, sslOptionFor } from "@/lib/db-client";
import { databaseTlsParams } from "@/lib/db-url";

// CA FICTIV (doar formă PEM; nu e un certificat real).
const CA = "-----BEGIN CERTIFICATE-----\nMIIfictiv\n-----END CERTIFICATE-----\n";
const base = "postgres://finet_app:parola-fictiva@db.exemplu.invalid:6543/postgres";
const url = (sslmode?: string): string => (sslmode ? `${base}?sslmode=${sslmode}` : base);
const opts = { ca: CA, applicationName: "finet-test" } as const;

describe("databaseTlsParams", () => {
  it("citește sslmode și prezența sslrootcert, fără alte părți din URL", () => {
    expect(databaseTlsParams(url("verify-full"))).toEqual({
      sslmode: "verify-full",
      hasSslRootCert: false,
    });
    expect(databaseTlsParams(`${base}?sslmode=verify-full&sslrootcert=/ca.crt`)).toEqual({
      sslmode: "verify-full",
      hasSslRootCert: true,
    });
    expect(databaseTlsParams(base)).toEqual({ sslmode: null, hasSslRootCert: false });
    expect(databaseTlsParams("nu e un url")).toEqual({ sslmode: null, hasSslRootCert: false });
  });
});

describe("sslOptionFor / postgresOptions", () => {
  it("verify-full și verify-ca cu CA → ssl explicit cu rejectUnauthorized: true", () => {
    for (const mode of ["verify-full", "verify-ca"]) {
      expect(sslOptionFor(url(mode), CA)).toEqual({ ca: CA, rejectUnauthorized: true });
      expect(postgresOptions(url(mode), opts).ssl).toEqual({ ca: CA, rejectUnauthorized: true });
    }
  });

  it("fără CA → nicio opțiune ssl (postgres.js folosește sslmode din URL și trust store-ul Node)", () => {
    expect(sslOptionFor(url("verify-full"), null)).toBeUndefined();
    expect("ssl" in postgresOptions(url("verify-full"), { ...opts, ca: null })).toBe(false);
  });

  it("require / disable / fără sslmode → nicio opțiune ssl, chiar cu CA", () => {
    for (const u of [url("require"), url("disable"), url("prefer"), url()]) {
      expect(sslOptionFor(u, CA)).toBeUndefined();
      expect("ssl" in postgresOptions(u, opts)).toBe(false);
    }
  });

  it("opțiunile comune: o conexiune, fără prepared statements, application_name", () => {
    const o = postgresOptions(url("disable"), opts);
    expect(o).toMatchObject({
      max: 1,
      prepare: false,
      idle_timeout: 30,
      connect_timeout: 3,
      connection: { application_name: "finet-test" },
    });
    expect(postgresOptions(url(), { ...opts, max: 4, connectTimeoutSeconds: 10 })).toMatchObject({
      max: 4,
      connect_timeout: 10,
    });
  });
});

// Integrare TLS (opțională): Postgres cu certificat semnat de un CA de test, generat local
// (vezi raportul T7). Variabilele lipsesc în CI, deci testele se sar acolo.
const TLS_URL = process.env.TLS_TEST_DATABASE_URL; // fără sslmode
const TLS_CA = process.env.TLS_TEST_CA_FILE;
const TLS_WRONG_CA = process.env.TLS_TEST_WRONG_CA_FILE;
const tls = TLS_URL && TLS_CA && TLS_WRONG_CA;

describe.skipIf(!tls)("TLS spre un Postgres real (CA de test)", () => {
  afterAll(async () => {
    await closeHealthDb();
  });
  const ca = (): string => readFileSync(TLS_CA!, "utf8");
  const wrongCa = (): string => readFileSync(TLS_WRONG_CA!, "utf8");

  it("verify-full + CA-ul corect → ok", async () => {
    expect(await checkDb(`${TLS_URL}?sslmode=verify-full`, ca())).toBe("ok");
  });

  it("verify-full + alt CA → down (certificatul nu e acceptat)", async () => {
    expect(await checkDb(`${TLS_URL}?sslmode=verify-full`, wrongCa())).toBe("down");
  });

  it("verify-full fără CA → down (CA-ul de test nu e în trust store-ul Node)", async () => {
    expect(await checkDb(`${TLS_URL}?sslmode=verify-full`, null)).toBe("down");
  });

  it("verify-full + CA corect, dar alt nume de host decât cel din certificat → down", async () => {
    const other = process.env.TLS_TEST_DATABASE_URL_OTHER_HOST;
    if (!other) return;
    expect(await checkDb(`${other}?sslmode=verify-full`, ca())).toBe("down");
    expect(await checkDb(`${other}?sslmode=verify-ca`, ca())).toBe("down");
  });

  it("require fără CA → ok (criptat, dar lanțul NU e verificat)", async () => {
    expect(await checkDb(`${TLS_URL}?sslmode=require`, null)).toBe("ok");
  });
});
