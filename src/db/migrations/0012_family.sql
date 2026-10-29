-- FINET 0012_family (Faza 8, F8-A): familia — invitațiile (`household_invites`), împărțirea
-- cheltuielilor (`transaction_splits`), decontările (`settlements`), gospodăria activă
-- (`user_preferences.active_household_id`) și vizibilitatea PERSONAL / COMUN pe conturi și pe tot
-- ce derivă din ele (tranzacții, etichetele tranzacțiilor, reguli recurente, ocurențe).
-- Prima parte e generată de `drizzle-kit generate --name family` din src/db/schema/family.ts și
-- user-data.ts (`when` din jurnal fixat de mână la 1794000000000, după 0011). A doua parte (după
-- „PARTEA SCRISĂ DE MÂNĂ”) e adăugată o singură dată, înainte de prima aplicare. Deciziile:
-- docs/adr/0016-family.md. NU modifica fișierul după aplicare: runner-ul compară hash-ul.
--
-- Efect pe tabelele existente (fără rescrierea datelor):
--   - user_preferences: coloana nouă `active_household_id` (NULL, fără rescriere) + cheia spre
--     households (ON DELETE SET NULL);
--   - politicile `accounts_household`, `transactions_household`, `transaction_tags_household`,
--     `recurring_rules_household`, `recurring_occurrences_household` sunt RESTRÂNSE prin
--     ALTER POLICY (aceleași nume): un cont cu `owner_user_id` nenul e PERSONAL și e vizibil
--     doar proprietarului, împreună cu tot ce e legat de el. ATENȚIE la producție: un cont cu
--     `owner_user_id` setat înainte de 0012 dispare pentru ceilalți membri (verificarea
--     operatorului e în docs/INFRA.md, „Faza 8 pe producție”);
--   - `finet.check_transfer_group` devine SECURITY DEFINER (aceeași semnătură), ca un transfer
--     personal → comun să nu poată fi rupt de un membru care vede doar jumătatea comună;
--   - `finet.due_recurring_rules` (aceeași semnătură): o regulă pe un cont personal se generează
--     doar în numele proprietarului contului, dacă e membru activ (altfel e omisă);
--   - politici noi DOAR pentru finet_migrator (funcțiile SECURITY DEFINER): citirea rândurilor de
--     transfer ale gospodăriei curente, citirea conturilor personale, citirea/consumarea
--     invitației în curs de acceptare, inserarea apartenenței în curs de acceptare;
--   - household_members: UPDATE doar pe coloana `role`; triggere noi (plafonul de 6 membri,
--     protecția ultimului owner); accounts: trigger nou (un cont comun nu devine personal).
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE invitațiile, împărțirile și
-- decontările; vizibilitatea revine la „toți membrii văd tot”):
--   alter policy accounts_household / transactions_household / transaction_tags_household /
--     recurring_rules_household / recurring_occurrences_household on ... (textele din
--     0002/0004/0006);
--   drop trigger household_members_guard_owner, household_members_check_cap on
--     finet.household_members; drop trigger accounts_check_owner_change on finet.accounts;
--   drop trigger transactions_splits_sum_valid on finet.transactions;
--   drop policy transactions_migrator_transfer_check on finet.transactions;
--   drop policy accounts_migrator_personal_owner on finet.accounts;
--   drop policy transactions_migrator_category_check on finet.transactions;
--   drop policy recurring_rules_migrator_category_check on finet.recurring_rules;
--   drop policy budgets_migrator_category_check on finet.budgets;
--   drop function finet.category_used_elsewhere(uuid);
--   drop policy household_members_migrator_join on finet.household_members;
--   create or replace function finet.check_transfer_group(uuid) ... security invoker (0002);
--   create or replace function finet.due_recurring_rules(date, integer) ... (textul din 0006);
--   drop table finet.transaction_splits, finet.settlements, finet.household_invites;
--   drop function finet.accept_invite(text), finet.household_members_guard_owner(),
--     finet.household_members_check_cap(), finet.accounts_check_owner_change(),
--     finet.transaction_splits_check_refs(), finet.transaction_splits_check_sum(),
--     finet.settlements_check(), finet.household_invites_check_update();
--   alter table finet.user_preferences drop column active_household_id;
--   grant update on finet.household_members to finet_app;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0012_family>';
CREATE TABLE "finet"."household_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "household_invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "household_invites_token_hash_format" CHECK ("finet"."household_invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "household_invites_role_valid" CHECK ("finet"."household_invites"."role" in ('owner', 'member')),
	CONSTRAINT "household_invites_expires_after_created" CHECK ("finet"."household_invites"."expires_at" > "finet"."household_invites"."created_at"),
	CONSTRAINT "household_invites_expires_max" CHECK ("finet"."household_invites"."expires_at" <= "finet"."household_invites"."created_at" + interval '168 hours'),
	CONSTRAINT "household_invites_used_shape" CHECK ("finet"."household_invites"."used_by_user_id" is null or "finet"."household_invites"."used_at" is not null),
	CONSTRAINT "household_invites_used_or_revoked" CHECK ("finet"."household_invites"."used_at" is null or "finet"."household_invites"."revoked_at" is null)
);
--> statement-breakpoint
CREATE TABLE "finet"."settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"settled_on" date NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	CONSTRAINT "settlements_distinct_users" CHECK ("finet"."settlements"."from_user_id" <> "finet"."settlements"."to_user_id"),
	CONSTRAINT "settlements_amount_min" CHECK ("finet"."settlements"."amount_minor" >= 1),
	CONSTRAINT "settlements_amount_max" CHECK ("finet"."settlements"."amount_minor" <= 10000000000000),
	CONSTRAINT "settlements_currency_valid" CHECK ("finet"."settlements"."currency" in ('RON', 'EUR', 'USD')),
	CONSTRAINT "settlements_settled_on_min" CHECK ("finet"."settlements"."settled_on" >= date '1900-01-01'),
	CONSTRAINT "settlements_settled_on_max" CHECK ("finet"."settlements"."settled_on" <= date '2999-12-31'),
	CONSTRAINT "settlements_note_length" CHECK ("finet"."settlements"."note" is null or char_length("finet"."settlements"."note") <= 200),
	CONSTRAINT "settlements_cancel_shape" CHECK ("finet"."settlements"."cancelled_by_user_id" is null or "finet"."settlements"."cancelled_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "finet"."transaction_splits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"payer_user_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"share_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_splits_transaction_user_key" UNIQUE("transaction_id","user_id"),
	CONSTRAINT "transaction_splits_share_min" CHECK ("finet"."transaction_splits"."share_minor" >= 0),
	CONSTRAINT "transaction_splits_share_max" CHECK ("finet"."transaction_splits"."share_minor" <= 10000000000000),
	CONSTRAINT "transaction_splits_currency_valid" CHECK ("finet"."transaction_splits"."currency" in ('RON', 'EUR', 'USD'))
);
--> statement-breakpoint
ALTER TABLE "finet"."user_preferences" ADD COLUMN "active_household_id" uuid;--> statement-breakpoint
ALTER TABLE "finet"."household_invites" ADD CONSTRAINT "household_invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."household_invites" ADD CONSTRAINT "household_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."household_invites" ADD CONSTRAINT "household_invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."settlements" ADD CONSTRAINT "settlements_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."settlements" ADD CONSTRAINT "settlements_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "finet"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."settlements" ADD CONSTRAINT "settlements_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "finet"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."settlements" ADD CONSTRAINT "settlements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."settlements" ADD CONSTRAINT "settlements_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transaction_splits" ADD CONSTRAINT "transaction_splits_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transaction_splits" ADD CONSTRAINT "transaction_splits_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "finet"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transaction_splits" ADD CONSTRAINT "transaction_splits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "finet"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."transaction_splits" ADD CONSTRAINT "transaction_splits_transaction_fk" FOREIGN KEY ("transaction_id","household_id") REFERENCES "finet"."transactions"("id","household_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "household_invites_household_created_idx" ON "finet"."household_invites" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE INDEX "settlements_household_settled_idx" ON "finet"."settlements" USING btree ("household_id","settled_on");--> statement-breakpoint
CREATE INDEX "settlements_from_user_id_idx" ON "finet"."settlements" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "settlements_to_user_id_idx" ON "finet"."settlements" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_household_id_idx" ON "finet"."transaction_splits" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_user_id_idx" ON "finet"."transaction_splits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "transaction_splits_payer_user_id_idx" ON "finet"."transaction_splits" USING btree ("payer_user_id");--> statement-breakpoint
ALTER TABLE "finet"."user_preferences" ADD CONSTRAINT "user_preferences_active_household_id_households_id_fk" FOREIGN KEY ("active_household_id") REFERENCES "finet"."households"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Vizibilitatea PERSONAL / COMUN (ADR 0016). Un cont cu `owner_user_id` NULL e COMUN (îl văd
-- toți membrii); unul cu `owner_user_id` = X e PERSONAL al lui X (îl vede DOAR X). Tranzacțiile,
-- etichetele lor, regulile recurente și ocurențele moștenesc vizibilitatea contului, deci și
-- toate agregatele (dashboard, rapoarte, bugete, exporturi), calculate sub RLS-ul celui care
-- citește. Aceleași nume de politici (ALTER POLICY): nimic nu rămâne fără politică nici o clipă.
-- Subinterogarea pe conturi e necorelată (evaluată o dată pe interogare, hashed SubPlan) și
-- repetă explicit condiția, deși RLS-ul conturilor ar impune-o oricum.
-- ---------------------------------------------------------------------------------------------
alter policy accounts_household on finet.accounts
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and (owner_user_id is null or owner_user_id = (select finet.current_user_id())));
--> statement-breakpoint
alter policy transactions_household on finet.transactions
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
alter policy transaction_tags_household on finet.transaction_tags
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.transactions t
                      where t.id = transaction_tags.transaction_id))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.transactions t
                      where t.id = transaction_tags.transaction_id));
--> statement-breakpoint
alter policy recurring_rules_household on finet.recurring_rules
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
alter policy recurring_occurrences_household on finet.recurring_occurrences
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.recurring_rules r
                      where r.id = recurring_occurrences.rule_id))
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and exists (select 1 from finet.recurring_rules r
                      where r.id = recurring_occurrences.rule_id));
--> statement-breakpoint
-- Un cont COMUN nu devine personal (ar ascunde de ceilalți tot istoricul lui) și un cont personal
-- nu se mută la alt membru; personal → comun e permis proprietarului (alegerea lui de a-l
-- împărți). RLS (WITH CHECK) mai cere ca proprietarul nou să fie NULL sau utilizatorul curent.
create function finet.accounts_check_owner_change() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.owner_user_id is not null
       and new.owner_user_id is distinct from old.owner_user_id then
      raise exception 'accounts: un cont nu poate deveni personal sau trece la alt membru'
        using errcode = '23514', constraint = 'accounts_owner_change';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger accounts_check_owner_change
  before update of owner_user_id on finet.accounts
  for each row execute function finet.accounts_check_owner_change();
--> statement-breakpoint
-- Transferurile: un transfer personal (A) → comun are o jumătate pe care ceilalți membri o văd
-- și una pe care n-o văd. Verificarea grupului (0002) rula cu RLS-ul celui care scrie, deci un
-- membru care șterge jumătatea comună ar fi văzut un grup gol („valid”) și ar fi lăsat jumătatea
-- personală orfană. Acum funcția rulează ca proprietarul (finet_migrator) și vede TOATE rândurile
-- grupului, dar doar în gospodăria curentă și doar rândurile de transfer (politica de mai jos);
-- întoarce `void` (doar ridică eroarea), deci nu dezvăluie nimic.
create policy transactions_migrator_transfer_check on finet.transactions
  for select to finet_migrator
  using (transfer_group_id is not null
         and household_id = (select finet.current_household_id()));
--> statement-breakpoint
create or replace function finet.check_transfer_group(p_group uuid) returns void
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    v record;
  begin
    if p_group is null then
      return;
    end if;
    select count(*) as n,
           count(*) filter (where t.transfer_direction = 'out') as n_out,
           count(*) filter (where t.transfer_direction = 'in') as n_in,
           count(distinct t.account_id) as n_accounts,
           count(distinct t.household_id) as n_households,
           count(distinct t.currency) as n_currencies,
           count(distinct t.amount_minor) as n_amounts,
           count(*) filter (where t.type <> 'transfer') as n_other
      into v
      from finet.transactions t
     where t.transfer_group_id = p_group;
    if v.n = 0 then
      return;
    end if;
    if v.n <> 2 or v.n_out <> 1 or v.n_in <> 1 or v.n_accounts <> 2 or v.n_households <> 1
       or v.n_other <> 0 then
      raise exception 'transactions: grup de transfer invalid' using errcode = '23514';
    end if;
    if v.n_currencies = 1 and v.n_amounts <> 1 then
      raise exception 'transactions: transfer în aceeași monedă cu sume diferite'
        using errcode = '23514';
    end if;
  end
  $$;
--> statement-breakpoint

-- Scadențele recurente (0006): o regulă pe un cont PERSONAL se generează DOAR în numele
-- proprietarului contului (singurul care îl vede), dacă e încă membru activ; altfel regula e
-- omisă (nu mai eșuează la nesfârșit în numele unui owner care nu vede contul). Proprietarul
-- (finet_migrator) vede conturile personale DOAR în interiorul funcțiilor care setează variabila
-- tranzacției `finet.definer_scope` (`due_recurring` aici, `category_usage` în
-- finet.category_used_elsewhere); în afara lor politica nu-i arată nimic. Conturile comune îi
-- rămân invizibile (`pa` e NULL pentru ele). Aceeași semnătură, aceleași garduri, doar
-- identificatori; funcția devine plpgsql (VOLATILE) ca să poată seta și reseta variabila.
create policy accounts_migrator_personal_owner on finet.accounts
  for select to finet_migrator
  using (owner_user_id is not null
         and current_setting('finet.definer_scope', true) in ('due_recurring', 'category_usage'));
--> statement-breakpoint
create or replace function finet.due_recurring_rules(p_today date, p_limit integer)
  returns table (rule_id uuid, household_id uuid, actor_user_id uuid)
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  #variable_conflict use_column
  begin
    perform set_config('finet.definer_scope', 'due_recurring', true);
    return query
    select r.id, r.household_id, a.user_id
      from finet.recurring_rules r
      left join finet.accounts pa on pa.id = r.account_id and pa.owner_user_id is not null
      cross join lateral (
        select m.user_id
          from finet.household_members m
          join finet.users u on u.id = m.user_id and u.status = 'active'
         where m.household_id = r.household_id
           and (case when pa.id is not null then m.user_id = pa.owner_user_id
                     else (m.user_id = r.created_by_user_id or m.role = 'owner') end)
         order by (m.user_id = r.created_by_user_id) desc, m.joined_at, m.user_id
         limit 1
      ) a
     where r.status = 'active'
       and r.next_run_on <= least(p_today, (pg_catalog.now() at time zone 'Europe/Bucharest')::date)
       and (r.retry_after is null or r.retry_after <= pg_catalog.now())
     order by r.next_run_on, r.id
     limit least(greatest(coalesce(p_limit, 0), 0), 1000);
    perform set_config('finet.definer_scope', '', true);
  end
  $$;
--> statement-breakpoint
-- Ștergerea unei categorii comune (F8-A, revizuirea m1): un membru nu vede tranzacțiile și
-- regulile din conturile personale ale altora și nici bugetele lor personale, deci nu poate ști
-- singur dacă o categorie mai e folosită acolo (cheia străină ar fi refuzat ștergerea și ar fi
-- dezvăluit folosirea; bugetele personale ar fi dispărut în cascadă). Funcția răspunde DOAR cu un
-- boolean, pentru gospodăria curentă și utilizatorul din context (care trebuie să fie membru);
-- serviciul ascunde atunci categoria în loc s-o șteargă. Proprietarul vede rândurile doar pentru
-- categoria în curs de verificare (variabila `finet.checking_category`, setată numai aici).
create policy transactions_migrator_category_check on finet.transactions
  for select to finet_migrator
  using (category_id = nullif(current_setting('finet.checking_category', true), '')::uuid
         and household_id = (select finet.current_household_id()));
--> statement-breakpoint
create policy recurring_rules_migrator_category_check on finet.recurring_rules
  for select to finet_migrator
  using (category_id = nullif(current_setting('finet.checking_category', true), '')::uuid
         and household_id = (select finet.current_household_id()));
--> statement-breakpoint
create policy budgets_migrator_category_check on finet.budgets
  for select to finet_migrator
  using (category_id = nullif(current_setting('finet.checking_category', true), '')::uuid
         and household_id = (select finet.current_household_id()));
--> statement-breakpoint
create function finet.category_used_elsewhere(p_category_id uuid) returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_user uuid := finet.current_user_id();
    v_household uuid := finet.current_household_id();
    v_used boolean;
  begin
    if v_user is null or v_household is null or p_category_id is null
       or finet.member_role(v_household) is null then
      return false;
    end if;
    perform set_config('finet.checking_category', p_category_id::text, true);
    perform set_config('finet.definer_scope', 'category_usage', true);
    select exists (select 1 from finet.transactions t
                     join finet.accounts a on a.id = t.account_id
                    where t.household_id = v_household and t.category_id = p_category_id
                      and a.owner_user_id is not null and a.owner_user_id <> v_user)
        or exists (select 1 from finet.recurring_rules r
                     join finet.accounts a on a.id = r.account_id
                    where r.household_id = v_household and r.category_id = p_category_id
                      and a.owner_user_id is not null and a.owner_user_id <> v_user)
        or exists (select 1 from finet.budgets b
                    where b.household_id = v_household and b.category_id = p_category_id
                      and b.scope = 'personal' and b.user_id <> v_user)
      into v_used;
    perform set_config('finet.checking_category', '', true);
    perform set_config('finet.definer_scope', '', true);
    return coalesce(v_used, false);
  end
  $$;
--> statement-breakpoint
revoke all on function finet.category_used_elsewhere(uuid) from public;
--> statement-breakpoint
grant execute on function finet.category_used_elsewhere(uuid) to finet_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Membrii: plafonul (6, master prompt 2 „Familie”) și protecția ULTIMULUI owner (L3). Ambele
-- rulează ca proprietarul (vede toți membrii prin `household_members_migrator_read`), serializate
-- per gospodărie cu un advisory lock (READ COMMITTED: după lock, numărătoarea vede ce au comis
-- cererile concurente — de exemplu doi owneri care se retrogradează reciproc).
-- ---------------------------------------------------------------------------------------------
create function finet.household_members_check_cap() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    -- L1: de schimbat doar printr-o migrație nouă.
    c_max_members constant integer := 6;
  begin
    perform pg_advisory_xact_lock(hashtext('finet.household_members:' || new.household_id::text));
    if (select count(*) from finet.household_members m where m.household_id = new.household_id)
       >= c_max_members then
      raise exception 'household_members: plafonul de % membri a fost atins', c_max_members
        using errcode = '54000', constraint = 'household_members_cap';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger household_members_check_cap
  before insert on finet.household_members
  for each row execute function finet.household_members_check_cap();
--> statement-breakpoint
-- Ultimul owner nu poate pleca și nu poate fi scos cât timp în gospodărie rămân alți membri și nu
-- poate fi retrogradat deloc (gospodăria ar rămâne fără owner); transferul de ownership e
-- explicit: întâi promovezi pe altcineva. Permis: ștergerea gospodăriei (cascada: gospodăria nu mai
-- există) și plecarea ultimului membru (gospodăria rămâne goală; ștergerea ei e separată).
create function finet.household_members_guard_owner() returns trigger
  language plpgsql security definer
  set search_path = pg_catalog
  as $$
  declare
    v_result finet.household_members;
  begin
    if tg_op = 'DELETE' then
      v_result := old;
    else
      v_result := new;
    end if;
    if old.role <> 'owner' or (tg_op = 'UPDATE' and new.role = 'owner') then
      return v_result;
    end if;
    if not exists (select 1 from finet.households h where h.id = old.household_id) then
      return v_result;
    end if;
    perform pg_advisory_xact_lock(hashtext('finet.household_members:' || old.household_id::text));
    if not exists (select 1 from finet.household_members m
                    where m.household_id = old.household_id and m.id <> old.id
                      and m.role = 'owner')
       and (tg_op = 'UPDATE'
            or exists (select 1 from finet.household_members m
                        where m.household_id = old.household_id and m.id <> old.id)) then
      raise exception 'household_members: ultimul owner'
        using errcode = '23514', constraint = 'household_members_last_owner';
    end if;
    return v_result;
  end
  $$;
--> statement-breakpoint
create trigger household_members_guard_owner
  before update of role or delete on finet.household_members
  for each row execute function finet.household_members_guard_owner();
--> statement-breakpoint
-- Intrarea printr-o invitație: proprietarul inserează DOAR apartenența utilizatorului din context
-- în gospodăria invitației în curs de acceptare (variabila tranzacției `finet.joining_household`,
-- setată numai în finet.accept_invite), ca la finet.create_household.
create policy household_members_migrator_join on finet.household_members
  for insert to finet_migrator
  with check (
    household_id = nullif(current_setting('finet.joining_household', true), '')::uuid
    and user_id = (select finet.current_user_id())
  );
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Invitațiile. Stările finale (folosită, revocată) sunt imutabile: o invitație revocată nu se
-- „reînvie”, una folosită nu se revocă.
-- ---------------------------------------------------------------------------------------------
create function finet.household_invites_check_update() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if old.used_at is not null or old.revoked_at is not null then
      raise exception 'household_invites: invitația nu mai e activă'
        using errcode = '23514', constraint = 'household_invites_final';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger household_invites_check_update
  before update on finet.household_invites
  for each row execute function finet.household_invites_check_update();
--> statement-breakpoint
-- Politicile proprietarului pentru accept_invite: DOAR invitația cu hash-ul în curs de acceptare
-- (variabila tranzacției `finet.accepting_invite`, setată numai în funcție).
create policy household_invites_migrator_accept_read on finet.household_invites
  for select to finet_migrator
  using (token_hash = nullif(current_setting('finet.accepting_invite', true), ''));
--> statement-breakpoint
create policy household_invites_migrator_accept_use on finet.household_invites
  for update to finet_migrator
  using (token_hash = nullif(current_setting('finet.accepting_invite', true), ''))
  with check (token_hash = nullif(current_setting('finet.accepting_invite', true), ''));
--> statement-breakpoint
-- Acceptarea unei invitații (utilizatorul NU e încă membru, deci RLS nu-i arată invitația).
-- Primește DOAR hash-ul SHA-256 al tokenului (tokenul în clar nu ajunge în bază) și acționează
-- pentru utilizatorul DIN CONTEXT. Consum atomic: rândul e blocat (FOR UPDATE); o a doua
-- acceptare concurentă așteaptă, re-evaluează condițiile pe rândul deja folosit și nu-l mai
-- găsește. Răspuns UNIFORM: niciun rând pentru token inexistent, expirat, folosit, revocat sau
-- format greșit (fără a spune care). Un utilizator deja membru primește id-ul gospodăriei
-- (`newly_joined = false`) fără să consume invitația (rămâne pentru cel invitat). Plafonul de
-- membri: triggerul household_members_check_cap (eroare 54000). Întoarce doar identificatorul
-- gospodăriei și un indicator.
create function finet.accept_invite(p_token_hash text)
  returns table (invite_household_id uuid, newly_joined boolean)
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_user uuid := finet.current_user_id();
    v_invite record;
  begin
    if v_user is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
      return;
    end if;
    if not exists (select 1 from finet.users u where u.id = v_user and u.status = 'active') then
      return;
    end if;
    perform set_config('finet.accepting_invite', p_token_hash, true);
    select i.id, i.household_id, i.role into v_invite
      from finet.household_invites i
     where i.token_hash = p_token_hash
       and i.used_at is null
       and i.revoked_at is null
       and i.expires_at > pg_catalog.now()
       -- Plasă de siguranță (revizuirea M1): cine a creat invitația trebuie să fie ÎNCĂ owner al
       -- gospodăriei; altfel invitația e inutilizabilă (același răspuns uniform).
       and exists (select 1 from finet.household_members c
                    where c.household_id = i.household_id
                      and c.user_id = i.created_by_user_id
                      and c.role = 'owner')
       for update of i;
    if not found then
      perform set_config('finet.accepting_invite', '', true);
      return;
    end if;
    if exists (select 1 from finet.household_members m
                where m.household_id = v_invite.household_id and m.user_id = v_user) then
      perform set_config('finet.accepting_invite', '', true);
      invite_household_id := v_invite.household_id;
      newly_joined := false;
      return next;
      return;
    end if;
    update finet.household_invites i
       set used_at = pg_catalog.now(), used_by_user_id = v_user
     where i.id = v_invite.id;
    perform set_config('finet.joining_household', v_invite.household_id::text, true);
    insert into finet.household_members (household_id, user_id, role)
      values (v_invite.household_id, v_user, v_invite.role);
    perform set_config('finet.joining_household', '', true);
    perform set_config('finet.accepting_invite', '', true);
    invite_household_id := v_invite.household_id;
    newly_joined := true;
    return next;
  end
  $$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Împărțirile. Plătitorul = proprietarul contului PERSONAL al cheltuielii = utilizatorul curent
-- (RLS); fiecare participant e membru al gospodăriei; moneda = moneda tranzacției. Fără UPDATE:
-- o împărțire se înlocuiește (DELETE + INSERT în aceeași tranzacție).
-- ---------------------------------------------------------------------------------------------
create function finet.transaction_splits_check_refs() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v record;
  begin
    select t.type, t.currency, a.owner_user_id into v
      from finet.transactions t
      join finet.accounts a on a.id = t.account_id
     where t.id = new.transaction_id and t.household_id = new.household_id;
    if not found then
      raise exception 'transaction_splits: tranzacția nu există' using errcode = '23503';
    end if;
    if v.type <> 'expense' then
      raise exception 'transaction_splits: doar cheltuielile se împart' using errcode = '23514';
    end if;
    if v.owner_user_id is distinct from new.payer_user_id then
      raise exception 'transaction_splits: doar din contul personal al plătitorului'
        using errcode = '23514';
    end if;
    if v.currency <> new.currency then
      raise exception 'transaction_splits: altă monedă decât tranzacția' using errcode = '23514';
    end if;
    if not exists (select 1 from finet.household_members m
                    where m.household_id = new.household_id and m.user_id = new.user_id) then
      raise exception 'transaction_splits: participantul nu e membru' using errcode = '23503';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger transaction_splits_check_refs
  before insert on finet.transaction_splits
  for each row execute function finet.transaction_splits_check_refs();
--> statement-breakpoint
-- Suma părților = totalul tranzacției, verificată la COMMIT (constraint trigger DEFERRABLE
-- INITIALLY DEFERRED), ca părțile să poată fi șterse și reinserate pe rând în aceeași tranzacție.
-- Rulează la orice schimbare a părților și la schimbarea sumei/monedei/tipului/contului unei
-- tranzacții împărțite. O tranzacție fără părți e validă (inserările existente nu sunt afectate);
-- o tranzacție ștearsă își șterge părțile (cascada), deci nu rămâne nimic de verificat.
create function finet.transaction_splits_check_sum() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  declare
    v_tx uuid;
    v_parts record;
    v_t record;
  begin
    if tg_table_name = 'transactions' then
      v_tx := new.id;
    elsif tg_op = 'DELETE' then
      v_tx := old.transaction_id;
    else
      v_tx := new.transaction_id;
    end if;
    select count(*) as n, coalesce(sum(s.share_minor), 0) as total,
           count(distinct s.currency) as n_currencies, min(s.currency) as currency,
           count(distinct s.payer_user_id) as n_payers
      into v_parts
      from finet.transaction_splits s
     where s.transaction_id = v_tx;
    if v_parts.n = 0 then
      return null;
    end if;
    select t.amount_minor, t.currency, t.type into v_t
      from finet.transactions t
     where t.id = v_tx;
    if not found then
      raise exception 'transaction_splits: tranzacția nu e accesibilă'
        using errcode = '23514', constraint = 'transaction_splits_sum';
    end if;
    if v_t.type <> 'expense' or v_parts.n_currencies <> 1 or v_parts.currency <> v_t.currency
       or v_parts.n_payers <> 1 or v_parts.total <> v_t.amount_minor then
      raise exception 'transaction_splits: suma părților diferă de total'
        using errcode = '23514', constraint = 'transaction_splits_sum';
    end if;
    return null;
  end
  $$;
--> statement-breakpoint
create constraint trigger transaction_splits_sum_valid
  after insert or delete on finet.transaction_splits
  deferrable initially deferred
  for each row execute function finet.transaction_splits_check_sum();
--> statement-breakpoint
create constraint trigger transactions_splits_sum_valid
  after update of amount_minor, currency, type, account_id on finet.transactions
  deferrable initially deferred
  for each row execute function finet.transaction_splits_check_sum();
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Decontările: la inserare ambii utilizatori sunt membri ai gospodăriei (istoricul rămâne după
-- plecarea unui membru, de aceea nu e o cheie străină). Singura modificare permisă e anularea, o
-- singură dată.
-- ---------------------------------------------------------------------------------------------
create function finet.settlements_check() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if tg_op = 'INSERT' then
      if (select count(*) from finet.household_members m
           where m.household_id = new.household_id
             and m.user_id in (new.from_user_id, new.to_user_id)) <> 2 then
        raise exception 'settlements: ambii utilizatori trebuie să fie membri'
          using errcode = '23503', constraint = 'settlements_members';
      end if;
      return new;
    end if;
    if old.cancelled_at is not null or new.cancelled_at is null then
      raise exception 'settlements: doar anularea, o singură dată'
        using errcode = '23514', constraint = 'settlements_cancel_once';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger settlements_check
  before insert or update on finet.settlements
  for each row execute function finet.settlements_check();
--> statement-breakpoint
revoke all on function finet.accounts_check_owner_change(), finet.household_members_check_cap(),
  finet.household_members_guard_owner(), finet.household_invites_check_update(),
  finet.accept_invite(text), finet.transaction_splits_check_refs(),
  finet.transaction_splits_check_sum(), finet.settlements_check() from public;
--> statement-breakpoint
grant execute on function finet.accept_invite(text) to finet_app;
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat pe tabelele noi, în aceeași migrație.
-- ---------------------------------------------------------------------------------------------
alter table finet.household_invites enable row level security;
--> statement-breakpoint
alter table finet.household_invites force row level security;
--> statement-breakpoint
alter table finet.transaction_splits enable row level security;
--> statement-breakpoint
alter table finet.transaction_splits force row level security;
--> statement-breakpoint
alter table finet.settlements enable row level security;
--> statement-breakpoint
alter table finet.settlements force row level security;
--> statement-breakpoint
-- Invitațiile: doar owner-ii gospodăriei curente le văd, le creează (în numele lor, active) și
-- le revocă. Hash-ul tokenului nu se poate citi (drepturi pe coloane, mai jos).
create policy household_invites_owner_select on finet.household_invites
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) = 'owner');
--> statement-breakpoint
create policy household_invites_owner_insert on finet.household_invites
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
              and (select finet.member_role(finet.current_household_id())) = 'owner'
              and created_by_user_id = (select finet.current_user_id())
              and used_at is null and used_by_user_id is null and revoked_at is null);
--> statement-breakpoint
create policy household_invites_owner_update on finet.household_invites
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) = 'owner')
  with check (household_id = (select finet.current_household_id())
              and (select finet.member_role(finet.current_household_id())) = 'owner');
--> statement-breakpoint
-- Împărțirile: toți membrii le văd (soldurile reciproce trebuie să fie aceleași pentru toți, fără
-- a vedea tranzacția sau contul personal); doar plătitorul le scrie și le șterge.
create policy transaction_splits_select on finet.transaction_splits
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy transaction_splits_insert on finet.transaction_splits
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
              and (select finet.member_role(finet.current_household_id())) is not null
              and payer_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy transaction_splits_delete on finet.transaction_splits
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and payer_user_id = (select finet.current_user_id()));
--> statement-breakpoint
-- Decontările: toți membrii le văd; un membru înregistrează o decontare în care e una dintre
-- părți, un owner pentru oricare doi membri; anulează oricare dintre părți sau creatorul (un owner
-- care nu e parte și nu a creat-o NU o anulează; revizuirea M2).
create policy settlements_select on finet.settlements
  for select to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null);
--> statement-breakpoint
create policy settlements_insert on finet.settlements
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
              and (select finet.member_role(finet.current_household_id())) is not null
              and created_by_user_id = (select finet.current_user_id())
              and cancelled_at is null and cancelled_by_user_id is null
              and ((select finet.current_user_id()) = from_user_id
                   or (select finet.current_user_id()) = to_user_id
                   or (select finet.member_role(finet.current_household_id())) = 'owner'));
--> statement-breakpoint
create policy settlements_cancel on finet.settlements
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         -- OR plat, scris explicit: un `x in (a, b, c)` devine `((x = a) OR (x = b)) OR (x = c)`
         -- în catalog, iar pg_dump îl reafișează aplatizat (amprenta restaurării ar diferi).
         and ((select finet.current_user_id()) = created_by_user_id
              or (select finet.current_user_id()) = from_user_id
              or (select finet.current_user_id()) = to_user_id))
  with check (household_id = (select finet.current_household_id())
              and cancelled_by_user_id = (select finet.current_user_id()));
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime, pe coloane. Fără DELETE pe invitații și decontări
-- (istoric; limita zilnică de invitații rămâne doar crescătoare). `user_preferences` are deja
-- drepturi pe tabel (0001), care acoperă și coloana nouă `active_household_id`.
-- ---------------------------------------------------------------------------------------------
revoke all on finet.household_invites, finet.transaction_splits, finet.settlements from public;
--> statement-breakpoint
grant select (id, household_id, role, created_by_user_id, created_at, expires_at, used_at,
  used_by_user_id, revoked_at) on finet.household_invites to finet_app;
--> statement-breakpoint
grant insert (id, household_id, token_hash, role, created_by_user_id, expires_at)
  on finet.household_invites to finet_app;
--> statement-breakpoint
grant update (revoked_at) on finet.household_invites to finet_app;
--> statement-breakpoint
grant select, insert, delete on finet.transaction_splits to finet_app;
--> statement-breakpoint
grant select on finet.settlements to finet_app;
--> statement-breakpoint
grant insert (id, household_id, from_user_id, to_user_id, amount_minor, currency, settled_on,
  note, created_by_user_id) on finet.settlements to finet_app;
--> statement-breakpoint
grant update (cancelled_at, cancelled_by_user_id) on finet.settlements to finet_app;
--> statement-breakpoint
-- household_members: doar rolul se schimbă (id, household_id, user_id, joined_at sunt fixe).
revoke update on finet.household_members from finet_app;
--> statement-breakpoint
grant update (role) on finet.household_members to finet_app;
