# Trecerea de la `personal` la `saas` (Faza 12-D, ADR 0036)

Runbook pentru operator. **Agentul nu a rulat nimic din acest document.** Fiecare pas care atinge producția (backup, SQL pe Supabase, schimbarea `APP_MODE`, redeploy) cere o frază explicită a operatorului. Rămâne valabilă regula: producția `personal` nu se schimbă până nu decizi.

O singură bază de cod și o singură schemă (master prompt 3.3): trecerea înseamnă (1) un plan „fondator” pentru gospodăriile existente, (2) un plan implicit pentru cele noi, (3) schimbarea configurației. **Ordinea contează:** în `saas`, o gospodărie fără abonament și fără plan implicit primește `503 plans_not_configured` la orice scriere. Planurile se pregătesc deci ÎNAINTE de comutare.

## 0. Condiții înainte de a începe

- Migrațiile `0023` și `0024` sunt aplicate (`finet-migrate` raportează „aplicate acum 0”).
- Decizii ale tale, nescrise de agent: valorile planului implicit (limite, funcții), eventual perioada de probă, furnizorul de plată (nu Stripe; până atunci abonamente `manual`). Vezi `docs/INFRA.md` 4y.
- Pentru expunerea publică: `docs/EXPOSURE.md` (Access, Turnstile, SMTP, conținut legal). Acest runbook acoperă DOAR datele și comutarea; expunerea publică (`SAAS_PUBLIC_ACCESS`) e un pas separat, ulterior.
- Un backup proaspăt: `sudo sh /srv/finet/src/ops/backup/run-backup.sh`, cu verificarea restaurării recentă (`docs/BACKUP.md`).

## 1. Verificarea (doar citire)

Ca `finet_migrator`, cu `psql` (ca la `roles.sql`, `ops/supabase/README.md`):

```
psql "<url-migrator>?sslmode=verify-full&sslrootcert=<ca.crt>" -X -v ON_ERROR_STOP=1 \
     -f ops/saas/founder-plan-check.sql
```

Rezultat: `gospodarii`, `cu_abonament`, `fara_abonament`, `plan_fondator_exista`, `plan_implicit`. Notează-le.

## 2. Planul „fondator” pentru gospodăriile existente

```
psql "<url-migrator>?sslmode=verify-full&sslrootcert=<ca.crt>" -X -v ON_ERROR_STOP=1 \
     -v cutoff="'2026-11-01 12:00:00+00'" --single-transaction -f ops/saas/founder-plan.sql
```

`cutoff` e obligatoriu: doar gospodăriile create până la acel moment primesc fondator. Alege momentul pregătirii comutării, înainte să se deschidă vreo înregistrare publică (în `personal` gospodării noi apar doar din CLI, rar). Fără el, scriptul se oprește fără să scrie.

- Creează planul `founder` („fără limite”: valoarea maximă întreagă sigură la `ai.dailyDocuments`, `storage.quotaMb`, `household.maxMembers`, `documents.maxFileMb`; toate funcțiile cunoscute, inclusiv `receipts.archive`) doar dacă lipsește.
- Adaugă un abonament `founder`, fără sfârșit de perioadă (nu expiră singur), fiecărei gospodării FĂRĂ abonament. Un abonament existent nu se atinge.
- O a doua rulare cu ACELAȘI prag nu schimbă nimic și nu rescrie un plan pe care l-ai editat; gospodăriile create după prag nu primesc fondator.
- Limitele tehnice globale rămân (`AI_MONTHLY_BUDGET`, dimensiunea tehnică maximă a fișierului). `queue.priority` lipsește (0): coada rămâne echitabilă.

Rerulează pasul 1: `fara_abonament` trebuie să fie 0 și `plan_fondator_exista` 1.

**Rerulează `founder-plan.sql` imediat înainte de pasul 4**, cu un prag nou (momentul de acum), dar numai cât înregistrarea publică e încă oprită: un cont creat între acest pas și comutare altfel ar primi 503 în `saas`, fiindcă nu are abonament. Nu rula scriptul după deschiderea înregistrării.

## 3. Planul implicit (gospodăriile noi)

Gospodăriile create DUPĂ pasul 2 (înregistrări publice) nu primesc fondator. Fără un plan implicit ele sunt doar-citire/refuzate (503). Creează-l tu, cu valorile tale, după `docs/INFRA.md` 4y pct. 2 (`is_default = true`; cel mult unul activ). Un plan implicit fără `documents.*` în `features` nu primește fișiere; fără `ask.finet`/`reports.custom` acele funcții sunt oprite.

Dacă nu vrei înregistrare publică încă (doar utilizatorii tăi), poți sări peste acest pas: gospodăriile noi create manual se tratează cu un abonament `manual` (INFRA 4y pct. 3).

## 4. Comutarea configurației

`APP_MODE` este fixat în `ops/docker/docker-compose.yml` la `personal` pentru `finet-web`, `finet-worker`, `finet-migrate`, `finet-admin` și `finet-cleanup`. Pentru `saas` se schimbă în toate (un override compose sau editarea fișierului), apoi `saas` cere variabilele lui obligatorii (SMTP, datele firmei etc., validate la pornire: serverul refuză un mediu invalid, vezi `src/lib/config.ts` și `docs/INFRA.md`). Redeploy cu `docker compose … up -d finet-web finet-worker`.

Înainte de redeploy verifică ce se schimbă în `saas` (master prompt 3.3): ruta `/` devine pagina publică, `robots.txt` permite indexarea paginilor publice, înregistrarea rămâne oprită până la `SIGNUP_ENABLED=1`, iar limitele vin din plan. Accesul rămâne în spatele Cloudflare Access până activezi explicit `SAAS_PUBLIC_ACCESS` (ADR 0034).

## 5. Verificarea după comutare

- `/api/health` sănătos; autentificare cu un cont existent.
- O scriere (de exemplu un cont nou) merge; `select * from finet.household_plan('<gospodărie>');` arată `plan_code = founder`, `state = ok`.
- O gospodărie nouă, fără abonament, urmează planul implicit (sau 503 dacă nu există: asta înseamnă că pasul 3 lipsește).

## 6. Rollback

- **Configurația:** `APP_MODE=personal` și redeploy. Este calea sigură: `personal` ignoră complet tabelele de planuri, deci datele din `plans`/`subscriptions` pot rămâne.
- **Datele fondator** (numai dacă ele însele sunt problema, cu decizia ta): `delete from finet.subscriptions where provider = 'founder'; delete from finet.plans where code = 'founder';` (ca `finet_migrator`).
- Migrațiile `0023`/`0024` nu se anulează pentru un simplu rollback de mod (antetul lor descrie anularea completă, cu backup).
