import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TEST_ADMIN_URL } from "@/db/testing";
import { parseAndroidRelease, readAndroidRelease } from "@/modules/app-release/android";
import { type AuthEnv, type AuthFixture, authEnv, createAuthFixture } from "@/modules/auth/testing";
import { createUserWithHousehold } from "@/modules/auth/users.service";

import * as A from "./_lib/app-handlers";
import type { ApiDeps } from "./_lib/http";
import { type Sessions, apiRequest, assertContract, readJson, sessionsFor } from "./_lib/testing";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

/** Exemplu FICTIV (sumă și link inventate). */
const VALID = {
  versionName: "1.2.3",
  versionCode: 10203,
  minSupportedVersionCode: 10000,
  url: "https://github.com/exemplu/finet/releases/download/FINET-v1.2.3/finet-1.2.3.apk",
  sha256: "a".repeat(64),
  sizeBytes: 23_456_789,
  notes: "Scanare offline; corecturi.",
  publishedAt: "2026-10-29T08:00:00Z",
};

describe("metadatele versiunii Android (fișierul operatorului)", () => {
  it("o versiune validă e acceptată (publishedAt opțional)", () => {
    expect(parseAndroidRelease(JSON.stringify(VALID))).toEqual(VALID);
    const rest: Partial<typeof VALID> = { ...VALID };
    delete rest.publishedAt;
    expect(parseAndroidRelease(JSON.stringify(rest))).toEqual(rest);
  });

  it("orice abatere → indisponibil (null), fără excepții", () => {
    const bad: unknown[] = [
      "nu e json",
      null,
      [],
      { ...VALID, url: "http://github.com/x.apk" },
      { ...VALID, url: "javascript:alert(1)" },
      { ...VALID, sha256: "A".repeat(64) },
      { ...VALID, sha256: "a".repeat(63) },
      { ...VALID, versionName: "1.2" },
      { ...VALID, versionName: "v1.2.3" },
      { ...VALID, versionCode: 0 },
      { ...VALID, versionCode: 1.5 },
      { ...VALID, minSupportedVersionCode: VALID.versionCode + 1 },
      { ...VALID, sizeBytes: 0 },
      { ...VALID, notes: "x".repeat(2001) },
      { ...VALID, publishedAt: "ieri" },
      { ...VALID, extra: true },
    ];
    for (const value of bad) {
      const raw = typeof value === "string" ? value : JSON.stringify(value);
      expect(parseAndroidRelease(raw), raw.slice(0, 80)).toBeNull();
    }
  });

  it("citirea din <STORAGE_DIR>/app/android-latest.json: lipsă, validă, prea mare, director", async () => {
    const dir = await mkdtemp(join(tmpdir(), "finet-android-"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await readAndroidRelease(dir)).toBeNull();
      expect(errors).not.toHaveBeenCalled(); // lipsa fișierului e normală
      await mkdir(join(dir, "app"));
      await writeFile(join(dir, "app", "android-latest.json"), JSON.stringify(VALID));
      expect(await readAndroidRelease(dir)).toEqual(VALID);
      await writeFile(join(dir, "app", "android-latest.json"), " ".repeat(17 * 1024));
      expect(await readAndroidRelease(dir)).toBeNull();
      await writeFile(join(dir, "app", "android-latest.json"), '{"secret":"nu-apare-in-log"}');
      expect(await readAndroidRelease(dir)).toBeNull();
      for (const call of errors.mock.calls) expect(String(call)).not.toContain("nu-apare");
    } finally {
      errors.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!TEST_ADMIN_URL)("GET /api/v1/app/android/latest (PostgreSQL real)", () => {
  let fx: AuthFixture;
  let env: AuthEnv & ApiDeps;
  let S: Sessions;
  let storageDir: string;
  const PASS = "parola-android-12345";

  beforeAll(async () => {
    fx = await createAuthFixture("finet_it_app_android");
    storageDir = await mkdtemp(join(tmpdir(), "finet-android-api-"));
    const base = authEnv(fx.db);
    const config = { ...base.config, storage: { ...base.config.storage, dir: storageDir } };
    env = { ...authEnv(fx.db, { config }) };
    await createUserWithHousehold(fx.db, {
      email: "ana@exemplu.ro",
      name: "Ana",
      password: PASS,
      firstUserBecomesAdmin: true,
      emailVerified: true,
    });
    S = await sessionsFor(env, "ana@exemplu.ro", PASS);
  });

  afterAll(async () => {
    await fx?.close();
    if (storageDir) await rm(storageDir, { recursive: true, force: true });
  });

  const get = async (
    init: Parameters<typeof apiRequest>[1] = {},
    path = "/api/v1/app/android/latest",
  ) => {
    const r = await A.androidLatestHandler(apiRequest(path, init), env);
    await assertContract(A.androidLatestHandler, r);
    return r;
  };

  it("fără sesiune → 401; parametri nepermiși → 400", async () => {
    expect((await get()).status).toBe(401);
    expect((await get({ bearer: S.bearer }, "/api/v1/app/android/latest?x=1")).status).toBe(400);
  });

  it("fără versiune publicată → 404 cu cod fix, cookie sau bearer", async () => {
    for (const init of [{ cookie: S.cookie }, { bearer: S.bearer }]) {
      const r = await get(init);
      expect(r.status).toBe(404);
      expect((await readJson(r)).error?.code).toBe("android_release_unavailable");
    }
  });

  it("cu fișierul operatorului → 200 cu metadatele, no-store; fișier invalid → 404", async () => {
    await mkdir(join(storageDir, "app"), { recursive: true });
    const file = join(storageDir, "app", "android-latest.json");
    await writeFile(file, JSON.stringify(VALID));
    const r = await get({ bearer: S.bearer });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect((await readJson(r)).data).toEqual(VALID);
    await writeFile(file, JSON.stringify({ ...VALID, url: "http://nesigur.invalid/a.apk" }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await get({ cookie: S.cookie })).status).toBe(404);
    errors.mockRestore();
  });
});
