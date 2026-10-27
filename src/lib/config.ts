import "server-only";

import { z } from "zod";

import { CURRENCIES, parseAmount, type Money } from "@/lib/money";
import { resolveSecretFiles } from "@/lib/secret-files";

/**
 * Configurația FINET (master prompt 3.3, 6.3): variabilele de mediu, citite O SINGURĂ DATĂ și
 * validate cu Zod. O valoare lipsă sau invalidă oprește aplicația la pornire
 * (`src/instrumentation.ts`), cu un mesaj care numește variabila și problema, dar nu valoarea.
 *
 * Numele variabilelor sunt cele din `docs/GHID_CONSTRUIRE.md`, secțiunea 10 (`CF_ACCESS_*`,
 * `STORAGE_DIR`, `STORAGE_S3_*`, `SMTP_*`), ca operatorul să completeze mediul după ghid.
 *
 * Reguli:
 * - Parsarea e leneșă (`getConfig()`), niciodată la încărcarea modulului: `next build` rulează
 *   cu `NODE_ENV=production` fără mediul de producție.
 * - Niciun secret în `NEXT_PUBLIC_*`: singura variabilă publică e `NEXT_PUBLIC_APP_NAME`.
 * - Mesajele de eroare folosesc doar numele variabilei și codul problemei, niciodată valoarea.
 * - Fiecare proces primește doar URL-ul bazei de date al rolului său (`FINET_ROLE`, vezi `Role`).
 * - Secretele (`SECRET_VARIABLES` din `src/lib/secret-files.ts`) pot veni și din fișiere:
 *   `<NUME>_FILE=/run/secrets/...` (secretele Docker, constatarea N1). Fișierele se citesc tot o
 *   singură dată, odată cu restul configurației; `X` și `X_FILE` împreună sunt o eroare.
 */

// ---------------------------------------------------------------------------------------------
// Tipuri publice
// ---------------------------------------------------------------------------------------------

export type AppMode = "personal" | "saas";
/**
 * Rolul procesului (`FINET_ROLE`), care decide ce URL de bază de date primește:
 * - `web` (implicit): serverul Next.js, doar `DATABASE_URL`;
 * - `worker`: procesul de fundal (Faza 5/6), doar `WORKER_DATABASE_URL`;
 * - `migrate`: rularea migrațiilor (Faza 1+), doar `MIGRATOR_DATABASE_URL`.
 * URL-urile celorlalte roluri, dacă apar în mediu, opresc pornirea: un proces compromis nu
 * trebuie să aibă la îndemână drepturile altui rol (de exemplu proprietarul schemei).
 */
export type Role = "web" | "worker" | "migrate";
export type NodeEnv = "development" | "production" | "test";

export type S3Config = Readonly<{
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}>;

export type StorageConfig = Readonly<{
  driver: "local" | "s3";
  /** Directorul local: fișierele (driver `local`) și fișierele temporare (ambele drivere). */
  dir: string;
  quotaMb: number;
  /** Prezent doar când `driver` e `s3`. */
  s3: S3Config | null;
}>;

export type AccessConfig = Readonly<{
  /** Dacă `true`, orice cerere fără JWT Cloudflare Access valid primește 403. */
  required: boolean;
  /** Domeniul echipei Zero Trust (`<echipa>.cloudflareaccess.com`), fără schemă. */
  teamDomain: string | null;
  /** Audiența (AUD tag) aplicației Access. */
  aud: string | null;
}>;

export type Config = Readonly<{
  nodeEnv: NodeEnv;
  role: Role;
  appMode: AppMode;
  appName: string;
  appUrl: string | null;
  database: Readonly<{
    /**
     * URL-ul bazei pentru rolul curent: `DATABASE_URL` (web), `WORKER_DATABASE_URL` (worker)
     * sau `MIGRATOR_DATABASE_URL` (migrate). `null` doar pentru `web` fără `DATABASE_URL`
     * (Faza 0: `/api/health` raportează `db: unknown`).
     */
    url: string | null;
  }>;
  storage: StorageConfig;
  access: AccessConfig;
  /** Token intern opțional pentru `/api/health` detaliat fără JWT Access (monitorizare). */
  healthToken: string | null;
  ai: Readonly<{
    /** Documente procesate cu AI pe zi, per gospodărie. */
    dailyDocumentLimit: number;
    /** Bugetul lunar global pentru furnizorii AI externi (0 = fără AI extern). */
    monthlyBudget: Money;
  }>;
  notify: Readonly<{
    telegram: Readonly<{ botToken: string; chatId: string }> | null;
    smtp: Readonly<{
      host: string;
      port: number;
      user: string | null;
      password: string | null;
      from: string;
    }> | null;
  }>;
}>;

export type ConfigIssue = Readonly<{ variable: string; problem: string }>;

/** Configurație invalidă. Mesajul și `issues` nu conțin valorile variabilelor. */
export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      "Configurație invalidă; aplicația nu pornește.\n" +
        issues.map((i) => `  - ${i.variable}: ${i.problem}`).join("\n"),
    );
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------

const POSTGRES_URL = /^postgres(?:ql)?:\/\/\S+$/;
// Hostname simplu: etichete DNS separate prin punct, fără schemă, port, cale sau spații.
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const optionalString = z.string().min(1).optional();
const postgresUrl = z.string().regex(POSTGRES_URL).optional();
const boolString = z.enum(["true", "false"]).optional();
const nonNegativeInt = z
  .string()
  .regex(/^\d{1,9}$/)
  .optional();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  FINET_ROLE: z.enum(["web", "worker", "migrate"]).optional(),
  APP_MODE: z.enum(["personal", "saas"]),
  APP_URL: z.url({ protocol: /^https?$/ }).optional(),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).max(40).optional(),

  DATABASE_URL: postgresUrl,
  WORKER_DATABASE_URL: postgresUrl,
  MIGRATOR_DATABASE_URL: postgresUrl,

  STORAGE_DRIVER: z.enum(["local", "s3"]).optional(),
  STORAGE_DIR: optionalString,
  STORAGE_QUOTA_MB: nonNegativeInt,
  STORAGE_S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  STORAGE_S3_REGION: optionalString,
  STORAGE_S3_BUCKET: optionalString,
  STORAGE_S3_ACCESS_KEY_ID: optionalString,
  STORAGE_S3_SECRET_ACCESS_KEY: optionalString,

  CF_ACCESS_REQUIRED: boolString,
  CF_ACCESS_TEAM_DOMAIN: z.string().regex(HOSTNAME).optional(),
  CF_ACCESS_AUD: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
  HEALTH_TOKEN: z.string().min(32).max(512).optional(),

  AI_DAILY_DOCUMENT_LIMIT: nonNegativeInt,
  AI_MONTHLY_BUDGET: z.string().max(40).optional(),
  AI_MONTHLY_BUDGET_CURRENCY: z.enum(CURRENCIES).optional(),

  NOTIFY_TELEGRAM_BOT_TOKEN: optionalString,
  NOTIFY_TELEGRAM_CHAT_ID: z
    .string()
    .regex(/^-?\d{1,20}$/)
    .optional(),
  SMTP_HOST: optionalString,
  SMTP_PORT: z
    .string()
    .regex(/^\d{1,5}$/)
    .optional(),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
});

type RawEnv = z.infer<typeof envSchema>;
const ENV_KEYS = Object.keys(envSchema.shape) as (keyof RawEnv)[];

type DatabaseVariable = "DATABASE_URL" | "WORKER_DATABASE_URL" | "MIGRATOR_DATABASE_URL";

/** Variabila de bază de date a fiecărui rol; celelalte două sunt interzise în acel rol. */
const ROLE_DATABASE_VARIABLE: Readonly<Record<Role, DatabaseVariable>> = {
  web: "DATABASE_URL",
  worker: "WORKER_DATABASE_URL",
  migrate: "MIGRATOR_DATABASE_URL",
};
const DATABASE_VARIABLES: readonly DatabaseVariable[] = [
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "MIGRATOR_DATABASE_URL",
];

/** Valori implicite (decizia mea, documentate în `.env.example`). */
const DEFAULTS = {
  appName: "FINET",
  storageDir: "./.data/storage",
  storageQuotaMb: 5000,
  aiDailyDocumentLimit: 50,
  // 0 = fără furnizori AI externi până când operatorul alege altfel (Faza 6).
  aiMonthlyBudget: "0",
  aiMonthlyBudgetCurrency: "USD",
  smtpPort: 587,
} as const;

// Probleme descrise fără valoare (Zod poate include valoarea în mesajele implicite).
function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return "lipsește sau nu are tipul așteptat";
    case "invalid_value":
      return "valoare nepermisă";
    case "invalid_format":
      return "format invalid";
    case "too_small":
      return "prea scurtă";
    case "too_big":
      return "prea lungă";
    default:
      return "valoare invalidă";
  }
}

// ---------------------------------------------------------------------------------------------
// Parsare
// ---------------------------------------------------------------------------------------------

export type ParseOptions = Readonly<{
  /** Citirea unui fișier secret (`X_FILE`); implicit din disc. Doar pentru teste. */
  readSecret?: (path: string) => string;
}>;

const ROLES: readonly Role[] = ["web", "worker", "migrate"];
const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

/**
 * Validează un set de variabile de mediu și construiește configurația. Nu citește `process.env`
 * (o folosesc `getConfig()` și testele); singurul efect e citirea fișierelor indicate de
 * variabilele `*_FILE` prezente în `env`.
 */
export function parseConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: ParseOptions = {},
): Config {
  // Rolul se află înaintea validării, ca fișierele cu URL-urile altor roluri să nu fie deschise.
  // Un `FINET_ROLE` invalid e raportat de schemă; atunci nu se citește niciun fișier.
  const rawRole = env.FINET_ROLE === undefined || env.FINET_ROLE === "" ? "web" : env.FINET_ROLE;
  const knownRole = isRole(rawRole) ? rawRole : null;
  const forbidden = new Map<string, string>();
  if (knownRole) {
    for (const variable of DATABASE_VARIABLES) {
      if (variable !== ROLE_DATABASE_VARIABLE[knownRole]) {
        forbidden.set(variable, `nu e permisă când FINET_ROLE=${knownRole}`);
      }
    }
  }
  const secrets = knownRole
    ? resolveSecretFiles(env, { forbidden, read: options.readSecret })
    : { env, fromFile: new Set<string>(), issues: [] };

  // Doar cheile cunoscute; șirul gol înseamnă „nesetat”.
  const input: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = secrets.env[key];
    if (value !== undefined && value !== "") input[key] = value;
  }

  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError([
      ...secrets.issues,
      ...parsed.error.issues.map((issue) => {
        const variable = String(issue.path[0] ?? "(necunoscută)");
        // O valoare citită din fișier se raportează sub numele variabilei `_FILE`.
        return {
          variable: secrets.fromFile.has(variable) ? `${variable}_FILE` : variable,
          problem: describeIssue(issue),
        };
      }),
    ]);
  }

  const e = parsed.data;
  const issues: ConfigIssue[] = [...secrets.issues];
  const need = (variable: keyof RawEnv, when: string): void => {
    if (e[variable] === undefined) issues.push({ variable, problem: `obligatorie ${when}` });
  };

  const nodeEnv: NodeEnv = e.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  // Baza de date pe rol (decizia mea: regula se aplică în orice NODE_ENV, nu doar în producție,
  // ca dezvoltarea să nu ascundă un mediu amestecat). `web` poate rula fără `DATABASE_URL` în
  // Faza 0; `worker` și `migrate` nu au sens fără URL-ul lor.
  const role: Role = e.FINET_ROLE ?? "web";
  const databaseVariable = ROLE_DATABASE_VARIABLE[role];
  for (const variable of DATABASE_VARIABLES) {
    if (variable !== databaseVariable && e[variable] !== undefined) {
      issues.push({ variable, problem: `nu e permisă când FINET_ROLE=${role}` });
    }
  }
  if (role !== "web") need(databaseVariable, `când FINET_ROLE=${role}`);

  // Cloudflare Access: implicit obligatoriu în producție; dezactivarea în producție e refuzată.
  const accessRequired = e.CF_ACCESS_REQUIRED ? e.CF_ACCESS_REQUIRED === "true" : isProduction;
  if (isProduction && !accessRequired) {
    issues.push({
      variable: "CF_ACCESS_REQUIRED",
      problem: "nu poate fi `false` când NODE_ENV=production",
    });
  }
  // Doar rolul `web` servește HTTP și verifică JWT-ul Access (decizia mea): workerul și migrarea
  // nu primesc CF_ACCESS_* în fișierele lor de mediu.
  if (accessRequired && role === "web") {
    need("CF_ACCESS_TEAM_DOMAIN", "când CF_ACCESS_REQUIRED=true");
    need("CF_ACCESS_AUD", "când CF_ACCESS_REQUIRED=true");
  }

  // Storage (migrarea nu atinge fișierele, deci nu are nevoie de STORAGE_DIR).
  const driver = e.STORAGE_DRIVER ?? "local";
  if (isProduction && role !== "migrate") need("STORAGE_DIR", "în producție");
  if (driver === "s3") {
    for (const v of [
      "STORAGE_S3_ENDPOINT",
      "STORAGE_S3_REGION",
      "STORAGE_S3_BUCKET",
      "STORAGE_S3_ACCESS_KEY_ID",
      "STORAGE_S3_SECRET_ACCESS_KEY",
    ] as const) {
      need(v, "când STORAGE_DRIVER=s3");
    }
  }

  // Bugetul AI: sumă, deci prin `parseAmount` (bigint în unități minore, niciodată float).
  const budgetCurrency = e.AI_MONTHLY_BUDGET_CURRENCY ?? DEFAULTS.aiMonthlyBudgetCurrency;
  let monthlyBudget: Money | null = null;
  try {
    monthlyBudget = parseAmount(e.AI_MONTHLY_BUDGET ?? DEFAULTS.aiMonthlyBudget, budgetCurrency);
  } catch {
    issues.push({ variable: "AI_MONTHLY_BUDGET", problem: "nu e o sumă validă" });
  }

  // Notificări: Telegram cere ambele variabile; SMTP cere gazda și expeditorul.
  if ((e.NOTIFY_TELEGRAM_BOT_TOKEN === undefined) !== (e.NOTIFY_TELEGRAM_CHAT_ID === undefined)) {
    issues.push({
      variable: "NOTIFY_TELEGRAM_BOT_TOKEN/NOTIFY_TELEGRAM_CHAT_ID",
      problem: "se setează împreună",
    });
  }
  if (e.SMTP_HOST !== undefined) need("SMTP_FROM", "când SMTP_HOST e setat");
  const smtpPort = e.SMTP_PORT ? Number.parseInt(e.SMTP_PORT, 10) : DEFAULTS.smtpPort;
  if (smtpPort < 1 || smtpPort > 65535) {
    issues.push({ variable: "SMTP_PORT", problem: "în afara intervalului 1–65535" });
  }

  if (issues.length > 0 || monthlyBudget === null) throw new ConfigError(issues);

  const int = (v: string | undefined, fallback: number): number =>
    v === undefined ? fallback : Number.parseInt(v, 10);

  return Object.freeze({
    nodeEnv,
    role,
    appMode: e.APP_MODE,
    appName: e.NEXT_PUBLIC_APP_NAME ?? DEFAULTS.appName,
    appUrl: e.APP_URL ?? null,
    database: Object.freeze({ url: e[databaseVariable] ?? null }),
    storage: Object.freeze({
      driver,
      dir: e.STORAGE_DIR ?? DEFAULTS.storageDir,
      quotaMb: int(e.STORAGE_QUOTA_MB, DEFAULTS.storageQuotaMb),
      s3:
        driver === "s3"
          ? Object.freeze({
              endpoint: e.STORAGE_S3_ENDPOINT!,
              region: e.STORAGE_S3_REGION!,
              bucket: e.STORAGE_S3_BUCKET!,
              accessKeyId: e.STORAGE_S3_ACCESS_KEY_ID!,
              secretAccessKey: e.STORAGE_S3_SECRET_ACCESS_KEY!,
            })
          : null,
    }),
    access: Object.freeze({
      required: accessRequired,
      teamDomain: e.CF_ACCESS_TEAM_DOMAIN ?? null,
      aud: e.CF_ACCESS_AUD ?? null,
    }),
    healthToken: e.HEALTH_TOKEN ?? null,
    ai: Object.freeze({
      dailyDocumentLimit: int(e.AI_DAILY_DOCUMENT_LIMIT, DEFAULTS.aiDailyDocumentLimit),
      monthlyBudget,
    }),
    notify: Object.freeze({
      telegram:
        e.NOTIFY_TELEGRAM_BOT_TOKEN && e.NOTIFY_TELEGRAM_CHAT_ID
          ? Object.freeze({
              botToken: e.NOTIFY_TELEGRAM_BOT_TOKEN,
              chatId: e.NOTIFY_TELEGRAM_CHAT_ID,
            })
          : null,
      smtp: e.SMTP_HOST
        ? Object.freeze({
            host: e.SMTP_HOST,
            port: smtpPort,
            user: e.SMTP_USER ?? null,
            password: e.SMTP_PASSWORD ?? null,
            from: e.SMTP_FROM!,
          })
        : null,
    }),
  });
}

let cached: Config | null = null;

/**
 * Configurația procesului curent. `process.env` se citește o singură dată, la primul apel
 * (la pornire, din `src/instrumentation.ts`); apelurile următoare întorc aceeași valoare.
 */
export function getConfig(): Config {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Doar pentru teste: uită configurația memorată. */
export function resetConfigForTests(): void {
  cached = null;
}
