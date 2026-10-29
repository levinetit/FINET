-- FINET 0010_worker_queue_fairness (Faza 6, revizuirea de securitate F6-A+B): selecția
-- documentelor de procesat pentru worker devine echitabilă între gospodării și ignoră loturile
-- (bonuri lungi) eșuate. Scrisă de mână (`drizzle-kit generate --custom`; `when` din jurnal fixat
-- la 1793800000000, după 0009). Schema tabelelor nu se schimbă. ADR 0014.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Problema: `queued_documents` sorta GLOBAL după `created_at` și workerul cere 20 la fiecare
-- trecere; o gospodărie cu multe documente blocate (de exemplu pozele unui bon lung cu o poză
-- respinsă, rămase `queued`) ocupa toate locurile, iar documentele altor gospodării nu mai erau
-- procesate. Acum:
--   - cel mult 5 documente pe gospodărie la fiecare apel (`row_number()` pe gospodărie), ordonate
--     „pe rând” (prima poziție a fiecărei gospodării, apoi a doua …), apoi după vechime;
--   - documentele unui lot `failed` nu mai sunt întoarse (și nici de `queued_document`).
-- Proprietarul funcțiilor (finet_migrator) vede din `processing_batches` (FORCE RLS) DOAR loturile
-- `failed` (politica nouă `processing_batches_migrator_failed`), suficient pentru excludere.
-- Semnăturile, `SECURITY DEFINER`, `search_path = pg_catalog` și drepturile rămân aceleași.
--
-- Rollback (manual, de operator; workerul oprit): recreează cele două funcții cu corpul din
-- 0008_documents.sql (`queued_documents`) și 0009_receipt_pipeline.sql (`queued_document`), apoi
--   drop policy processing_batches_migrator_failed on finet.processing_batches;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0010_worker_queue_fairness>';
create policy processing_batches_migrator_failed on finet.processing_batches
  for select to finet_migrator
  using (status = 'failed');
--> statement-breakpoint
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
     where q.rn <= 5
     order by q.rn, q.created_at, q.id
     limit least(greatest(coalesce(p_limit, 0), 0), 100)
  $$;
--> statement-breakpoint
revoke all on function finet.queued_documents(integer, integer) from public;
--> statement-breakpoint
grant execute on function finet.queued_documents(integer, integer) to finet_app;
--> statement-breakpoint
create or replace function finet.queued_document(p_document_id uuid)
  returns table (document_id uuid, household_id uuid, actor_user_id uuid)
  language sql stable security definer
  set search_path = pg_catalog
  as $$
    select d.id, d.household_id, a.user_id
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
     where d.id = p_document_id
       and d.storage_key is not null
       and d.attempts < 10
       and d.status in ('queued', 'processing')
       and (d.batch_id is null
            or not exists (select 1 from finet.processing_batches b
                            where b.id = d.batch_id and b.status = 'failed'))
  $$;
--> statement-breakpoint
revoke all on function finet.queued_document(uuid) from public;
--> statement-breakpoint
grant execute on function finet.queued_document(uuid) to finet_app;
