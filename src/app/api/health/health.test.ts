import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  checkDb,
  checkQueue,
  checkStorage,
  closeHealthDb,
  overallStatus,
  runHealthChecks,
} from "@/app/api/health/checks";
import { GET } from "@/app/api/health/route";
import { GET as GET_LIVE } from "@/app/api/health/live/route";
import { resetConfigForTests } from "@/lib/config";
import { LocalStorage, S3Storage, type Storage } from "@/lib/storage";

// Postgres real, doar dacă e configurat (CI / container efemer).
const REAL_DB = process.env.DATABASE_URL;
// Port închis pe loopback: conexiunea e refuzată imediat.
const DEAD_DB = "postgres://finet:parola-fictiva@127.0.0.1:1/finet_test";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "finet-health-"));
});
afterAll(async () => {
  await closeHealthDb();
  await rm(dir, { recursive: true, force: true });
});

const s3 = new S3Storage({
  endpoint: "https://exemplu.invalid",
  region: "r",
  bucket: "b",
  accessKeyId: "id-fictiv",
  secretAccessKey: "secret-fictiv",
});

describe("checkQueue", () => {
  it("fără URL → unknown; bază inaccesibilă → unknown (starea bazei o dă checkDb)", async () => {
    expect(await checkQueue(null)).toBe("unknown");
    expect(await checkQueue(DEAD_DB)).toBe("unknown");
  });

  it.skipIf(!REAL_DB)("bază fără migrația 0006 → unknown, nu down", async () => {
    expect(await checkQueue(REAL_DB!)).toBe("unknown");
  });
});

describe("checkDb", () => {
  it("fără DATABASE_URL → unknown", async () => {
    expect(await checkDb(null)).toBe("unknown");
  });

  it("bază inaccesibilă → down", async () => {
    expect(await checkDb(DEAD_DB)).toBe("down");
  });

  it.skipIf(!REAL_DB)("Postgres real → ok (SELECT 1)", async () => {
    expect(await checkDb(REAL_DB!)).toBe("ok");
    // Clientul e refolosit la al doilea apel.
    expect(await checkDb(REAL_DB!)).toBe("ok");
  });
});

describe("checkStorage", () => {
  it("storage local funcțional → ok, fără fișiere rămase", async () => {
    const storage = new LocalStorage(join(dir, "s"));
    expect(await checkStorage(storage)).toBe("ok");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "s", "health"))).toEqual([]);
  });

  it("driverul S3 neimplementat → unknown (nu down, nu ok)", async () => {
    expect(await checkStorage(s3)).toBe("unknown");
  });

  it("storage care eșuează → down", async () => {
    const broken: Storage = {
      put: async () => {
        throw new Error("EACCES /cale/secreta");
      },
      get: async () => new Uint8Array(),
      delete: async () => {},
      exists: async () => false,
      putStream: async () => "health/x" as never,
      openRead: async () => (async function* () {})(),
    };
    expect(await checkStorage(broken)).toBe("down");
  });

  it("storage care întoarce alt conținut → down", async () => {
    const wrong: Storage = {
      put: async () => "health/x" as never,
      get: async () => new Uint8Array([1, 2, 3]),
      delete: async () => {},
      exists: async () => true,
      putStream: async () => "health/x" as never,
      openRead: async () => (async function* () {})(),
    };
    expect(await checkStorage(wrong)).toBe("down");
  });

  it("lipsa storage-ului → unknown", async () => {
    expect(await checkStorage(null)).toBe("unknown");
  });
});

describe("overallStatus", () => {
  it("down dacă oricare e down; ok doar cu db și storage ok; altfel degraded", () => {
    const base = { queue: "unknown", ai: "unknown" } as const;
    expect(overallStatus({ ...base, db: "ok", storage: "ok" })).toBe("ok");
    expect(overallStatus({ ...base, db: "unknown", storage: "ok" })).toBe("degraded");
    expect(overallStatus({ ...base, db: "ok", storage: "unknown" })).toBe("degraded");
    expect(overallStatus({ ...base, db: "down", storage: "ok" })).toBe("down");
    expect(overallStatus({ db: "ok", storage: "ok", queue: "down", ai: "unknown" })).toBe("down");
    // Faza 5: coada cu semnal vechi degradează starea, fără 503; coada ok rămâne ok.
    expect(overallStatus({ db: "ok", storage: "ok", queue: "degraded", ai: "unknown" })).toBe(
      "degraded",
    );
    expect(overallStatus({ db: "ok", storage: "ok", queue: "ok", ai: "unknown" })).toBe("ok");
  });
});

describe("runHealthChecks", () => {
  it("fără bază: coada și AI-ul sunt unknown", async () => {
    const r = await runHealthChecks({ databaseUrl: null, storage: null, diskDir: null });
    expect(r).toEqual({
      status: "degraded",
      checks: { db: "unknown", storage: "unknown", queue: "unknown", ai: "unknown" },
    });
  });

  it("include procentul de disc liber ca întreg 0–100", async () => {
    const r = await runHealthChecks({
      databaseUrl: null,
      storage: new LocalStorage(join(dir, "d")),
      diskDir: dir,
    });
    expect(Number.isInteger(r.diskFreePercent)).toBe(true);
    expect(r.diskFreePercent).toBeGreaterThanOrEqual(0);
    expect(r.diskFreePercent).toBeLessThanOrEqual(100);
  });
});

describe("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTests();
  });

  function env(vars: Record<string, string>) {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("APP_MODE", "personal");
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.stubEnv("STORAGE_DIR", join(dir, "route"));
    vi.stubEnv("DATABASE_URL", "");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
    resetConfigForTests();
  }

  it("fără bază: 200, degraded, storage ok", async () => {
    env({});
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks).toEqual({ db: "unknown", storage: "ok", queue: "unknown", ai: "unknown" });
  });

  it("bază căzută: 503, down, fără detalii interne în răspuns", async () => {
    env({ DATABASE_URL: DEAD_DB });
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.status).toBe("down");
    expect(body.checks.db).toBe("down");
    expect(Object.keys(body).sort()).toEqual(["checks", "diskFreePercent", "status"]);
    for (const leak of ["127.0.0.1", "parola", "finet_test", dir, "version", "Error", "ECONN"]) {
      expect(text).not.toContain(leak);
    }
  });

  it.skipIf(!REAL_DB)("Postgres real + storage local: 200, ok", async () => {
    env({ DATABASE_URL: REAL_DB! });
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.checks).toEqual({ db: "ok", storage: "ok", queue: "unknown", ai: "unknown" });
  });

  it("configurație invalidă: 503 down, fără mesajul erorii", async () => {
    env({ APP_MODE: "invalid" });
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text).status).toBe("down");
    expect(text).not.toContain("APP_MODE");
  });

  it("driverul S3: storage unknown, nu ok", async () => {
    env({
      STORAGE_DRIVER: "s3",
      STORAGE_S3_ENDPOINT: "https://exemplu.invalid",
      STORAGE_S3_REGION: "r",
      STORAGE_S3_BUCKET: "b",
      STORAGE_S3_ACCESS_KEY_ID: "id-fictiv",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret-fictiv",
    });
    const body = await (await GET()).json();
    expect(body.checks.storage).toBe("unknown");
  });
});

describe("GET /api/health/live", () => {
  it("200 cu `ok` și nimic altceva", async () => {
    const res = GET_LIVE();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});
