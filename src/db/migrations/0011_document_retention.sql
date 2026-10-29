-- FINET 0011_document_retention (Faza 6, F6-C): selecția documentelor cu retenția expirată, pentru
-- comanda de administrare `cleanup-documents` (ștergerea originalelor la `expires_at`,
-- `RECEIPT_IMAGE_RETENTION_DAYS`). Scrisă de mână (`drizzle-kit generate --custom`; `when` din
-- jurnal fixat la 1793900000000, după 0010). Schema tabelelor nu se schimbă. ADR 0015.
-- NU modifica fișierul după aplicare: runner-ul (src/db/migrate.ts) compară hash-ul.
--
-- Același model ca `queued_documents` (0008): CLI-ul rulează ca finet_app (NOBYPASSRLS) și nu
-- vede niciun document fără contextul unei gospodării. Funcția rulează ca proprietarul
-- (finet_migrator), căruia FORCE RLS îi arată din `documents` DOAR rândurile expirate cu fișier
-- (politica nouă `documents_migrator_expired`), și întoarce DOAR identificatori: documentul,
-- gospodăria și membrul în numele căruia se face ștergerea (cel care a încărcat, dacă e încă
-- membru activ; altfel cel mai vechi proprietar activ; altfel documentul e omis). Fără chei de
-- storage, nume sau sume. Ștergerea propriu-zisă (fișierul, apoi `storage_key = NULL`,
-- `file_deleted_at`) o face CLI-ul ca acel membru, sub RLS, cu drepturile pe coloane din 0008.
-- Documentele în lucru (`queued`, `processing`) nu sunt întoarse (workerul le-ar citi).
-- Garda: `p_limit` plafonat la 0..500.
--
-- Rollback (manual, de operator):
--   drop function finet.expired_documents(integer);
--   drop policy documents_migrator_expired on finet.documents;
--   delete from finet.__drizzle_migrations where hash = '<hash-ul 0011_document_retention>';
create policy documents_migrator_expired on finet.documents
  for select to finet_migrator
  using (storage_key is not null and expires_at is not null and expires_at <= pg_catalog.now());
--> statement-breakpoint
create function finet.expired_documents(p_limit integer)
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
     where d.storage_key is not null
       and d.expires_at is not null
       and d.expires_at <= pg_catalog.now()
       and d.status <> 'queued'
       and d.status <> 'processing'
     order by d.expires_at, d.id
     limit least(greatest(coalesce(p_limit, 0), 0), 500)
  $$;
--> statement-breakpoint
revoke all on function finet.expired_documents(integer) from public;
--> statement-breakpoint
grant execute on function finet.expired_documents(integer) to finet_app;
