import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError, parseConfig, resetConfigForTests } from "@/lib/config";
import { validateConfigOrExit } from "@/lib/config-startup";

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
    expect(c.role).toBe("web");
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

describe("parseConfig pe rol (FINET_ROLE)", () => {
  const URL_WEB = "postgres://finet_app.ref:p-web@pooler.exemplu.invalid:6543/postgres";
  const URL_WORKER = "postgres://finet_app.ref:p-worker@pooler.exemplu.invalid:5432/postgres";
  const URL_MIGRATOR = "postgres://finet_migrator.ref:p-mig@pooler.exemplu.invalid:5432/postgres";

  it("implicit e `web`; șirul gol înseamnă tot `web`", () => {
    expect(parseConfig(DEV).role).toBe("web");
    expect(parseConfig({ ...DEV, FINET_ROLE: "" }).role).toBe("web");
    expect(parseConfig({ ...DEV, FINET_ROLE: "web", DATABASE_URL: URL_WEB }).database.url).toBe(
      URL_WEB,
    );
  });

  it("refuză un rol necunoscut", () => {
    expect(issuesOf({ ...DEV, FINET_ROLE: "admin" })).toEqual(["FINET_ROLE"]);
    expect(issuesOf({ ...DEV, FINET_ROLE: "WEB" })).toEqual(["FINET_ROLE"]);
  });

  it("web respinge WORKER_DATABASE_URL și MIGRATOR_DATABASE_URL (în dezvoltare și în producție)", () => {
    for (const base of [DEV, PROD]) {
      expect(issuesOf({ ...base, WORKER_DATABASE_URL: URL_WORKER })).toEqual([
        "WORKER_DATABASE_URL",
      ]);
      expect(issuesOf({ ...base, MIGRATOR_DATABASE_URL: URL_MIGRATOR })).toEqual([
        "MIGRATOR_DATABASE_URL",
      ]);
      expect(
        issuesOf({
          ...base,
          DATABASE_URL: URL_WEB,
          WORKER_DATABASE_URL: URL_WORKER,
          MIGRATOR_DATABASE_URL: URL_MIGRATOR,
        }),
      ).toEqual(["WORKER_DATABASE_URL", "MIGRATOR_DATABASE_URL"]);
    }
  });

  it("web: mesajul numește variabila interzisă, nu valoarea", () => {
    let message = "";
    try {
      parseConfig({ ...PROD, MIGRATOR_DATABASE_URL: URL_MIGRATOR });
    } catch (error) {
      message = (error as Error).message + JSON.stringify((error as ConfigError).issues);
    }
    expect(message).toContain("MIGRATOR_DATABASE_URL");
    expect(message).toContain("FINET_ROLE=web");
    expect(message).not.toContain("p-mig");
    expect(message).not.toContain("pooler.exemplu.invalid");
  });

  it("worker cere WORKER_DATABASE_URL și respinge celelalte URL-uri", () => {
    const worker = { ...PROD, FINET_ROLE: "worker" };
    expect(issuesOf(worker)).toEqual(["WORKER_DATABASE_URL"]);
    const c = parseConfig({ ...worker, WORKER_DATABASE_URL: URL_WORKER });
    expect(c.role).toBe("worker");
    expect(c.database).toEqual({ url: URL_WORKER, ca: null });
    expect(issuesOf({ ...worker, WORKER_DATABASE_URL: URL_WORKER, DATABASE_URL: URL_WEB })).toEqual(
      ["DATABASE_URL"],
    );
    expect(
      issuesOf({ ...worker, WORKER_DATABASE_URL: URL_WORKER, MIGRATOR_DATABASE_URL: URL_MIGRATOR }),
    ).toEqual(["MIGRATOR_DATABASE_URL"]);
  });

  it("migrate cere MIGRATOR_DATABASE_URL și respinge celelalte URL-uri", () => {
    const migrate = { ...DEV, FINET_ROLE: "migrate" };
    expect(issuesOf(migrate)).toEqual(["MIGRATOR_DATABASE_URL"]);
    const c = parseConfig({ ...migrate, MIGRATOR_DATABASE_URL: URL_MIGRATOR });
    expect(c.role).toBe("migrate");
    expect(c.database).toEqual({ url: URL_MIGRATOR, ca: null });
    expect(
      issuesOf({ ...migrate, MIGRATOR_DATABASE_URL: URL_MIGRATOR, DATABASE_URL: URL_WEB }),
    ).toEqual(["DATABASE_URL"]);
    expect(
      issuesOf({
        ...migrate,
        MIGRATOR_DATABASE_URL: URL_MIGRATOR,
        WORKER_DATABASE_URL: URL_WORKER,
      }),
    ).toEqual(["WORKER_DATABASE_URL"]);
  });

  it("în producție, doar web cere CF_ACCESS_*; migrate nu cere nici STORAGE_DIR", () => {
    const bare = { APP_MODE: "personal", NODE_ENV: "production" };
    expect(issuesOf(bare)).toEqual(["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "STORAGE_DIR"]);
    expect(issuesOf({ ...bare, FINET_ROLE: "worker", WORKER_DATABASE_URL: URL_WORKER })).toEqual([
      "STORAGE_DIR",
    ]);
    const w = parseConfig({
      ...bare,
      FINET_ROLE: "worker",
      WORKER_DATABASE_URL: URL_WORKER,
      STORAGE_DIR: "/data/storage",
    });
    expect(w.storage.dir).toBe("/data/storage");
    const m = parseConfig({ ...bare, FINET_ROLE: "migrate", MIGRATOR_DATABASE_URL: URL_MIGRATOR });
    expect(m.database.url).toBe(URL_MIGRATOR);
    // CF_ACCESS_REQUIRED=false rămâne refuzat în producție pentru orice rol.
    expect(
      issuesOf({
        ...bare,
        FINET_ROLE: "migrate",
        MIGRATOR_DATABASE_URL: URL_MIGRATOR,
        CF_ACCESS_REQUIRED: "false",
      }),
    ).toEqual(["CF_ACCESS_REQUIRED"]);
  });

  it("URL-ul interzis gol (`VAR=`) e tratat ca nesetat, deci nu blochează pornirea", () => {
    expect(() =>
      parseConfig({ ...DEV, WORKER_DATABASE_URL: "", MIGRATOR_DATABASE_URL: "" }),
    ).not.toThrow();
  });

  it("Config nu mai expune URL-urile altor roluri", () => {
    const c = parseConfig({ ...DEV, DATABASE_URL: URL_WEB });
    expect(Object.keys(c.database)).toEqual(["url", "ca"]);
  });
});

describe("validateConfigOrExit (pornirea serverului web)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetConfigForTests();
  });

  function start(env: Record<string, string>): { exited: number | null; log: string } {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_MODE", "personal");
    vi.stubEnv("CF_ACCESS_REQUIRED", "false");
    vi.stubEnv("FINET_ROLE", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("WORKER_DATABASE_URL", "");
    vi.stubEnv("MIGRATOR_DATABASE_URL", "");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    resetConfigForTests();
    let exited: number | null = null;
    const log: string[] = [];
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exited = code ?? 0;
      return undefined as never;
    }) as typeof process.exit);
    vi.spyOn(console, "error").mockImplementation((m: unknown) => void log.push(String(m)));
    validateConfigOrExit();
    return { exited, log: log.join("\n") };
  }

  it("pornește cu rolul web implicit", () => {
    expect(start({}).exited).toBeNull();
  });

  it("se oprește dacă mediul web conține URL-ul migratorului (fără să-l afișeze)", () => {
    const r = start({ MIGRATOR_DATABASE_URL: "postgres://m:parola-mig@h.exemplu.invalid/db" });
    expect(r.exited).toBe(1);
    expect(r.log).toContain("MIGRATOR_DATABASE_URL");
    expect(r.log).not.toContain("parola-mig");
  });

  it("se oprește cu FINET_ROLE=worker sau migrate, chiar dacă mediul e valid pentru acel rol", () => {
    const w = start({ FINET_ROLE: "worker", WORKER_DATABASE_URL: "postgres://w:p@h/db" });
    expect(w.exited).toBe(1);
    expect(w.log).toContain("FINET_ROLE");
    resetConfigForTests();
    vi.restoreAllMocks();
    const m = start({ FINET_ROLE: "migrate", MIGRATOR_DATABASE_URL: "postgres://m:p@h/db" });
    expect(m.exited).toBe(1);
  });
});

describe("DATABASE_CA_FILE", () => {
  // CA FICTIV (doar formă PEM).
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIfictiv\n-----END CERTIFICATE-----\n";
  const VERIFY = "postgres://finet_app:parola-fictiva@db.exemplu.invalid:6543/postgres";
  let caDir: string;
  beforeAll(() => {
    caDir = mkdtempSync(join(tmpdir(), "finet-ca-"));
  });
  afterAll(() => {
    rmSync(caDir, { recursive: true, force: true });
  });
  const caFile = (name: string, content: string): string => {
    const path = join(caDir, name);
    writeFileSync(path, content);
    return path;
  };

  it("fără DATABASE_CA_FILE, `database.ca` e null", () => {
    expect(
      parseConfig({ ...DEV, DATABASE_URL: `${VERIFY}?sslmode=verify-full` }).database.ca,
    ).toBeNull();
  });

  it("citește CA-ul o dată, cu sslmode=verify-full sau verify-ca", () => {
    const path = caFile("ca.crt", PEM);
    for (const mode of ["verify-full", "verify-ca"]) {
      const c = parseConfig({
        ...DEV,
        DATABASE_URL: `${VERIFY}?sslmode=${mode}`,
        DATABASE_CA_FILE: path,
      });
      expect(c.database.ca).toBe(PEM);
    }
    // Web fără bază configurată: CA-ul e citit, dar nefolosit.
    expect(parseConfig({ ...DEV, DATABASE_CA_FILE: path }).database.ca).toBe(PEM);
  });

  it("refuză CA-ul cu sslmode care nu verifică certificatul (încredere falsă)", () => {
    const path = caFile("ca2.crt", PEM);
    for (const suffix of ["?sslmode=require", "?sslmode=disable", ""]) {
      expect(
        issuesOf({ ...DEV, DATABASE_URL: `${VERIFY}${suffix}`, DATABASE_CA_FILE: path }),
      ).toEqual(["DATABASE_CA_FILE"]);
    }
  });

  it("refuză un fișier lipsă, gol sau care nu e PEM", () => {
    const env = { ...DEV, DATABASE_URL: `${VERIFY}?sslmode=verify-full` };
    expect(issuesOf({ ...env, DATABASE_CA_FILE: join(caDir, "absent") })).toEqual([
      "DATABASE_CA_FILE",
    ]);
    expect(issuesOf({ ...env, DATABASE_CA_FILE: caFile("gol.crt", "") })).toEqual([
      "DATABASE_CA_FILE",
    ]);
    expect(issuesOf({ ...env, DATABASE_CA_FILE: caFile("text.crt", "nu e certificat") })).toEqual([
      "DATABASE_CA_FILE",
    ]);
    expect(issuesOf({ ...env, DATABASE_CA_FILE: caDir })).toEqual(["DATABASE_CA_FILE"]);
  });

  it("refuză `sslrootcert` în URL (postgres.js nu-l citește; serverul ar refuza conexiunea)", () => {
    expect(
      issuesOf({ ...DEV, DATABASE_URL: `${VERIFY}?sslmode=verify-full&sslrootcert=/ca.crt` }),
    ).toEqual(["DATABASE_URL"]);
    expect(issuesOf({ ...DEV, DATABASE_URL: `${VERIFY}?sslrootcert=system` })).toEqual([
      "DATABASE_URL",
    ]);
    // Pentru un URL citit din fișier, problema e raportată pe `_FILE`.
    const urlFile = caFile("url", `${VERIFY}?sslmode=verify-full&sslrootcert=/x\n`);
    expect(issuesOf({ ...DEV, DATABASE_URL_FILE: urlFile })).toEqual(["DATABASE_URL_FILE"]);
  });

  it("se aplică URL-ului rolului curent (worker)", () => {
    const path = caFile("ca3.crt", PEM);
    const c = parseConfig({
      ...DEV,
      FINET_ROLE: "worker",
      WORKER_DATABASE_URL: `${VERIFY}?sslmode=verify-full`,
      DATABASE_CA_FILE: path,
    });
    expect(c.database.ca).toBe(PEM);
  });
});
