# ADR 0053: sondaje rare și conexiuni păstrate, pentru egress-ul Supabase

- **Stare:** propus (2026-11-23; cere deploy-ul imaginii `tools` de către operator, fără migrație).
- **Legături:** `src/worker/main.ts` (`POLLING_SECONDS`), `src/worker/boss.ts` (`bossOptions`, `DB_IDLE_TIMEOUT_SECONDS`), `src/db/index.ts` (`idleTimeoutSeconds`), ADR 0011 (workerul pg-boss), `docs/INFRA.md` secțiunea 5.

## Context

Supabase a anunțat (email către operator, 2026-11) că organizația depășește cota de egress a planului Free (5,5 GB pe perioadă de facturare) și că politica de utilizare echitabilă se aplică de la 2026-12-23. FINET folosește Supabase doar ca Postgres (ADR 0002), deci tot egress-ul vine din interogări.

**Măsurat** pe producție (2026-11-23, containerul `finet-worker` pornit de 10,6 zile): 2,86 GB primiți și 7,4 GB trimiși pe `eth0`, toate către pooler-ul Supabase; o fereastră de 120 s a dat 3,17 KB/s primiți (≈ 8 GB / 30 de zile, ≈ 6,8 GB după scăderea antetelor TCP/IP). `finet-web`: 55 MB în 10 zile. Backup-ul: dump de ~0,65 MiB pe zi (≈ 20 MB/lună). Fișierele sunt pe disc local (`STORAGE_DRIVER=local`): 0 din Supabase Storage.

**Cauza**, reprodusă local cu un proxy care numără octeții pe tip de interogare, cu aceleași cozi și cron-uri ca workerul (pg-boss 12.38.2, 9 cozi): lucrătorii pg-boss sondează implicit la 2 s fiecare (~4,5 interogări/s, ~284 B primiți fiecare), iar rezolvitorul intern de „flow-uri” (dependențe între joburi, nefolosit de FINET) citește la 5 s toate cozile (~3,6 KB). Împreună ~2,4 KB/s pe o bază fără niciun job. Un al doilea strat: conexiunile se închideau după 10 s (`pg`) sau 30 s (postgres.js) de inactivitate, iar la sondaje mai rare fiecare ciclu ar fi deschis una nouă (~4,5 KB de handshake TLS + pornire).

## Decizii

1. **Sondaje pe categorii** (`POLLING_SECONDS`): `sweep` 15 s (cozile `*.sweep` primesc un job pe minut din cron), `process` 30 s, `scheduled` 60 s (joburi orare/zilnice). `recurring.generate-now` (nefolosit de serverul web, ADR 0012) folosește `process`.
2. **Trezirea lucrătorului `process`:** sweep-ul care a trimis joburi apelează `boss.notifyWorker(<id lucrător process>)` (același proces), deci procesarea unui bon/extras/comparație pornește imediat, nu după sondajul de 30 s. Sondajul rămâne plasă de siguranță (reîncercări cu pauză de 60-120 s, joburi rămase după o repornire).
3. **`flowIntervalSeconds: 3600`** (implicit 5): FINET nu folosește `dependsOn`; rămâne o trecere pe oră, fără să dezactiveze supravegherea (expirări, retenție).
4. **`cronWorkerIntervalSeconds: 10`** (implicit 5; maximul pg-boss e 45): sweep-urile sunt la minut.
5. **Conexiuni păstrate 120 s** (`DB_IDLE_TIMEOUT_SECONDS`, `idleTimeoutMillis` la pg-boss și `idle_timeout` la postgres.js): peste cel mai lung ciclu repetitiv (60 s). Local: 26 de conexiuni noi / 5 minute → 0.
6. **Neschimbat:** `LISTEN/NOTIFY` (`notify: true` pe cozi) NU se activează: ar elimina aproape tot sondajul, dar cere o conexiune de ascultare permanentă prin pooler-ul Supabase în modul sesiune și schimbă comportamentul cozilor într-un mod care nu se poate verifica fără baza reală; se reevaluează dacă Free rămâne obiectiv. Backup-ul rămâne zilnic (nu contează: ~20 MB/lună). `supervise`, `maintenance` și semnalul de viață (60 s) rămân.

## Rezultate (local, pg-boss REAL + proxy de octeți, doar sarcina de fond a workerului, fără TLS)

| Variantă | Primit | Estimare / 30 zile |
|---|---|---|
| implicit pg-boss (ca până acum) | 2.362 B/s | 6,1 GB |
| doar sondaj 30 s | 1.203 B/s | 3,1 GB |
| + `flowIntervalSeconds` 3600 | 464 B/s | 1,2 GB |
| varianta aleasă, cu conexiunile păstrate | 419 B/s | 1,1 GB |

Pe producție se adaugă TLS, sweep-urile și semnalul de viață (mici): estimare 1,3-1,6 GB/lună de la worker, față de ~7-8 GB.

## Consecințe

- Latența unui bon încărcat crește cu cel mult ~15-20 s (sondajul cron-ului de 10 s și al sweep-ului de 15 s), de la ≤ ~65 s la ≤ ~85 s; apoi procesarea începe imediat. E2E-urile așteaptă 200 s.
- Joburile `process` rămase în coadă fără sweep (de exemplu după o repornire) pornesc în cel mult 30 s.
- Un dezvoltator care adaugă o coadă nouă trebuie să-i aleagă categoria din `POLLING_SECONDS` (implicitul pg-boss, 2 s, reapare altfel); `worker.test.ts` păzește valorile și `pgboss.test.ts` trezirea.
- Efectul apare doar după ce operatorul trage imaginea `tools` nouă și recreează `finet-worker` (docs/INFRA.md); `finet-web` nu se schimbă.
