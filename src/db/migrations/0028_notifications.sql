-- FINET 0028_notifications (modernizare 2026, pasul J; ADR 0048): notificări în aplicație și
-- preferințele lor. DDL-ul generat de drizzle-kit (din `src/db/schema/notifications.ts`) vine
-- primul; după el sunt scrise de mână RLS-ul, drepturile și funcția `finet.notification_targets`.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Nu modifică tabelele existente. Notificările sunt pe UTILIZATOR (destinatar) și gospodărie:
-- un utilizator vede doar rândurile lui; workerul le scrie sub contextul RLS al destinatarului
-- (ca la recurențe), nu ca superuser. `dedup_key` unic pe utilizator împiedică repetarea.
--
-- Rollback (manual, de operator, cu backup; pierde notificările și preferințele):
--   drop function finet.notification_targets(integer);
--   drop table finet.notifications, finet.notification_preferences;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0028_notifications>';
CREATE TABLE "finet"."notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"in_app" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"kinds" text[] DEFAULT array['payment_due', 'budget_warning', 'budget_exceeded', 'unusual_spending', 'goal_reminder', 'subscription_renewal', 'monthly_summary', 'sync_failure']::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_kinds_valid" CHECK ("finet"."notification_preferences"."kinds" <@ array['payment_due', 'budget_warning', 'budget_exceeded', 'unusual_spending', 'goal_reminder', 'subscription_renewal', 'monthly_summary', 'sync_failure']::text[]),
	CONSTRAINT "notification_preferences_kinds_count" CHECK (cardinality("finet"."notification_preferences"."kinds") <= 8)
);
--> statement-breakpoint
CREATE TABLE "finet"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"emailed_at" timestamp with time zone,
	CONSTRAINT "notifications_user_dedup_key" UNIQUE("user_id","dedup_key"),
	CONSTRAINT "notifications_kind_valid" CHECK ("finet"."notifications"."kind" in ('payment_due', 'budget_warning', 'budget_exceeded', 'unusual_spending', 'goal_reminder', 'subscription_renewal', 'monthly_summary', 'sync_failure')),
	CONSTRAINT "notifications_title_length" CHECK (char_length("finet"."notifications"."title") between 1 and 200),
	CONSTRAINT "notifications_body_length" CHECK (char_length("finet"."notifications"."body") between 1 and 2000),
	CONSTRAINT "notifications_link_shape" CHECK ("finet"."notifications"."link" is null or "finet"."notifications"."link" ~ '^/[a-z0-9/?=&._-]{0,200}$'),
	CONSTRAINT "notifications_dedup_key_length" CHECK (char_length("finet"."notifications"."dedup_key") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "finet"."notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."notifications" ADD CONSTRAINT "notifications_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "finet"."notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_household_idx" ON "finet"."notifications" USING btree ("household_id");
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS (ENABLE + FORCE): doar rândurile proprii, în gospodăria curentă (membru).
alter table finet.notifications enable row level security;
--> statement-breakpoint
alter table finet.notifications force row level security;
--> statement-breakpoint
create policy notifications_own on finet.notifications
  for all to finet_app
  using (user_id = (select finet.current_user_id())
         and household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null)
  with check (user_id = (select finet.current_user_id())
         and household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
revoke all on finet.notifications from public;
--> statement-breakpoint
grant select, insert, delete on finet.notifications to finet_app;
--> statement-breakpoint
-- Doar marcajele se schimbă (citită, trimisă pe email); conținutul nu.
grant update (read_at, emailed_at) on finet.notifications to finet_app;
--> statement-breakpoint
alter table finet.notification_preferences enable row level security;
--> statement-breakpoint
alter table finet.notification_preferences force row level security;
--> statement-breakpoint
create policy notification_preferences_own on finet.notification_preferences
  for all to finet_app
  using (user_id = (select finet.current_user_id()))
  with check (user_id = (select finet.current_user_id()));
--> statement-breakpoint
revoke all on finet.notification_preferences from public;
--> statement-breakpoint
grant select, insert, delete on finet.notification_preferences to finet_app;
--> statement-breakpoint
grant update (in_app, email, kinds, updated_at) on finet.notification_preferences to finet_app;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Destinatarii evaluării zilnice: (gospodărie, membru activ), DOAR id-uri, ca `due_recurring_rules`
-- (0006/0012). Workerul rulează apoi evaluarea în contextul RLS al fiecărui membru, deci vede
-- exact ce vede membrul în aplicație (conturile personale ale altora rămân invizibile).
create function finet.notification_targets(p_limit integer)
  returns table (household_id uuid, user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select m.household_id, m.user_id
      from finet.household_members m
      join finet.users u on u.id = m.user_id and u.status = 'active'
     order by m.household_id, m.joined_at, m.user_id
     limit least(greatest(coalesce(p_limit, 0), 0), 100000)
  $$;
--> statement-breakpoint
revoke all on function finet.notification_targets(integer) from public;
--> statement-breakpoint
grant execute on function finet.notification_targets(integer) to finet_app;
