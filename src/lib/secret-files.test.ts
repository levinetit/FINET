import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfigError, parseConfig } from "@/lib/config";
import {
  SECRET_FILE_MAX_BYTES,
  SECRET_VARIABLES,
  SECRET_VARIABLES_NOT_YET_VALIDATED,
  readSecretFile,
  resolveSecretFiles,
} from "@/lib/secret-files";
import { parseSecretNames } from "../../scripts/scan-client-secrets.mjs";

// Valori FICTIVE.
const URL_WEB = "postgres://finet_app:parola-fictiva-web@db.exemplu.invalid:6543/postgres";
const URL_WORKER = "postgres://finet_app:parola-fictiva-worker@db.exemplu.invalid:5432/postgres";
const URL_MIGRATOR =
  "postgres://finet_migrator:parola-fictiva-mig@db.exemplu.invalid:5432/postgres";
const TOKEN = "token-fictiv-de-sanatate-0123456789abcdef";
const DEV = { APP_MODE: "personal", NODE_ENV: "development" } as const;

let dir: string;
const file = (name: string, content: string | Buffer): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "finet-secrets-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function issuesOf(
  env: Record<string, string | undefined>,
): { variable: string; problem: string }[] {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return [...(error as ConfigError).issues];
  }
  throw new Error("parseConfig trebuia să arunce");
}

describe("readSecretFile", () => {
  it("citește conținutul și taie un singur sfârșit de linie final", () => {
    expect(readSecretFile(file("a", "valoare"))).toBe("valoare");
    expect(readSecretFile(file("b", "valoare\n"))).toBe("valoare");
    expect(readSecretFile(file("c", "valoare\r\n"))).toBe("valoare");
  });

  it("refuză mai multe linii (inclusiv două newline-uri finale)", () => {
    expect(() => readSecretFile(file("d", "valoare\n\n"))).toThrow("mai multe linii");
    expect(() => readSecretFile(file("e", "a\nb"))).toThrow("mai multe linii");
  });

  it("refuză fișierul lipsă, gol sau doar cu newline", () => {
    expect(() => readSecretFile(join(dir, "nu-exista"))).toThrow("lipsește");
    expect(() => readSecretFile(file("gol", ""))).toThrow("gol");
    expect(() => readSecretFile(file("nl", "\n"))).toThrow("gol");
  });

  it(`acceptă exact ${SECRET_FILE_MAX_BYTES} octeți și refuză mai mult`, () => {
    const max = "x".repeat(SECRET_FILE_MAX_BYTES);
    expect(readSecretFile(file("max", max))).toBe(max);
    expect(() => readSecretFile(file("mare", max + "x"))).toThrow("prea mare");
    // Un newline final peste limită: fișierul tot e prea mare (limita e pe octeții din fișier).
    expect(() => readSecretFile(file("mare-nl", max + "\n"))).toThrow("prea mare");
  });

  it("urmează un symlink spre un fișier; refuză un director și un symlink spre director", () => {
    const target = file("tinta", "din-symlink\n");
    symlinkSync(target, join(dir, "link-fisier"));
    expect(readSecretFile(join(dir, "link-fisier"))).toBe("din-symlink");

    mkdirSync(join(dir, "director"));
    symlinkSync(join(dir, "director"), join(dir, "link-director"));
    expect(() => readSecretFile(join(dir, "director"))).toThrow("nu e un fișier obișnuit");
    expect(() => readSecretFile(join(dir, "link-director"))).toThrow("nu e un fișier obișnuit");
    // Symlink rupt.
    symlinkSync(join(dir, "nu-exista-2"), join(dir, "link-rupt"));
    expect(() => readSecretFile(join(dir, "link-rupt"))).toThrow("lipsește");
  });

  it("un FIFO nu blochează pornirea", () => {
    const fifo = join(dir, "fifo");
    try {
      execFileSync("mkfifo", [fifo]);
    } catch {
      return; // mkfifo indisponibil: verificarea nu se poate face aici
    }
    expect(() => readSecretFile(fifo)).toThrow("nu e un fișier obișnuit");
  });

  it.skipIf(process.getuid?.() === 0)("refuză un fișier necitibil (fără permisiuni)", () => {
    const path = file("fara-drept", "secret-fictiv");
    chmodSync(path, 0o000);
    expect(() => readSecretFile(path)).toThrow("lipsește sau nu poate fi citit");
  });

  it("refuză conținut care nu e UTF-8", () => {
    expect(() => readSecretFile(file("bin", Buffer.from([0xff, 0xfe, 0x00])))).toThrow("UTF-8");
  });

  it("mesajele nu conțin nici conținutul, nici calea", () => {
    const path = file("secret-mare", "PAROLA-FICTIVA-".repeat(400));
    try {
      readSecretFile(path);
      throw new Error("trebuia să arunce");
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).not.toContain("PAROLA-FICTIVA");
      expect(message).not.toContain(dir);
    }
  });
});

describe("resolveSecretFiles", () => {
  it("nu modifică mediul de intrare și nu citește nimic fără `_FILE`", () => {
    const read = vi.fn(() => "x");
    const env = { DATABASE_URL: URL_WEB };
    const out = resolveSecretFiles(env, { read });
    expect(read).not.toHaveBeenCalled();
    expect(out.env).toEqual(env);
    expect(out.issues).toEqual([]);
  });

  it("citește fiecare fișier o singură dată", () => {
    const read = vi.fn(() => TOKEN);
    const env = { HEALTH_TOKEN_FILE: "/run/secrets/finet_health_token" };
    const out = resolveSecretFiles(env, { read });
    expect(read).toHaveBeenCalledTimes(1);
    expect(out.env.HEALTH_TOKEN).toBe(TOKEN);
    expect(env).toEqual({ HEALTH_TOKEN_FILE: "/run/secrets/finet_health_token" });
  });

  it("acoperă toate variabilele marcate `# secret` în .env.example (fără să se desincronizeze)", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "..", ".env.example"), "utf8");
    const marked = parseSecretNames(text).sort();
    const known = [...SECRET_VARIABLES, ...SECRET_VARIABLES_NOT_YET_VALIDATED].sort();
    expect(marked).toEqual(known);
  });
});

describe("parseConfig cu `*_FILE`", () => {
  it("citește DATABASE_URL și HEALTH_TOKEN din fișiere", () => {
    const c = parseConfig({
      ...DEV,
      DATABASE_URL_FILE: file("db", `${URL_WEB}\n`),
      HEALTH_TOKEN_FILE: file("ht", `${TOKEN}\n`),
    });
    expect(c.database.url).toBe(URL_WEB);
    expect(c.healthToken).toBe(TOKEN);
  });

  it("citește secretele notificărilor și S3 din fișiere", () => {
    const c = parseConfig({
      ...DEV,
      NOTIFY_TELEGRAM_BOT_TOKEN_FILE: file("tg", "123456789:token-fictiv\n"),
      NOTIFY_TELEGRAM_CHAT_ID: "-1001",
      SMTP_HOST: "smtp.exemplu.invalid",
      SMTP_FROM: "finet@exemplu.invalid",
      SMTP_PASSWORD_FILE: file("smtp", "parola-smtp-fictiva"),
      STORAGE_DRIVER: "s3",
      STORAGE_S3_ENDPOINT: "https://exemplu.invalid",
      STORAGE_S3_REGION: "r",
      STORAGE_S3_BUCKET: "b",
      STORAGE_S3_ACCESS_KEY_ID_FILE: file("s3id", "id-fictiv"),
      STORAGE_S3_SECRET_ACCESS_KEY_FILE: file("s3key", "cheie-fictiva"),
    });
    expect(c.notify.telegram?.botToken).toBe("123456789:token-fictiv");
    expect(c.notify.smtp?.password).toBe("parola-smtp-fictiva");
    expect(c.storage.s3).toMatchObject({
      accessKeyId: "id-fictiv",
      secretAccessKey: "cheie-fictiva",
    });
  });

  it("refuză `X` și `X_FILE` setate împreună, numind ambele variabile", () => {
    const issues = issuesOf({
      ...DEV,
      DATABASE_URL: URL_WEB,
      DATABASE_URL_FILE: file("db2", URL_WEB),
    });
    expect(issues).toEqual([
      { variable: "DATABASE_URL/DATABASE_URL_FILE", problem: "se setează doar una dintre ele" },
    ]);
  });

  it("`X_FILE=` gol e tratat ca nesetat", () => {
    expect(parseConfig({ ...DEV, DATABASE_URL: URL_WEB, DATABASE_URL_FILE: "" }).database.url).toBe(
      URL_WEB,
    );
  });

  it("fișier lipsă / gol / prea mare → problema e raportată pe `X_FILE`", () => {
    expect(issuesOf({ ...DEV, HEALTH_TOKEN_FILE: join(dir, "absent") })).toEqual([
      { variable: "HEALTH_TOKEN_FILE", problem: "fișierul lipsește sau nu poate fi citit" },
    ]);
    expect(issuesOf({ ...DEV, HEALTH_TOKEN_FILE: file("ht-gol", "") })).toEqual([
      { variable: "HEALTH_TOKEN_FILE", problem: "fișierul e gol" },
    ]);
    expect(issuesOf({ ...DEV, HEALTH_TOKEN_FILE: file("ht-mare", "t".repeat(5000)) })).toEqual([
      {
        variable: "HEALTH_TOKEN_FILE",
        problem: `fișier prea mare (max. ${SECRET_FILE_MAX_BYTES} octeți)`,
      },
    ]);
  });

  it("valoarea din fișier trece prin aceeași validare; eroarea numește `X_FILE`", () => {
    expect(issuesOf({ ...DEV, HEALTH_TOKEN_FILE: file("ht-scurt", "scurt") })).toEqual([
      { variable: "HEALTH_TOKEN_FILE", problem: "prea scurtă" },
    ]);
    expect(issuesOf({ ...DEV, DATABASE_URL_FILE: file("db-rau", "mysql://x") })).toEqual([
      { variable: "DATABASE_URL_FILE", problem: "format invalid" },
    ]);
  });

  it("mesajul de eroare nu conține conținutul fișierului", () => {
    try {
      parseConfig({ ...DEV, DATABASE_URL: URL_WEB, DATABASE_URL_FILE: file("db3", URL_WEB) });
      throw new Error("trebuia să arunce");
    } catch (error) {
      expect((error as Error).message).not.toContain("parola-fictiva");
    }
  });

  describe("regula pe rol (FINET_ROLE)", () => {
    it("web respinge WORKER_DATABASE_URL_FILE și MIGRATOR_DATABASE_URL_FILE fără să le deschidă", () => {
      const readSecret = vi.fn(() => URL_MIGRATOR);
      try {
        parseConfig(
          {
            ...DEV,
            WORKER_DATABASE_URL_FILE: "/run/secrets/finet_worker_database_url",
            MIGRATOR_DATABASE_URL_FILE: "/run/secrets/finet_migrate_database_url",
          },
          { readSecret },
        );
        throw new Error("trebuia să arunce");
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).issues).toEqual([
          { variable: "WORKER_DATABASE_URL_FILE", problem: "nu e permisă când FINET_ROLE=web" },
          { variable: "MIGRATOR_DATABASE_URL_FILE", problem: "nu e permisă când FINET_ROLE=web" },
        ]);
      }
      expect(readSecret).not.toHaveBeenCalled();
    });

    it("worker citește doar WORKER_DATABASE_URL_FILE; respinge DATABASE_URL_FILE", () => {
      const c = parseConfig({
        ...DEV,
        FINET_ROLE: "worker",
        WORKER_DATABASE_URL_FILE: file("w", URL_WORKER),
      });
      expect(c.database.url).toBe(URL_WORKER);
      expect(
        issuesOf({
          ...DEV,
          FINET_ROLE: "worker",
          WORKER_DATABASE_URL_FILE: file("w2", URL_WORKER),
          DATABASE_URL_FILE: file("d2", URL_WEB),
        }).map((i) => i.variable),
      ).toEqual(["DATABASE_URL_FILE"]);
    });

    it("migrate citește doar MIGRATOR_DATABASE_URL_FILE; worker fără URL → obligatoriu", () => {
      const c = parseConfig({
        ...DEV,
        FINET_ROLE: "migrate",
        MIGRATOR_DATABASE_URL_FILE: file("m", `${URL_MIGRATOR}\n`),
      });
      expect(c.database.url).toBe(URL_MIGRATOR);
      expect(
        issuesOf({
          ...DEV,
          FINET_ROLE: "migrate",
          MIGRATOR_DATABASE_URL_FILE: file("m2", URL_MIGRATOR),
          WORKER_DATABASE_URL_FILE: file("w3", URL_WORKER),
        }).map((i) => i.variable),
      ).toEqual(["WORKER_DATABASE_URL_FILE"]);
      expect(issuesOf({ ...DEV, FINET_ROLE: "worker" }).map((i) => i.variable)).toEqual([
        "WORKER_DATABASE_URL",
      ]);
    });

    it("cu un FINET_ROLE invalid nu se deschide niciun fișier", () => {
      const readSecret = vi.fn(() => URL_WEB);
      expect(() =>
        parseConfig({ ...DEV, FINET_ROLE: "root", DATABASE_URL_FILE: "/x" }, { readSecret }),
      ).toThrow(ConfigError);
      expect(readSecret).not.toHaveBeenCalled();
    });
  });
});
