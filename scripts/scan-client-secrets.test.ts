import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseSecretNames, scanDirectory } from "./scan-client-secrets.mjs";

const SCRIPT = join(import.meta.dirname, "scan-client-secrets.mjs");

// Secretele plantate se compun la rulare, ca niciun șir care arată a cheie reală să nu fie
// în repository (altfel scanerele GitHub ar bloca push-ul).
const fakeStripeKey = ["sk", "live", "0123456789abcdefXYZ"].join("_");
const fakeWebhookSecret = ["whsec", "0123456789abcdef"].join("_");
const fakePem = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");

const ENV_EXAMPLE = [
  "# Modul",
  "APP_MODE=personal",
  "# secret",
  "DATABASE_URL=postgres://u:p@localhost/db",
  "# secret",
  "BETTER_AUTH_SECRET=x",
  "# secret",
  "NEXT_PUBLIC_APP_NAME=FINET",
  "SMTP_HOST=localhost",
].join("\n");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "finet-scan-"));
  mkdirSync(join(dir, "chunks"), { recursive: true });
  writeFileSync(join(dir, "chunks", "app.js"), 'console.log("FINET", process.env.APP_MODE);');
  writeFileSync(join(dir, "style.css"), "body{color:#14201c}");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseSecretNames", () => {
  it("ia doar variabilele marcate `# secret` și ignoră NEXT_PUBLIC_*", () => {
    expect(parseSecretNames(ENV_EXAMPLE)).toEqual(["DATABASE_URL", "BETTER_AUTH_SECRET"]);
  });

  it("marcajul se aplică doar variabilei imediat următoare", () => {
    expect(parseSecretNames("# secret\nA_KEY=1\nB_KEY=2")).toEqual(["A_KEY"]);
  });

  it("ia și variabila marcată, dar comentată, fără să mute marcajul pe următoarea", () => {
    expect(
      parseSecretNames("# secret\n# WORKER_URL=postgres://x\nSMTP_HOST=localhost\n# secret\nB=1"),
    ).toEqual(["WORKER_URL", "B"]);
    // Un comentariu obișnuit (fără `NUME=`) sau o variabilă comentată nemarcată nu contează.
    expect(parseSecretNames("# OPTIONAL_X=1\n# secret\n# o notă\nA_KEY=1")).toEqual(["A_KEY"]);
  });

  it("păstrează în listă toate URL-urile bazei de date din .env.example al repo-ului", () => {
    const text = readFileSync(join(import.meta.dirname, "..", ".env.example"), "utf8");
    const names = parseSecretNames(text);
    for (const n of ["DATABASE_URL", "WORKER_DATABASE_URL", "MIGRATOR_DATABASE_URL"]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("SMTP_HOST");
  });
});

describe("scanDirectory", () => {
  const secretNames = parseSecretNames(ENV_EXAMPLE);

  it("trece pe un director curat", () => {
    expect(scanDirectory(dir, { secretNames })).toEqual([]);
  });

  it("găsește o cheie Stripe plantată", () => {
    writeFileSync(join(dir, "chunks", "leak.js"), `const k="${fakeStripeKey}";`);
    expect(scanDirectory(dir, { secretNames })).toEqual([
      { file: join("chunks", "leak.js"), kind: "Stripe live secret key" },
    ]);
  });

  it("găsește un secret de webhook și o cheie privată", () => {
    writeFileSync(join(dir, "a.js"), fakeWebhookSecret);
    writeFileSync(join(dir, "b.txt"), `${fakePem}\nAAAA`);
    const kinds = scanDirectory(dir, { secretNames }).map((f) => f.kind);
    expect(kinds).toContain("Stripe webhook secret");
    expect(kinds).toContain("cheie privată PEM");
  });

  it("găsește numele unei variabile secrete, dar nu și al uneia publice", () => {
    writeFileSync(join(dir, "c.js"), "x=process.env.BETTER_AUTH_SECRET;y=NEXT_PUBLIC_APP_NAME");
    expect(scanDirectory(dir, { secretNames })).toEqual([
      { file: "c.js", kind: "numele variabilei secrete BETTER_AUTH_SECRET" },
    ]);
  });

  it("nu confundă un nume care doar conține numele secret", () => {
    writeFileSync(join(dir, "d.js"), "MY_DATABASE_URL_HINT=1");
    expect(scanDirectory(dir, { secretNames })).toEqual([]);
  });
});

describe("CLI", () => {
  function run(target: string) {
    // `.env.example` de test stă în afara directorului scanat.
    const envDir = mkdtempSync(join(tmpdir(), "finet-env-"));
    const envFile = join(envDir, ".env.example");
    writeFileSync(envFile, ENV_EXAMPLE);
    try {
      return spawnSync(process.execPath, [SCRIPT, target, "--env-example", envFile], {
        encoding: "utf8",
      });
    } finally {
      rmSync(envDir, { recursive: true, force: true });
    }
  }

  it("iese cu 0 pe un director curat", () => {
    expect(run(dir).status).toBe(0);
  });

  it("iese cu 1 și nu afișează valoarea secretului", () => {
    writeFileSync(join(dir, "leak.js"), fakeStripeKey);
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("leak.js");
    expect(result.stderr).not.toContain(fakeStripeKey);
  });

  it("iese cu 2 dacă directorul lipsește", () => {
    expect(run(join(dir, "nu-exista")).status).toBe(2);
  });
});
