import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { createdAt, finet, updatedAt } from "./finet";

/**
 * Tabelele stratului de autentificare (Better Auth 1.7, master prompt 6.1 `users` + tabelele de
 * sesiune și cont). Câmpurile urmează schema de bază Better Auth (`user`, `session`, `account`,
 * `verification`, `rateLimit` cu `rateLimit.storage = "database"`); cheile obiectelor de mai jos
 * sunt numele de câmpuri Better Auth (camelCase), coloanele sunt snake_case.
 *
 * Numele tabelelor diferă de cele implicite Better Auth (decizia mea, ADR 0003): `users` (cerut
 * de 6.1) și prefixul `auth_` pentru celelalte, pentru că `accounts` e rezervat conturilor
 * financiare din Faza 2. Adaptorul Drizzle primește maparea explicit (`authSchema` din
 * `src/db/schema/index.ts`), iar ID-urile sunt `uuid` generate de bază
 * (`advanced.database.generateId: "uuid"` în configurația Better Auth, F1-B).
 *
 * Fără RLS (nu au `household_id`): le accesează doar serverul, ca `finet_app` (fără BYPASSRLS,
 * fără Data API). Vezi ADR 0003, „Tabelele de autentificare”.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const USER_STATUSES = ["active", "disabled"] as const;

export const users = finet.table(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // Normalizat: litere mici, fără spații la capete (CHECK); unicitatea e pe lower(email).
    email: text("email").notNull(),
    // Better Auth cere un boolean (`emailVerified`); 6.1 cerea `email_verified_at` — abatere
    // notată în ADR 0003.
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    status: text("status", { enum: USER_STATUSES }).notNull().default("active"),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    check("users_email_normalized", sql`${t.email} = lower(btrim(${t.email}))`),
    check("users_email_format", sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`),
    check("users_email_length", sql`char_length(${t.email}) <= 254`),
    check("users_name_length", sql`char_length(${t.name}) between 1 and 100`),
    check("users_status_valid", sql`${t.status} in ('active', 'disabled')`),
  ],
);

export const authSessions = finet.table(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique("auth_sessions_token_key"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_sessions_user_id_idx").on(t.userId)],
);

export const authAccounts = finet.table(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    // Hash-ul parolei (Argon2id, F1-B); niciodată parola în clar.
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("auth_accounts_user_id_idx").on(t.userId),
    // Un cont de furnizor aparține unui singur utilizator.
    uniqueIndex("auth_accounts_provider_account_key").on(t.providerId, t.accountId),
  ],
);

export const authVerifications = finet.table(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

/** Contoarele de rate limiting ale Better Auth (`rateLimit.storage = "database"`). */
export const authRateLimits = finet.table("auth_rate_limits", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull().unique("auth_rate_limits_key_key"),
  count: integer("count").notNull(),
  // Milisecunde Unix (Better Auth: `number`, `bigint: true`).
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
