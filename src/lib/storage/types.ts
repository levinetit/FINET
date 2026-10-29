/**
 * Tipurile și validarea cheilor pentru storage. Fără dependențe de mediu, ca driverele și
 * testele să le poată importa direct.
 */

/**
 * Cheie de fișier, generată de storage. Două forme, ambele stricte:
 * - `<prefix>/<uuid v4>` (fișiere generice);
 * - `households/<uuid gospodărie>/documents/<uuid v4>` (documentele unei gospodării, Faza 6).
 */
export type StorageKey = string & { readonly __brand: "StorageKey" };

/** Prefixul (categoria) fișierului: litere mici, cifre și `-`, maxim 32 de caractere. */
export type StoragePrefix = string;

export type PutOptions = Readonly<{
  /** Categoria fișierului (de exemplu `receipts`); implicit `files`. Ignorat cu `householdId`. */
  prefix?: StoragePrefix;
  /**
   * Gospodăria documentului: cheia devine `households/<householdId>/documents/<uuid>` (Faza 6).
   * Trebuie să fie un uuid (în litere mici sau mari; cheia folosește litere mici).
   */
  householdId?: string;
  /**
   * Plafonul de dimensiune al fișierului, în octeți (constatarea F9). Peste el, scrierea e
   * oprită, fișierul temporar șters și se aruncă `StorageLimitError`.
   */
  maxBytes?: number;
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
  /**
   * Salvează conținutul primit pe bucăți (fără a-l ține tot în memorie) și întoarce cheia.
   * O eroare a sursei sau depășirea `maxBytes` nu lasă niciun fișier în urmă.
   */
  putStream(
    source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
    options?: PutOptions,
  ): Promise<StorageKey>;
  /** Citește conținutul ca flux (pentru fișiere mari); `StorageNotFoundError` dacă nu există. */
  openRead(key: StorageKey): Promise<AsyncIterable<Uint8Array>>;
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

/** Fișierul depășește plafonul de dimensiune (`maxBytes`). */
export class StorageLimitError extends StorageError {
  constructor() {
    super("Fișierul depășește dimensiunea maximă.");
    this.name = "StorageLimitError";
  }
}

/** Storage-ul a fost deschis doar pentru citire (de exemplu în worker). */
export class StorageReadOnlyError extends StorageError {
  constructor() {
    super("Storage-ul e doar pentru citire.");
    this.name = "StorageReadOnlyError";
  }
}

const PREFIX = /^[a-z][a-z0-9-]{0,31}$/;
const UUID_V4 = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
// Gospodăria: orice uuid (nu doar v4), în litere mici.
const ANY_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY = new RegExp(
  `^(?:[a-z][a-z0-9-]{0,31}/${UUID_V4}|households/${ANY_UUID}/documents/${UUID_V4})$`,
);
const HOUSEHOLD_ID = new RegExp(`^${ANY_UUID}$`, "i");

/** Un id de gospodărie acceptat pentru cheile de documente. */
export function isStorageHouseholdId(value: unknown): value is string {
  return typeof value === "string" && HOUSEHOLD_ID.test(value);
}

/** Cheia documentelor unei gospodării: `households/<id>/documents/<uuid>`. */
export function householdDocumentKey(householdId: string, name: string): StorageKey {
  const key = `households/${householdId.toLowerCase()}/documents/${name}`;
  assertStorageKey(key);
  return key;
}

/** Ultimul segment al cheii (uuid-ul generat), de exemplu id-ul documentului. */
export function storageKeyName(key: StorageKey): string {
  assertStorageKey(key);
  return key.slice(key.lastIndexOf("/") + 1);
}

export function isStoragePrefix(value: unknown): value is StoragePrefix {
  return typeof value === "string" && PREFIX.test(value);
}

export function isStorageKey(value: unknown): value is StorageKey {
  return typeof value === "string" && KEY.test(value);
}

/**
 * Cheia e un document AL ACESTEI gospodării (`households/<householdId>/documents/<uuid>`), nu
 * doar o cheie bine formată: apărare în adâncime la citire și ștergere (revizuirea F6-C), peste
 * CHECK-ul `documents_storage_key_shape` din bază. Altfel `InvalidStorageKeyError`.
 */
export function isKeyOfHousehold(value: unknown, householdId: string): value is StorageKey {
  return (
    isStorageKey(value) &&
    isStorageHouseholdId(householdId) &&
    value.startsWith(`households/${householdId.toLowerCase()}/documents/`)
  );
}

export function assertKeyOfHousehold(
  value: unknown,
  householdId: string,
): asserts value is StorageKey {
  if (!isKeyOfHousehold(value, householdId)) throw new InvalidStorageKeyError();
}

/** Respinge orice nu are forma exactă a unei chei generate (deci și `..`, căi absolute, `\`). */
export function assertStorageKey(value: unknown): asserts value is StorageKey {
  if (!isStorageKey(value)) throw new InvalidStorageKeyError();
}
