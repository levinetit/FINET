import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { type Db, withRlsOn } from "@/db";
import type { Config } from "@/lib/config";
import { parseRefCode, redeemReferral } from "@/modules/referrals/referrals.service";

import { currentHouseholdIdOf, insertAudit } from "./audit";
import {
  type Mailer,
  existingAccountMessage,
  sendInBackground,
  verifyEmailMessage,
} from "./mailer";
import {
  PASSWORD_PROBLEM_MESSAGES,
  type PasswordProblem,
  checkPasswordPolicy,
  hashPassword,
} from "./password";
import { emailSchema } from "./request";
import { createUserWithHousehold } from "./users.service";
import { findUserByEmail, findUserById, markEmailVerified, setPasswordHash } from "./users.repo";

/**
 * Înregistrarea publică (Faza 11-C, ADR 0029), doar `saas`. Doi pași, ca parola să o aleagă
 * PROPRIETARUL adresei, nu cel care a completat formularul (altfel cineva ar putea crea un cont pe
 * adresa altuia, cu parola lui, iar confirmarea de către proprietar i-ar da acces):
 *
 * 1. `registerAccount`: email + nume + acceptarea termenilor. Creează utilizatorul NEVERIFICAT, fără
 *    parolă (gospodăria personală, preferințele), apoi trimite linkul de confirmare. Răspunsul e
 *    același dacă adresa există sau nu; pentru o adresă cu cont verificat se trimite un mesaj
 *    „ai deja un cont”.
 * 2. `completeRegistration`: linkul semnat + parola aleasă. Verifică emailul și setează parola
 *    în aceeași tranzacție, o singură dată (condiția `email_verified = false`).
 *
 * `firstUserBecomesAdmin` e fixat pe `false`: un străin nu poate deveni administrator al platformei.
 */

export const VERIFY_TOKEN_TTL_SECONDS = 48 * 60 * 60;
const TOKEN_PURPOSE = "finet.register.v1";

export const registerInputSchema = z
  .object({
    email: emailSchema,
    name: z.string().trim().min(1).max(100),
    acceptTerms: z.literal(true),
    /** Tokenul widgetului Turnstile; obligatoriu doar când Turnstile e configurat (ADR 0030). */
    turnstileToken: z.string().min(1).max(2048).optional(),
  })
  .strict();

export const completeInputSchema = z
  .object({ token: z.string().min(20).max(600), password: z.string().min(1).max(1000) })
  .strict();

type Payload = Readonly<{ u: string; e: string; x: number; r?: string }>;

const b64 = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${TOKEN_PURPOSE}:${payload}`).digest();
}

/** Token semnat (HMAC-SHA256 cu secretul aplicației), cu utilizatorul, emailul și expirarea. */
export function signRegistrationToken(
  secret: string,
  userId: string,
  email: string,
  nowMs: number,
  referral?: string,
): string {
  const payload: Payload = {
    u: userId,
    e: email,
    x: Math.floor(nowMs / 1000) + VERIFY_TOKEN_TTL_SECONDS,
    // Codul de recomandare (12-C) rămâne în tokenul semnat: linkul poate fi deschis pe alt
    // dispozitiv, unde cookie-ul `finet_ref` nu există.
    ...(referral ? { r: referral } : {}),
  };
  const body = b64(JSON.stringify(payload));
  return `${body}.${b64(mac(secret, body))}`;
}

/** `null` pentru orice token invalid, modificat sau expirat (fără a spune care). */
export function readRegistrationToken(
  secret: string,
  token: string,
  nowMs: number,
): Payload | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = mac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<Payload>;
    if (
      typeof value.u !== "string" ||
      typeof value.e !== "string" ||
      typeof value.x !== "number" ||
      value.x < Math.floor(nowMs / 1000)
    ) {
      return null;
    }
    const r = typeof value.r === "string" ? parseRefCode(value.r) : null;
    return { u: value.u, e: value.e, x: value.x, ...(r ? { r } : {}) };
  } catch {
    return null;
  }
}

export type RegistrationDeps = Readonly<{
  db: Db;
  config: Config;
  mailer: Mailer;
  now?: () => number;
}>;

/** Pasul 1. Nu întoarce nimic despre existența adresei. */
export async function registerAccount(
  deps: RegistrationDeps,
  input: z.infer<typeof registerInputSchema>,
  /** Codul de recomandare din cookie-ul `finet_ref` (deja validat ca formă), dacă există. */
  referral?: string,
): Promise<void> {
  const { db, config, mailer } = deps;
  const secret = config.auth.secret;
  if (!secret) throw new Error("BETTER_AUTH_SECRET lipsește");
  const now = deps.now ?? Date.now;
  const baseUrl = new URL(config.appUrl ?? "http://localhost:3000").origin;

  const result = await createUserWithHousehold(db, {
    email: input.email,
    name: input.name,
    password: null,
    firstUserBecomesAdmin: false,
    emailVerified: false,
  });
  // Cererea nu așteaptă SMTP (aceeași formă de răspuns, același timp, indiferent de adresă).
  sendInBackground(mailer, async () => {
    if (result.created) {
      const token = signRegistrationToken(secret, result.userId, input.email, now(), referral);
      return verifyEmailMessage(
        config.appName,
        input.email,
        `${baseUrl}/register/complete?token=${encodeURIComponent(token)}`,
        VERIFY_TOKEN_TTL_SECONDS / 3600,
      );
    }
    const existing = await findUserByEmail(db, input.email);
    if (!existing || existing.status !== "active") return null;
    if (!existing.emailVerified) {
      // Înregistrare neterminată: aceeași adresă primește un link nou.
      const token = signRegistrationToken(secret, existing.id, input.email, now(), referral);
      return verifyEmailMessage(
        config.appName,
        input.email,
        `${baseUrl}/register/complete?token=${encodeURIComponent(token)}`,
        VERIFY_TOKEN_TTL_SECONDS / 3600,
      );
    }
    return existingAccountMessage(config.appName, input.email, `${baseUrl}/login`);
  });
}

export type CompleteResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "invalid_token" | "password"; message: string }>;

const INVALID_LINK = "Linkul de confirmare nu este valid sau a expirat. Cere o înregistrare nouă.";

/** Pasul 2. Parola se verifică înainte de a consuma linkul (o parolă respinsă nu îl arde). */
export async function completeRegistration(
  deps: RegistrationDeps,
  input: z.infer<typeof completeInputSchema>,
): Promise<CompleteResult> {
  const { db, config } = deps;
  const secret = config.auth.secret;
  if (!secret) throw new Error("BETTER_AUTH_SECRET lipsește");
  const now = deps.now ?? Date.now;

  const claims = readRegistrationToken(secret, input.token, now());
  if (!claims) return { ok: false, reason: "invalid_token", message: INVALID_LINK };
  const user = await findUserById(db, claims.u);
  if (!user || user.email !== claims.e || user.status !== "active" || user.emailVerified) {
    return { ok: false, reason: "invalid_token", message: INVALID_LINK };
  }
  const problem: PasswordProblem | null = await checkPasswordPolicy(input.password, {
    hibpEnabled: config.auth.hibpEnabled,
  });
  if (problem)
    return { ok: false, reason: "password", message: PASSWORD_PROBLEM_MESSAGES[problem] };

  const passwordHash = await hashPassword(input.password);
  const done = await withRlsOn(db, { userId: user.id }, async (tx) => {
    if (!(await markEmailVerified(tx, user.id))) return false;
    await setPasswordHash(tx, user.id, passwordHash);
    const householdId = await currentHouseholdIdOf(tx, user.id);
    if (householdId) {
      await insertAudit(tx, user.id, householdId, {
        action: "user.email_verified",
        targetType: "user",
        targetId: user.id,
        metadata: { via: "registration" },
      });
    }
    return true;
  });
  if (!done) return { ok: false, reason: "invalid_token", message: INVALID_LINK };
  // Recomandarea (12-C): regulile sunt în baza de date; o eroare aici nu strică niciodată
  // înregistrarea (contul e deja confirmat).
  if (claims.r) {
    try {
      await redeemReferral(db, user.id, claims.r);
    } catch {
      console.error("[register] recomandarea nu a putut fi aplicată");
    }
  }
  return { ok: true };
}
