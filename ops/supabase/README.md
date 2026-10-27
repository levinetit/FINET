# Supabase pentru FINET (pașii operatorului)

Totul de aici se face **doar de operator**. Agentul nu are acces la Supabase și nu a rulat nimic din acest director. Referințe: master prompt 3.5, `docs/GHID_CONSTRUIRE.md` 4.4, `docs/INFRA.md`.

Numele exacte ale meniurilor din panoul Supabase se pot schimba; dacă un pas nu se găsește la calea indicată, caută opțiunea după nume și notează diferența în `docs/INFRA.md`.

## 1. Proiectul
1. **New project**, regiune în UE: **Frankfurt (`eu-central-1`)**.
2. Parola bazei generată de Supabase → doar în managerul de parole al operatorului.
3. Notează versiunea majoră PostgreSQL (Settings → Infrastructure) și actualizează `ops/postgres/VERSION` și imaginea din `.devcontainer/docker-compose.yml` într-un PR (acum `17` e provizoriu).
4. Planul (gratuit sau plătit) se decide de operator și se notează într-un ADR (planul gratuit suspendă proiectul după inactivitate și nu are backup-uri descărcabile).

## 2. Securitate (obligatorie, verificată la acceptarea Fazei 0)
1. **Data API (PostgREST):** dezactivat (Settings → Data API). Dacă nu se poate dezactiva, schema `finet` **nu** apare în „Exposed schemas”.
2. **SSL:** Settings → Database → SSL Configuration → *Enforce SSL* pornit. Descarcă certificatul CA; pe server îl pui în `/srv/finet/ca/supabase-ca.crt` (644) și îl montezi în container (vezi `docs/INFRA.md`, „Supabase din container”).
3. **Network Restrictions:** Settings → Database → Network Restrictions: doar IP-ul de ieșire al VPS-ului docker-apps (`curl -s https://ifconfig.me` rulat pe server; atenție, IP-ul de ieșire al containerelor de pe `apps` e același cu al hostului doar dacă nu există un NAT/proxy separat; verifică din container). Temporar și IP-ul operatorului, pentru administrare; apoi îl scoți.
4. **Cheile `anon` și `service_role`:** nu se folosesc nicăieri în FINET (nici în env, nici în APK).

## 3. Rolurile și schema
Din `ops/supabase/roles.sql`, cu **psql** (instrucțiunile sunt în antetul fișierului). Parolele se dau prin variabile de mediu, nu în linia de comandă.

Rezultatul așteptat al interogărilor de verificare de la final:

| Verificare | Așteptat |
|---|---|
| `finet_app.rolbypassrls` | `f` |
| `finet_migrator.rolsuper`, `finet_app.rolsuper` | `f` |
| proprietarul schemei `finet` | `finet_migrator` |
| `usage` pentru `anon`, `authenticated` | `f` |
| `usage` pentru `finet_app` | `t` |

**Posibilă eroare, de verificat:** în unele versiuni PostgreSQL, `create schema finet authorization finet_migrator` cere ca utilizatorul curent (`postgres`) să fie membru al rolului `finet_migrator`. Dacă primești `must be able to SET ROLE "finet_migrator"`, rulează în aceeași sesiune `grant finet_migrator to postgres;` înaintea comenzii (după ce ai șters, dacă e cazul, rolurile create parțial: scriptul rulează într-o tranzacție, deci o eroare nu lasă nimic pe jumătate). Comportamentul exact nu a fost verificat pe Supabase.

Drepturile pe tabele (`finet_app` doar `select/insert/update/delete`) și politicile RLS vin din migrațiile Drizzle (Faza 1+), rulate cu `MIGRATOR_DATABASE_URL`.

## 4. Conexiunile
Din **Connect** în panou. Formatul utilizatorului pentru pooler e `<rol>.<ref-proiect>`.

| Variabilă | Mod pooler | Port | Rol |
|---|---|---|---|
| `DATABASE_URL` | tranzacție | 6543 | `finet_app` |
| `WORKER_DATABASE_URL` | sesiune | 5432 | `finet_app` |
| `MIGRATOR_DATABASE_URL` | sesiune | 5432 | `finet_migrator` |

Toate cu `sslmode=verify-full`. Valorile reale stau doar în `/srv/finet/env/finet*.env` (600, câte unul pe rol: `finet.env`, `finet.worker.env`, `finet.migrate.env`). Limitele de conexiuni ale planului: de completat în `docs/INFRA.md`.

## 5. Storage (bucket privat)
1. Storage → New bucket `finet-documents`, **privat**.
2. Settings → Storage → S3 Connection: o cheie de acces S3 → doar în `finet.env` (`STORAGE_S3_*`).
3. **În Faza 0 nu se folosește:** driverul S3 e un schelet (`STORAGE_DRIVER=s3` dă `storage: unknown` și `/api/health` = `degraded`). Compose-ul fixează `STORAGE_DRIVER=local`. Trecerea pe S3 vine în Faza 6.

## 6. Verificări de acceptare (toate NOT RUN – așteaptă operatorul)
- Conexiune din containerul `finet-web` prin pooler cu `sslmode=verify-full` → `/api/health` arată `db: ok`.
- Cerere Data API cu cheia `anon` pe un tabel din `finet` → refuzată (de exemplu `curl` către `https://<ref>.supabase.co/rest/v1/<tabel>` cu antetul `Accept-Profile: finet` → eroare, nu date). Testul automat vine odată cu primul tabel (Faza 1).
- `psql` de pe un IP care nu e în Network Restrictions → conexiune refuzată.
