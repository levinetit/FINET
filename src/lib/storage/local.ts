import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  assertStorageKey,
  householdDocumentKey,
  isStorageHouseholdId,
  isStoragePrefix,
  StorageError,
  StorageLimitError,
  StorageNotFoundError,
  StorageReadOnlyError,
  type PutOptions,
  type Storage,
  type StorageKey,
} from "@/lib/storage/types";

const DEFAULT_PREFIX = "files";
/** Fișierele temporare: `<nume>.tmp-<uuid>` (nu au forma unei chei, deci nu pot fi citite). */
const TEMP_FILE = /\.tmp-[0-9a-f-]{36}$/;
/** Adâncimea maximă a arborelui (`households/<id>/documents/<fișier>`). */
const MAX_DEPTH = 4;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export type LocalStorageOptions = Readonly<{
  /**
   * Doar citire (workerul, Faza 6): directorul de bază nu se creează, iar `put`/`putStream`/
   * `delete`/`cleanupTemp` aruncă `StorageReadOnlyError`. Volumul e montat oricum read-only.
   */
  readOnly?: boolean;
}>;

/**
 * Storage pe disc local, confinat într-un director de bază.
 *
 * Apărare în straturi împotriva ieșirii din director:
 * 1. cheia trebuie să aibă una dintre formele exacte (`<prefix>/<uuid>` sau
 *    `households/<uuid>/documents/<uuid>`; fără `..`, `/` inițial, `\`, NUL);
 * 2. directorul de bază e rezolvat cu `realpath` o dată; calea finală trebuie să fie în el;
 * 3. fiecare director intermediar trebuie să fie un director real (nu symlink), cu `realpath`
 *    egal cu calea așteptată;
 * 4. fișierele se deschid cu `O_NOFOLLOW` (un symlink pus în locul fișierului e refuzat) și se
 *    verifică să fie fișiere obișnuite.
 * Scrierea e atomică: fișier temporar în același director, apoi `rename`. Un fișier temporar
 * rămas după o oprire bruscă se șterge cu `cleanupTemp` (constatarea F9).
 */
export class LocalStorage implements Storage {
  private readonly baseDir: string;
  private readonly readOnly: boolean;
  private basePromise: Promise<string> | null = null;

  constructor(baseDir: string, options: LocalStorageOptions = {}) {
    if (typeof baseDir !== "string" || baseDir === "") {
      throw new StorageError("Directorul de storage lipsește.");
    }
    this.baseDir = resolve(baseDir);
    this.readOnly = options.readOnly === true;
  }

  /** Directorul de bază (creat dacă lipsește, în afara modului doar-citire), cu `realpath`. */
  private base(): Promise<string> {
    this.basePromise ??= (async () => {
      if (!this.readOnly) await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
      try {
        return await realpath(this.baseDir);
      } catch (error) {
        if (errorCode(error) === "ENOENT")
          throw new StorageError("Directorul de storage lipsește.");
        throw error;
      }
    })();
    // O eroare (de exemplu permisiuni) nu rămâne memorată: următorul apel reîncearcă.
    this.basePromise.catch(() => {
      this.basePromise = null;
    });
    return this.basePromise;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new StorageReadOnlyError();
  }

  /**
   * Calea fișierului pentru o cheie validă. Întoarce `null` dacă un director intermediar nu
   * există (și `create` e fals).
   */
  private async pathFor(key: StorageKey, create: boolean): Promise<string | null> {
    assertStorageKey(key);
    const base = await this.base();
    const parts = key.split("/");
    const name = parts.pop()!;
    let dir = base;
    for (const part of parts) {
      const next = join(dir, part);
      if (!next.startsWith(dir + sep)) throw new StorageError("Cheie în afara storage-ului.");
      dir = next;
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
    }
    if ((await realpath(dir)) !== dir) throw new StorageError("Cheie în afara storage-ului.");

    const file = join(dir, name);
    if (!file.startsWith(dir + sep)) throw new StorageError("Cheie în afara storage-ului.");
    return file;
  }

  /** Cheia nouă pentru opțiunile date (generată aici, niciodată din input). */
  private newKey(options: PutOptions): StorageKey {
    if (options.householdId !== undefined) {
      if (!isStorageHouseholdId(options.householdId)) {
        throw new StorageError("Gospodărie invalidă pentru storage.");
      }
      return householdDocumentKey(options.householdId, randomUUID());
    }
    const prefix = options.prefix ?? DEFAULT_PREFIX;
    if (!isStoragePrefix(prefix)) throw new StorageError("Prefix de storage invalid.");
    return `${prefix}/${randomUUID()}` as StorageKey;
  }

  private static maxBytesOf(options: PutOptions): number {
    const max = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(max) || max < 0)
      throw new StorageError("Plafon de dimensiune invalid.");
    return max;
  }

  async put(data: Uint8Array, options: PutOptions = {}): Promise<StorageKey> {
    if (!(data instanceof Uint8Array)) throw new TypeError("Conținutul trebuie să fie Uint8Array.");
    if (data.byteLength > LocalStorage.maxBytesOf(options)) throw new StorageLimitError();
    return this.putStream([data], options);
  }

  async putStream(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options: PutOptions = {},
  ): Promise<StorageKey> {
    this.assertWritable();
    const maxBytes = LocalStorage.maxBytesOf(options);
    const key = this.newKey(options);
    const file = await this.pathFor(key, true);
    if (!file) throw new StorageError("Directorul de storage nu a putut fi creat.");

    const tmp = `${file}.tmp-${randomUUID()}`;
    const handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      let total = 0;
      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) throw new TypeError("Conținut invalid.");
        total += chunk.byteLength;
        if (total > maxBytes) throw new StorageLimitError();
        await handle.write(chunk);
      }
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

  /** Deschide fișierul pentru citire (fără symlink, doar fișier obișnuit). */
  private async openFile(key: StorageKey) {
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
    const st = await handle.stat().catch(async (error: unknown) => {
      await handle.close();
      throw error;
    });
    if (!st.isFile()) {
      await handle.close();
      throw new StorageError("Structură de storage neașteptată.");
    }
    return handle;
  }

  async get(key: StorageKey): Promise<Uint8Array> {
    const handle = await this.openFile(key);
    try {
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async openRead(key: StorageKey): Promise<AsyncIterable<Uint8Array>> {
    const handle = await this.openFile(key);
    // `autoClose`: descriptorul se închide la sfârșitul fluxului sau la eroare.
    return handle.createReadStream({ highWaterMark: 64 * 1024, autoClose: true });
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
    this.assertWritable();
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

  /**
   * Șterge fișierele temporare orfane (`*.tmp-<uuid>`) mai vechi de `olderThanMs` (o scriere
   * întreruptă de o oprire bruscă; constatarea F9). Nu urmează symlink-uri și nu coboară mai
   * adânc decât structura cheilor. Întoarce numărul de fișiere șterse.
   */
  async cleanupTemp(olderThanMs: number, now: number = Date.now()): Promise<number> {
    this.assertWritable();
    if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
      throw new StorageError("Vârstă invalidă pentru curățare.");
    }
    const base = await this.base();
    let removed = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          if (depth < MAX_DEPTH) await walk(path, depth + 1);
        } else if (entry.isFile() && TEMP_FILE.test(entry.name)) {
          const st = await lstat(path).catch(() => null);
          if (st?.isFile() && now - st.mtimeMs >= olderThanMs) {
            await unlink(path).catch((error: unknown) => {
              if (errorCode(error) !== "ENOENT") throw error;
            });
            removed++;
          }
        }
      }
    };
    await walk(base, 1);
    return removed;
  }
}
