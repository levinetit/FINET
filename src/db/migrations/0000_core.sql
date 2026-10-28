-- FINET 0000_core (Faza 1): tabelele nucleu în schema `finet`: autentificarea (Better Auth:
-- users, auth_sessions, auth_accounts, auth_verifications, auth_rate_limits), gospodăriile
-- (households, household_members), user_preferences, consents și audit_events.
-- Generată de `drizzle-kit generate --name core` din src/db/schema/; editată de mână o singură
-- dată, înainte de prima aplicare: scos `CREATE SCHEMA "finet"` (schema există deja, creată de
-- operator cu ops/supabase/roles.sql și deținută de finet_migrator, care NU are dreptul CREATE
-- pe bază). RLS, funcțiile și drepturile sunt în 0001_rls.sql.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE datele din aceste tabele):
--   drop table finet.audit_events, finet.consents, finet.user_preferences,
--     finet.household_members, finet.households, finet.auth_rate_limits,
--     finet.auth_verifications, finet.auth_accounts, finet.auth_sessions, finet.users;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0000_core>';
CREATE TABLE "finet"."auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finet"."auth_rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_key_key" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "finet"."auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	CONSTRAINT "auth_sessions_token_key" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "finet"."auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finet"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_normalized" CHECK ("finet"."users"."email" = lower(btrim("finet"."users"."email"))),
	CONSTRAINT "users_email_format" CHECK ("finet"."users"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "users_email_length" CHECK (char_length("finet"."users"."email") <= 254),
	CONSTRAINT "users_name_length" CHECK (char_length("finet"."users"."name") between 1 and 100),
	CONSTRAINT "users_status_valid" CHECK ("finet"."users"."status" in ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "finet"."household_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_household_user_key" UNIQUE("household_id","user_id"),
	CONSTRAINT "household_members_role_valid" CHECK ("finet"."household_members"."role" in ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "finet"."households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"default_currency" text DEFAULT 'RON' NOT NULL,
	"timezone" text DEFAULT 'Europe/Bucharest' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "households_name_length" CHECK (char_length("finet"."households"."name") between 1 and 100),
	CONSTRAINT "households_currency_valid" CHECK ("finet"."households"."default_currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "households_timezone_length" CHECK (char_length("finet"."households"."timezone") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "finet"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_action_format" CHECK ("finet"."audit_events"."action" ~ '^[a-z][a-z0-9_.]{1,63}$'),
	CONSTRAINT "audit_events_target_type_format" CHECK ("finet"."audit_events"."target_type" is null or "finet"."audit_events"."target_type" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "audit_events_metadata_small_object" CHECK (jsonb_typeof("finet"."audit_events"."metadata") = 'object' and pg_column_size("finet"."audit_events"."metadata") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "finet"."consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "consents_kind_valid" CHECK ("finet"."consents"."kind" in ('external_ai', 'external_ai_statements', 'usage_stats')),
	CONSTRAINT "consents_revoked_after_granted" CHECK ("finet"."consents"."revoked_at" is null or "finet"."consents"."revoked_at" >= "finet"."consents"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "finet"."user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"locale" text DEFAULT 'ro-RO' NOT NULL,
	"timezone" text DEFAULT 'Europe/Bucharest' NOT NULL,
	"default_currency" text DEFAULT 'RON' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_locale_format" CHECK ("finet"."user_preferences"."locale" ~ '^[a-z]{2}-[A-Z]{2}$'),
	CONSTRAINT "user_preferences_timezone_length" CHECK (char_length("finet"."user_preferences"."timezone") between 1 and 64),
	CONSTRAINT "user_preferences_currency_valid" CHECK ("finet"."user_preferences"."default_currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "user_preferences_theme_valid" CHECK ("finet"."user_preferences"."theme" in ('system', 'light', 'dark'))
);
--> statement-breakpoint
ALTER TABLE "finet"."auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."household_members" ADD CONSTRAINT "household_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."households" ADD CONSTRAINT "households_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."audit_events" ADD CONSTRAINT "audit_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "finet"."auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_key" ON "finet"."auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "finet"."auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "finet"."auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "finet"."users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "household_members_user_id_idx" ON "finet"."household_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "households_created_by_idx" ON "finet"."households" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "audit_events_household_created_idx" ON "finet"."audit_events" USING btree ("household_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "consents_user_kind_active_key" ON "finet"."consents" USING btree ("user_id","kind") WHERE "finet"."consents"."revoked_at" is null;
