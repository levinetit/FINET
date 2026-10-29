import "server-only";

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Db, createDb } from "@/db";
import { ConfigError, parseConfig } from "@/lib/config";
import { PASSWORD_PROBLEM_MESSAGES, checkPasswordPolicy } from "@/modules/auth/password";
import { emailSchema } from "@/modules/auth/request";
import {
  UserServiceError,
  addMemberByEmail,
  createUserWithHousehold,
  resetPasswordByEmail,
} from "@/modules/auth/users.service";
import { LocalStorage, type Storage } from "@/lib/storage";
import { expireDocumentFiles } from "@/modules/documents/retention";
import { purgeIdempotencyKeys } from "@/modules/idempotency/idempotency";
import { cleanupStatementFiles } from "@/modules/statements/cleanup";

/**
 * CLI-ul de administrare (master prompt 3.3, Faza 1), împachetat în `dist/tools/admin.mjs`
 * (imaginea `finet:tools`, serviciul compose `finet-admin`):
 *
 *   admin.mjs create-user --email <email> --name <nume> [--password-stdin]
 *   admin.mjs reset-password --email <email> [--password-stdin]
 *   admin.mjs add-member --household <id> --email <email> [--role member|owner]
 *   admin.mjs cleanup-idempotency
 *
 * `cleanup-idempotency` (F2-B, ADR 0005) șterge cheile `Idempotency-Key` mai vechi de 24 de ore
 * prin `finet.purge_idempotency_keys()` și scrie DOAR numărul de rânduri șterse (o linie), ca să
 * poată fi rulată din cron/Portainer și citită de un script. Idempotentă (a doua rulare: `0`).
 *
 * Reguli: parola NU se dă niciodată ca argument (ar rămâne în istoricul shell-ului și în `ps`):
 * se citește din stdin (`--password-stdin`, prima linie) sau se generează și se afișează O
 * SINGURĂ DATĂ. Ieșirea nu conține parola citită, URL-ul bazei sau emailul (doar id-uri).
 * Configurația: `FINET_ROLE=admin`, `DATABASE_URL(_FILE)` (rolul `finet_app`). Cod de ieșire 0 la
 * succes (inclusiv „nimic de făcut”), 1 la eroare, 2 la utilizare greșită.
 */

export type AdminIo = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  argv: readonly string[];
  readStdin: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Doar pentru teste: baza de date dată direct (altfel din configurație). */
  db?: Db;
  /** Doar pentru teste: storage-ul (altfel `STORAGE_DIR` din configurație). */
  storage?: Storage & { cleanupTemp?: (olderThanMs: number) => Promise<number> };
}>;

const USAGE = [
  "Utilizare:",
  "  admin create-user --email <email> --name <nume> [--password-stdin]",
  "  admin reset-password --email <email> [--password-stdin]",
  "  admin add-member --household <id> --email <email> [--role member|owner]",
  "  admin cleanup-idempotency",
  "  admin cleanup-documents [--temp-hours <ore>]",
  "Parola se citește din stdin cu --password-stdin; altfel se generează și se afișează o dată.",
].join("\n");

class UsageError extends Error {}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

type Flags = Record<string, string | true>;

const COMMANDS: Readonly<Record<string, readonly string[]>> = {
  "create-user": ["email", "name", "password-stdin"],
  "reset-password": ["email", "password-stdin"],
  "add-member": ["household", "email", "role"],
  "cleanup-idempotency": [],
  "cleanup-documents": ["temp-hours"],
};
const BOOLEAN_FLAGS = new Set(["password-stdin"]);

export function parseArgs(argv: readonly string[]): { command: string; flags: Flags } {
  const [command, ...rest] = argv;
  if (!command || !(command in COMMANDS)) throw new UsageError("comandă necunoscută");
  const allowed = COMMANDS[command]!;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new UsageError(`argument neașteptat`);
    const name = match[1]!;
    if (name === "password") {
      throw new UsageError("parola nu se dă ca argument; folosește --password-stdin");
    }
    if (!allowed.includes(name)) throw new UsageError(`opțiune necunoscută: --${name}`);
    if (name in flags) throw new UsageError(`opțiune repetată: --${name}`);
    if (BOOLEAN_FLAGS.has(name)) {
      if (match[2] !== undefined) throw new UsageError(`--${name} nu primește o valoare`);
      flags[name] = true;
      continue;
    }
    const value = match[2] ?? rest[++i];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`--${name} cere o valoare`);
    }
    flags[name] = value;
  }
  return { command, flags };
}

function required(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.trim() === "") throw new UsageError(`lipsește --${name}`);
  return value;
}

function parseEmail(raw: string): string {
  const parsed = emailSchema.safeParse(raw);
  if (!parsed.success) throw new UsageError("email invalid");
  return parsed.data;
}

/** Generată: 24 de caractere base64url (144 de biți). */
export function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

async function obtainPassword(
  io: AdminIo,
  flags: Flags,
  hibpEnabled: boolean,
): Promise<{ password: string; generated: boolean }> {
  if (flags["password-stdin"] !== true) return { password: generatePassword(), generated: true };
  const text = await io.readStdin();
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  const problem = await checkPasswordPolicy(line, { hibpEnabled });
  if (problem) throw new UsageError(PASSWORD_PROBLEM_MESSAGES[problem]);
  return { password: line, generated: false };
}

function describeError(error: unknown): string {
  if (error instanceof ConfigError || error instanceof UserServiceError) return error.message;
  if (error && typeof error === "object") {
    // drizzle-orm învelește erorile driverului (DrizzleQueryError, cu `cause`); mesajul lui
    // conține query-ul și parametrii, deci nu se afișează.
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === "object" && cause !== error) return describeError(cause);
    const e = error as { code?: unknown; name?: unknown };
    const code = typeof e.code === "string" ? e.code : null;
    // Fără mesajul complet al erorilor PostgreSQL: pot cita valori (de exemplu emailul).
    if (e.name === "PostgresError") return `eroare PostgreSQL ${code ?? ""}`.trim();
    if (code) return `eroare de conexiune sau de sistem (${code})`;
  }
  return "eroare neașteptată";
}

export async function main(io: AdminIo): Promise<number> {
  let parsed: { command: string; flags: Flags };
  try {
    parsed = parseArgs(io.argv);
  } catch (error) {
    io.err(`finet-admin: ${error instanceof Error ? error.message : "argumente invalide"}`);
    io.err(USAGE);
    return 2;
  }

  let close: (() => Promise<void>) | null = null;
  try {
    const config = parseConfig(io.env);
    if (config.role !== "admin") {
      io.err(`finet-admin: FINET_ROLE trebuie să fie „admin” (acum: ${config.role})`);
      return 1;
    }
    let db = io.db;
    if (!db) {
      if (!config.database.url) {
        io.err("finet-admin: lipsește DATABASE_URL(_FILE)");
        return 1;
      }
      const created = createDb(config.database.url, {
        ca: config.database.ca,
        applicationName: "finet-admin",
        max: 1,
      });
      db = created.db;
      close = () => created.client.end({ timeout: 5 });
    }

    const { command, flags } = parsed;
    if (command === "create-user") {
      const email = parseEmail(required(flags, "email"));
      const name = required(flags, "name");
      const { password, generated } = await obtainPassword(io, flags, config.auth.hibpEnabled);
      const result = await createUserWithHousehold(db, {
        email,
        name,
        password,
        firstUserBecomesAdmin: true,
        emailVerified: true,
      });
      if (!result.created) {
        io.out(
          `finet-admin: utilizatorul există deja (id ${result.userId}); nu s-a modificat nimic`,
        );
        return 0;
      }
      io.out(
        `finet-admin: utilizator creat (id ${result.userId}), gospodăria personală ${result.householdId}` +
          (result.isPlatformAdmin ? ", administrator al platformei" : ""),
      );
      if (generated) io.out(`finet-admin: parola generată (afișată o singură dată): ${password}`);
      return 0;
    }

    if (command === "reset-password") {
      const email = parseEmail(required(flags, "email"));
      const { password, generated } = await obtainPassword(io, flags, config.auth.hibpEnabled);
      const result = await resetPasswordByEmail(db, email, password);
      io.out(
        `finet-admin: parola utilizatorului ${result.userId} a fost schimbată; sesiuni revocate: ${result.revokedSessions}`,
      );
      if (generated) io.out(`finet-admin: parola generată (afișată o singură dată): ${password}`);
      return 0;
    }

    if (command === "cleanup-documents") {
      // Faza 6 (ADR 0015): originalele cu retenția expirată + fișierele temporare orfane. Doar
      // contoare în ieșire (fără căi, chei sau nume).
      const raw = flags["temp-hours"];
      const hours = raw === undefined ? 24 : Number(raw);
      // Minimum 1 oră (revizuirea F6-C): o scriere în curs are un fișier `*.tmp-*` proaspăt.
      if (typeof raw === "string" && (!/^[0-9]{1,4}$/.test(raw) || Number(raw) < 1)) {
        throw new UsageError("--temp-hours: un număr întreg de ore (1–9999)");
      }
      let storage = io.storage;
      let mounted = true;
      if (!storage) {
        // Siguranța: fără STORAGE_DIR explicit sau cu directorul nemontat, NU se marchează nimic
        // ca șters (lipsa unui fișier ar fi tratată drept „deja șters”, iar originalul ar rămâne
        // pe disc fără evidență). `households/` există de la primul document încărcat.
        const dir = io.env.STORAGE_DIR?.trim();
        if (!dir || !isDirectory(dir)) {
          io.err("finet-admin: STORAGE_DIR lipsește sau nu e montat (în scriere)");
          return 1;
        }
        mounted = isDirectory(join(dir, "households"));
        storage = new LocalStorage(dir);
      }
      const r = await expireDocumentFiles({
        db,
        storage,
        tempOlderThanMs: hours * 3600 * 1000,
        skipFiles: !mounted,
      });
      // Faza 7 (F7-B): PDF-urile de extras expirate/eșuate și previzualizările vechi de 7 zile.
      const s = await cleanupStatementFiles({ db, storage, skipFiles: !mounted });
      io.out(
        `expired=${r.expired} failed=${r.failed} temp=${r.tempRemoved}` +
          ` statements=${s.files} statements_failed=${s.failed} previews=${s.previews}` +
          (mounted ? "" : " storage=empty"),
      );
      return r.failed > 0 || s.failed > 0 ? 1 : 0;
    }

    if (command === "cleanup-idempotency") {
      io.out(String(await purgeIdempotencyKeys(db)));
      return 0;
    }

    // add-member
    const householdId = required(flags, "household");
    const email = parseEmail(required(flags, "email"));
    const role = flags.role === undefined ? "member" : flags.role;
    if (role !== "member" && role !== "owner") throw new UsageError("--role: member sau owner");
    const result = await addMemberByEmail(db, householdId, email, role);
    io.out(
      result.added
        ? `finet-admin: utilizatorul ${result.userId} a fost adăugat în gospodăria ${householdId} (${role})`
        : `finet-admin: utilizatorul ${result.userId} e deja membru al gospodăriei; nu s-a modificat nimic`,
    );
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`finet-admin: ${error.message}`);
      return 2;
    }
    io.err(`finet-admin: EȘEC: ${describeError(error)}`);
    return 1;
  } finally {
    await close?.();
  }
}
