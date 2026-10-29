-- FINET 0017_shopping_lists (Faza 10, F10-A): listele de cumpărături (`shopping_lists`,
-- `shopping_list_items`) și coada pasului opțional cu LLM al comparației listă ↔ bon
-- (`shopping_list_ai_requests`).
-- Prima parte e generată de `drizzle-kit generate --name shopping_lists` din
-- src/db/schema/shopping.ts și documents.ts (`when` din jurnal fixat de mână la 1794900000000,
-- după 0014; 0018 e rezervată Fazei 10-B). A doua parte (după „PARTEA SCRISĂ DE MÂNĂ”) e adăugată
-- o singură dată, înainte de prima aplicare. Deciziile: docs/adr/0022-shopping-lists.md.
-- NU modifica fișierul după aplicare: runner-ul compară hash-ul.
--
-- Efect pe tabelele existente (fără rescrierea datelor):
--   - `receipt_lines`: cheia unică `receipt_lines_id_household_key (id, household_id)`, ținta
--     cheii compuse din `shopping_list_items` (id e deja cheie primară: nu schimbă nimic, doar
--     creează un index). Dacă Faza 10-B are nevoie de aceeași cheie, o reutilizează.
--   - nicio politică, funcție sau trigger existent nu se schimbă.
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE listele de cumpărături și
-- coada AI a comparațiilor):
--   drop function finet.erase_user_shopping_lists(), finet.queued_list_matches(integer, integer),
--     finet.queued_list_match(uuid), finet.shopping_lists_check_cap(),
--     finet.shopping_lists_check_owner_change(), finet.shopping_list_items_check_cap(),
--     finet.shopping_list_items_check_match();
--   drop table finet.shopping_list_ai_requests, finet.shopping_list_items, finet.shopping_lists;
--   alter table finet.receipt_lines drop constraint receipt_lines_id_household_key;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0017_shopping_lists>';
CREATE TABLE "finet"."shopping_list_ai_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"list_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error_code" text,
	"processing_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_list_ai_requests_list_receipt_key" UNIQUE("list_id","receipt_id"),
	CONSTRAINT "shopping_list_ai_requests_status_valid" CHECK ("finet"."shopping_list_ai_requests"."status" in ('queued', 'processing', 'done', 'failed', 'skipped')),
	CONSTRAINT "shopping_list_ai_requests_attempts_range" CHECK ("finet"."shopping_list_ai_requests"."attempts" >= 0 and "finet"."shopping_list_ai_requests"."attempts" <= 3),
	CONSTRAINT "shopping_list_ai_requests_error_code_format" CHECK ("finet"."shopping_list_ai_requests"."error_code" is null or "finet"."shopping_list_ai_requests"."error_code" ~ '^[a-z][a-z0-9_]{1,63}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."shopping_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"quantity" numeric(9, 3) DEFAULT '1' NOT NULL,
	"unit" text,
	"note" text,
	"checked" boolean DEFAULT false NOT NULL,
	"checked_by_user_id" uuid,
	"checked_at" timestamp with time zone,
	"position" integer DEFAULT 0 NOT NULL,
	"matched_receipt_line_id" uuid,
	"match_status" text DEFAULT 'none' NOT NULL,
	"match_score" smallint,
	"match_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_list_items_name_length" CHECK (char_length("finet"."shopping_list_items"."name") >= 1 and char_length("finet"."shopping_list_items"."name") <= 120),
	CONSTRAINT "shopping_list_items_name_trimmed" CHECK ("finet"."shopping_list_items"."name" = btrim("finet"."shopping_list_items"."name")),
	CONSTRAINT "shopping_list_items_normalized_name_length" CHECK (char_length("finet"."shopping_list_items"."normalized_name") >= 1 and char_length("finet"."shopping_list_items"."normalized_name") <= 300),
	CONSTRAINT "shopping_list_items_quantity_range" CHECK ("finet"."shopping_list_items"."quantity" > 0 and "finet"."shopping_list_items"."quantity" < 1000000),
	CONSTRAINT "shopping_list_items_unit_length" CHECK ("finet"."shopping_list_items"."unit" is null or (char_length("finet"."shopping_list_items"."unit") >= 1 and char_length("finet"."shopping_list_items"."unit") <= 20)),
	CONSTRAINT "shopping_list_items_note_length" CHECK ("finet"."shopping_list_items"."note" is null or (char_length("finet"."shopping_list_items"."note") >= 1 and char_length("finet"."shopping_list_items"."note") <= 200)),
	CONSTRAINT "shopping_list_items_position_range" CHECK ("finet"."shopping_list_items"."position" >= 0 and "finet"."shopping_list_items"."position" <= 100000),
	CONSTRAINT "shopping_list_items_checked_shape" CHECK (("finet"."shopping_list_items"."checked_at" is not null) = "finet"."shopping_list_items"."checked"),
	CONSTRAINT "shopping_list_items_match_status_valid" CHECK ("finet"."shopping_list_items"."match_status" in ('none', 'suggested', 'confirmed', 'rejected')),
	CONSTRAINT "shopping_list_items_match_source_valid" CHECK ("finet"."shopping_list_items"."match_source" is null or "finet"."shopping_list_items"."match_source" in ('code', 'learned', 'ai', 'manual')),
	CONSTRAINT "shopping_list_items_match_score_range" CHECK ("finet"."shopping_list_items"."match_score" is null or ("finet"."shopping_list_items"."match_score" >= 0 and "finet"."shopping_list_items"."match_score" <= 100)),
	CONSTRAINT "shopping_list_items_none_shape" CHECK ("finet"."shopping_list_items"."match_status" <> 'none' or ("finet"."shopping_list_items"."matched_receipt_line_id" is null and "finet"."shopping_list_items"."match_score" is null and "finet"."shopping_list_items"."match_source" is null))
);
--> statement-breakpoint
CREATE TABLE "finet"."shopping_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopping_lists_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "shopping_lists_name_length" CHECK (char_length("finet"."shopping_lists"."name") >= 1 and char_length("finet"."shopping_lists"."name") <= 100),
	CONSTRAINT "shopping_lists_name_trimmed" CHECK ("finet"."shopping_lists"."name" = btrim("finet"."shopping_lists"."name")),
	CONSTRAINT "shopping_lists_status_valid" CHECK ("finet"."shopping_lists"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "finet"."shopping_list_ai_requests" ADD CONSTRAINT "shopping_list_ai_requests_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_list_ai_requests" ADD CONSTRAINT "shopping_list_ai_requests_list_fk" FOREIGN KEY ("list_id","household_id") REFERENCES "finet"."shopping_lists"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_list_ai_requests" ADD CONSTRAINT "shopping_list_ai_requests_receipt_fk" FOREIGN KEY ("receipt_id","household_id") REFERENCES "finet"."receipts"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_list_items" ADD CONSTRAINT "shopping_list_items_checked_by_user_id_users_id_fk" FOREIGN KEY ("checked_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_list_items" ADD CONSTRAINT "shopping_list_items_list_fk" FOREIGN KEY ("list_id","household_id") REFERENCES "finet"."shopping_lists"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_lists" ADD CONSTRAINT "shopping_lists_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_lists" ADD CONSTRAINT "shopping_lists_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "finet"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."shopping_lists" ADD CONSTRAINT "shopping_lists_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shopping_list_ai_requests_status_created_idx" ON "finet"."shopping_list_ai_requests" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "shopping_list_ai_requests_household_id_idx" ON "finet"."shopping_list_ai_requests" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "shopping_list_ai_requests_receipt_id_idx" ON "finet"."shopping_list_ai_requests" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "shopping_list_ai_requests_requested_by_idx" ON "finet"."shopping_list_ai_requests" USING btree ("requested_by_user_id");--> statement-breakpoint
CREATE INDEX "shopping_list_items_list_position_idx" ON "finet"."shopping_list_items" USING btree ("list_id","position");--> statement-breakpoint
CREATE INDEX "shopping_list_items_household_id_idx" ON "finet"."shopping_list_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "shopping_list_items_checked_by_idx" ON "finet"."shopping_list_items" USING btree ("checked_by_user_id");--> statement-breakpoint
CREATE INDEX "shopping_list_items_line_idx" ON "finet"."shopping_list_items" USING btree ("matched_receipt_line_id") WHERE "finet"."shopping_list_items"."matched_receipt_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "shopping_list_items_line_key" ON "finet"."shopping_list_items" USING btree ("list_id","matched_receipt_line_id") WHERE "finet"."shopping_list_items"."match_status" = 'suggested' or "finet"."shopping_list_items"."match_status" = 'confirmed';--> statement-breakpoint
CREATE INDEX "shopping_lists_household_status_idx" ON "finet"."shopping_lists" USING btree ("household_id","status");--> statement-breakpoint
CREATE INDEX "shopping_lists_owner_user_id_idx" ON "finet"."shopping_lists" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "shopping_lists_created_by_idx" ON "finet"."shopping_lists" USING btree ("created_by_user_id");--> statement-breakpoint
ALTER TABLE "finet"."receipt_lines" ADD CONSTRAINT "receipt_lines_id_household_key" UNIQUE("id","household_id");
--> statement-breakpoint

-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Linia de bon dispare (bon șters, ștergerea documentului sau a gospodăriei): cheia compusă pune
-- NULL DOAR pe `matched_receipt_line_id` (un `SET NULL` simplu ar goli și `household_id`, NOT
-- NULL). Starea potrivirii rămâne (CHECK-ul `shopping_list_items_none_shape` e cu sens unic, deci
-- nu poate fi încălcat de această acțiune). Precedent: `goals_account_fk`.
alter table finet.shopping_list_items add constraint shopping_list_items_line_fk
  foreign key (matched_receipt_line_id, household_id)
  references finet.receipt_lines (id, household_id)
  on delete set null (matched_receipt_line_id) on update no action;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Plafoane (protejează resursele): cel mult 100 de liste vizibile celui care creează (comune + ale
-- lui) și 300 de articole pe listă. Triggere SECURITY INVOKER (numără sub RLS-ul apelantului;
-- articolele unei liste vizibile sunt toate vizibile), serializate cu un advisory lock (READ
-- COMMITTED: după lock, numărătoarea vede ce au comis cererile concurente). Erorile poartă
-- `CONSTRAINT = <nume>`, mapat de `translateDbError` pe coduri fixe, fără mesajul Postgres.
-- ---------------------------------------------------------------------------------------------
create function finet.shopping_lists_check_cap() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    c_max_lists constant integer := 100;
  begin
    perform pg_advisory_xact_lock(hashtext('finet.shopping_lists:' || new.household_id::text));
    if (select count(*) from finet.shopping_lists l where l.household_id = new.household_id)
       >= c_max_lists then
      raise exception 'shopping_lists: plafonul de % liste a fost atins', c_max_lists
        using errcode = '54000', constraint = 'shopping_lists_cap';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger shopping_lists_check_cap
  before insert on finet.shopping_lists
  for each row execute function finet.shopping_lists_check_cap();
--> statement-breakpoint
create function finet.shopping_list_items_check_cap() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    c_max_items constant integer := 300;
  begin
    perform pg_advisory_xact_lock(hashtext('finet.shopping_items:' || new.list_id::text));
    if (select count(*) from finet.shopping_list_items i where i.list_id = new.list_id)
       >= c_max_items then
      raise exception 'shopping_list_items: plafonul de % articole a fost atins', c_max_items
        using errcode = '54000', constraint = 'shopping_list_items_cap';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger shopping_list_items_check_cap
  before insert on finet.shopping_list_items
  for each row execute function finet.shopping_list_items_check_cap();
--> statement-breakpoint
-- O listă COMUNĂ nu devine personală (ar ascunde de ceilalți tot ce au adăugat) și una personală
-- nu trece la alt membru; personal → comun e permis proprietarului (alegerea lui de a o împărți).
-- RLS (WITH CHECK) mai cere oricum ca proprietarul să fie NULL sau utilizatorul curent.
create function finet.shopping_lists_check_owner_change() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.owner_user_id is not null and new.owner_user_id is distinct from old.owner_user_id then
      raise exception 'shopping_lists: o listă nu devine personală și nu își schimbă proprietarul'
        using errcode = '23514', constraint = 'shopping_lists_owner_change';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger shopping_lists_check_owner_change
  before update of owner_user_id on finet.shopping_lists
  for each row execute function finet.shopping_lists_check_owner_change();
--> statement-breakpoint
-- Linia propusă/confirmată aparține unui bon CONFIRMAT (`saved`) al aceleiași gospodării (cheia
-- compusă garantează gospodăria; aici, starea bonului). Bonul și linia nu se modifică niciodată.
create function finet.shopping_list_items_check_match() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.matched_receipt_line_id is not null
       and not exists (select 1
                         from finet.receipt_lines l
                         join finet.receipts r on r.id = l.receipt_id and r.household_id = l.household_id
                        where l.id = new.matched_receipt_line_id
                          and l.household_id = new.household_id
                          and r.status = 'saved') then
      raise exception 'shopping_list_items: linia nu aparține unui bon confirmat'
        using errcode = '23503', constraint = 'shopping_list_items_line_valid';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger shopping_list_items_check_match
  before insert or update of matched_receipt_line_id on finet.shopping_list_items
  for each row execute function finet.shopping_list_items_check_match();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat pe tabelele noi, în aceeași migrație.
-- ---------------------------------------------------------------------------------------------
alter table finet.shopping_lists enable row level security;
--> statement-breakpoint
alter table finet.shopping_lists force row level security;
--> statement-breakpoint
alter table finet.shopping_list_items enable row level security;
--> statement-breakpoint
alter table finet.shopping_list_items force row level security;
--> statement-breakpoint
alter table finet.shopping_list_ai_requests enable row level security;
--> statement-breakpoint
alter table finet.shopping_list_ai_requests force row level security;
--> statement-breakpoint
-- Listele: o listă cu `owner_user_id` NULL e COMUNĂ (toți membrii), una cu `owner_user_id` = X e
-- PERSONALĂ a lui X (o vede, o schimbă și o șterge DOAR X). Se creează în numele celui conectat,
-- comună sau personală a lui. Articolele și cererile AI moștenesc vizibilitatea listei prin
-- subinterogarea necorelată (evaluată o dată pe interogare, ca la `transactions_household`).
create policy shopping_lists_select on finet.shopping_lists
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())));
--> statement-breakpoint
create policy shopping_lists_insert on finet.shopping_lists
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and created_by_user_id = (select finet.current_user_id())
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())));
--> statement-breakpoint
create policy shopping_lists_update on finet.shopping_lists
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())));
--> statement-breakpoint
create policy shopping_lists_delete on finet.shopping_lists
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())));
--> statement-breakpoint
create policy shopping_list_items_household on finet.shopping_list_items
  for all to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and list_id in (select l.id from finet.shopping_lists l
                          where l.household_id = (select finet.current_household_id())
                            and (l.owner_user_id is null
                                 or l.owner_user_id = (select finet.current_user_id()))))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and list_id in (select l.id from finet.shopping_lists l
                          where l.household_id = (select finet.current_household_id())
                            and (l.owner_user_id is null
                                 or l.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy shopping_list_ai_requests_select on finet.shopping_list_ai_requests
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and list_id in (select l.id from finet.shopping_lists l
                          where l.household_id = (select finet.current_household_id())
                            and (l.owner_user_id is null
                                 or l.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy shopping_list_ai_requests_insert on finet.shopping_list_ai_requests
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and requested_by_user_id = (select finet.current_user_id())
         and list_id in (select l.id from finet.shopping_lists l
                          where l.household_id = (select finet.current_household_id())
                            and (l.owner_user_id is null
                                 or l.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy shopping_list_ai_requests_update on finet.shopping_list_ai_requests
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and list_id in (select l.id from finet.shopping_lists l
                          where l.household_id = (select finet.current_household_id())
                            and (l.owner_user_id is null
                                 or l.owner_user_id = (select finet.current_user_id()))))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and list_id in (select l.id from finet.shopping_lists l
                          where l.household_id = (select finet.current_household_id())
                            and (l.owner_user_id is null
                                 or l.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Coada workerului (model: `queued_statement_uploads`, 0014): doar identificatori. Membrul în
-- numele căruia se lucrează = cel care a cerut comparația, dacă e încă utilizator activ și membru
-- (pentru o listă personală e chiar proprietarul: doar el o vede). Altfel cererea nu se
-- procesează. Se iau cererile `queued` și cele `processing` cu termenul expirat (worker oprit),
-- sub plafonul de încercări. Garduri: `p_limit` 0..100, `p_stale_seconds` cel puțin 60.
-- ---------------------------------------------------------------------------------------------
create policy shopping_list_ai_requests_migrator_pending on finet.shopping_list_ai_requests
  for select to finet_migrator
  using (status = 'queued' or status = 'processing');
--> statement-breakpoint
create function finet.queued_list_matches(p_limit integer, p_stale_seconds integer)
  returns table (request_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select q.id, q.household_id, q.requested_by_user_id
      from finet.shopping_list_ai_requests q
      join finet.household_members m
        on m.household_id = q.household_id and m.user_id = q.requested_by_user_id
      join finet.users u on u.id = m.user_id and u.status = 'active'
     where q.attempts < 3
       and (q.status = 'queued'
            or (q.status = 'processing'
                and (q.processing_started_at is null
                     or q.processing_started_at < pg_catalog.now()
                        - pg_catalog.make_interval(secs => greatest(coalesce(p_stale_seconds, 900), 60)))))
     order by q.created_at, q.id
     limit least(greatest(coalesce(p_limit, 0), 0), 100)
  $$;
--> statement-breakpoint
create function finet.queued_list_match(p_request_id uuid)
  returns table (request_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select q.id, q.household_id, q.requested_by_user_id
      from finet.shopping_list_ai_requests q
      join finet.household_members m
        on m.household_id = q.household_id and m.user_id = q.requested_by_user_id
      join finet.users u on u.id = m.user_id and u.status = 'active'
     where q.id = p_request_id
       and q.attempts < 3
       and (q.status = 'queued' or q.status = 'processing')
  $$;
--> statement-breakpoint
revoke all on function finet.queued_list_matches(integer, integer) from public;
--> statement-breakpoint
revoke all on function finet.queued_list_match(uuid) from public;
--> statement-breakpoint
grant execute on function finet.queued_list_matches(integer, integer) to finet_app;
--> statement-breakpoint
grant execute on function finet.queued_list_match(uuid) to finet_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Ștergerea contului (Faza 9, ADR 0021): listele PERSONALE ale utilizatorului din TOATE
-- gospodăriile (inclusiv cele părăsite, unde nu mai vede nimic), șterse înaintea
-- `erase_current_user()`. Cheia `owner_user_id` e CASCADE, dar rândul `users` poate fi doar
-- anonimizat (e referit de istoricul altora), caz în care cascada nu rulează. Funcția acționează
-- DOAR pentru utilizatorul din context, întoarce doar numărul de liste șterse; proprietarul vede
-- rândurile doar sub variabila tranzacției `finet.definer_scope`, setată numai aici.
-- ---------------------------------------------------------------------------------------------
create policy shopping_lists_migrator_erase_select on finet.shopping_lists
  for select to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_shopping_lists'
         and owner_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy shopping_lists_migrator_erase_delete on finet.shopping_lists
  for delete to finet_migrator
  using (current_setting('finet.definer_scope', true) = 'erase_shopping_lists'
         and owner_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create function finet.erase_user_shopping_lists() returns integer
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_user uuid := finet.current_user_id();
    v_n integer;
  begin
    if v_user is null then
      raise exception 'erase_user_shopping_lists: lipsește utilizatorul din context'
        using errcode = '42501';
    end if;
    perform set_config('finet.definer_scope', 'erase_shopping_lists', true);
    delete from finet.shopping_lists l where l.owner_user_id = v_user;
    get diagnostics v_n = row_count;
    perform set_config('finet.definer_scope', '', true);
    return v_n;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.erase_user_shopping_lists() from public;
--> statement-breakpoint
grant execute on function finet.erase_user_shopping_lists() to finet_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime, pe coloane. Listele și articolele se șterg de
-- aplicație; cererile AI NU (dispar odată cu lista sau cu bonul, prin cascadă).
-- ---------------------------------------------------------------------------------------------
revoke all on finet.shopping_lists, finet.shopping_list_items, finet.shopping_list_ai_requests
  from public;
--> statement-breakpoint
grant select, insert, delete on finet.shopping_lists to finet_app;
--> statement-breakpoint
grant update (name, owner_user_id, status, updated_at) on finet.shopping_lists to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.shopping_list_items to finet_app;
--> statement-breakpoint
grant update (name, normalized_name, quantity, unit, note, checked, checked_by_user_id,
  checked_at, position, matched_receipt_line_id, match_status, match_score, match_source,
  updated_at) on finet.shopping_list_items to finet_app;
--> statement-breakpoint
grant select, insert on finet.shopping_list_ai_requests to finet_app;
--> statement-breakpoint
grant update (status, attempts, error_code, processing_started_at, updated_at)
  on finet.shopping_list_ai_requests to finet_app;
