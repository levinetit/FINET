import "server-only";

import { z } from "zod";

import { VERIFYING_SSL_MODES, databaseTlsParams, isTlsUrlParam } from "@/lib/db-url";
import { CURRENCIES, parseAmount, type Money } from "@/lib/money";
import { SecretFileError, readSmallFile, resolveSecretFiles } from "@/lib/secret-files";

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
 * - `migrate`: rularea migrațiilor (Faza 1+), doar `MIGRATOR_DATABASE_URL`;
 * - `admin`: CLI-ul de administrare (`dist/tools/admin.mjs`, F1-B), cu drepturile aplicației
 *   (`DATABASE_URL`, rolul Postgres `finet_app`), fără server HTTP (decizia mea, ADR 0003).
 * URL-urile celorlalte roluri, dacă apar în mediu, opresc pornirea: un proces compromis nu
 * trebuie să aibă la îndemână drepturile altui rol (de exemplu proprietarul schemei).
 */
export type Role = "web" | "worker" | "migrate" | "admin";
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

/** Limitele documentelor încărcate (Faza 6, master prompt 6.3; ADR 0013). */
export type DocumentsConfig = Readonly<{
  /** Dimensiunea maximă a unui fișier (`MAX_UPLOAD_MB`, implicit 10), în octeți. */
  maxUploadBytes: number;
  /** Fișiere pe cerere (fix: 4, cât un bon lung). */
  maxFilesPerRequest: number;
  /** Pagini maxime pe PDF (`MAX_PDF_PAGES`, implicit 6). */
  maxPdfPages: number;
  /** Pixeli maximi pe imagine (`MAX_IMAGE_PIXELS`): apărarea contra „bombelor” de decompresie. */
  maxImagePixels: number;
  /** Zile până la ștergerea fișierului original (`RECEIPT_IMAGE_RETENTION_DAYS`; 0 = niciodată). */
  retentionDays: number;
  /** Distanța Hamming maximă între dHash-uri pentru „posibil duplicat” (0..32). */
  duplicateMaxDistance: number;
}>;

export type AccessConfig = Readonly<{
  /** Dacă `true`, orice cerere fără JWT Cloudflare Access valid primește 403. */
  required: boolean;
  /** Domeniul echipei Zero Trust (`<echipa>.cloudflareaccess.com`), fără schemă. */
  teamDomain: string | null;
  /** Audiența (AUD tag) aplicației Access. */
  aud: string | null;
}>;

/**
 * Furnizorul AI (Faza 6, F6-B; master prompt 3.6; ADR 0014): LiteLLM-ul de pe gazdă, compatibil
 * OpenAI. Alias-urile modelelor stau în configurația LiteLLM, nu în cod.
 */
export type AiConfig = Readonly<{
  /** Documente procesate cu AI pe zi, per gospodărie. */
  dailyDocumentLimit: number;
  /** Bugetul lunar global pentru furnizorii AI externi (0 = fără AI extern). */
  monthlyBudget: Money;
  /** `AI_BASE_URL` (de exemplu `http://172.88.88.4:4000/v1`); `null` = AI neconfigurat. */
  baseUrl: string | null;
  /** `AI_ALLOWED_HOSTS`: gazdele (`host` sau `host:port`) permise pentru `AI_BASE_URL`. */
  allowedHosts: readonly string[];
  /** Cheia virtuală LiteLLM, DOAR din `AI_API_KEY_FILE` și doar pentru `FINET_ROLE=worker`. */
  apiKey: string | null;
  /** `AI_VISION_MODEL` (implicit `finet-vision-external`). */
  visionModel: string;
  /** `AI_TEXT_MODEL` (implicit `finet-text-external`). */
  textModel: string;
  /** Termenul unei încercări (`AI_TIMEOUT_MS`, implicit 60 000). */
  timeoutMs: number;
  /** Reîncercări după prima încercare (`AI_MAX_RETRIES`, 0..3, implicit 2). */
  maxRetries: number;
  /** Sub acest scor (0..100), bonul trece „De verificat” (`AI_CONFIDENCE_THRESHOLD`, implicit 80). */
  confidenceThreshold: number;
  /** `AI_RESPONSE_FORMAT`: `json_schema` (implicit), `json_object` sau `none`. */
  responseFormat: "json_schema" | "json_object" | "none";
  /** Tarifele pentru estimarea costului, în unități minore ale monedei bugetului per 1M tokeni. */
  pricing: Readonly<{ inputPerMTokMinor: bigint; outputPerMTokMinor: bigint }>;
}>;

export type RateLimitRule = Readonly<{ max: number; windowSeconds: number }>;

export type AuthConfig = Readonly<{
  /**
   * Secretul Better Auth (`BETTER_AUTH_SECRET`, minimum 32 de caractere): semnează cookie-urile
   * și tokenurile bearer. `null` doar în afara producției (atunci autentificarea nu pornește).
   */
  secret: string | null;
  /** Verificarea parolelor compromise prin HIBP (k-anonymity). Implicit oprită. */
  hibpEnabled: boolean;
  rateLimits: Readonly<{
    /** Login-ul web (parolă), pe IP + email normalizat. */
    login: RateLimitRule;
    /** Login-ul din aplicația mobilă (`X-FINET-Client: android/...`), limite proprii. */
    mobileLogin: RateLimitRule;
    /**
     * Plafonul pe email SINGUR (fără IP), aplicat în plus față de `login`/`mobileLogin` (M2):
     * oprește încercările distribuite pe multe IP-uri.
     */
    loginEmail: RateLimitRule;
    /** Emailurile trimise (magic link, resetarea parolei), pe IP + email. */
    email: RateLimitRule;
    /** Schimbarea parolei (cere parola curentă), pe utilizator + IP. */
    passwordChange: RateLimitRule;
  }>;
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
    /**
     * Conținutul PEM al CA-ului bazei de date (`DATABASE_CA_FILE`, de exemplu CA-ul Supabase),
     * citit o singură dată la pornire; `null` dacă variabila nu e setată. Folosit de
     * `src/lib/db-client.ts` cu `sslmode=verify-full`.
     */
    ca: string | null;
    /**
     * `FINET_ALLOW_INSECURE_DB=1` (doar dezvoltare/teste, refuzat în producție): workerul acceptă
     * o conexiune fără `sslmode=verify-full` + CA (Postgres-ul efemer din CI). Altfel `false`.
     */
    allowInsecure: boolean;
  }>;
  storage: StorageConfig;
  documents: DocumentsConfig;
  access: AccessConfig;
  /** Token intern opțional pentru `/api/health` detaliat fără JWT Access (monitorizare). */
  healthToken: string | null;
  auth: AuthConfig;
  ai: AiConfig;
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
const positiveInt = z
  .string()
  .regex(/^[1-9]\d{0,8}$/)
  .optional();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  FINET_ROLE: z.enum(["web", "worker", "migrate", "admin"]).optional(),
  APP_MODE: z.enum(["personal", "saas"]),
  APP_URL: z.url({ protocol: /^https?$/ }).optional(),
  NEXT_PUBLIC_APP_NAME: z.string().min(1).max(40).optional(),

  DATABASE_URL: postgresUrl,
  WORKER_DATABASE_URL: postgresUrl,
  MIGRATOR_DATABASE_URL: postgresUrl,
  // Calea către CA-ul bazei (nu e secret: certificatul e public).
  DATABASE_CA_FILE: optionalString,

  STORAGE_DRIVER: z.enum(["local", "s3"]).optional(),
  STORAGE_DIR: optionalString,
  STORAGE_QUOTA_MB: nonNegativeInt,
  STORAGE_S3_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
  STORAGE_S3_REGION: optionalString,
  STORAGE_S3_BUCKET: optionalString,
  STORAGE_S3_ACCESS_KEY_ID: optionalString,
  STORAGE_S3_SECRET_ACCESS_KEY: optionalString,

  CF_ACCESS_REQUIRED: boolString,
  // Doar dezvoltare/teste: workerul fără TLS verificat (refuzat în producție; ADR 0011).
  FINET_ALLOW_INSECURE_DB: z.enum(["1"]).optional(),
  CF_ACCESS_TEAM_DOMAIN: z.string().regex(HOSTNAME).optional(),
  CF_ACCESS_AUD: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/)
    .optional(),
  HEALTH_TOKEN: z.string().min(32).max(512).optional(),

  BETTER_AUTH_SECRET: z.string().min(32).max(512).optional(),
  AUTH_HIBP_ENABLED: boolString,
  AUTH_LOGIN_MAX_ATTEMPTS: positiveInt,
  AUTH_LOGIN_WINDOW_SECONDS: positiveInt,
  AUTH_MOBILE_LOGIN_MAX_ATTEMPTS: positiveInt,
  AUTH_MOBILE_LOGIN_WINDOW_SECONDS: positiveInt,
  AUTH_EMAIL_MAX_REQUESTS: positiveInt,
  AUTH_EMAIL_WINDOW_SECONDS: positiveInt,
  AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS: positiveInt,
  AUTH_PASSWORD_CHANGE_WINDOW_SECONDS: positiveInt,
  AUTH_LOGIN_EMAIL_MAX_ATTEMPTS: positiveInt,
  AUTH_LOGIN_EMAIL_WINDOW_SECONDS: positiveInt,

  MAX_UPLOAD_MB: z
    .string()
    .regex(/^[1-9]\d{0,2}$/)
    .optional(),
  MAX_PDF_PAGES: z
    .string()
    .regex(/^[1-9]\d{0,1}$/)
    .optional(),
  MAX_IMAGE_PIXELS: positiveInt,
  RECEIPT_IMAGE_RETENTION_DAYS: z
    .string()
    .regex(/^\d{1,5}$/)
    .optional(),
  DOCUMENT_DUPLICATE_MAX_DISTANCE: z
    .string()
    .regex(/^\d{1,2}$/)
    .optional(),

  AI_DAILY_DOCUMENT_LIMIT: nonNegativeInt,
  AI_MONTHLY_BUDGET: z.string().max(40).optional(),
  AI_MONTHLY_BUDGET_CURRENCY: z.enum(CURRENCIES).optional(),
  AI_BASE_URL: z
    .url({ protocol: /^https?$/ })
    .max(300)
    .optional(),
  AI_ALLOWED_HOSTS: z
    .string()
    .max(1000)
    .regex(/^[a-z0-9.:\-]+(?:,[a-z0-9.:\-]+)*$/)
    .optional(),
  AI_API_KEY: z
    .string()
    .min(8)
    .max(512)
    .regex(/^[\x21-\x7e]+$/)
    .optional(),
  AI_VISION_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._:/-]{0,99}$/)
    .optional(),
  AI_TEXT_MODEL: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._:/-]{0,99}$/)
    .optional(),
  AI_TIMEOUT_MS: z
    .string()
    .regex(/^[1-9]\d{2,5}$/)
    .optional(),
  AI_MAX_RETRIES: z
    .string()
    .regex(/^[0-3]$/)
    .optional(),
  AI_CONFIDENCE_THRESHOLD: z
    .string()
    .regex(/^(?:100|[1-9]?\d)$/)
    .optional(),
  AI_RESPONSE_FORMAT: z.enum(["json_schema", "json_object", "none"]).optional(),
  AI_PRICE_INPUT_PER_MTOK: z.string().max(40).optional(),
  AI_PRICE_OUTPUT_PER_MTOK: z.string().max(40).optional(),

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
  admin: "DATABASE_URL",
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
  // Documentele (Faza 6; decizia mea, ADR 0013).
  maxUploadMb: 10,
  maxFilesPerRequest: 4,
  maxPdfPages: 6,
  // 50 MP: peste orice cameră de telefon obișnuită (48 MP), sub o „bombă” de decompresie.
  maxImagePixels: 50_000_000,
  retentionDays: 180,
  duplicateMaxDistance: 6,
  // 0 = fără furnizori AI externi până când operatorul alege altfel (Faza 6).
  aiMonthlyBudget: "0",
  aiMonthlyBudgetCurrency: "USD",
  // Furnizorul AI (F6-B, ADR 0014): LiteLLM-ul de pe gazdă, pe rețeaua `apps`.
  aiAllowedHosts: "172.88.88.4:4000",
  aiVisionModel: "finet-vision-external",
  aiTextModel: "finet-text-external",
  aiTimeoutMs: 60_000,
  aiMaxRetries: 2,
  aiConfidenceThreshold: 80,
  // Tarife pesimiste (decizia mea), în moneda bugetului per 1M tokeni; operatorul le ajustează.
  aiPriceInputPerMTok: "0.50",
  aiPriceOutputPerMTok: "3.00",
  smtpPort: 587,
  // Limitele de autentificare (decizia mea, ADR 0003): încercări pe fereastră.
  loginMax: 5,
  loginWindowSeconds: 15 * 60,
  mobileLoginMax: 10,
  mobileLoginWindowSeconds: 15 * 60,
  emailMax: 3,
  emailWindowSeconds: 60 * 60,
  passwordChangeMax: 5,
  passwordChangeWindowSeconds: 15 * 60,
  loginEmailMax: 20,
  loginEmailWindowSeconds: 60 * 60,
} as const;

/**
 * Valorile de exemplu din `.env.example` (intenționat invalide) nu trec drept secret real.
 * Verificarea e pe forme cunoscute, nu pe entropie.
 */
const PLACEHOLDER_SECRET = /^invalid|inlocuieste|schimba|exemplu|changeme|placeholder/i;

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

const ROLES: readonly Role[] = ["web", "worker", "migrate", "admin"];
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
    // Cheia AI (F6-B): doar workerul apelează furnizorul; celelalte roluri nu deschid fișierul.
    if (knownRole !== "worker") {
      forbidden.set("AI_API_KEY", `nu e permisă când FINET_ROLE=${knownRole}`);
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

  // TLS spre bază (decizia mea): `sslrootcert` din URL nu e citit de postgres.js, ci trimis
  // serverului ca parametru de conexiune, care refuză conexiunea; CA-ul vine din
  // DATABASE_CA_FILE. Un CA setat fără `sslmode=verify-full`/`verify-ca` ar da o încredere falsă
  // (conexiunea nu l-ar folosi), deci e refuzat.
  const databaseUrl = e[databaseVariable] ?? null;
  const urlVariable = secrets.fromFile.has(databaseVariable)
    ? `${databaseVariable}_FILE`
    : databaseVariable;
  const tls = databaseUrl ? databaseTlsParams(databaseUrl) : null;
  if (tls?.hasSslRootCert) {
    issues.push({
      variable: urlVariable,
      problem: "parametrul sslrootcert nu e suportat; CA-ul se dă prin DATABASE_CA_FILE",
    });
  }
  let databaseCa: string | null = null;
  if (e.DATABASE_CA_FILE !== undefined) {
    if (tls && (tls.sslmode === null || !VERIFYING_SSL_MODES.includes(tls.sslmode))) {
      issues.push({
        variable: "DATABASE_CA_FILE",
        problem: `cere sslmode=verify-full (sau verify-ca) în ${urlVariable}`,
      });
    }
    try {
      databaseCa = readCaFile(e.DATABASE_CA_FILE);
    } catch (error) {
      issues.push({
        variable: "DATABASE_CA_FILE",
        problem: error instanceof SecretFileError ? error.problem : "fișierul nu poate fi citit",
      });
    }
  }

  // Workerul (Faza 5, ADR 0011; revizuirea `security` F5, I2): TLS cu verificare OBLIGATORIU în
  // ORICE mediu, fail-closed. Driverul `pg` al pg-boss tratează `sslmode` altfel decât
  // postgres.js, deci se cere forma unică `sslmode=verify-full` (o singură dată, exact așa
  // scrisă, fără alți parametri TLS) plus CA-ul din DATABASE_CA_FILE. Singura excepție:
  // `FINET_ALLOW_INSECURE_DB=1`, explicit, pentru teste/CI, refuzată în producție.
  const allowInsecure = e.FINET_ALLOW_INSECURE_DB === "1";
  if (allowInsecure && isProduction) {
    issues.push({ variable: "FINET_ALLOW_INSECURE_DB", problem: "nu e permisă în producție" });
  }
  if (role === "worker" && databaseUrl && !allowInsecure) {
    let modes: string[] = [];
    let otherTlsParams = false;
    try {
      const params = new URL(databaseUrl).searchParams;
      modes = params.getAll("sslmode");
      otherTlsParams = [...params.keys()].some((k) => isTlsUrlParam(k) && k !== "sslmode");
    } catch {
      modes = [];
    }
    if (modes.length !== 1 || modes[0] !== "verify-full" || otherTlsParams) {
      issues.push({ variable: urlVariable, problem: "cere exact sslmode=verify-full" });
    }
    need("DATABASE_CA_FILE", "pentru FINET_ROLE=worker (sau FINET_ALLOW_INSECURE_DB=1 în teste)");
  }

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

  // Autentificarea (F1-B): serverul web de producție cere secretul Better Auth și adresa publică
  // HTTPS (cookie-urile `Secure`, `trustedOrigins`). Celelalte roluri nu primesc secretul.
  if (e.BETTER_AUTH_SECRET !== undefined && PLACEHOLDER_SECRET.test(e.BETTER_AUTH_SECRET)) {
    issues.push({
      variable: secrets.fromFile.has("BETTER_AUTH_SECRET")
        ? "BETTER_AUTH_SECRET_FILE"
        : "BETTER_AUTH_SECRET",
      problem: "e valoarea de exemplu; generează una: openssl rand -base64 32",
    });
  }
  if (isProduction && role === "web") {
    need("BETTER_AUTH_SECRET", "în producție");
    need("APP_URL", "în producție");
    if (e.APP_URL !== undefined && !e.APP_URL.startsWith("https://")) {
      issues.push({ variable: "APP_URL", problem: "trebuie să fie https:// în producție" });
    }
  }

  // Storage (migrarea și CLI-ul de administrare nu ating fișierele, deci nu cer STORAGE_DIR).
  const driver = e.STORAGE_DRIVER ?? "local";
  // Workerul citește documentele încărcate (Faza 6; ADR 0013), doar citire.
  if (isProduction && (role === "web" || role === "worker")) need("STORAGE_DIR", "în producție");
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

  // Furnizorul AI (F6-B, ADR 0014). Cheia: DOAR din fișier (`AI_API_KEY_FILE`, secretul Docker
  // `finet_litellm_key`) și doar în rolul worker; valoarea în clar în mediu e refuzată.
  if (e.AI_API_KEY !== undefined) {
    if (!secrets.fromFile.has("AI_API_KEY")) {
      issues.push({ variable: "AI_API_KEY", problem: "se dă doar prin AI_API_KEY_FILE" });
    } else if (role !== "worker") {
      issues.push({ variable: "AI_API_KEY_FILE", problem: `nu e permisă când FINET_ROLE=${role}` });
    }
  }
  const aiAllowedHosts = (e.AI_ALLOWED_HOSTS ?? DEFAULTS.aiAllowedHosts).split(",");
  if (e.AI_BASE_URL !== undefined) {
    let host: string | null = null;
    try {
      const u = new URL(e.AI_BASE_URL);
      if (u.username === "" && u.password === "" && u.search === "" && u.hash === "") {
        host = u.host.toLowerCase();
      }
    } catch {
      host = null;
    }
    if (host === null || !aiAllowedHosts.includes(host)) {
      issues.push({ variable: "AI_BASE_URL", problem: "gazda nu e în AI_ALLOWED_HOSTS" });
    }
  }
  const pricing: { inputPerMTokMinor: bigint; outputPerMTokMinor: bigint } = {
    inputPerMTokMinor: 0n,
    outputPerMTokMinor: 0n,
  };
  for (const [variable, key, fallback] of [
    ["AI_PRICE_INPUT_PER_MTOK", "inputPerMTokMinor", DEFAULTS.aiPriceInputPerMTok],
    ["AI_PRICE_OUTPUT_PER_MTOK", "outputPerMTokMinor", DEFAULTS.aiPriceOutputPerMTok],
  ] as const) {
    try {
      pricing[key] = parseAmount(e[variable] ?? fallback, budgetCurrency).amountMinor;
    } catch {
      issues.push({ variable, problem: "nu e o sumă validă" });
    }
  }
  const aiTimeoutMs = e.AI_TIMEOUT_MS ? Number.parseInt(e.AI_TIMEOUT_MS, 10) : DEFAULTS.aiTimeoutMs;
  if (aiTimeoutMs < 1000 || aiTimeoutMs > 300_000) {
    issues.push({ variable: "AI_TIMEOUT_MS", problem: "în afara intervalului 1000–300000" });
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

  const maxPdfPages = e.MAX_PDF_PAGES ? Number.parseInt(e.MAX_PDF_PAGES, 10) : DEFAULTS.maxPdfPages;
  if (maxPdfPages > 50) issues.push({ variable: "MAX_PDF_PAGES", problem: "maximum 50" });
  const maxUploadMb = e.MAX_UPLOAD_MB ? Number.parseInt(e.MAX_UPLOAD_MB, 10) : DEFAULTS.maxUploadMb;
  if (maxUploadMb > 50) issues.push({ variable: "MAX_UPLOAD_MB", problem: "maximum 50" });
  const duplicateMaxDistance = e.DOCUMENT_DUPLICATE_MAX_DISTANCE
    ? Number.parseInt(e.DOCUMENT_DUPLICATE_MAX_DISTANCE, 10)
    : DEFAULTS.duplicateMaxDistance;
  if (duplicateMaxDistance > 32) {
    issues.push({ variable: "DOCUMENT_DUPLICATE_MAX_DISTANCE", problem: "maximum 32" });
  }
  const maxImagePixels = e.MAX_IMAGE_PIXELS
    ? Number.parseInt(e.MAX_IMAGE_PIXELS, 10)
    : DEFAULTS.maxImagePixels;
  if (maxImagePixels < 1_000_000 || maxImagePixels > 200_000_000) {
    issues.push({
      variable: "MAX_IMAGE_PIXELS",
      problem: "în afara intervalului 1000000–200000000",
    });
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
    database: Object.freeze({
      url: databaseUrl,
      ca: databaseCa,
      allowInsecure: allowInsecure && !isProduction,
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
    documents: Object.freeze({
      maxUploadBytes: maxUploadMb * 1024 * 1024,
      maxFilesPerRequest: DEFAULTS.maxFilesPerRequest,
      maxPdfPages,
      maxImagePixels,
      retentionDays: int(e.RECEIPT_IMAGE_RETENTION_DAYS, DEFAULTS.retentionDays),
      duplicateMaxDistance,
    }),
    access: Object.freeze({
      required: accessRequired,
      teamDomain: e.CF_ACCESS_TEAM_DOMAIN ?? null,
      aud: e.CF_ACCESS_AUD ?? null,
    }),
    healthToken: e.HEALTH_TOKEN ?? null,
    auth: Object.freeze({
      secret: e.BETTER_AUTH_SECRET ?? null,
      hibpEnabled: e.AUTH_HIBP_ENABLED === "true",
      rateLimits: Object.freeze({
        login: Object.freeze({
          max: int(e.AUTH_LOGIN_MAX_ATTEMPTS, DEFAULTS.loginMax),
          windowSeconds: int(e.AUTH_LOGIN_WINDOW_SECONDS, DEFAULTS.loginWindowSeconds),
        }),
        mobileLogin: Object.freeze({
          max: int(e.AUTH_MOBILE_LOGIN_MAX_ATTEMPTS, DEFAULTS.mobileLoginMax),
          windowSeconds: int(e.AUTH_MOBILE_LOGIN_WINDOW_SECONDS, DEFAULTS.mobileLoginWindowSeconds),
        }),
        email: Object.freeze({
          max: int(e.AUTH_EMAIL_MAX_REQUESTS, DEFAULTS.emailMax),
          windowSeconds: int(e.AUTH_EMAIL_WINDOW_SECONDS, DEFAULTS.emailWindowSeconds),
        }),
        loginEmail: Object.freeze({
          max: int(e.AUTH_LOGIN_EMAIL_MAX_ATTEMPTS, DEFAULTS.loginEmailMax),
          windowSeconds: int(e.AUTH_LOGIN_EMAIL_WINDOW_SECONDS, DEFAULTS.loginEmailWindowSeconds),
        }),
        passwordChange: Object.freeze({
          max: int(e.AUTH_PASSWORD_CHANGE_MAX_ATTEMPTS, DEFAULTS.passwordChangeMax),
          windowSeconds: int(
            e.AUTH_PASSWORD_CHANGE_WINDOW_SECONDS,
            DEFAULTS.passwordChangeWindowSeconds,
          ),
        }),
      }),
    }),
    ai: Object.freeze({
      dailyDocumentLimit: int(e.AI_DAILY_DOCUMENT_LIMIT, DEFAULTS.aiDailyDocumentLimit),
      monthlyBudget,
      baseUrl: e.AI_BASE_URL ?? null,
      allowedHosts: Object.freeze(aiAllowedHosts),
      apiKey: role === "worker" ? (e.AI_API_KEY ?? null) : null,
      visionModel: e.AI_VISION_MODEL ?? DEFAULTS.aiVisionModel,
      textModel: e.AI_TEXT_MODEL ?? DEFAULTS.aiTextModel,
      timeoutMs: aiTimeoutMs,
      maxRetries: int(e.AI_MAX_RETRIES, DEFAULTS.aiMaxRetries),
      confidenceThreshold: int(e.AI_CONFIDENCE_THRESHOLD, DEFAULTS.aiConfidenceThreshold),
      responseFormat: e.AI_RESPONSE_FORMAT ?? "json_schema",
      pricing: Object.freeze(pricing),
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

/** Un pachet de certificate CA încape lejer; limita doar oprește un fișier greșit. */
export const CA_FILE_MAX_BYTES = 65536;

/** Citește CA-ul (PEM) și verifică doar că pare un certificat; validarea reală o face TLS. */
function readCaFile(path: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(readSmallFile(path, CA_FILE_MAX_BYTES));
  } catch (error) {
    if (error instanceof SecretFileError) throw error;
    throw new SecretFileError("conținutul nu e text UTF-8");
  }
  if (!text.includes("-----BEGIN CERTIFICATE-----")) {
    throw new SecretFileError("nu conține un certificat PEM (-----BEGIN CERTIFICATE-----)");
  }
  return text;
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
