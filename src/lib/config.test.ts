import { describe, expect, it } from "vitest";

import { ConfigError, parseConfig } from "@/lib/config";

// Mediu minim valid pentru dezvoltare.
const DEV = { APP_MODE: "personal", NODE_ENV: "development" } as const;

// Mediu minim valid pentru producție (valori fictive).
const PROD = {
  APP_MODE: "personal",
  NODE_ENV: "production",
  STORAGE_DIR: "/data/storage",
  CF_ACCESS_TEAM_DOMAIN: "echipa-exemplu.cloudflareaccess.com",
  CF_ACCESS_AUD: "aud-fictiv-0123456789",
} as const;

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).issues.map((i) => i.variable);
  }
  throw new Error("parseConfig trebuia să arunce");
}

describe("parseConfig", () => {
  it("acceptă mediul minim de dezvoltare și aplică valorile implicite", () => {
    const c = parseConfig(DEV);
    expect(c.appMode).toBe("personal");
    expect(c.appName).toBe("FINET");
    expect(c.storage).toMatchObject({ driver: "local", dir: "./.data/storage", quotaMb: 5000 });
    expect(c.storage.s3).toBeNull();
    expect(c.access).toEqual({ required: false, teamDomain: null, aud: null });
    expect(c.database.url).toBeNull();
    expect(c.ai.dailyDocumentLimit).toBe(50);
    expect(c.ai.monthlyBudget).toEqual({ amountMinor: 0n, currency: "USD" });
    expect(c.notify).toEqual({ telegram: null, smtp: null });
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("cere APP_MODE (fără valoare implicită) și refuză valori necunoscute", () => {
    expect(issuesOf({ NODE_ENV: "development" })).toEqual(["APP_MODE"]);
    expect(issuesOf({ ...DEV, APP_MODE: "enterprise" })).toEqual(["APP_MODE"]);
  });

  it("tratează șirul gol ca nesetat", () => {
    const c = parseConfig({ ...DEV, DATABASE_URL: "", STORAGE_QUOTA_MB: "" });
    expect(c.database.url).toBeNull();
    expect(c.storage.quotaMb).toBe(5000);
  });

  it("în producție CF_ACCESS_REQUIRED e implicit true și cere domeniul și AUD-ul", () => {
    const c = parseConfig(PROD);
    expect(c.access.required).toBe(true);
    expect(
      issuesOf({ ...PROD, CF_ACCESS_TEAM_DOMAIN: undefined, CF_ACCESS_AUD: undefined }),
    ).toEqual(["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD"]);
  });

  it("FAIL-CLOSED: refuză pornirea cu CF_ACCESS_REQUIRED=false în producție", () => {
    expect(issuesOf({ ...PROD, CF_ACCESS_REQUIRED: "false" })).toEqual(["CF_ACCESS_REQUIRED"]);
  });

  it("permite CF_ACCESS_REQUIRED=false explicit doar în afara producției", () => {
    expect(parseConfig({ ...DEV, CF_ACCESS_REQUIRED: "false" }).access.required).toBe(false);
    const c = parseConfig({
      ...DEV,
      CF_ACCESS_REQUIRED: "true",
      CF_ACCESS_TEAM_DOMAIN: "echipa.cloudflareaccess.com",
      CF_ACCESS_AUD: "aud",
    });
    expect(c.access.required).toBe(true);
  });

  it("acceptă doar `true`/`false` pentru CF_ACCESS_REQUIRED (nu „0”, „yes”)", () => {
    expect(issuesOf({ ...DEV, CF_ACCESS_REQUIRED: "0" })).toEqual(["CF_ACCESS_REQUIRED"]);
    expect(issuesOf({ ...DEV, CF_ACCESS_REQUIRED: "yes" })).toEqual(["CF_ACCESS_REQUIRED"]);
  });

  it("CF_ACCESS_TEAM_DOMAIN trebuie să fie un hostname simplu (fără schemă sau cale)", () => {
    for (const bad of [
      "https://echipa.cloudflareaccess.com",
      "echipa.cloudflareaccess.com/cale",
      "echipa.cloudflareaccess.com:443",
      "localhost",
      "evil.com#",
    ]) {
      expect(issuesOf({ ...PROD, CF_ACCESS_TEAM_DOMAIN: bad })).toEqual(["CF_ACCESS_TEAM_DOMAIN"]);
    }
  });

  it("în producție cere STORAGE_DIR explicit", () => {
    expect(issuesOf({ ...PROD, STORAGE_DIR: undefined })).toEqual(["STORAGE_DIR"]);
  });

  it("driverul s3 cere toate variabilele STORAGE_S3_*", () => {
    expect(issuesOf({ ...DEV, STORAGE_DRIVER: "s3" })).toEqual([
      "STORAGE_S3_ENDPOINT",
      "STORAGE_S3_REGION",
      "STORAGE_S3_BUCKET",
      "STORAGE_S3_ACCESS_KEY_ID",
      "STORAGE_S3_SECRET_ACCESS_KEY",
    ]);
    const c = parseConfig({
      ...DEV,
      STORAGE_DRIVER: "s3",
      STORAGE_S3_ENDPOINT: "https://exemplu.invalid/storage/v1/s3",
      STORAGE_S3_REGION: "eu-central-1",
      STORAGE_S3_BUCKET: "finet-exemplu",
      STORAGE_S3_ACCESS_KEY_ID: "cheie-fictiva",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret-fictiv",
    });
    expect(c.storage.s3?.bucket).toBe("finet-exemplu");
  });

  it("refuză un driver de storage necunoscut și numere invalide", () => {
    expect(issuesOf({ ...DEV, STORAGE_DRIVER: "ftp" })).toEqual(["STORAGE_DRIVER"]);
    expect(issuesOf({ ...DEV, STORAGE_QUOTA_MB: "-5" })).toEqual(["STORAGE_QUOTA_MB"]);
    expect(issuesOf({ ...DEV, AI_DAILY_DOCUMENT_LIMIT: "1.5" })).toEqual([
      "AI_DAILY_DOCUMENT_LIMIT",
    ]);
  });

  it("AI_MONTHLY_BUDGET e sumă în unități minore (bigint), fără float", () => {
    const c = parseConfig({
      ...DEV,
      AI_MONTHLY_BUDGET: "12,50",
      AI_MONTHLY_BUDGET_CURRENCY: "EUR",
    });
    expect(c.ai.monthlyBudget).toEqual({ amountMinor: 1250n, currency: "EUR" });
    expect(typeof c.ai.monthlyBudget.amountMinor).toBe("bigint");
    expect(issuesOf({ ...DEV, AI_MONTHLY_BUDGET: "12.345" })).toEqual(["AI_MONTHLY_BUDGET"]);
    expect(issuesOf({ ...DEV, AI_MONTHLY_BUDGET: "1e3" })).toEqual(["AI_MONTHLY_BUDGET"]);
    expect(issuesOf({ ...DEV, AI_MONTHLY_BUDGET_CURRENCY: "GBP" })).toEqual([
      "AI_MONTHLY_BUDGET_CURRENCY",
    ]);
  });

  it("refuză URL-uri Postgres invalide", () => {
    expect(issuesOf({ ...DEV, DATABASE_URL: "mysql://u:p@h/db" })).toEqual(["DATABASE_URL"]);
    expect(parseConfig({ ...DEV, DATABASE_URL: "postgresql://u:p@h:5432/db" }).database.url).toBe(
      "postgresql://u:p@h:5432/db",
    );
  });

  it("mesajul de eroare nu conține valorile secretelor", () => {
    const secret = "parola-super-secreta-123";
    let message = "";
    try {
      parseConfig({
        ...PROD,
        DATABASE_URL: `mysql://user:${secret}@db.exemplu.invalid/x`,
        HEALTH_TOKEN: "tk-qz7",
        NOTIFY_TELEGRAM_BOT_TOKEN: secret,
        STORAGE_S3_SECRET_ACCESS_KEY: secret,
        CF_ACCESS_REQUIRED: "false",
      });
    } catch (error) {
      message = (error as Error).message + JSON.stringify((error as ConfigError).issues);
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("HEALTH_TOKEN");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("tk-qz7");
    expect(message).not.toContain("db.exemplu.invalid");
  });

  it("notificările Telegram cer ambele variabile; SMTP cere expeditorul", () => {
    expect(issuesOf({ ...DEV, NOTIFY_TELEGRAM_BOT_TOKEN: "token-fictiv" })).toEqual([
      "NOTIFY_TELEGRAM_BOT_TOKEN/NOTIFY_TELEGRAM_CHAT_ID",
    ]);
    expect(issuesOf({ ...DEV, SMTP_HOST: "smtp.exemplu.invalid" })).toEqual(["SMTP_FROM"]);
    const c = parseConfig({
      ...DEV,
      NOTIFY_TELEGRAM_BOT_TOKEN: "token-fictiv",
      NOTIFY_TELEGRAM_CHAT_ID: "-100123",
      SMTP_HOST: "smtp.exemplu.invalid",
      SMTP_FROM: "FINET <finet@exemplu.invalid>",
    });
    expect(c.notify.telegram?.chatId).toBe("-100123");
    expect(c.notify.smtp?.port).toBe(587);
  });

  it("HEALTH_TOKEN, dacă e setat, are cel puțin 32 de caractere", () => {
    expect(issuesOf({ ...DEV, HEALTH_TOKEN: "x".repeat(31) })).toEqual(["HEALTH_TOKEN"]);
    expect(parseConfig({ ...DEV, HEALTH_TOKEN: "x".repeat(32) }).healthToken).toHaveLength(32);
  });

  it("ignoră variabilele necunoscute din mediu", () => {
    expect(() => parseConfig({ ...DEV, PATH: "/usr/bin", ALTCEVA: "x" })).not.toThrow();
  });
});
