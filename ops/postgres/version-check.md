# Jobul săptămânal „versiune majoră PostgreSQL nouă” — NEIMPLEMENTAT

**Stare: neimplementat.** Depinde de proiectul Supabase (încă necreat) și de un token pentru Management API pe care doar operatorul îl poate emite. Acest document descrie jobul care se implementează după ce există proiectul (master prompt 3.5).

## Ce face
1. O dată pe săptămână (de exemplu luni, 09:00 `Europe/Bucharest`), citește versiunea majoră curentă din `ops/postgres/VERSION`.
2. Întreabă Supabase ce versiuni de upgrade sunt disponibile pentru proiect.
3. Dacă există o versiune majoră mai mare decât cea curentă, trimite **o singură** notificare prin `ops/notify/notify.sh` (de exemplu „Supabase oferă PostgreSQL 18 pentru proiectul FINET; procedura: docs/INFRA.md, Upgrade PostgreSQL”) și ține minte versiunea anunțată, ca să nu repete mesajul în fiecare săptămână.
4. Nu face niciodată upgrade-ul: acesta se pornește manual din panou, după procedura din `docs/INFRA.md`.
5. Dacă interogarea eșuează de 2 ori la rând, trimite o notificare de eroare (fără detalii sensibile).

## Sursa informației (de verificat la implementare)
- Management API Supabase: `GET https://api.supabase.com/v1/projects/{ref}/upgrade/eligibility` (marcat „experimental” în tipurile OpenAPI publicate de Supabase la 2026-10-27). Răspunsul include versiunile țintă disponibile. Structura exactă se verifică în documentația curentă înainte de implementare.
- Autentificare: un Personal Access Token Supabase, cu drepturi minime, păstrat doar pe server (`SUPABASE_ACCESS_TOKEN` în fișierul de mediu al jobului; variabilă nouă, încă nefolosită de aplicație).

## Unde rulează (propunere)
- Un container efemer pornit de cron-ul de pe docker-apps **nu** se adaugă fără aprobare (regula hostului: cron-urile root se editează doar cu `crontab -e`).
- Varianta preferată: job pg-boss programat în `finet-worker`, după ce workerul există (Faza 5/6).
- Alternativ: workflow GitHub Actions programat, doar dacă operatorul acceptă un secret `SUPABASE_ACCESS_TOKEN` în GitHub.

## Legătura cu CI
`.github/workflows/ci.yml` rulează testele pe `postgres:<VERSION>-alpine`. Workflow-ul săptămânal care rulează testele și pe versiunea majoră următoare (master prompt 3.5) e și el **neimplementat**.
