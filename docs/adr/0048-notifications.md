# ADR 0048: notificări în aplicație, generate zilnic din date, cu email opțional

- **Stare:** propus (modernizare 2026, pasul J din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`).
- **Legături:** migrația `0028_notifications`, `src/db/schema/notifications.ts`, `src/modules/notifications/` (reguli pure, serviciu, repo), `src/worker/notifications/notify-jobs.ts`, `src/app/api/v1/_lib/notifications-handlers.ts`, paginile `/notifications` și `/settings/notifications`, bannerul din layout; ADR 0011 (workerul), ADR 0045–0047 (sursele datelor), ADR 0021 (exportul GDPR, care include acum notificările și preferințele).

## Context

Master prompt-ul cere notificări pentru plăți viitoare, limite de buget, cheltuieli neobișnuite, obiective, reînnoiri de abonamente, rezumatul lunar și eșecuri de sincronizare, pe canale potrivite (în aplicație, email, push Android), cu respectarea preferințelor. FINET nu avea nicio notificare pentru utilizator (doar alertele operatorului din `ops/notify` și actualizările live SSE ale familiei).

## Decizii

1. **Notificările sunt rânduri în baza de date**, pe utilizator și gospodărie, generate o dată pe zi de worker (`notify.evaluate`, 07:30 Europe/Bucharest), nu în timpul cererilor. Sursele sunt serviciile existente, apelate în numele membrului (`finet.notification_targets` dă doar id-urile, ca `due_recurring_rules`): prognoza (plăți în 3 zile), stările bugetelor (galben/roșu), consilierul (tranzacții neobișnuite), planul de economisire (termen în 7 zile sau depășit), abonamentele (reînnoiri în 3 zile), rezumatul lunii precedente (în ziua 1) și documentele/extrasele eșuate (ultimele 36 h). Fiecare candidat are un `dedup_key` stabil (unic pe utilizator): aceeași situație nu notifică de două ori; o situație nouă (altă scadență, altă lună) dă o cheie nouă.
2. **Vizibilitatea urmează RLS-ul membrului**: evaluarea rulează în contextul lui, deci notificările conțin doar ce vede el în aplicație (conturile personale ale altora rămân invizibile). Politica `notifications_own` permite doar rândurile proprii; aplicația poate actualiza doar `read_at` și `emailed_at`.
3. **Preferințe fail-open dar explicite:** fără rând în `notification_preferences`, toate tipurile sunt active în aplicație și emailul e oprit. `in_app = false` oprește evaluarea complet (nici email). Tipurile sunt o listă închisă (CHECK în bază și enum în Zod).
4. **Emailul e un digest**, cel mult unul pe zi, doar cu `email = true` și SMTP configurat la worker (același `createMailer` ca autentificarea, TLS obligatoriu în producție); conține aceleași texte ca în aplicație și linkuri spre pagini (din `APP_URL`), niciodată linkuri de autentificare; rândurile trimise primesc `emailed_at`. Fără SMTP nimic nu se trimite și nimic nu se marchează.
5. **Push Android nu intră în această iterație**: ar cere un proiect Firebase (chei, dependență nouă, consimțământ de dispozitiv). Aplicația Android citește `GET /api/v1/notifications` (același model, pasul M); push-ul rămâne o decizie a operatorului.
6. **API-ul merge și cu abonament expirat** (`handleAlways`): un utilizator trebuie să-și poată citi avertizările. Rutele: `GET /api/v1/notifications?unread=&limit=`, `POST /api/v1/notifications/{id}/read`, `POST /api/v1/notifications/read-all`, `DELETE /api/v1/notifications/{id}`, `GET/PUT /api/v1/me/notification-preferences`.
7. **Conținut minim în loguri și audit:** jobul loghează doar contoare și coduri; nu există evenimente de audit pentru notificări (nu sunt acțiuni ale utilizatorului). Exportul GDPR include notificările și preferințele; ștergerea contului le elimină în cascadă.
8. **Costul evaluării:** pe membru, câteva zeci de interogări agregate (prognoză, bugete, consilier, plan, abonamente); la zeci de gospodării, secunde pe zi. Dacă `saas` crește, se trece la evaluare pe loturi sau la coadă per gospodărie (`policy: exclusive`), fără schimbarea modelului de date.

## Consecințe

- Migrația `0028_notifications` e aditivă (două tabele, o funcție); se aplică pe producție doar cu fraza operatorului; workerul trebuie recreat după deploy ca jobul să fie programat.
- Pragurile (3 zile, 7 zile, 36 h) sunt constante în `rules.ts`, documentate în textele din `ro.notifications.kindHints`; schimbarea lor e o schimbare de produs.
- Rămân deschise: notificări „instantanee” (de exemplu la confirmarea unui bon de către alt membru) prin magistrala SSE existentă; push Android; o fereastră de „liniște” (fără email în weekend).
