import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotImplementedError } from "@/lib/errors";
import {
  assertKeyOfHousehold,
  createStorage,
  InvalidStorageKeyError,
  isKeyOfHousehold,
  isStorageKey,
  LocalStorage,
  S3Storage,
  StorageError,
  StorageLimitError,
  StorageNotFoundError,
  StorageReadOnlyError,
  storageKeyName,
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
    // Forma cheilor de documente (Faza 6): orice abatere e refuzată.
    `households/${UUID}/documents/../../files/${UUID}`,
    `households/../documents/${UUID}`,
    `households/${UUID}/documents/${UUID}/x`,
    `households/${UUID}/other/${UUID}`,
    `households/${UUID.toUpperCase()}/documents/${UUID}`,
    `households/${UUID}/documents/${UUID}.tmp-${UUID}`,
    `households//documents/${UUID}`,
    `x/households/${UUID}/documents/${UUID}`,
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
    await expect(s3.putStream([bytes("x")])).rejects.toBeInstanceOf(NotImplementedError);
    await expect(s3.openRead(key)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("createStorage alege driverul local implicit", () => {
    expect(createStorage({ driver: "local", dir: base, quotaMb: 1, s3: null })).toBeInstanceOf(
      LocalStorage,
    );
  });
});

const HH = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield bytes(p);
}

describe("LocalStorage — documentele gospodăriilor (Faza 6)", () => {
  it("cheia `households/<id>/documents/<uuid>`, cu id-ul gospodăriei în litere mici", async () => {
    const key = await storage.put(bytes("bon"), { householdId: HH.toUpperCase() });
    expect(key).toMatch(new RegExp(`^households/${HH}/documents/[0-9a-f-]{36}$`));
    expect(isStorageKey(key)).toBe(true);
    expect(storageKeyName(key)).toBe(key.split("/")[3]);
    expect(new TextDecoder().decode(await storage.get(key))).toBe("bon");
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
  });

  it("respinge un id de gospodărie care nu e uuid", async () => {
    for (const householdId of ["..", "../x", "", "abc", `${HH}/x`]) {
      await expect(storage.put(bytes("x"), { householdId })).rejects.toBeInstanceOf(StorageError);
    }
  });

  it("refuză un director intermediar care e symlink spre exterior", async () => {
    await mkdir(join(base, "households"), { recursive: true });
    await symlink(outside, join(base, "households", HH));
    await expect(storage.put(bytes("x"), { householdId: HH })).rejects.toBeInstanceOf(StorageError);
    const key = `households/${HH}/documents/${UUID}` as StorageKey;
    await expect(storage.get(key)).rejects.toBeInstanceOf(StorageError);
    expect(await readdir(outside)).toEqual([UUID]);
  });
});

describe("LocalStorage — putStream, plafon, citire ca flux", () => {
  it("putStream scrie bucățile în ordine; openRead le citește înapoi", async () => {
    const key = await storage.putStream(chunks("ab", "cd", "ef"), { householdId: HH });
    const parts: Uint8Array[] = [];
    for await (const c of await storage.openRead(key)) parts.push(c);
    expect(new TextDecoder().decode(Buffer.concat(parts))).toBe("abcdef");
  });

  it("peste maxBytes: StorageLimitError și niciun fișier (nici temporar) rămas", async () => {
    await expect(
      storage.putStream(chunks("1234", "5678"), { householdId: HH, maxBytes: 6 }),
    ).rejects.toBeInstanceOf(StorageLimitError);
    await expect(storage.put(bytes("1234567"), { maxBytes: 6 })).rejects.toBeInstanceOf(
      StorageLimitError,
    );
    expect(await readdir(join(base, "households", HH, "documents"))).toEqual([]);
    // Exact la plafon: merge.
    const key = await storage.put(bytes("123456"), { maxBytes: 6 });
    expect((await storage.get(key)).byteLength).toBe(6);
  });

  it("o eroare a sursei la mijloc nu lasă fișiere (scriere atomică)", async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield bytes("început");
      throw new Error("conexiune întreruptă");
    }
    await expect(storage.putStream(broken(), { householdId: HH })).rejects.toThrow(
      "conexiune întreruptă",
    );
    expect(await readdir(join(base, "households", HH, "documents"))).toEqual([]);
  });

  it("plafon invalid → StorageError", async () => {
    await expect(storage.put(bytes("x"), { maxBytes: -1 })).rejects.toBeInstanceOf(StorageError);
  });

  it("openRead pe cheie inexistentă → StorageNotFoundError", async () => {
    await expect(
      storage.openRead(`households/${HH}/documents/${UUID}` as StorageKey),
    ).rejects.toBeInstanceOf(StorageNotFoundError);
  });
});

describe("LocalStorage — doar citire (worker)", () => {
  it("citește, dar nu scrie, nu șterge și nu creează directorul de bază", async () => {
    const key = await storage.put(bytes("original"), { householdId: HH });
    const ro = new LocalStorage(base, { readOnly: true });
    expect(new TextDecoder().decode(await ro.get(key))).toBe("original");
    expect(await ro.exists(key)).toBe(true);
    await expect(ro.put(bytes("x"))).rejects.toBeInstanceOf(StorageReadOnlyError);
    await expect(ro.putStream(chunks("x"))).rejects.toBeInstanceOf(StorageReadOnlyError);
    await expect(ro.delete(key)).rejects.toBeInstanceOf(StorageReadOnlyError);
    await expect(ro.cleanupTemp(0)).rejects.toBeInstanceOf(StorageReadOnlyError);
    expect(await storage.exists(key)).toBe(true);

    const missing = new LocalStorage(join(root, "nu-exista"), { readOnly: true });
    await expect(missing.exists(key)).rejects.toBeInstanceOf(StorageError);
    await expect(stat(join(root, "nu-exista"))).rejects.toThrow();
  });

  it("funcționează pe un director fără drept de scriere (volum montat read-only)", async () => {
    const key = await storage.put(bytes("ro"), { householdId: HH });
    await chmod(base, 0o500);
    try {
      const ro = new LocalStorage(base, { readOnly: true });
      expect(new TextDecoder().decode(await ro.get(key))).toBe("ro");
    } finally {
      await chmod(base, 0o700);
    }
  });
});

describe("LocalStorage — curățarea fișierelor temporare orfane (F9)", () => {
  it("șterge doar `*.tmp-<uuid>` mai vechi decât pragul; fișierele reale rămân", async () => {
    const key = await storage.put(bytes("real"), { householdId: HH });
    const dir = join(base, "households", HH, "documents");
    const oldTmp = join(dir, `${UUID}.tmp-${UUID}`);
    const newTmp = join(dir, `${UUID}.tmp-0f8fad5b-d9cb-469f-a165-70867728950f`);
    await writeFile(oldTmp, "rest");
    await writeFile(newTmp, "în scriere");
    const past = new Date(Date.now() - 2 * 3600_000);
    await utimes(oldTmp, past, past);
    // Un symlink cu nume de fișier temporar nu e urmat și nu e șters.
    await symlink(join(outside, UUID), join(dir, `x.tmp-${UUID}`));

    expect(await storage.cleanupTemp(3600_000)).toBe(1);
    const names = (await readdir(dir)).sort();
    expect(names).toContain(storageKeyName(key));
    expect(names).toContain(`${UUID}.tmp-0f8fad5b-d9cb-469f-a165-70867728950f`);
    expect(names).not.toContain(`${UUID}.tmp-${UUID}`);
    expect(await readFile(join(outside, UUID), "utf8")).toBe("secret-din-afara");
  });

  it("vârstă invalidă → StorageError", async () => {
    await expect(storage.cleanupTemp(-1)).rejects.toBeInstanceOf(StorageError);
  });
});

describe("cheia unui document al gospodăriei (revizuirea F6-C)", () => {
  const H = "7d5c0f8e-1b2a-4c3d-9e8f-0a1b2c3d4e5f";
  const OTHER = "11111111-2222-4333-8444-555555555555";
  const D = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  it("acceptă doar `households/<gospodăria>/documents/<uuid>` al aceleiași gospodării", () => {
    const own = `households/${H}/documents/${D}`;
    expect(isKeyOfHousehold(own, H)).toBe(true);
    expect(isKeyOfHousehold(own, H.toUpperCase())).toBe(true);
    expect(() => assertKeyOfHousehold(own, H)).not.toThrow();
    for (const key of [
      `households/${OTHER}/documents/${D}`,
      `exports/${D}`,
      `households/${H}/documents/../${D}`,
      `households/${H}/documents/${D}/x`,
      null,
      42,
    ]) {
      expect(isKeyOfHousehold(key, H), String(key)).toBe(false);
      expect(() => assertKeyOfHousehold(key, H)).toThrow(InvalidStorageKeyError);
    }
    expect(isKeyOfHousehold(own, "nu-e-uuid")).toBe(false);
  });
});
