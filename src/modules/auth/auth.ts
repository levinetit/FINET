import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins/bearer";
import { magicLink } from "better-auth/plugins/magic-link";

import { type Db, getDb } from "@/db";
import { authSchema } from "@/db/schema";
import { type Config, getConfig } from "@/lib/config";

import { recordAudit } from "./audit";
import {
  type Mailer,
  createMailer,
  magicLinkMessage,
  resetPasswordMessage,
  sendInBackground,
} from "./mailer";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  hasArgon2,
  hashPassword,
  verifyPassword,
} from "./password";
import {
  CLIENT_HEADER,
  CLIENT_IP_HEADER,
  normalizeEmail,
  parseClientHeader,
  sessionUserAgent,
} from "./request";
import { findUserByEmail, findUserById } from "./users.repo";

/**
 * Configurația Better Auth (master prompt 3.2, 6.3; ADR 0003). Doar pe server.
 *
 * - Adaptorul Drizzle pe tabelele FINET (`authSchema`: `users`, `auth_*`), id-uri uuid generate
 *   de bază (`generateId: "uuid"`), schema validată la pornire.
 * - Email + parolă cu Argon2id (`src/modules/auth/password.ts`), minimum 10 caractere.
 *   Înregistrarea publică e oprită (`disableSignUp`; în `personal` ruta răspunde 404, vezi
 *   `handler.ts`); utilizatorii se creează doar din CLI.
 * - Magic link și resetarea prin email DOAR cu SMTP configurat; magic link-ul nu creează conturi
 *   și nu trimite nimic unui email necunoscut (răspunsul e același).
 * - Sesiuni în bază: 30 de zile, prelungite cel mult o dată pe zi; fără cookie cache (revocarea
 *   are efect imediat). Pluginul `bearer` (doar tokenuri semnate) pentru clientul Android.
 * - Rate limiting-ul Better Auth e oprit: îl face `handler.ts`, pe IP de încredere + email, în
 *   `auth_rate_limits` (cheia Better Auth ar fi doar IP + cale).
 */

export const SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
export const MAGIC_LINK_EXPIRES_IN_SECONDS = 10 * 60;
export const RESET_PASSWORD_EXPIRES_IN_SECONDS = 30 * 60;

/**
 * Căile Better Auth închise prin HTTP (404): logica lor există o singură dată, în serviciile
 * FINET de sub `/api/v1/me` (6.4), cu validare, rate limiting și audit proprii; `list-sessions`
 * ar expune tokenurile sesiunilor.
 */
export const DISABLED_AUTH_PATHS = [
  "/sign-up/email",
  "/update-user",
  "/change-email",
  "/change-password",
  "/set-password",
  "/delete-user",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/list-accounts",
  "/unlink-account",
  // M1: căi active implicit, nefolosite de FINET și fără rate limiting propriu.
  "/verify-password",
  "/send-verification-email",
  "/verify-email",
  "/update-session",
  "/link-social",
  "/refresh-token",
  "/get-access-token",
  "/account-info",
  "/sign-in/social",
  "/delete-user/callback",
] as const;

/**
 * M1: lista PERMISĂ a căilor Better Auth expuse prin HTTP (`handler.ts` răspunde 404 la orice
 * altceva, inclusiv la căile adăugate de o versiune nouă Better Auth sau de un plugin). Un test
 * parcurge `auth.api` din instanța reală și verifică regula.
 */
export const ALLOWED_AUTH_PATHS: ReadonlySet<string> = new Set([
  "/get-session",
  "/sign-out",
  "/sign-in/email",
  "/sign-in/magic-link",
  "/magic-link/verify",
  "/request-password-reset",
  "/reset-password",
  "/ok",
  "/error",
]);

/** Căile cu parametru permise (callback-ul linkului de resetare: `/reset-password/<token>`). */
export const ALLOWED_AUTH_PREFIXES: readonly string[] = ["/reset-password/"];

export function isAllowedAuthPath(sub: string): boolean {
  if (ALLOWED_AUTH_PATHS.has(sub)) return true;
  return ALLOWED_AUTH_PREFIXES.some((p) => sub.startsWith(p) && !sub.slice(p.length).includes("/"));
}

/** Mesajul uniform pentru credențiale greșite (același cod ca Better Auth). */
const INVALID_CREDENTIALS = {
  code: "INVALID_EMAIL_OR_PASSWORD",
  message: "Invalid email or password",
} as const;

export type AuthDeps = Readonly<{
  db: Db;
  config: Config;
  /** `null` = fără SMTP (magic link și resetarea prin email dezactivate). */
  mailer: Mailer | null;
}>;

function headersOf(ctx: unknown): Headers | null {
  if (!ctx || typeof ctx !== "object") return null;
  const c = ctx as { headers?: unknown; request?: { headers?: unknown } };
  if (c.headers instanceof Headers) return c.headers;
  if (c.request?.headers instanceof Headers) return c.request.headers;
  return null;
}

function pathOf(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object") return null;
  const p = (ctx as { path?: unknown }).path;
  return typeof p === "string" ? p : null;
}

export function createAuth(deps: AuthDeps) {
  const { db, config, mailer } = deps;
  if (!hasArgon2()) throw new Error("crypto.argon2 lipsește: FINET cere Node.js >= 24.7");
  const secret = config.auth.secret;
  if (!secret) throw new Error("BETTER_AUTH_SECRET lipsește: autentificarea nu poate porni");

  const baseURL = config.appUrl ?? "http://localhost:3000";
  const origin = new URL(baseURL).origin;
  const secure = baseURL.startsWith("https://") || config.nodeEnv === "production";

  const plugins = [
    bearer({ requireSignature: true }),
    ...(mailer
      ? [
          magicLink({
            disableSignUp: true,
            expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
            storeToken: "hashed",
            sendMagicLink: ({ email, url }) => {
              // În fundal (M4): căutarea contului și trimiterea nu întârzie răspunsul. Fără cont
              // activ: nimic de trimis, iar răspunsul rămâne același (fără enumerare).
              sendInBackground(mailer, async () => {
                const user = await findUserByEmail(db, normalizeEmail(email));
                if (!user || user.status !== "active") return null;
                return magicLinkMessage(
                  config.appName,
                  user.email,
                  url,
                  MAGIC_LINK_EXPIRES_IN_SECONDS / 60,
                );
              });
            },
          }),
        ]
      : []),
  ];

  return betterAuth({
    appName: config.appName,
    baseURL,
    basePath: "/api/auth",
    secret,
    trustedOrigins: [origin],
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    telemetry: { enabled: false },
    logger: {
      level: "error",
      // Doar nivelul și mesajul: argumentele pot conține obiecte cu date personale.
      log: (level, message) => console.error(`[auth] ${level}: ${message}`),
    },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    rateLimit: { enabled: false },
    user: {
      additionalFields: {
        status: { type: "string", input: false, required: false, defaultValue: "active" },
        isPlatformAdmin: {
          type: "boolean",
          input: false,
          required: false,
          defaultValue: false,
        },
      },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN_SECONDS,
      ...(mailer
        ? {
            sendResetPassword: async ({ user, url }) => {
              // În fundal (M4): timpul răspunsului nu include trimiterea SMTP.
              sendInBackground(mailer, () =>
                resetPasswordMessage(
                  config.appName,
                  user.email,
                  url,
                  RESET_PASSWORD_EXPIRES_IN_SECONDS / 60,
                ),
              );
            },
            onPasswordReset: async ({ user }) => {
              await recordAudit(db, user.id, {
                action: "auth.password_reset",
                targetType: "user",
                targetId: user.id,
                metadata: { via: "email" },
              });
            },
          }
        : {}),
    },
    advanced: {
      // IP-ul vine DOAR din antetul intern pus de `handler.ts` după verificarea de încredere.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: secure,
      // Explicit (și în teste: Better Auth sare implicit verificarea originii când NODE_ENV=test).
      disableCSRFCheck: false,
      disableOriginCheck: false,
      cookiePrefix: "finet",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
      database: { generateId: "uuid" },
    },
    databaseHooks: {
      user: {
        create: {
          // Nicio cale Better Auth nu creează utilizatori, în niciun mod (doar CLI-ul): înregistrarea
          // publică din `saas` nu e implementată, iar `finet_app` nu poate insera
          // `status`/`is_platform_admin` și nu poate șterge utilizatori (M5), deci nici o
          // compensare după o creare eșuată. Faza `saas` va aduce o funcție de creare dedicată.
          before: async () => false,
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            const user = await findUserById(db, session.userId);
            if (!user || user.status !== "active") {
              throw APIError.from("UNAUTHORIZED", INVALID_CREDENTIALS);
            }
            const headers = headersOf(ctx);
            return {
              data: {
                ...session,
                userAgent: sessionUserAgent(headers, session.userAgent ?? null),
              },
            };
          },
          after: async (session, ctx) => {
            const path = pathOf(ctx);
            const client = parseClientHeader(headersOf(ctx)?.get(CLIENT_HEADER));
            await recordAudit(db, session.userId, {
              action: "auth.login_succeeded",
              targetType: "session",
              targetId: session.id,
              metadata: {
                method: path?.startsWith("/magic-link") ? "magic_link" : "password",
                platform: client ? "android" : "web",
              },
            });
          },
        },
      },
    },
    plugins,
  });
}

export type FinetAuth = ReturnType<typeof createAuth>;

export type AuthRuntime = Readonly<{ auth: FinetAuth; db: Db; config: Config }>;

let runtime: AuthRuntime | null = null;

/** Instanța procesului (rolul `web`), creată leneș la prima cerere. */
export function getAuthRuntime(): AuthRuntime {
  if (runtime) return runtime;
  const config = getConfig();
  const db = getDb();
  runtime = {
    auth: createAuth({
      db,
      config,
      mailer: createMailer(config.notify.smtp, { production: config.nodeEnv === "production" }),
    }),
    db,
    config,
  };
  return runtime;
}
