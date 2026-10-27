import "server-only";

import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

/**
 * Secrete citite din fișiere (`<NUME>_FILE`), pentru secretele Docker montate în
 * `/run/secrets/` (constatarea N1: valorile din `environment`/`env_file` ajung în
 * `config.v2.json` al containerului, deci în arhiva necriptată a data-root-ului Docker; fișierele
 * montate prin `secrets:` nu ajung acolo). Detalii: `docs/INFRA.md`, „Secretele ca fișiere”.
 *
 * Reguli:
 * - fiecare variabilă din `SECRET_VARIABLES` poate veni direct (`X`) SAU dintr-un fișier
 *   (`X_FILE`); ambele setate → eroare de configurare;
 * - fișierul trebuie să fie un fișier obișnuit (un symlink spre un fișier e acceptat), citibil,
 *   de cel mult 4096 octeți, text UTF-8 pe o singură linie; se taie un singur sfârșit de linie
 *   final (`\n` sau `\r\n`); conținutul gol e o eroare;
 * - URL-urile bazei de date ale altor roluri (`FINET_ROLE`) sunt refuzate și ca `X_FILE`, iar
 *   fișierul lor nu se deschide deloc;
 * - mesajele de eroare numesc variabila și problema, niciodată conținutul sau calea fișierului.
 */

/**
 * Variabilele secrete care acceptă și forma `<NUME>_FILE`. Lista acoperă toate variabilele
 * marcate `# secret` în `.env.example` și validate de `src/lib/config.ts` (un test le compară).
 * `BETTER_AUTH_SECRET` (Faza 1) nu e încă citit de config; se adaugă aici odată cu el
 * (decizia mea: nu accept o variabilă `_FILE` pe care nimic nu o folosește).
 */
export const SECRET_VARIABLES = [
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "MIGRATOR_DATABASE_URL",
  "HEALTH_TOKEN",
  "NOTIFY_TELEGRAM_BOT_TOKEN",
  "SMTP_PASSWORD",
  "STORAGE_S3_ACCESS_KEY_ID",
  "STORAGE_S3_SECRET_ACCESS_KEY",
] as const;

export type SecretVariable = (typeof SECRET_VARIABLES)[number];

/** Variabilele marcate `# secret` în `.env.example`, dar încă necitite de config (vezi sus). */
export const SECRET_VARIABLES_NOT_YET_VALIDATED = ["BETTER_AUTH_SECRET"] as const;

/** Dimensiunea maximă a unui fișier secret (o parolă, un token sau un URL, nu un certificat). */
export const SECRET_FILE_MAX_BYTES = 4096;

/** Eroare la citirea unui fișier: `problem` descrie cauza fără cale și fără conținut. */
export class SecretFileError extends Error {
  constructor(readonly problem: string) {
    super(problem);
    this.name = "SecretFileError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Citește un fișier mic, obișnuit, de cel mult `maxBytes` octeți. Deschiderea cu `O_NONBLOCK`
 * nu blochează pornirea dacă la cale e un FIFO; tipul se verifică pe descriptorul deschis
 * (`fstat`, deci după rezolvarea symlink-urilor), iar dimensiunea după octeții citiți efectiv,
 * nu după `stat` (fișierele din `/proc` raportează 0).
 */
export function readSmallFile(path: string, maxBytes: number): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    throw new SecretFileError("fișierul lipsește sau nu poate fi citit");
  }
  try {
    let isFile = false;
    try {
      isFile = fstatSync(fd).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) throw new SecretFileError("nu e un fișier obișnuit");

    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    try {
      for (;;) {
        const n = readSync(fd, buffer, total, buffer.length - total, null);
        if (n === 0) break;
        total += n;
        if (total > maxBytes) break;
      }
    } catch {
      throw new SecretFileError("fișierul nu poate fi citit");
    }
    if (total > maxBytes) throw new SecretFileError(`fișier prea mare (max. ${maxBytes} octeți)`);
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

/** Citește un fișier secret și întoarce valoarea (fără sfârșitul de linie final). */
export function readSecretFile(path: string): string {
  const bytes = readSmallFile(path, SECRET_FILE_MAX_BYTES);
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    throw new SecretFileError("conținutul nu e text UTF-8");
  }
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text === "") throw new SecretFileError("fișierul e gol");
  if (/[\r\n]/.test(text)) throw new SecretFileError("conținutul are mai multe linii");
  return text;
}

export type SecretFileIssue = Readonly<{ variable: string; problem: string }>;

export type ResolvedSecrets = Readonly<{
  /** Mediul de intrare, cu valorile citite din fișiere puse la numele lor (`X`). */
  env: Readonly<Record<string, string | undefined>>;
  /** Variabilele a căror valoare vine dintr-un fișier (pentru mesajele de eroare: `X_FILE`). */
  fromFile: ReadonlySet<string>;
  issues: readonly SecretFileIssue[];
}>;

export type ResolveOptions = Readonly<{
  /**
   * Variabilele interzise rolului curent (URL-urile bazei de date ale altor roluri), cu textul
   * problemei: forma lor `_FILE` e o eroare de configurare, iar fișierul nu se deschide.
   */
  forbidden?: ReadonlyMap<string, string>;
  /** Doar pentru teste; implicit `readSecretFile`. */
  read?: (path: string) => string;
}>;

const isSet = (value: string | undefined): value is string => value !== undefined && value !== "";

/**
 * Rezolvă variabilele `<NUME>_FILE` din `env`. Nu modifică `env`; întoarce o copie completată și
 * problemele găsite (fără valori). Fiecare fișier se citește o singură dată, aici.
 */
export function resolveSecretFiles(
  env: Readonly<Record<string, string | undefined>>,
  options: ResolveOptions = {},
): ResolvedSecrets {
  const read = options.read ?? readSecretFile;
  const out: Record<string, string | undefined> = { ...env };
  const fromFile = new Set<string>();
  const issues: SecretFileIssue[] = [];

  for (const variable of SECRET_VARIABLES) {
    const fileVariable = `${variable}_FILE`;
    const path = env[fileVariable];
    if (!isSet(path)) continue;
    if (isSet(env[variable])) {
      issues.push({
        variable: `${variable}/${fileVariable}`,
        problem: "se setează doar una dintre ele",
      });
      continue;
    }
    const forbidden = options.forbidden?.get(variable);
    if (forbidden !== undefined) {
      issues.push({ variable: fileVariable, problem: forbidden });
      continue;
    }
    try {
      out[variable] = read(path);
      fromFile.add(variable);
    } catch (error) {
      issues.push({
        variable: fileVariable,
        problem: error instanceof SecretFileError ? error.problem : "fișierul nu poate fi citit",
      });
    }
  }
  return { env: out, fromFile, issues };
}
