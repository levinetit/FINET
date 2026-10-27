import "server-only";

import { z } from "zod";

import { CURRENCIES, parseAmount, type Money } from "@/lib/money";

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
 */

// ---------------------------------------------------------------------------------------------
// Tipuri publice
// ---------------------------------------------------------------------------------------------

export type AppMode = "personal" | "saas";
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
  appMode: AppMode;
  appName: string;
  appUrl: string | null;
  database: Readonly<{
    url: string | null;
    workerUrl: string | null;
    migratorUrl: string | null;
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

/**
 * Validează un set de variabile de mediu și construiește configurația. Funcție pură (nu citește
 * `process.env`), folosită de `getConfig()` și de teste.
 */
export function parseConfig(env: Readonly<Record<string, string | undefined>>): Config {
  // Doar cheile cunoscute; șirul gol înseamnă „nesetat”.
  const input: Record<string, string> = {};
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== "") input[key] = value;
  }

  const parsed = envSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        variable: String(issue.path[0] ?? "(necunoscută)"),
        problem: describeIssue(issue),
      })),
    );
  }

  const e = parsed.data;
  const issues: ConfigIssue[] = [];
  const need = (variable: keyof RawEnv, when: string): void => {
    if (e[variable] === undefined) issues.push({ variable, problem: `obligatorie ${when}` });
  };

  const nodeEnv: NodeEnv = e.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  // Cloudflare Access: implicit obligatoriu în producție; dezactivarea în producție e refuzată.
  const accessRequired = e.CF_ACCESS_REQUIRED ? e.CF_ACCESS_REQUIRED === "true" : isProduction;
  if (isProduction && !accessRequired) {
    issues.push({
      variable: "CF_ACCESS_REQUIRED",
      problem: "nu poate fi `false` când NODE_ENV=production",
    });
  }
  if (accessRequired) {
    need("CF_ACCESS_TEAM_DOMAIN", "când CF_ACCESS_REQUIRED=true");
    need("CF_ACCESS_AUD", "când CF_ACCESS_REQUIRED=true");
  }

  // Storage.
  const driver = e.STORAGE_DRIVER ?? "local";
  if (isProduction) need("STORAGE_DIR", "în producție");
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
    appMode: e.APP_MODE,
    appName: e.NEXT_PUBLIC_APP_NAME ?? DEFAULTS.appName,
    appUrl: e.APP_URL ?? null,
    database: Object.freeze({
      url: e.DATABASE_URL ?? null,
      workerUrl: e.WORKER_DATABASE_URL ?? null,
      migratorUrl: e.MIGRATOR_DATABASE_URL ?? null,
    }),
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
