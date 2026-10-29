-- FINET 0014_statement_uploads (Faza 7, F7-B): calea PDF-urilor de extras spre worker, curățarea
-- previzualizărilor vechi, potrivirea bon ↔ tranzacție și propunerile de plăți recurente.
-- Prima parte e generată de `drizzle-kit generate --name statement_uploads` din
-- src/db/schema/statements.ts (`when` din jurnal fixat de mână la 1794800000000, după 0013, care vine după 0016; 0015 e
-- rezervată, Faza 9 folosește ≥ 0016). A doua parte (după „PARTEA SCRISĂ DE MÂNĂ”) e adăugată o
-- singură dată, înainte de prima aplicare. Deciziile: docs/adr/0018-statements-import.md (§11) și
-- docs/adr/0019-matching-recurring.md. NU modifica fișierul după aplicare: runner-ul compară hash-ul.
--
-- Efect pe tabelele existente (fără rescrierea datelor):
--   - `receipts`: indexul UNIC parțial `receipts_transaction_key` (o tranzacție are cel mult un
--     bon) și triggerul `receipts_check_transaction` (bonul se leagă doar de o cheltuială VIZIBILĂ
--     apelantului, din aceeași gospodărie și monedă). ÎNAINTE de aplicare, pe producție:
--       select transaction_id, count(*) from finet.receipts where transaction_id is not null
--        group by 1 having count(*) > 1;   -- trebuie să fie gol (altfel indexul unic eșuează)
--   - `statement_usage_daily` (0013): triggerul `statement_usage_daily_check_update` (contorul nu
--     scade niciodată; revizuirea F7-A).
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE încărcările în așteptare,
-- respingerile potrivirilor și ale propunerilor; fișierele PDF rămase se șterg cu
-- `finet-admin cleanup-documents` ÎNAINTE de rollback):
--   drop function finet.queued_statement_uploads(integer, integer),
--     finet.queued_statement_upload(uuid), finet.cleanable_statement_uploads(integer),
--     finet.forget_statement_upload_file(uuid, text),
--     finet.purge_stale_statement_previews(integer, integer);
--   drop policy statement_imports_migrator_stale_select on finet.statement_imports;
--   drop policy statement_imports_migrator_stale_delete on finet.statement_imports;
--   drop trigger receipts_check_transaction on finet.receipts;
--   drop trigger statement_usage_daily_check_update on finet.statement_usage_daily;
--   drop function finet.receipts_check_transaction(), finet.statement_usage_daily_check_update(),
--     finet.statement_uploads_check_update();
--   drop index finet.receipts_transaction_key;
--   drop table finet.statement_uploads, finet.receipt_match_rejections,
--     finet.recurring_suggestion_dismissals;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0014_statement_uploads>';
CREATE TABLE "finet"."receipt_match_rejections" (
	"household_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"rejected_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_match_rejections_pkey" PRIMARY KEY("receipt_id","transaction_id")
);
--> statement-breakpoint
CREATE TABLE "finet"."recurring_suggestion_dismissals" (
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"signature" text NOT NULL,
	"dismissed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_suggestion_dismissals_pkey" PRIMARY KEY("household_id","signature"),
	CONSTRAINT "recurring_suggestion_dismissals_currency_valid" CHECK ("finet"."recurring_suggestion_dismissals"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "recurring_suggestion_dismissals_signature_format" CHECK ("finet"."recurring_suggestion_dismissals"."signature" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "finet"."statement_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"created_by_user_id" uuid,
	"storage_key" text,
	"sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"part_index" smallint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"error_code" text,
	"processing_started_at" timestamp with time zone,
	"import_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"file_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_uploads_id_household_key" UNIQUE("id","household_id"),
	CONSTRAINT "statement_uploads_status_valid" CHECK ("finet"."statement_uploads"."status" in ('queued', 'processing', 'parsed', 'failed')),
	CONSTRAINT "statement_uploads_currency_valid" CHECK ("finet"."statement_uploads"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "statement_uploads_sha256_format" CHECK ("finet"."statement_uploads"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "statement_uploads_size_min" CHECK ("finet"."statement_uploads"."size_bytes" >= 1),
	CONSTRAINT "statement_uploads_size_max" CHECK ("finet"."statement_uploads"."size_bytes" <= 20971520),
	CONSTRAINT "statement_uploads_part_index_min" CHECK ("finet"."statement_uploads"."part_index" >= 0),
	CONSTRAINT "statement_uploads_part_index_max" CHECK ("finet"."statement_uploads"."part_index" <= 19),
	CONSTRAINT "statement_uploads_attempts_min" CHECK ("finet"."statement_uploads"."attempts" >= 0),
	CONSTRAINT "statement_uploads_attempts_max" CHECK ("finet"."statement_uploads"."attempts" <= 3),
	CONSTRAINT "statement_uploads_error_code_format" CHECK ("finet"."statement_uploads"."error_code" is null or "finet"."statement_uploads"."error_code" ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT "statement_uploads_storage_key_shape" CHECK ("finet"."statement_uploads"."storage_key" is null or "finet"."statement_uploads"."storage_key" ~ '^households/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/documents/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "statement_uploads_file_deleted_shape" CHECK (("finet"."statement_uploads"."storage_key" is null) = ("finet"."statement_uploads"."file_deleted_at" is not null)),
	CONSTRAINT "statement_uploads_expires_after_created" CHECK ("finet"."statement_uploads"."expires_at" > "finet"."statement_uploads"."created_at")
);
--> statement-breakpoint
ALTER TABLE "finet"."receipt_match_rejections" ADD CONSTRAINT "receipt_match_rejections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipt_match_rejections" ADD CONSTRAINT "receipt_match_rejections_rejected_by_user_id_users_id_fk" FOREIGN KEY ("rejected_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipt_match_rejections" ADD CONSTRAINT "receipt_match_rejections_receipt_fk" FOREIGN KEY ("receipt_id","household_id") REFERENCES "finet"."receipts"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."receipt_match_rejections" ADD CONSTRAINT "receipt_match_rejections_transaction_fk" FOREIGN KEY ("transaction_id","household_id") REFERENCES "finet"."transactions"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_suggestion_dismissals" ADD CONSTRAINT "recurring_suggestion_dismissals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_suggestion_dismissals" ADD CONSTRAINT "recurring_suggestion_dismissals_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."recurring_suggestion_dismissals" ADD CONSTRAINT "recurring_suggestion_dismissals_account_fk" FOREIGN KEY ("account_id","household_id","currency") REFERENCES "finet"."accounts"("id","household_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_uploads" ADD CONSTRAINT "statement_uploads_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_uploads" ADD CONSTRAINT "statement_uploads_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."statement_uploads" ADD CONSTRAINT "statement_uploads_account_fk" FOREIGN KEY ("account_id","household_id","currency") REFERENCES "finet"."accounts"("id","household_id","currency") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "receipt_match_rejections_household_id_idx" ON "finet"."receipt_match_rejections" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "receipt_match_rejections_transaction_id_idx" ON "finet"."receipt_match_rejections" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "receipt_match_rejections_rejected_by_idx" ON "finet"."receipt_match_rejections" USING btree ("rejected_by_user_id");--> statement-breakpoint
CREATE INDEX "recurring_suggestion_dismissals_account_id_idx" ON "finet"."recurring_suggestion_dismissals" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "recurring_suggestion_dismissals_dismissed_by_idx" ON "finet"."recurring_suggestion_dismissals" USING btree ("dismissed_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_uploads_account_pending_key" ON "finet"."statement_uploads" USING btree ("account_id","sha256") WHERE "finet"."statement_uploads"."status" = 'queued' or "finet"."statement_uploads"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "statement_uploads_household_created_idx" ON "finet"."statement_uploads" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "statement_uploads_status_created_idx" ON "finet"."statement_uploads" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "statement_uploads_created_by_user_id_idx" ON "finet"."statement_uploads" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "statement_uploads_import_id_idx" ON "finet"."statement_uploads" USING btree ("import_id");--> statement-breakpoint

-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- Încărcarea → previzualizarea produsă de worker: același cont, aceeași monedă (cheia compusă).
-- Renunțarea la previzualizare (sau curățarea ei) desface doar legătura.
alter table finet.statement_uploads add constraint statement_uploads_import_fk
  foreign key (import_id, household_id, account_id, currency)
  references finet.statement_imports (id, household_id, account_id, currency)
  on delete set null (import_id) on update no action;
--> statement-breakpoint
-- Stările unei încărcări: `queued` → `processing` | `failed`; `processing` → `processing`
-- (reluată după termen) | `parsed` | `failed`; `parsed` și `failed` sunt finale. Încercările nu
-- scad; cheia de storage doar se golește (fișierul șters), nu se pune la loc și nu se schimbă;
-- legătura spre previzualizare se pune o singură dată, odată cu `parsed`, și o golește doar
-- cheia străină (previzualizarea nu mai există).
create function finet.statement_uploads_check_update() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.attempts < old.attempts then
      raise exception 'statement_uploads: încercările nu scad'
        using errcode = '23514', constraint = 'statement_uploads_transition';
    end if;
    if new.storage_key is not null and new.storage_key is distinct from old.storage_key then
      raise exception 'statement_uploads: fișierul nu se înlocuiește'
        using errcode = '23514', constraint = 'statement_uploads_transition';
    end if;
    if new.status is distinct from old.status then
      if old.status = 'parsed' or old.status = 'failed' then
        raise exception 'statement_uploads: încărcarea e finală'
          using errcode = '23514', constraint = 'statement_uploads_transition';
      end if;
      if new.status = 'queued' then
        raise exception 'statement_uploads: tranziție de stare nepermisă'
          using errcode = '23514', constraint = 'statement_uploads_transition';
      end if;
      if old.status = 'queued' and new.status = 'parsed' then
        raise exception 'statement_uploads: tranziție de stare nepermisă'
          using errcode = '23514', constraint = 'statement_uploads_transition';
      end if;
    end if;
    if new.import_id is distinct from old.import_id then
      if old.import_id is not null then
        if new.import_id is not null
           or exists (select 1 from finet.statement_imports i where i.id = old.import_id) then
          raise exception 'statement_uploads: legătura spre previzualizare nu se schimbă'
            using errcode = '23514', constraint = 'statement_uploads_transition';
        end if;
      elsif new.status <> 'parsed' then
        raise exception 'statement_uploads: doar o încărcare citită are previzualizare'
          using errcode = '23514', constraint = 'statement_uploads_transition';
      end if;
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger statement_uploads_check_update
  before update on finet.statement_uploads
  for each row execute function finet.statement_uploads_check_update();
--> statement-breakpoint
-- Cota zilnică a extraselor (0013) e un contor care DOAR crește (revizuirea F7-A): impus și în
-- bază, nu doar prin drepturile pe coloane.
create function finet.statement_usage_daily_check_update() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.count < old.count
       or new.day is distinct from old.day
       or new.household_id is distinct from old.household_id then
      raise exception 'statement_usage_daily: contorul doar crește'
        using errcode = '23514', constraint = 'statement_usage_daily_monotonic';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger statement_usage_daily_check_update
  before update on finet.statement_usage_daily
  for each row execute function finet.statement_usage_daily_check_update();
--> statement-breakpoint
-- O tranzacție are cel mult un bon (potrivirea nu poate lega două bonuri de aceeași cheltuială).
create unique index receipts_transaction_key on finet.receipts (transaction_id)
  where transaction_id is not null;
--> statement-breakpoint
-- Bonul se leagă doar de o CHELTUIALĂ din aceeași gospodărie și monedă, VIZIBILĂ apelantului
-- (SECURITY INVOKER: sub RLS-ul lui). Cheia compusă (0008) nu vede RLS-ul, deci fără trigger un id
-- ghicit dintr-un cont personal al altui membru ar trece (ADR 0019). Golirea (ștergerea
-- tranzacției, ON DELETE SET NULL) nu e verificată.
create function finet.receipts_check_transaction() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.transaction_id is null then
      return new;
    end if;
    if tg_op = 'UPDATE' then
      if new.transaction_id is not distinct from old.transaction_id
         and new.household_id is not distinct from old.household_id
         and new.currency is not distinct from old.currency then
        return new;
      end if;
    end if;
    if not exists (select 1 from finet.transactions t
                    where t.id = new.transaction_id
                      and t.household_id = new.household_id
                      and t.type = 'expense'
                      and t.currency = new.currency) then
      raise exception 'receipts: tranzacția nu e o cheltuială vizibilă'
        using errcode = '23503', constraint = 'receipts_transaction_visible';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger receipts_check_transaction
  before insert or update of transaction_id, household_id, currency on finet.receipts
  for each row execute function finet.receipts_check_transaction();
--> statement-breakpoint
revoke all on function finet.statement_uploads_check_update(),
  finet.statement_usage_daily_check_update(), finet.receipts_check_transaction() from public;
--> statement-breakpoint
alter table finet.statement_uploads enable row level security;
--> statement-breakpoint
alter table finet.statement_uploads force row level security;
--> statement-breakpoint
alter table finet.receipt_match_rejections enable row level security;
--> statement-breakpoint
alter table finet.receipt_match_rejections force row level security;
--> statement-breakpoint
alter table finet.recurring_suggestion_dismissals enable row level security;
--> statement-breakpoint
alter table finet.recurring_suggestion_dismissals force row level security;
--> statement-breakpoint
-- Vizibilitatea încărcărilor urmează contul (ca `statement_imports`, 0013): un extras pe un cont
-- PERSONAL îl vede doar proprietarul.
create policy statement_uploads_select on finet.statement_uploads
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy statement_uploads_insert on finet.statement_uploads
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and created_by_user_id = (select finet.current_user_id())
         and status = 'queued'
         and attempts = 0
         and import_id is null
         and error_code is null
         and storage_key is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy statement_uploads_update on finet.statement_uploads
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
-- Un rând se șterge doar după ce fișierul lui a fost șters (fără fișiere orfane pe disc).
create policy statement_uploads_delete on finet.statement_uploads
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and storage_key is null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
-- Proprietarul schemei (finet_migrator, în funcțiile SECURITY DEFINER de mai jos) vede DOAR
-- încărcările în lucru (coada workerului) și pe cele de curățat (expirate sau eșuate, cu fișier),
-- și poate goli DOAR cheia de storage a celor de curățat.
create policy statement_uploads_migrator_pending on finet.statement_uploads
  for select to finet_migrator
  using (status = 'queued' or status = 'processing');
--> statement-breakpoint
create policy statement_uploads_migrator_cleanup on finet.statement_uploads
  for select to finet_migrator
  using (storage_key is not null
         and (expires_at <= pg_catalog.now() or status = 'failed'));
--> statement-breakpoint
-- După golire, rândul trebuie să rămână vizibil proprietarului în aceeași comandă (noul rând al
-- unui UPDATE trece și prin politicile SELECT).
create policy statement_uploads_migrator_forgotten on finet.statement_uploads
  for select to finet_migrator
  using (storage_key is null
         and (expires_at <= pg_catalog.now() or status = 'failed'));
--> statement-breakpoint
create policy statement_uploads_migrator_forget on finet.statement_uploads
  for update to finet_migrator
  using (storage_key is not null
         and (expires_at <= pg_catalog.now() or status = 'failed'))
  with check (storage_key is null and file_deleted_at is not null);
--> statement-breakpoint
-- Previzualizările neconfirmate mai vechi de 7 zile (curățarea; revizuirea F7-A, punctul 2).
create policy statement_imports_migrator_stale_select on finet.statement_imports
  for select to finet_migrator
  using (status = 'previewed' and created_at < pg_catalog.now() - interval '7 days');
--> statement-breakpoint
create policy statement_imports_migrator_stale_delete on finet.statement_imports
  for delete to finet_migrator
  using (status = 'previewed' and created_at < pg_catalog.now() - interval '7 days');
--> statement-breakpoint
-- Respingerile potrivirilor: vizibile doar cu tranzacția (subinterogarea rulează sub RLS-ul
-- apelantului, deci o tranzacție dintr-un cont personal al altui membru rămâne invizibilă).
create policy receipt_match_rejections_select on finet.receipt_match_rejections
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.transactions t
                      where t.id = receipt_match_rejections.transaction_id));
--> statement-breakpoint
create policy receipt_match_rejections_insert on finet.receipt_match_rejections
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and rejected_by_user_id = (select finet.current_user_id())
         and exists (select 1 from finet.transactions t
                      where t.id = receipt_match_rejections.transaction_id));
--> statement-breakpoint
create policy receipt_match_rejections_delete on finet.receipt_match_rejections
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.transactions t
                      where t.id = receipt_match_rejections.transaction_id));
--> statement-breakpoint
create policy recurring_suggestion_dismissals_select on finet.recurring_suggestion_dismissals
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy recurring_suggestion_dismissals_insert on finet.recurring_suggestion_dismissals
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and dismissed_by_user_id = (select finet.current_user_id())
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
create policy recurring_suggestion_dismissals_delete on finet.recurring_suggestion_dismissals
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and account_id in (select a.id from finet.accounts a
                             where a.household_id = (select finet.current_household_id())
                               and (a.owner_user_id is null
                                    or a.owner_user_id = (select finet.current_user_id()))));
--> statement-breakpoint
-- Coada workerului (model: `queued_documents`, 0008/0010): doar identificatori. Membrul în numele
-- căruia se lucrează = cel care a încărcat, dacă e încă utilizator activ și membru (doar el sigur
-- vede contul: pentru un cont personal e chiar proprietarul). Altfel încărcarea nu se procesează
-- și o șterge curățarea la expirare.
create function finet.queued_statement_uploads(p_limit integer, p_stale_seconds integer)
  returns table (upload_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select s.id, s.household_id, s.created_by_user_id
      from finet.statement_uploads s
      join finet.household_members m
        on m.household_id = s.household_id and m.user_id = s.created_by_user_id
      join finet.users u on u.id = m.user_id and u.status = 'active'
     where s.storage_key is not null
       and s.attempts < 3
       and s.expires_at > pg_catalog.now()
       and (s.status = 'queued'
            or (s.status = 'processing'
                and (s.processing_started_at is null
                     or s.processing_started_at < pg_catalog.now()
                        - pg_catalog.make_interval(secs => greatest(coalesce(p_stale_seconds, 900), 60)))))
     order by s.created_at, s.id
     limit least(greatest(coalesce(p_limit, 0), 0), 100)
  $$;
--> statement-breakpoint
create function finet.queued_statement_upload(p_upload_id uuid)
  returns table (upload_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select s.id, s.household_id, s.created_by_user_id
      from finet.statement_uploads s
      join finet.household_members m
        on m.household_id = s.household_id and m.user_id = s.created_by_user_id
      join finet.users u on u.id = m.user_id and u.status = 'active'
     where s.id = p_upload_id
       and s.storage_key is not null
       and s.attempts < 3
       and s.expires_at > pg_catalog.now()
       and (s.status = 'queued' or s.status = 'processing')
  $$;
--> statement-breakpoint
-- Curățarea (`finet-admin cleanup-documents`, cu storage-ul în scriere): încărcările cu fișier
-- expirate (`expires_at`, 24 h) sau eșuate, inclusiv cele al căror autor nu mai e membru (fără
-- actor: curățarea nu trece prin RLS, deci nu rămân fișiere orfane). Întoarce doar
-- identificatori și cheia de storage (nu conținut). Cele în lucru nu se ating până nu trec 15
-- minute de la revendicare (workerul le poate citi chiar acum).
create function finet.cleanable_statement_uploads(p_limit integer)
  returns table (upload_id uuid, household_id uuid, storage_key text)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select s.id, s.household_id, s.storage_key
      from finet.statement_uploads s
     where s.storage_key is not null
       and (s.expires_at <= pg_catalog.now() or s.status = 'failed')
       and (s.status <> 'processing'
            or s.processing_started_at is null
            or s.processing_started_at < pg_catalog.now() - interval '15 minutes')
     order by s.expires_at, s.id
     limit least(greatest(coalesce(p_limit, 0), 0), 500)
  $$;
--> statement-breakpoint
-- După ștergerea fișierului: golește cheia (doar dacă e aceeași și rândul e încă de curățat);
-- o încărcare neterminată devine `failed` cu `upload_expired`. Întoarce dacă a golit-o.
create function finet.forget_statement_upload_file(p_upload_id uuid, p_storage_key text)
  returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_found boolean;
  begin
    update finet.statement_uploads s
       set storage_key = null,
           file_deleted_at = pg_catalog.now(),
           status = case when s.status = 'queued' or s.status = 'processing'
                         then 'failed' else s.status end,
           error_code = case when s.status = 'queued' or s.status = 'processing'
                             then 'upload_expired' else s.error_code end,
           updated_at = pg_catalog.now()
     where s.id = p_upload_id
       and s.storage_key = p_storage_key
       and (s.expires_at <= pg_catalog.now() or s.status = 'failed');
    get diagnostics v_found = row_count;
    return v_found;
  end
  $$;
--> statement-breakpoint
-- Previzualizările neconfirmate mai vechi de `p_older_than_days` (minimum 7) se șterg cu rândurile
-- lor (cascadă); cota zilnică nu se eliberează. Întoarce numărul lor.
create function finet.purge_stale_statement_previews(p_older_than_days integer, p_limit integer)
  returns integer
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_count integer;
  begin
    delete from finet.statement_imports i
     where i.id in (select x.id from finet.statement_imports x
                     where x.status = 'previewed'
                       and x.created_at < pg_catalog.now()
                           - pg_catalog.make_interval(days => greatest(coalesce(p_older_than_days, 7), 7))
                     order by x.created_at, x.id
                     limit least(greatest(coalesce(p_limit, 0), 0), 1000));
    get diagnostics v_count = row_count;
    return v_count;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.queued_statement_uploads(integer, integer),
  finet.queued_statement_upload(uuid), finet.cleanable_statement_uploads(integer),
  finet.forget_statement_upload_file(uuid, text),
  finet.purge_stale_statement_previews(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.queued_statement_uploads(integer, integer),
  finet.queued_statement_upload(uuid), finet.cleanable_statement_uploads(integer),
  finet.forget_statement_upload_file(uuid, text),
  finet.purge_stale_statement_previews(integer, integer) to finet_app;
--> statement-breakpoint
-- Drepturile minime ale aplicației:
-- - statement_uploads: citire, inserare, ștergere (doar fără fișier, prin politică); UPDATE doar
--   pe starea de lucru, încercări, cod, legătura spre previzualizare și ștergerea fișierului;
-- - receipt_match_rejections, recurring_suggestion_dismissals: citire, inserare, ștergere.
revoke all on finet.statement_uploads, finet.receipt_match_rejections,
  finet.recurring_suggestion_dismissals from public;
--> statement-breakpoint
grant select, insert, delete on finet.statement_uploads to finet_app;
--> statement-breakpoint
grant update (status, attempts, error_code, processing_started_at, import_id, storage_key,
  file_deleted_at, updated_at) on finet.statement_uploads to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.receipt_match_rejections to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.recurring_suggestion_dismissals to finet_app;
