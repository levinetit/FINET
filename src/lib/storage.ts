import "server-only";

import { getConfig, type StorageConfig } from "@/lib/config";
import { LocalStorage, type LocalStorageOptions } from "@/lib/storage/local";
import { S3Storage } from "@/lib/storage/s3";
import {
  assertKeyOfHousehold,
  assertStorageKey,
  householdDocumentKey,
  InvalidStorageKeyError,
  isStorageHouseholdId,
  isKeyOfHousehold,
  isStorageKey,
  StorageError,
  StorageLimitError,
  StorageNotFoundError,
  StorageReadOnlyError,
  storageKeyName,
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
  assertKeyOfHousehold,
  assertStorageKey,
  householdDocumentKey,
  InvalidStorageKeyError,
  isKeyOfHousehold,
  isStorageHouseholdId,
  isStorageKey,
  LocalStorage,
  S3Storage,
  StorageError,
  StorageLimitError,
  StorageNotFoundError,
  StorageReadOnlyError,
  storageKeyName,
};
export type { LocalStorageOptions, PutOptions, Storage, StorageKey, StoragePrefix };

/**
 * Construiește driverul pentru o configurație dată. `readOnly` (workerul, Faza 6): fără scrieri,
 * fără crearea directorului de bază.
 */
export function createStorage(config: StorageConfig, options: LocalStorageOptions = {}): Storage {
  if (config.driver === "s3") {
    if (!config.s3) throw new StorageError("Configurația S3 lipsește.");
    return new S3Storage(config.s3);
  }
  return new LocalStorage(config.dir, options);
}

let cached: { config: StorageConfig; storage: Storage } | null = null;

/**
 * Driverul de storage al procesului curent (din configurație; memorat per configurație).
 * Workerul (`FINET_ROLE=worker`) primește storage-ul doar pentru citire (ADR 0013).
 */
export function getStorage(): Storage {
  const full = getConfig();
  const config = full.storage;
  if (cached?.config !== config) {
    cached = { config, storage: createStorage(config, { readOnly: full.role === "worker" }) };
  }
  return cached.storage;
}
