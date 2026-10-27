import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  assertStorageKey,
  isStoragePrefix,
  StorageError,
  StorageNotFoundError,
  type PutOptions,
  type Storage,
  type StorageKey,
} from "@/lib/storage/types";

const DEFAULT_PREFIX = "files";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

/**
 * Storage pe disc local, confinat într-un director de bază.
 *
 * Apărare în straturi împotriva ieșirii din director:
 * 1. cheia trebuie să aibă forma exactă `<prefix>/<uuid>` (fără `..`, `/` inițial, `\`, NUL);
 * 2. directorul de bază e rezolvat cu `realpath` o dată; calea finală trebuie să fie în el;
 * 3. directorul prefixului trebuie să fie un director real (nu symlink), cu `realpath` egal cu
 *    calea așteptată;
 * 4. fișierele se deschid cu `O_NOFOLLOW` (un symlink pus în locul fișierului e refuzat) și se
 *    verifică să fie fișiere obișnuite.
 * Scrierea e atomică: fișier temporar în același director, apoi `rename`.
 */
export class LocalStorage implements Storage {
  private readonly baseDir: string;
  private basePromise: Promise<string> | null = null;

  constructor(baseDir: string) {
    if (typeof baseDir !== "string" || baseDir === "") {
      throw new StorageError("Directorul de storage lipsește.");
    }
    this.baseDir = resolve(baseDir);
  }

  /** Directorul de bază, creat dacă lipsește și rezolvat cu `realpath`. */
  private base(): Promise<string> {
    this.basePromise ??= (async () => {
      await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
      return realpath(this.baseDir);
    })();
    // O eroare (de exemplu permisiuni) nu rămâne memorată: următorul apel reîncearcă.
    this.basePromise.catch(() => {
      this.basePromise = null;
    });
    return this.basePromise;
  }

  /**
   * Calea fișierului pentru o cheie validă. Întoarce `null` dacă directorul prefixului nu există
   * (și `create` e fals).
   */
  private async pathFor(key: StorageKey, create: boolean): Promise<string | null> {
    assertStorageKey(key);
    const base = await this.base();
    const [prefix, name] = key.split("/") as [string, string];
    const dir = join(base, prefix);
    if (!dir.startsWith(base + sep)) throw new StorageError("Cheie în afara storage-ului.");

    if (create) {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }

    let st;
    try {
      st = await lstat(dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new StorageError("Structură de storage neașteptată.");
    }
    if ((await realpath(dir)) !== dir) throw new StorageError("Cheie în afara storage-ului.");

    const file = join(dir, name);
    if (!file.startsWith(dir + sep)) throw new StorageError("Cheie în afara storage-ului.");
    return file;
  }

  async put(data: Uint8Array, options: PutOptions = {}): Promise<StorageKey> {
    if (!(data instanceof Uint8Array)) throw new TypeError("Conținutul trebuie să fie Uint8Array.");
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (!isStoragePrefix(prefix)) throw new StorageError("Prefix de storage invalid.");

    const key = `${prefix}/${randomUUID()}` as StorageKey;
    const file = await this.pathFor(key, true);
    if (!file) throw new StorageError("Directorul de storage nu a putut fi creat.");

    // Numele temporar nu are forma unei chei, deci nu poate fi citit prin `get`.
    const tmp = `${file}.tmp-${randomUUID()}`;
    const handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(data);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    await handle.close();
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
    return key;
  }

  async get(key: StorageKey): Promise<Uint8Array> {
    const file = await this.pathFor(key, false);
    if (!file) throw new StorageNotFoundError();

    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") throw new StorageNotFoundError();
      if (code === "ELOOP") throw new StorageError("Structură de storage neașteptată.");
      throw error;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new StorageError("Structură de storage neașteptată.");
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async exists(key: StorageKey): Promise<boolean> {
    const file = await this.pathFor(key, false);
    if (!file) return false;
    try {
      const st = await lstat(file);
      return st.isFile() && !st.isSymbolicLink();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
  }

  async delete(key: StorageKey): Promise<void> {
    const file = await this.pathFor(key, false);
    if (!file) return;
    let st;
    try {
      st = await lstat(file);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (!st.isFile() || st.isSymbolicLink()) {
      throw new StorageError("Structură de storage neașteptată.");
    }
    try {
      await unlink(file);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}
