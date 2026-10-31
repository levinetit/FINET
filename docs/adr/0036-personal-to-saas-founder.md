# ADR 0036: trecerea `personal` → `saas` și planul „fondator” (Faza 12-D)

- **Stare:** propus (branch `phase/12d-personal-to-saas`). Nu schimbă schema; **nu cere migrație**. Nu rulează nimic pe producție.
- **Legături:** master prompt 3.3 și Faza 12, ADR 0035 (planuri), ADR 0034 (expunere), `docs/MIGRARE_PERSONAL_SAAS.md`, SECURITY_CHECKLIST §39.

## Problema

Master prompt 3.3: la trecerea la `saas`, gospodăriile existente primesc un plan „fondator” fără limite. În `saas`, fără abonament și fără plan implicit, orice scriere primește 503 (ADR 0035, fail closed). Fără o procedură, comutarea ar bloca imediat utilizatorii de azi.

## Decizii

1. **Un script SQL, nu cod de aplicație.** `ops/saas/founder-plan.sql`, rulat de operator ca `finet_migrator` cu `psql --single-transaction`. Aplicația (`finet_app`) nu poate scrie `plans`/`subscriptions` (ADR 0035 pct. 2); un CLI de aplicație ar fi cerut o cale de scriere pentru ea, ceea ce nu vrem. `finet_migrator` citește `households` prin politica `households_migrator_read` (0001), deci nu e nevoie de drepturi noi.
2. **Idempotent și neagresiv.** Planul `founder` se creează doar dacă lipsește; abonamentele se adaugă doar gospodăriilor fără abonament (`on conflict do nothing`). Un plan editat de operator și abonamentele existente nu se rescriu.
3. **„Fără limite” = valoarea maximă întreagă sigură** pe cele patru limite numerice din plan, plus toate funcțiile cunoscute. Alegerea e a master prompt-ului, nu o valoare comercială inventată. `queue.priority` rămâne 0 (echitatea din 0010 se păstrează); limitele tehnice globale rămân valabile. Abonamentul nu are sfârșit de perioadă.
4. **Ordinea e parte din procedură:** fondatorul ÎNAINTE de `APP_MODE=saas`. Gospodăriile create după rulare nu primesc fondator; ele urmează planul implicit al operatorului (valorile lui nu sunt în cod).
5. **Verificare separată, doar citire:** `ops/saas/founder-plan-check.sql`.
6. **Rollback simplu:** `APP_MODE=personal` (care ignoră tabelele). Ștergerea datelor fondator e opțională.

## Consecințe

- Testat pe Postgres real (`src/modules/entitlements/founder-plan.test.ts`): acordare, abonament existent neatins, idempotență, plan editat nerescris, gospodărie nouă fail closed, verificarea nu scrie.
- Rămâne la operator: valorile planului implicit, comutarea efectivă, variabilele `saas`, expunerea publică, furnizorul de plată.
