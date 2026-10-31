-- FINET 0024_queue_priority (Faza 12-A.2, ADR 0035): prioritatea planului în coada workerului.
-- Scrisă de mână (fără schimbări de schemă). NU modifica fișierul după aplicare: runner-ul
-- (src/db/migrate.ts) compară hash-ul.
--
-- `finet.queued_documents` păstrează echitatea din 0010 (cel mult 5 documente pe gospodărie,
-- „pe rând”: întâi prima poziție a fiecărei gospodării, apoi a doua …). Singura schimbare: în
-- cadrul aceluiași rând, gospodăriile al căror plan viu are `limits."queue.priority"` mai mare
-- (număr întreg ≥ 0) sunt luate înaintea celorlalte, apoi după vechime. Fără plan viu,
-- fără cheie sau în `personal` (tabelele de planuri sunt goale) prioritatea e 0, deci ordinea
-- e exact cea de până acum. Corpul rămâne cel din 0010, cu aceleași drepturi, `SECURITY DEFINER`
-- și `search_path = pg_catalog`; funcția citește planul prin `finet.household_plan` (0023).
--
-- Rollback (manual, de operator; workerul oprit): recreează `finet.queued_documents` cu corpul din
-- 0010_worker_queue_fairness.sql și
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0024_queue_priority>';
create or replace function finet.queued_documents(p_limit integer, p_stale_seconds integer)
  returns table (document_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select q.id, q.household_id, q.user_id
      from (
        select d.id, d.household_id, a.user_id, d.created_at,
               pg_catalog.row_number() over (partition by d.household_id
                                             order by d.created_at, d.id) as rn
          from finet.documents d
          cross join lateral (
            select m.user_id
              from finet.household_members m
              join finet.users u on u.id = m.user_id and u.status = 'active'
             where m.household_id = d.household_id
               and (m.user_id = d.uploaded_by_user_id or m.role = 'owner')
             order by (m.user_id = d.uploaded_by_user_id) desc, m.joined_at, m.user_id
             limit 1
          ) a
         where d.storage_key is not null
           and d.attempts < 10
           and (d.status = 'queued'
                or (d.status = 'processing'
                    and (d.processing_started_at is null
                         or d.processing_started_at < pg_catalog.now()
                            - pg_catalog.make_interval(secs => greatest(coalesce(p_stale_seconds, 900), 60)))))
           and (d.batch_id is null
                or not exists (select 1 from finet.processing_batches b
                                where b.id = d.batch_id and b.status = 'failed'))
      ) q
      cross join lateral (
        select coalesce(
                 case when hp.state = 'ok'
                           and pg_catalog.jsonb_typeof(hp.limits -> 'queue.priority') = 'number'
                           and (hp.limits ->> 'queue.priority') ~ '^[0-9]{1,9}$'
                      then (hp.limits ->> 'queue.priority')::integer end,
                 0) as prio
          from finet.household_plan(q.household_id) hp
      ) p
     where q.rn <= 5
     order by q.rn, p.prio desc, q.created_at, q.id
     limit least(greatest(coalesce(p_limit, 0), 0), 100)
  $$;
--> statement-breakpoint
revoke all on function finet.queued_documents(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.queued_documents(integer, integer) to finet_app;
