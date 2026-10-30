-- FINET 0018_report_definitions (Faza 10, F10-B): definițiile rapoartelor de micro-cheltuieli
-- (`report_definitions`): reguli de potrivire pe numele normalizat al produselor de pe bonuri,
-- ca DATE (nu cod). Rapoartele de sistem (`household_id` NULL, `is_system`) sunt inserate aici;
-- cele ale gospodăriilor se creează prin API. Deciziile: docs/adr/0023-prices-reports.md.
-- Prima parte e generată de `drizzle-kit generate --name report_definitions` (într-o COPIE a
-- repo-ului, ca fișierele de migrare existente să nu fie atinse) din src/db/schema/reports.ts;
-- fișierul și `when` din jurnal sunt redenumite/fixate de mână (0018, 1795000000000: 0017 e
-- rezervată listelor de cumpărături F10-A). A doua parte (după „PARTEA SCRISĂ DE MÂNĂ”) e scrisă
-- de mână. NU modifica fișierul după aplicare: runner-ul compară hash-ul.
--
-- Efect pe tabelele existente: NICIUNUL (tabel nou; fără ALTER pe tabele existente).
--
-- Rollback (doar manual, de operator, cu backup înainte; DISTRUGE rapoartele proprii ale
-- gospodăriilor):
--   drop table finet.report_definitions;  -- șterge și politicile, indecșii și triggerul
--   drop function finet.report_definitions_check_cap();
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0018_report_definitions>';
CREATE TABLE "finet"."report_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb NOT NULL,
	"advice" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_definitions_name_length" CHECK (char_length("finet"."report_definitions"."name") >= 1 and char_length("finet"."report_definitions"."name") <= 80 and "finet"."report_definitions"."name" = btrim("finet"."report_definitions"."name")),
	CONSTRAINT "report_definitions_description_length" CHECK ("finet"."report_definitions"."description" is null or char_length("finet"."report_definitions"."description") <= 500),
	CONSTRAINT "report_definitions_advice_length" CHECK ("finet"."report_definitions"."advice" is null or char_length("finet"."report_definitions"."advice") <= 500),
	CONSTRAINT "report_definitions_rules_shape" CHECK (jsonb_typeof("finet"."report_definitions"."rules") = 'object' and pg_column_size("finet"."report_definitions"."rules") <= 8192 and "finet"."report_definitions"."rules" ->> 'v' = '1'),
	CONSTRAINT "report_definitions_scope_shape" CHECK (("finet"."report_definitions"."household_id" is null) = "finet"."report_definitions"."is_system"),
	CONSTRAINT "report_definitions_system_no_author" CHECK (not "finet"."report_definitions"."is_system" or "finet"."report_definitions"."created_by_user_id" is null)
);
--> statement-breakpoint
ALTER TABLE "finet"."report_definitions" ADD CONSTRAINT "report_definitions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "finet"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finet"."report_definitions" ADD CONSTRAINT "report_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "finet"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_definitions_household_archived_idx" ON "finet"."report_definitions" USING btree ("household_id","archived");--> statement-breakpoint
CREATE INDEX "report_definitions_created_by_user_id_idx" ON "finet"."report_definitions" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_definitions_household_name_active_key" ON "finet"."report_definitions" USING btree ("household_id",lower("name")) WHERE not "finet"."report_definitions"."archived";--> statement-breakpoint
CREATE UNIQUE INDEX "report_definitions_system_name_key" ON "finet"."report_definitions" USING btree (lower("name")) WHERE "finet"."report_definitions"."is_system";
--> statement-breakpoint
-- =============================================================================================
-- PARTEA SCRISĂ DE MÂNĂ (nu e generată de drizzle-kit)
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Rapoartele de SISTEM (id-uri fixe; constanta `SYSTEM_REPORTS` din
-- src/modules/report-definitions/system-definitions.ts le oglindește, un test compară rândurile).
-- Inserate ÎNAINTE de activarea RLS (FORCE se aplică și proprietarului). Se schimbă doar printr-o
-- migrație nouă: aplicația nu poate scrie rânduri cu `household_id` NULL.
-- ---------------------------------------------------------------------------------------------
insert into finet.report_definitions (id, household_id, name, description, rules, advice, is_system)
values ('a10b0000-0000-4000-8000-000000000001', null, 'Pungi și sacoșe', 'Pungile și sacoșele plătite la casă (nu și pungile de menaj sau de gunoi).',
  '{"v":1,"categoryIds":[],"tagIds":[],"combine":"any","include":[{"type":"token","value":"punga"},{"type":"token","value":"pungi"},{"type":"token","value":"sacosa"},{"type":"token","value":"sacose"}],"exclude":[{"type":"token","value":"menaj"},{"type":"token","value":"gunoi"},{"type":"token","value":"congelare"},{"type":"token","value":"congelator"},{"type":"token","value":"frigider"},{"type":"token","value":"sandwich"}],"kinds":["product","bag","other"]}'::jsonb,
  'Pungile și sacoșele de la casă se plătesc la fiecare cumpărătură. O sacoșă refolosibilă adusă de acasă elimină această cheltuială.', true);
--> statement-breakpoint
insert into finet.report_definitions (id, household_id, name, description, rules, advice, is_system)
values ('a10b0000-0000-4000-8000-000000000002', null, 'Garanția SGR: plătită și recuperată', 'Garanțiile SGR plătite pe bonuri (ambalaje returnabile) față de cele recuperate prin bonurile de retur.',
  '{"v":1,"categoryIds":[],"tagIds":[],"combine":"any","include":[{"type":"token","value":"sgr"},{"type":"token","value":"garantie"},{"type":"token","value":"garantii"},{"type":"token","value":"deposit"},{"type":"contains","value":"ambalaj returnabil"},{"type":"contains","value":"retur ambalaj"}],"exclude":[],"kinds":["deposit_sgr","discount"]}'::jsonb,
  'Garanția SGR este de 0,50 lei pentru fiecare ambalaj returnabil și se recuperează doar dacă returnezi ambalajul și folosești bonul de retur. Diferența dintre plătit și recuperat arată garanțiile încă nerecuperate pe bonurile tale; returnările făcute la un automat pot să nu apară pe bonuri.', true);
--> statement-breakpoint
insert into finet.report_definitions (id, household_id, name, description, rules, advice, is_system)
values ('a10b0000-0000-4000-8000-000000000003', null, 'Cumpărături de la casă', 'Dulciuri, gumă de mestecat și batoane, cumpărate de obicei în ultimul moment.',
  '{"v":1,"categoryIds":[],"tagIds":[],"combine":"any","include":[{"type":"token","value":"guma"},{"type":"token","value":"gume"},{"type":"token","value":"bomboane"},{"type":"token","value":"bomboana"},{"type":"token","value":"ciocolata"},{"type":"token","value":"baton"},{"type":"token","value":"batoane"},{"type":"token","value":"napolitana"},{"type":"token","value":"napolitane"},{"type":"token","value":"jeleuri"},{"type":"token","value":"dropsuri"},{"type":"token","value":"acadele"},{"type":"token","value":"lizoi"},{"type":"token","value":"drajeuri"},{"type":"token","value":"snickers"},{"type":"token","value":"twix"},{"type":"token","value":"bounty"},{"type":"token","value":"kitkat"},{"type":"token","value":"mentos"},{"type":"token","value":"orbit"}],"exclude":[],"kinds":["product","other"]}'::jsonb,
  'Produsele de la casă se cumpără adesea fără să fie pe lista de cumpărături. Compară totalul cu ce îți propuseseși să cumperi.', true);
--> statement-breakpoint
insert into finet.report_definitions (id, household_id, name, description, rules, advice, is_system)
values ('a10b0000-0000-4000-8000-000000000004', null, 'Nealimentare la supermarket', 'Produse de igienă și de menaj cumpărate odată cu alimentele.',
  '{"v":1,"categoryIds":[],"tagIds":[],"combine":"any","include":[{"type":"token","value":"sampon"},{"type":"token","value":"balsam"},{"type":"token","value":"sapun"},{"type":"token","value":"deodorant"},{"type":"token","value":"detergent"},{"type":"token","value":"dezinfectant"},{"type":"token","value":"odorizant"},{"type":"token","value":"servetele"},{"type":"token","value":"burete"},{"type":"token","value":"prosop"},{"type":"token","value":"prosoape"},{"type":"token","value":"periuta"},{"type":"token","value":"lotiune"},{"type":"token","value":"absorbante"},{"type":"token","value":"tampoane"},{"type":"contains","value":"hartie igienica"},{"type":"contains","value":"pasta de dinti"},{"type":"contains","value":"pasta dinti"},{"type":"contains","value":"gel de dus"},{"type":"contains","value":"gel dus"}],"exclude":[],"kinds":["product","other"]}'::jsonb,
  'Compară prețul pe unitate între magazine, în secțiunea Prețuri, înainte să cumperi astfel de produse în cantități mari.', true);
--> statement-breakpoint
insert into finet.report_definitions (id, household_id, name, description, rules, advice, is_system)
values ('a10b0000-0000-4000-8000-000000000005', null, 'Cafea și băuturi la bucată', 'Cafea, sucuri, apă, bere și alte băuturi cumpărate la bucată (fără ambalajele mari de cafea).',
  '{"v":1,"categoryIds":[],"tagIds":[],"combine":"any","include":[{"type":"token","value":"cafea"},{"type":"token","value":"espresso"},{"type":"token","value":"cappuccino"},{"type":"token","value":"capuccino"},{"type":"token","value":"latte"},{"type":"token","value":"frappe"},{"type":"token","value":"ceai"},{"type":"token","value":"suc"},{"type":"token","value":"cola"},{"type":"token","value":"pepsi"},{"type":"token","value":"fanta"},{"type":"token","value":"sprite"},{"type":"token","value":"nestea"},{"type":"token","value":"bere"},{"type":"token","value":"energizant"},{"type":"token","value":"monster"},{"type":"token","value":"apa"},{"type":"token","value":"limonada"},{"type":"contains","value":"red bull"},{"type":"contains","value":"izotonic"}],"exclude":[{"type":"token","value":"boabe"},{"type":"token","value":"macinata"},{"type":"token","value":"solubila"},{"type":"token","value":"instant"},{"type":"token","value":"capsule"},{"type":"token","value":"plicuri"},{"type":"token","value":"pliculete"},{"type":"token","value":"bax"},{"type":"token","value":"set"},{"type":"token","value":"multipack"},{"type":"token","value":"colonie"},{"type":"token","value":"gura"},{"type":"token","value":"oxigenata"},{"type":"contains","value":"kg"},{"type":"contains","value":"6x"},{"type":"contains","value":"12x"},{"type":"contains","value":"24x"},{"type":"contains","value":"4x"},{"type":"contains","value":"250g"},{"type":"contains","value":"500g"}],"kinds":["product","other"]}'::jsonb,
  'Compară prețul pe litru al aceluiași produs în ambalaje diferite, în secțiunea Prețuri.', true);
--> statement-breakpoint
insert into finet.report_definitions (id, household_id, name, description, rules, advice, is_system)
values ('a10b0000-0000-4000-8000-000000000006', null, 'Economii din reduceri și carduri', 'Reducerile, cupoanele și avantajele cardurilor de fidelitate scăzute pe bonuri (fără retururile SGR).',
  '{"v":1,"categoryIds":[],"tagIds":[],"combine":"any","include":[],"exclude":[{"type":"token","value":"sgr"},{"type":"token","value":"garantie"},{"type":"token","value":"garantii"},{"type":"contains","value":"retur ambalaj"}],"kinds":["discount"]}'::jsonb,
  'Totalul arată cât s-a scăzut efectiv din bonurile tale prin reduceri și carduri de fidelitate, așa cum apare pe bon.', true);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Plafonul de definiții pe gospodărie (100). Trigger SECURITY INVOKER; blocarea consultativă pe
-- gospodărie serializează inserările concurente (altfel două cereri ar putea trece amândouă
-- pragul). Eroarea poartă doar codul și numele constrângerii, fără valori.
-- ---------------------------------------------------------------------------------------------
create function finet.report_definitions_check_cap() returns trigger
  language plpgsql security invoker
  set search_path = pg_catalog
  as $$
  begin
    if new.household_id is null then
      return new;
    end if;
    perform pg_advisory_xact_lock(pg_catalog.hashtextextended('report_definitions:' || new.household_id::text, 0));
    if (select count(*) from finet.report_definitions r where r.household_id = new.household_id) >= 100 then
      raise exception 'report_definitions: plafonul de definiții pe gospodărie'
        using errcode = '54000', constraint = 'report_definitions_cap';
    end if;
    return new;
  end
  $$;
--> statement-breakpoint
create trigger report_definitions_check_cap
  before insert on finet.report_definitions
  for each row execute function finet.report_definitions_check_cap();
--> statement-breakpoint
revoke all on function finet.report_definitions_check_cap() from public;
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- RLS: activat ȘI forțat. Politici pe comandă:
-- - SELECT: rapoartele de sistem (`household_id` NULL) pentru orice utilizator autentificat;
--   cele ale gospodăriei doar pentru membrii ei;
-- - INSERT / UPDATE / DELETE: DOAR rânduri ale gospodăriei curente, ca membru, niciodată de
--   sistem (rândurile de sistem nu au `household_id`, deci nu pot fi atinse);
-- - INSERT: autorul trebuie să fie utilizatorul curent.
-- ---------------------------------------------------------------------------------------------
alter table finet.report_definitions enable row level security;
--> statement-breakpoint
alter table finet.report_definitions force row level security;
--> statement-breakpoint
create policy report_definitions_select on finet.report_definitions
  for select to finet_app
  using ((select finet.current_user_id()) is not null
         and (household_id is null
              or (household_id = (select finet.current_household_id())
                  and (select finet.member_role(finet.current_household_id())) is not null)));
--> statement-breakpoint
create policy report_definitions_insert on finet.report_definitions
  for insert to finet_app
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and not is_system
         and created_by_user_id = (select finet.current_user_id()));
--> statement-breakpoint
create policy report_definitions_update on finet.report_definitions
  for update to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and not is_system)
  with check (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and not is_system);
--> statement-breakpoint
create policy report_definitions_delete on finet.report_definitions
  for delete to finet_app
  using (household_id = (select finet.current_household_id())
         and (select finet.member_role(finet.current_household_id())) is not null
         and not is_system);
--> statement-breakpoint
-- ---------------------------------------------------------------------------------------------
-- Drepturile lui finet_app: explicite, minime. Nu se schimbă după creare: id, household_id,
-- is_system, created_by_user_id, created_at.
-- ---------------------------------------------------------------------------------------------
revoke all on finet.report_definitions from public;
--> statement-breakpoint
grant select, insert, delete on finet.report_definitions to finet_app;
--> statement-breakpoint
grant update (name, description, rules, advice, archived, updated_at)
  on finet.report_definitions to finet_app;
