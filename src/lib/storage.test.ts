import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotImplementedError } from "@/lib/errors";
import {
  createStorage,
  InvalidStorageKeyError,
  isStorageKey,
  LocalStorage,
  S3Storage,
  StorageError,
  StorageNotFoundError,
  type StorageKey,
} from "@/lib/storage";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let root: string; // director temporar care conține baza și „exteriorul”
let base: string;
let outside: string;
let storage: LocalStorage;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "finet-storage-")));
  base = join(root, "base");
  outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, UUID), "secret-din-afara");
  storage = new LocalStorage(base);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("LocalStorage — operații", () => {
  it("put/get/exists/delete: ciclu complet", async () => {
    const key = await storage.put(bytes("salut"), { prefix: "receipts" });
    expect(isStorageKey(key)).toBe(true);
    expect(key.startsWith("receipts/")).toBe(true);
    expect(await storage.exists(key)).toBe(true);
    expect(new TextDecoder().decode(await storage.get(key))).toBe("salut");
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it("generează chei unice, cu prefixul implicit `files`", async () => {
    const a = await storage.put(bytes("a"));
    const b = await storage.put(bytes("a"));
    expect(a).not.toBe(b);
    expect(a.startsWith("files/")).toBe(true);
  });

  it("nu lasă fișiere temporare după scriere", async () => {
    await storage.put(bytes("x"), { prefix: "t" });
    const names = await readdir(join(base, "t"));
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain(".tmp-");
  });

  it("delete e idempotent; exists pe cheie inexistentă → false", async () => {
    const key = `files/${UUID}` as StorageKey;
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it("conținut binar și gol", async () => {
    const data = new Uint8Array([0, 255, 1, 128]);
    expect(await storage.get(await storage.put(data))).toEqual(data);
    expect(await storage.get(await storage.put(new Uint8Array()))).toEqual(new Uint8Array());
  });

  it("respinge un prefix invalid", async () => {
    for (const prefix of ["..", "../x", "/abs", "A", "a/b", "", "x".repeat(33)]) {
      await expect(storage.put(bytes("x"), { prefix })).rejects.toBeInstanceOf(StorageError);
    }
  });
});

describe("LocalStorage — confinare", () => {
  const badKeys = [
    "../outside/" + UUID,
    "files/../../outside/" + UUID,
    "a/../../b",
    "/etc/passwd",
    join("/", "tmp", UUID),
    "files\\..\\" + UUID,
    `files/${UUID}\0`,
    `files/${UUID}/x`,
    `files/${UUID}.tmp-${UUID}`,
    `files/${UUID.toUpperCase()}`,
    "",
    UUID,
  ];

  for (const key of badKeys) {
    it(`respinge cheia ${JSON.stringify(key)}`, async () => {
      const k = key as StorageKey;
      await expect(storage.get(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    });
  }

  it("refuză un director-prefix care e symlink spre exterior", async () => {
    await storage.put(bytes("init")); // creează baza
    await symlink(outside, join(base, "evil"));
    const key = `evil/${UUID}` as StorageKey;
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageError);
    await expect(storage.exists(key)).rejects.toBeInstanceOf(StorageError);
    await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageError);
    await expect(storage.put(bytes("x"), { prefix: "evil" })).rejects.toBeInstanceOf(StorageError);
    // Fișierul din afară e neatins.
    expect(await readFile(join(outside, UUID), "utf8")).toBe("secret-din-afara");
    expect(await readdir(outside)).toEqual([UUID]);
  });

  it("refuză un fișier care e symlink spre exterior", async () => {
    await mkdir(join(base, "files"), { recursive: true });
    await symlink(join(outside, UUID), join(base, "files", UUID));
    const key = `files/${UUID}` as StorageKey;
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageError);
    await expect(storage.get(key)).rejects.not.toBeInstanceOf(StorageNotFoundError);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageError);
  });

  it("funcționează când directorul de bază e el însuși un symlink (volum montat)", async () => {
    const real = join(root, "real-base");
    await mkdir(real);
    await symlink(real, join(root, "link-base"));
    const s = new LocalStorage(join(root, "link-base"));
    const key = await s.put(bytes("ok"));
    expect(new TextDecoder().decode(await s.get(key))).toBe("ok");
  });

  it("mesajele de eroare nu conțin căi", async () => {
    await mkdir(join(base, "files"), { recursive: true });
    await symlink(join(outside, UUID), join(base, "files", UUID));
    const error = await storage.get(`files/${UUID}` as StorageKey).catch((e: Error) => e);
    expect((error as Error).message).not.toContain(root);
  });
});

describe("S3Storage — schelet", () => {
  it("fiecare operație aruncă NotImplementedError", async () => {
    const s3 = createStorage({
      driver: "s3",
      dir: "/nu-conteaza",
      quotaMb: 1,
      s3: {
        endpoint: "https://exemplu.invalid",
        region: "r",
        bucket: "b",
        accessKeyId: "id-fictiv",
        secretAccessKey: "secret-fictiv",
      },
    });
    expect(s3).toBeInstanceOf(S3Storage);
    const key = `files/${UUID}` as StorageKey;
    await expect(s3.put(bytes("x"))).rejects.toBeInstanceOf(NotImplementedError);
    await expect(s3.get(key)).rejects.toThrow("S3 vine în Faza 6");
    await expect(s3.delete(key)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(s3.exists(key)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("createStorage alege driverul local implicit", () => {
    expect(createStorage({ driver: "local", dir: base, quotaMb: 1, s3: null })).toBeInstanceOf(
      LocalStorage,
    );
  });
});
