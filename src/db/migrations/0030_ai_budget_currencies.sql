-- FINET 0030_ai_budget_currencies (reparație după modernizarea 2026, pasul K; ADR 0049): funcția
-- `finet.ai_budget_reserve` (0009) respingea cu 22023 orice monedă în afară de RON, EUR și USD, deși
-- 0029 a extins CHECK-ul `ai_budget_usage_currency_valid` și `AI_MONTHLY_BUDGET_CURRENCY`
-- (`src/lib/config.ts`, lista `CURRENCIES`) acceptă și HUF și GBP: un buget AI în HUF/GBP ar fi
-- blocat orice apel extern. Scrisă de mână (fără schimbări de schemă); lista de monede de mai
-- jos trebuie să rămână egală cu `CURRENCIES` din `src/lib/money.ts` (un test o păzește).
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- `create or replace` cu ACEEAȘI semnătură: proprietarul și drepturile existente se păstrează
-- (revoke/grant sunt repetate explicit, idempotent). Corpul e cel din 0009, cu singura diferență
-- lista de monede. Lock: doar pe catalogul funcției, instantaneu; nicio rescriere de date.
--
-- Rollback (manual, de operator, cu backup): reaplică corpul din 0009 (lista ('RON', 'EUR', 'USD'))
-- printr-un `create or replace function` identic cu cel din `0009_receipt_pipeline.sql`;
-- NU șterge rândul din `finet.__drizzle_migrations` (hash-ul migrației rămâne evidență).
create or replace function finet.ai_budget_reserve(p_cost bigint, p_budget bigint, p_currency text)
  returns boolean
  language plpgsql volatile security definer
  set search_path = pg_catalog
  as $$
  declare
    v_month date := date_trunc('month', pg_catalog.now() at time zone 'Europe/Bucharest')::date;
  begin
    if p_cost is null or p_cost < 1 or p_cost > 10000000000000 then
      raise exception 'ai_budget_reserve: cost invalid' using errcode = '22023';
    end if;
    if p_currency is null or p_currency not in ('RON', 'EUR', 'USD', 'HUF', 'GBP') then
      raise exception 'ai_budget_reserve: monedă invalidă' using errcode = '22023';
    end if;
    if p_budget is null or p_budget <= 0 then
      return false;
    end if;
    insert into finet.ai_budget_usage (month, currency) values (v_month, p_currency)
      on conflict (month, currency) do nothing;
    update finet.ai_budget_usage
       set reserved_minor = reserved_minor + p_cost,
           calls = calls + 1,
           updated_at = pg_catalog.now()
     where month = v_month and currency = p_currency
       and reserved_minor + p_cost <= least(p_budget, 10000000000000);
    return found;
  end
  $$;
--> statement-breakpoint
revoke all on function finet.ai_budget_reserve(bigint, bigint, text) from public;
--> statement-breakpoint
grant execute on function finet.ai_budget_reserve(bigint, bigint, text) to finet_app;
