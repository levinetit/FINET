-- FINET 0020_admin_feedback (Faza 11-B, ADR 0028): feedback și rapoarte de bug-uri din aplicație,
-- anunțuri de la administrator, monitorizarea internă a erorilor și funcțiile panoului de
-- administrare. Prima parte (până la „PARTEA SCRISĂ DE MÂNĂ”) e generată de `drizzle-kit generate`
-- din src/db/schema/admin.ts (fișier redenumit în 0020, `when` fixat în jurnal la 1795200000000,
-- peste 0019). A doua parte e scrisă o singură dată, înainte de prima aplicare.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Principii: NICIO dată financiară nu intră în aceste tabele și nicio funcție de administrare nu le
-- citește (utilizatori: id, email, nume, stare; gospodării: id, nume, număr de membri; cozi: nume,
-- stare, contor). Administratorul platformei (`users.is_platform_admin` și `status = 'active'`) e
-- singurul care citește feedback-ul altora, scrie anunțuri și vede erorile; verificarea o face
-- `finet.is_platform_admin()`, în fiecare politică și în fiecare funcție.
--
-- Rollback (manual, de operator, cu backup; pierde feedback-ul, anunțurile și erorile):
--   drop function finet.admin_set_user_status(uuid, text), finet.admin_jobs(),
--     finet.admin_households(integer, integer), finet.admin_users(integer, integer),
--     finet.record_app_error(text, text, text, text, text), finet.is_platform_admin();
--   drop table finet.app_errors, finet.announcements, finet.feedback;
CREATE TABLE "finet"."announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcements_level_valid" CHECK ("finet"."announcements"."level" in ('info', 'warn')),
	CONSTRAINT "announcements_title_length" CHECK (char_length("finet"."announcements"."title") >= 1 and char_length("finet"."announcements"."title") <= 100 and "finet"."announcements"."title" = btrim("finet"."announcements"."title")),
	CONSTRAINT "announcements_body_length" CHECK (char_length("finet"."announcements"."body") >= 1 and char_length("finet"."announcements"."body") <= 500),
	CONSTRAINT "announcements_period" CHECK ("finet"."announcements"."ends_at" is null or "finet"."announcements"."ends_at" > "finet"."announcements"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "finet"."app_errors" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"route" text NOT NULL,
	"code" text NOT NULL,
	"digest" text,
	"app_version" text,
	"occurrences" bigint DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recent_burst" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_errors_kind_valid" CHECK ("finet"."app_errors"."kind" in ('client', 'server')),
	CONSTRAINT "app_errors_fingerprint_length" CHECK (char_length("finet"."app_errors"."fingerprint") <= 200),
	CONSTRAINT "app_errors_route_shape" CHECK (char_length("finet"."app_errors"."route") <= 200 and "finet"."app_errors"."route" ~ '^/[A-Za-z0-9/_\[\]-]*$'),
	CONSTRAINT "app_errors_code_shape" CHECK ("finet"."app_errors"."code" ~ '^[A-Za-z0-9_.:-]{1,60}$'),
	CONSTRAINT "app_errors_digest_shape" CHECK ("finet"."app_errors"."digest" is null or "finet"."app_errors"."digest" ~ '^[A-Za-z0-9_-]{1,40}$'),
	CONSTRAINT "app_errors_app_version_length" CHECK ("finet"."app_errors"."app_version" is null or char_length("finet"."app_errors"."app_version") <= 40),
	CONSTRAINT "app_errors_occurrences_positive" CHECK ("finet"."app_errors"."occurrences" >= 1)
);
--> statement-breakpoint
CREATE TABLE "finet"."feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"page" text,
	"app_version" text,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_kind_valid" CHECK ("finet"."feedback"."kind" in ('feedback', 'bug')),
	CONSTRAINT "feedback_status_valid" CHECK ("finet"."feedback"."status" in ('new', 'seen', 'closed')),
	CONSTRAINT "feedback_message_length" CHECK (char_length("finet"."feedback"."message") >= 3 and char_length("finet"."feedback"."message") <= 2000),
	CONSTRAINT "feedback_page_shape" CHECK ("finet"."feedback"."page" is null or (char_length("finet"."feedback"."page") <= 200 and "finet"."feedback"."page" ~ '^/[A-Za-z0-9/_\[\]-]*$')),
	CONSTRAINT "feedback_app_version_length" CHECK ("finet"."feedback"."app_version" is null or char_length("finet"."feedback"."app_version") <= 40)
);
--> statement-breakpoint
ALTER TABLE "finet"."announcements" ADD CONSTRAINT "announcements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcements_active_idx" ON "finet"."announcements" USING btree ("archived","starts_at");--> statement-breakpoint
CREATE INDEX "announcements_created_by_user_id_idx" ON "finet"."announcements" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "app_errors_last_seen_idx" ON "finet"."app_errors" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "feedback_status_created_idx" ON "finet"."feedback" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_user_id_idx" ON "finet"."feedback" USING btree ("user_id");
--> statement-breakpoint
-- ==============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- ==============================================================================================

-- Administratorul platformei (activ), pentru politicile de mai jos. SECURITY DEFINER ca să nu
-- depindă de drepturile apelantului; doar identificatori, `search_path` fix.
create function finet.is_platform_admin() returns boolean
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select exists (
      select 1 from finet.users u
       where u.id = finet.current_user_id() and u.is_platform_admin and u.status = 'active')
  $$;
--> statement-breakpoint
revoke all on function finet.is_platform_admin() from public;
--> statement-breakpoint
grant execute on function finet.is_platform_admin() to finet_app;
--> statement-breakpoint

-- feedback: autorul își vede rândurile, administratorul pe toate; scrie doar autorul propriile rânduri;
-- doar administratorul schimbă starea.
alter table finet.feedback enable row level security;
--> statement-breakpoint
alter table finet.feedback force row level security;
--> statement-breakpoint
create policy feedback_select on finet.feedback
  for select to finet_app
  using (user_id = (select finet.current_user_id()) or (select finet.is_platform_admin()));
--> statement-breakpoint
create policy feedback_insert on finet.feedback
  for insert to finet_app
  with check (user_id = (select finet.current_user_id()) and status = 'new');
--> statement-breakpoint
create policy feedback_update on finet.feedback
  for update to finet_app
  using ((select finet.is_platform_admin()))
  with check ((select finet.is_platform_admin()));
--> statement-breakpoint
revoke all on finet.feedback from public;
--> statement-breakpoint
grant select on finet.feedback to finet_app;
--> statement-breakpoint
-- Drizzle trimite și coloanele cu valoare implicită (`DEFAULT`), deci și ele au drept de INSERT;
-- politica cere `status = 'new'`, deci autorul nu poate alege altă stare.
grant insert (id, user_id, kind, message, page, app_version, status, created_at, updated_at)
  on finet.feedback to finet_app;
--> statement-breakpoint
grant update (status, updated_at) on finet.feedback to finet_app;
--> statement-breakpoint

-- announcements: orice utilizator autentificat vede anunțurile active; administratorul vede și scrie
-- pe toate.
alter table finet.announcements enable row level security;
--> statement-breakpoint
alter table finet.announcements force row level security;
--> statement-breakpoint
create policy announcements_select_active on finet.announcements
  for select to finet_app
  using ((select finet.current_user_id()) is not null
         and not archived
         and starts_at <= now()
         and (ends_at is null or ends_at > now()));
--> statement-breakpoint
create policy announcements_select_admin on finet.announcements
  for select to finet_app
  using ((select finet.is_platform_admin()));
--> statement-breakpoint
create policy announcements_insert on finet.announcements
  for insert to finet_app
  with check ((select finet.is_platform_admin())
              and created_by_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy announcements_update on finet.announcements
  for update to finet_app
  using ((select finet.is_platform_admin()))
  with check ((select finet.is_platform_admin()));
--> statement-breakpoint
revoke all on finet.announcements from public;
--> statement-breakpoint
grant select on finet.announcements to finet_app;
--> statement-breakpoint
grant insert (id, title, body, level, starts_at, ends_at, archived, created_by_user_id, created_at)
  on finet.announcements to finet_app;
--> statement-breakpoint
grant update (title, body, level, starts_at, ends_at, archived) on finet.announcements to finet_app;
--> statement-breakpoint

-- app_errors: citit doar de administrator; scris doar prin `record_app_error` (SECURITY DEFINER,
-- cu variabila `finet.definer_scope` = 'app_error', singura care deschide politicile
-- finet_migrator de mai jos).
alter table finet.app_errors enable row level security;
--> statement-breakpoint
alter table finet.app_errors force row level security;
--> statement-breakpoint
create policy app_errors_select on finet.app_errors
  for select to finet_app
  using ((select finet.is_platform_admin()));
--> statement-breakpoint
create policy app_errors_migrator_select on finet.app_errors
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'app_error');
--> statement-breakpoint
create policy app_errors_migrator_insert on finet.app_errors
  for insert to finet_migrator
  with check (current_setting('finet.definer_scope', true) = 'app_error');
--> statement-breakpoint
create policy app_errors_migrator_update on finet.app_errors
  for update to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'app_error')
  with check (current_setting('finet.definer_scope', true) = 'app_error');
--> statement-breakpoint
revoke all on finet.app_errors from public;
--> statement-breakpoint
grant select on finet.app_errors to finet_app;
--> statement-breakpoint

-- Înregistrează o eroare (oricine, inclusiv fără sesiune: erorile paginilor publice contează). Nu
-- aruncă niciodată pentru date invalide (raportarea nu trebuie să strice nimic): valorile care nu
-- respectă formele se ignoră. Plafon: cel mult 500 de erori distincte; peste el, doar contoarele
-- celor existente cresc.
create function finet.record_app_error(
  p_kind text, p_route text, p_code text, p_digest text, p_version text
) returns void
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_fp text;
  begin
    if p_kind is null or p_kind not in ('client', 'server')
       or p_route is null or p_route !~ '^/[A-Za-z0-9/_\[\]-]{0,199}$'
       or p_code is null or p_code !~ '^[A-Za-z0-9_.:-]{1,60}$'
       or (p_digest is not null and p_digest !~ '^[A-Za-z0-9_-]{1,40}$')
       or (p_version is not null and pg_catalog.char_length(p_version) > 40) then
      return;
    end if;
    v_fp := pg_catalog.left(
      p_kind || ':' || p_route || ':' || p_code || ':' || coalesce(p_digest, '-'), 200);
    perform set_config('finet.definer_scope', 'app_error', true);
    if exists (select 1 from finet.app_errors e where e.fingerprint = v_fp) then
      update finet.app_errors
         set occurrences = occurrences + 1,
             last_seen_at = pg_catalog.now(),
             updated_at = pg_catalog.now(),
             app_version = coalesce(p_version, app_version)
       where fingerprint = v_fp;
    elsif (select pg_catalog.count(*) from finet.app_errors) < 500 then
      insert into finet.app_errors (fingerprint, kind, route, code, digest, app_version)
      values (v_fp, p_kind, p_route, p_code, p_digest, p_version);
    end if;
    perform set_config('finet.definer_scope', '', true);
  end
  $$;
--> statement-breakpoint
revoke all on function finet.record_app_error(text, text, text, text, text) from public;
--> statement-breakpoint
grant execute on function finet.record_app_error(text, text, text, text, text) to finet_app;
--> statement-breakpoint

-- Listele panoului de administrare: DOAR administratorul (42501 altfel), doar coloane
-- nefinanciare, pagini de cel mult 200 de rânduri.
create function finet.admin_users(p_limit integer, p_offset integer)
  returns table (
    id uuid, email text, name text, status text, is_platform_admin boolean,
    created_at timestamptz, households integer)
  language plpgsql stable security definer
  set search_path = pg_catalog
  as $$
  begin
    if not finet.is_platform_admin() then
      raise exception 'admin_users: doar administratorul platformei' using errcode = '42501';
    end if;
    return query
      select u.id, u.email, u.name, u.status, u.is_platform_admin, u.created_at,
             (select pg_catalog.count(*)::integer from finet.household_members m
               where m.user_id = u.id)
        from finet.users u
       order by u.created_at, u.id
       limit (case when p_limit < 1 then 1 when p_limit > 200 then 200 else p_limit end)
       offset (case when p_offset < 0 then 0 else p_offset end);
  end
  $$;
--> statement-breakpoint
revoke all on function finet.admin_users(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.admin_users(integer, integer) to finet_app;
--> statement-breakpoint

create function finet.admin_households(p_limit integer, p_offset integer)
  returns table (id uuid, name text, members integer, created_at timestamptz)
  language plpgsql stable security definer
  set search_path = pg_catalog
  as $$
  begin
    if not finet.is_platform_admin() then
      raise exception 'admin_households: doar administratorul platformei' using errcode = '42501';
    end if;
    return query
      select h.id, h.name,
             (select pg_catalog.count(*)::integer from finet.household_members m
               where m.household_id = h.id),
             h.created_at
        from finet.households h
       order by h.created_at, h.id
       limit (case when p_limit < 1 then 1 when p_limit > 200 then 200 else p_limit end)
       offset (case when p_offset < 0 then 0 else p_offset end);
  end
  $$;
--> statement-breakpoint
revoke all on function finet.admin_households(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.admin_households(integer, integer) to finet_app;
--> statement-breakpoint

-- Cozile de lucru (pg-boss): doar numele, starea și contorul, fără conținutul joburilor.
create function finet.admin_jobs()
  returns table (name text, state text, jobs bigint)
  language plpgsql stable security definer
  set search_path = pg_catalog
  as $$
  begin
    if not finet.is_platform_admin() then
      raise exception 'admin_jobs: doar administratorul platformei' using errcode = '42501';
    end if;
    return query
      select j.name::text, j.state::text, pg_catalog.count(*)
        from pgboss.job j
       group by j.name, j.state
       order by j.name, j.state;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.admin_jobs() from public;
--> statement-breakpoint
grant execute on function finet.admin_jobs() to finet_app;
--> statement-breakpoint

-- Activează sau dezactivează un cont (un cont dezactivat nu mai are sesiune validă). Nu poate fi
-- apelată asupra propriului cont. Întoarce `true` dacă s-a schimbat un rând.
create function finet.admin_set_user_status(p_user uuid, p_status text) returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_changed integer;
  begin
    if not finet.is_platform_admin() then
      raise exception 'admin_set_user_status: doar administratorul platformei' using errcode = '42501';
    end if;
    if p_status is null or p_status not in ('active', 'disabled') then
      raise exception 'admin_set_user_status: stare nevalidă' using errcode = '22023';
    end if;
    if p_user is null or p_user = finet.current_user_id() then
      raise exception 'admin_set_user_status: nu îți poți schimba propriul cont' using errcode = '22023';
    end if;
    update finet.users set status = p_status, updated_at = pg_catalog.now() where id = p_user;
    get diagnostics v_changed = row_count;
    return v_changed = 1;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.admin_set_user_status(uuid, text) from public;
--> statement-breakpoint
grant execute on function finet.admin_set_user_status(uuid, text) to finet_app;
