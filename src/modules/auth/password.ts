import "server-only";

import * as nodeCrypto from "node:crypto";

/**
 * Parolele (master prompt 6.3): Argon2id prin `crypto.argon2` din Node (adăugat în v24.7.0),
 * fără dependență nouă și fără pachet nativ (decizia mea, ADR 0003). Varianta asincronă rulează
 * în thread pool-ul libuv, deci nu blochează bucla de evenimente.
 *
 * Parametrii impliciți: OWASP Password Storage Cheat Sheet, prima recomandare pentru Argon2id:
 * m = 19 MiB (19456 KiB), t = 2, p = 1; sare de 16 octeți, rezumat de 32 de octeți.
 *
 * Formatul stocat e șirul PHC standard (compatibil cu `argon2`/`@node-rs/argon2`):
 *   $argon2id$v=19$m=19456,t=2,p=1$<sare base64 fără padding>$<rezumat base64 fără padding>
 *
 * Verificarea citește parametrii din șirul stocat (ca o creștere viitoare a parametrilor să nu
 * invalideze parolele vechi), dar acceptă DOAR `argon2id` v=19 și parametri în limite rezonabile
 * (un hash manipulat nu poate cere 4 GiB de memorie). Comparația e în timp constant.
 * Dacă `crypto.argon2` lipsește (Node prea vechi), hash-ul și verificarea aruncă: nu există
 * revenire la alt algoritm.
 */

export type Argon2Params = Readonly<{
  /** Memorie, în KiB. */
  memoryKiB: number;
  /** Numărul de treceri (t). */
  passes: number;
  /** Paralelism (p). */
  parallelism: number;
}>;

/** OWASP: m=19 MiB, t=2, p=1 (minimul recomandat; poate fi crescut, nu scăzut). */
export const ARGON2_PARAMS: Argon2Params = Object.freeze({
  memoryKiB: 19456,
  passes: 2,
  parallelism: 1,
});

const SALT_BYTES = 16;
const TAG_BYTES = 32;

/** Limitele acceptate la verificare (apărare față de un hash stocat manipulat). */
const VERIFY_LIMITS = Object.freeze({
  memoryKiB: { min: 19456, max: 262144 },
  passes: { min: 2, max: 10 },
  parallelism: { min: 1, max: 4 },
  saltBytes: { min: 16, max: 64 },
  tagBytes: { min: 32, max: 64 },
});

/** Lungimea parolei (6.3: minimum 10; maximul limitează costul unui hash). */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

type Argon2Fn = (
  algorithm: "argon2id",
  parameters: {
    message: string | Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  callback: (error: Error | null, derivedKey: Buffer) => void,
) => void;

function argon2Fn(): Argon2Fn {
  const fn = (nodeCrypto as unknown as { argon2?: Argon2Fn }).argon2;
  if (typeof fn !== "function") {
    throw new Error("crypto.argon2 lipsește: FINET cere Node.js >= 24.7");
  }
  return fn;
}

/** `true` dacă runtime-ul are `crypto.argon2` (verificat și la pornirea autentificării). */
export function hasArgon2(): boolean {
  return typeof (nodeCrypto as unknown as { argon2?: unknown }).argon2 === "function";
}

function derive(
  password: string,
  salt: Buffer,
  params: Argon2Params,
  tagLength: number,
): Promise<Buffer> {
  const fn = argon2Fn();
  return new Promise((resolve, reject) => {
    fn(
      "argon2id",
      {
        message: Buffer.from(password.normalize("NFKC"), "utf8"),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memoryKiB,
        passes: params.passes,
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

const b64 = (buffer: Buffer): string => buffer.toString("base64").replace(/=+$/, "");

/** Hash Argon2id (șir PHC). Parola se normalizează NFKC înainte (aceeași regulă la verificare). */
export async function hashPassword(
  password: string,
  params: Argon2Params = ARGON2_PARAMS,
): Promise<string> {
  const salt = nodeCrypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(key)}`;
}

export type ParsedHash = Readonly<{ params: Argon2Params; salt: Buffer; key: Buffer }>;

const PHC =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,88})\$([A-Za-z0-9+/]{16,88})$/;

const inRange = (value: number, range: Readonly<{ min: number; max: number }>): boolean =>
  Number.isSafeInteger(value) && value >= range.min && value <= range.max;

/** Parsează un șir PHC Argon2id; `null` dacă formatul sau parametrii nu sunt acceptați. */
export function parseArgon2idHash(stored: string): ParsedHash | null {
  if (typeof stored !== "string" || stored.length > 256) return null;
  const match = PHC.exec(stored);
  if (!match) return null;
  const params = {
    memoryKiB: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
  };
  const salt = Buffer.from(match[4]!, "base64");
  const key = Buffer.from(match[5]!, "base64");
  if (
    !inRange(params.memoryKiB, VERIFY_LIMITS.memoryKiB) ||
    !inRange(params.passes, VERIFY_LIMITS.passes) ||
    !inRange(params.parallelism, VERIFY_LIMITS.parallelism) ||
    !inRange(salt.length, VERIFY_LIMITS.saltBytes) ||
    !inRange(key.length, VERIFY_LIMITS.tagBytes)
  ) {
    return null;
  }
  return { params, salt, key };
}

/** Verifică o parolă față de hash-ul stocat. Un hash invalid sau neacceptat dă `false`. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parsed = parseArgon2idHash(stored);
  if (!parsed || typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.params, parsed.key.length);
  return key.length === parsed.key.length && nodeCrypto.timingSafeEqual(key, parsed.key);
}

// ---------------------------------------------------------------------------------------------
// Politica parolelor
// ---------------------------------------------------------------------------------------------

export type PasswordProblem = "too_short" | "too_long" | "compromised";

/** Mesajele (română), fără a repeta parola. */
export const PASSWORD_PROBLEM_MESSAGES: Readonly<Record<PasswordProblem, string>> = {
  too_short: `Parola trebuie să aibă cel puțin ${PASSWORD_MIN_LENGTH} caractere.`,
  too_long: `Parola poate avea cel mult ${PASSWORD_MAX_LENGTH} caractere.`,
  compromised: "Parola apare în liste de parole compromise publicate. Alege alta.",
};

/** Lungimea în puncte de cod (nu în unități UTF-16), după normalizarea NFKC. */
export function passwordLength(password: string): number {
  return [...password.normalize("NFKC")].length;
}

/** Regula de lungime; `null` dacă e respectată. */
export function checkPasswordLength(password: string): PasswordProblem | null {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) return "too_short";
  if (length > PASSWORD_MAX_LENGTH) return "too_long";
  return null;
}

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  text: () => Promise<string>;
}>;

/**
 * Verificarea HIBP prin k-anonymity: se trimit doar primele 5 caractere ale SHA-1 (hex, mari)
 * către api.pwnedpasswords.com; potrivirea se face local. Opțională (`AUTH_HIBP_ENABLED`,
 * implicit oprită) și dezactivată în teste (fetcher injectat). O eroare de rețea NU blochează
 * schimbarea parolei (fail open, decizia mea: verificarea e o recomandare a 6.3, nu o condiție
 * de securitate; Argon2id și rate limiting-ul rămân).
 */
export async function isPasswordCompromised(
  password: string,
  fetcher: Fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) }),
): Promise<boolean> {
  const sha1 = nodeCrypto
    .createHash("sha1")
    .update(password.normalize("NFKC"), "utf8")
    .digest("hex")
    .toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const response = await fetcher(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "FINET" },
    });
    if (!response.ok) return false;
    const body = await response.text();
    for (const line of body.split("\n")) {
      const [hashSuffix, count] = line.trim().split(":");
      if (hashSuffix === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export type PasswordPolicy = Readonly<{
  hibpEnabled: boolean;
  fetcher?: Fetcher;
}>;

/** Politica completă (lungime, apoi HIBP dacă e activat). `null` = parola e acceptată. */
export async function checkPasswordPolicy(
  password: string,
  policy: PasswordPolicy,
): Promise<PasswordProblem | null> {
  const lengthProblem = checkPasswordLength(password);
  if (lengthProblem) return lengthProblem;
  if (policy.hibpEnabled && (await isPasswordCompromised(password, policy.fetcher))) {
    return "compromised";
  }
  return null;
}
