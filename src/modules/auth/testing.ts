import type postgres from "postgres";

import { type Db, createDb } from "@/db";
import { runMigrations } from "@/db/migrate";
import {
  MIGRATIONS_DIR,
  type ScratchDatabase,
  createScratchDatabase,
  testClient,
} from "@/db/testing";
import { type Config, parseConfig } from "@/lib/config";

import { type FinetAuth, createAuth } from "./auth";
import { handleAuthRequest } from "./handler";
import type { MailMessage, Mailer } from "./mailer";

/**
 * Doar pentru testele de integrare ale autentificării: o bază nouă (migrată), clientul
 * aplicației ca `finet_app`, configurația de test, Better Auth și un mailer fals (fără rețea).
 * Nu se importă din codul aplicației.
 */

export const APP_URL = "http://localhost:3000";
/** Secret FICTIV, doar pentru teste. */
export const TEST_AUTH_SECRET = "secret-de-test-finet-0123456789-abcdefghij";

export function testConfig(extra: Record<string, string> = {}): Config {
  return parseConfig({
    APP_MODE: "personal",
    NODE_ENV: "test",
    APP_URL,
    BETTER_AUTH_SECRET: TEST_AUTH_SECRET,
    ...extra,
  });
}

export type FakeMailer = Mailer & { sent: MailMessage[] };

export function fakeMailer(): FakeMailer {
  const sent: MailMessage[] = [];
  return { sent, send: async (m) => void sent.push(m) };
}

export type AuthFixture = Readonly<{
  scratch: ScratchDatabase;
  db: Db;
  client: postgres.Sql;
  close: () => Promise<void>;
}>;

export async function createAuthFixture(prefix: string): Promise<AuthFixture> {
  const scratch = await createScratchDatabase(prefix);
  const migrator = testClient(scratch.migratorUrl, 1);
  try {
    await runMigrations(migrator, { folder: MIGRATIONS_DIR });
  } finally {
    await migrator.end({ timeout: 5 });
  }
  const app = createDb(scratch.appUrl, { ca: null, applicationName: "finet-test", max: 3 });
  return {
    scratch,
    db: app.db,
    client: app.client,
    close: async () => {
      await app.client.end({ timeout: 5 });
      await scratch.drop();
    },
  };
}

export type AuthEnv = Readonly<{
  auth: FinetAuth;
  db: Db;
  config: Config;
  mailer: FakeMailer | null;
  now?: () => number;
}>;

export function authEnv(
  db: Db,
  options: { config?: Config; mailer?: FakeMailer | null; now?: () => number } = {},
): AuthEnv {
  const config = options.config ?? testConfig();
  const mailer = options.mailer === undefined ? fakeMailer() : options.mailer;
  return { auth: createAuth({ db, config, mailer }), db, config, mailer, now: options.now };
}

export function authRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  return new Request(`${APP_URL}${path}`, {
    method,
    headers: {
      origin: APP_URL,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Cookie-urile setate de un răspuns, ca antet `Cookie` (doar perechile nume=valoare). */
export function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";", 1)[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export type LoginResult = Readonly<{ response: Response; cookie: string; bearer: string | null }>;

export async function login(
  env: AuthEnv,
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<LoginResult> {
  const response = await handleAuthRequest(
    authRequest("/api/auth/sign-in/email", { body: { email, password }, headers }),
    env,
  );
  return {
    response,
    cookie: cookieHeader(response),
    bearer: response.headers.get("set-auth-token"),
  };
}
