/**
 * Tipurile și validarea cheilor pentru storage. Fără dependențe de mediu, ca driverele și
 * testele să le poată importa direct.
 */

/** Cheie de fișier: `<prefix>/<uuid v4>`, generată de storage. */
export type StorageKey = string & { readonly __brand: "StorageKey" };

/** Prefixul (categoria) fișierului: litere mici, cifre și `-`, maxim 32 de caractere. */
export type StoragePrefix = string;

export type PutOptions = Readonly<{
  /** Categoria fișierului (de exemplu `receipts`); implicit `files`. */
  prefix?: StoragePrefix;
}>;

export interface Storage {
  /** Salvează conținutul și întoarce cheia nou generată. */
  put(data: Uint8Array, options?: PutOptions): Promise<StorageKey>;
  /** Citește conținutul; `StorageNotFoundError` dacă nu există. */
  get(key: StorageKey): Promise<Uint8Array>;
  /** Șterge fișierul; idempotent (o cheie inexistentă nu e eroare). */
  delete(key: StorageKey): Promise<void>;
  /** Există fișierul? */
  exists(key: StorageKey): Promise<boolean>;
}

/** Eroare de storage. Mesajele nu conțin căi de pe disc. */
export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export class StorageNotFoundError extends StorageError {
  constructor() {
    super("Fișierul nu există.");
    this.name = "StorageNotFoundError";
  }
}

export class InvalidStorageKeyError extends StorageError {
  constructor() {
    super("Cheie de storage invalidă.");
    this.name = "InvalidStorageKeyError";
  }
}

const PREFIX = /^[a-z][a-z0-9-]{0,31}$/;
const KEY =
  /^[a-z][a-z0-9-]{0,31}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isStoragePrefix(value: unknown): value is StoragePrefix {
  return typeof value === "string" && PREFIX.test(value);
}

export function isStorageKey(value: unknown): value is StorageKey {
  return typeof value === "string" && KEY.test(value);
}

/** Respinge orice nu are forma exactă a unei chei generate (deci și `..`, căi absolute, `\`). */
export function assertStorageKey(value: unknown): asserts value is StorageKey {
  if (!isStorageKey(value)) throw new InvalidStorageKeyError();
}
