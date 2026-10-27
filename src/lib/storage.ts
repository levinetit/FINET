import "server-only";

import { getConfig, type StorageConfig } from "@/lib/config";
import { LocalStorage } from "@/lib/storage/local";
import { S3Storage } from "@/lib/storage/s3";
import {
  assertStorageKey,
  InvalidStorageKeyError,
  isStorageKey,
  StorageError,
  StorageNotFoundError,
  type PutOptions,
  type Storage,
  type StorageKey,
  type StoragePrefix,
} from "@/lib/storage/types";

/**
 * Stocarea fișierelor (master prompt 3.2, 6.3). Restul aplicației folosește doar interfața
 * `Storage`; driverul (`local` sau `s3`) se alege din `STORAGE_DRIVER`.
 *
 * Cheile sunt generate de storage la `put` (`<prefix>/<uuid>`), niciodată din input.
 * Cheile primite la `get`/`delete`/`exists` (venite, mai târziu, din baza de date) se validează
 * strict înainte de orice acces la disc.
 */

export {
  assertStorageKey,
  InvalidStorageKeyError,
  isStorageKey,
  LocalStorage,
  S3Storage,
  StorageError,
  StorageNotFoundError,
};
export type { PutOptions, Storage, StorageKey, StoragePrefix };

/** Construiește driverul pentru o configurație dată. */
export function createStorage(config: StorageConfig): Storage {
  if (config.driver === "s3") {
    if (!config.s3) throw new StorageError("Configurația S3 lipsește.");
    return new S3Storage(config.s3);
  }
  return new LocalStorage(config.dir);
}

let cached: { config: StorageConfig; storage: Storage } | null = null;

/** Driverul de storage al procesului curent (din configurație; memorat per configurație). */
export function getStorage(): Storage {
  const config = getConfig().storage;
  if (cached?.config !== config) cached = { config, storage: createStorage(config) };
  return cached.storage;
}
