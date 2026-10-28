# ADR 0004 — Registrul financiar (Faza 2, F2-A)

- **Stare:** propus (F2-A: schema, migrația `0002_ledger`, RLS, serviciile). API-ul, idempotența HTTP, OpenAPI și evenimentele: F2-B. UI și E2E: F2-C.
- **Legături:** master prompt 5.1, 5.2, 5.4, 5.6, 6.1, 6.2, 6.4, 6.5; ADR 0003 (stratul de date al Fazei 1).

## Context
Faza 2 aduce conturile, categoriile, tranzacțiile și transferurile, plus tabelele de platformă cerute de 6.1 (`idempotency_keys`, `client_installations`, `app_events`, `app_downloads`). Constrângerile rămân cele din ADR 0003: schema `finet` deținută de `finet_migrator`, aplicația ca `finet_app` (`NOBYPASSRLS`), contextul RLS per tranzacție (`app.user_id`, `app.household_id`), migrațiile imutabile după aplicare. `0000_core` și `0001_rls` sunt aplicate pe producție și nu se ating.

## Decizii

### O singură migrație, `0002_ledger.sql`
- Prima parte e generată de `drizzle-kit generate --name ledger` din `src/db/schema/ledger.ts`; a doua parte („PARTEA SCRISĂ DE MÂNĂ”) e adăugată înainte de prima aplicare: categoriile de sistem, triggerele, RLS, politicile și drepturile. O a doua rulare `drizzle-kit generate` raportează „No schema changes” (snapshot-ul `0002_snapshot.json` e coerent cu schema).
- O singură migrație (decizia mea), nu `0002` generată + `0003` de mână ca în Faza 1: tabelele au RLS `ENABLE` + `FORCE` în același fișier în care sunt create. Runner-ul aplică oricum toate migrațiile în așteptare într-o singură tranzacție.
- Categoriile de sistem se inserează **înainte** de activarea RLS pe `categories`: `FORCE` se aplică și proprietarului (`finet_migrator`), care nu are politici pe acest tabel.
- Rollback: în antetul migrației (doar manual, de operator, cu backup; distruge datele din tabelele noi).

### Bani fără float
- `amount_minor`, `opening_balance_minor` sunt `bigint`, citite în JS ca `bigint` (`mode: "bigint"`). `amount_minor > 0` (CHECK); semnul vine din `type`.
- Intrarea: `amountMinor` (întreg JSON sigur, validat cu Zod și convertit prin `fromJson`) sau `amount` (text românesc, `parseAmount`), niciodată ambele (`src/modules/ledger/input.ts`).
- Ieșirea: serializatoarele `*ToJson` trec prin `toJson`, care aruncă `MoneyOverflowError` peste 2^53 − 1. Baza poate stoca sume mai mari (introduse de altă cale decât serviciile); ele nu ajung în JSON trunchiate.
- Soldul **se calculează** (6.1), nu se stochează: `sum(amount_minor)` pe tip și pe sens (`numeric` în Postgres, citit ca text, apoi `BigInt`), iar formula `sold inițial + venituri − cheltuieli + transferuri intrate − transferuri ieșite` se aplică cu `add`/`sub` din `money.ts`. Totalurile sunt separate pe monedă și includ doar conturile nearhivate.
- În cursorul sortării după sumă, suma e text cu cifre, nu număr JSON.

### Integritatea: constrângeri, nu doar validare în serviciu
- **Cont și monedă:** cheie străină compusă `transactions(account_id, household_id, currency) → accounts(id, household_id, currency)`. Garantează că tranzacția e în gospodăria contului și în moneda lui; schimbarea monedei unui cont cu tranzacții e refuzată de bază (și de serviciu, cu mesaj clar).
- **`NO ACTION`, nu `RESTRICT`,** pe cheile spre conturi și categorii: verificarea se face la sfârșitul instrucțiunii, deci ștergerea unei gospodării șterge în cascadă și conturile, și tranzacțiile. Pentru aplicație efectul e același: contul cu tranzacții și categoria folosită nu se șterg (5.6).
- **Transfer:** `transfer_direction` (`out`/`in`), coloană nouă față de 6.1 (decizia mea), necesară formulei soldului. CHECK pe rând: `type = 'transfer'` ⇔ grup ⇔ sens, fără categorie. Index unic `(transfer_group_id, transfer_direction)`. Grupul complet (exact `out` + `in`, conturi diferite, aceeași gospodărie, aceeași sumă dacă moneda e aceeași) e verificat de un **constraint trigger `DEFERRABLE INITIALLY DEFERRED`**, adică la COMMIT: cele două rânduri se pot insera sau șterge pe rând în aceeași tranzacție, dar un grup incomplet nu ajunge niciodată în bază (inclusiv ștergerea unui singur rând).
- **Triggere BEFORE** (decizia mea: trigger, nu doar validare, pentru că cheile străine simple ignoră RLS): `transactions_check_refs` (contul există în gospodărie și nu e arhivat la creare/mutare; categoria e de sistem sau a gospodăriei și de același tip), `categories_check_parent` (un singur nivel, același tip, părinte vizibil), `category_visibility_check` (doar categoriile de sistem).
- Toate funcțiile noi sunt **`SECURITY INVOKER`** cu `search_path = pg_catalog` și nume calificate. Rulează sub RLS-ul apelantului: un rând al altei gospodării e invizibil și e respins ca inexistent. Niciun `SECURITY DEFINER` nou (testat în `migrate.test.ts`).
- Serviciile validează aceleași reguli înainte (mesaje clare, `ValidationError`/`ConflictError`); erorile Postgres care scapă (curse) sunt traduse în `src/modules/ledger/context.ts` (`23505`/`23503`/`23514` → 409, `42501` → 404).
- Limită cunoscută: două modificări concurente ale ierarhiei categoriilor (A devine copil în timp ce B devine copilul lui A) pot ocoli verificarea „un singur nivel” (fiecare tranzacție vede starea dinainte). Risc mic, doar în propria gospodărie; de închis cu un lock pe gospodărie dacă devine relevant.

### Categoriile de sistem și vizibilitatea
- Cele 21 de categorii de cheltuieli și 7 de venituri din 5.4 sunt seed în migrație, cu `household_id IS NULL`, cheie stabilă `system_key` (de exemplu `expense.groceries`) și `sort_order` (ordinea din 5.4). Id-urile sunt generate la aplicare, deci diferă între baze: clienții folosesc `system_key` pentru o referință stabilă. Fără pictograme/culori (decide UI-ul în F2-C).
- Nu se pot șterge și nu se pot modifica: politicile de scriere cer `household_id = gospodăria curentă`, iar `household_id`, `kind`, `system_key` nu au drept de UPDATE.
- Se ascund **per gospodărie** prin `category_visibility(household_id, category_id, hidden)` (rândul de sistem rămâne neatins); categoriile personalizate au coloana proprie `hidden`. Serviciul expune un singur `hidden` pentru ambele.
- Categoriile personalizate pot avea ca părinte o categorie de sistem sau una proprie, de același tip (decizia mea). Ștergerea: refuzată dacă are subcategorii; dacă e folosită, doar cu `reassignTo` (aceeași tranzacție SQL mută tranzacțiile, apoi șterge).

### RLS și drepturi
- `ENABLE` + `FORCE` pe toate cele 8 tabele noi. Politicile pe gospodărie folosesc forma `household_id = (select current_household_id()) and (select member_role(current_household_id())) is not null` (evaluată o dată pe query).
- Categoriile de sistem sunt citibile doar cu un context valid de membru (fără context → 0 rânduri, ca restul).
- `accounts`: `owner_user_id` trebuie să fie NULL sau un membru al aceleiași gospodării (`WITH CHECK` cu subinterogare pe `household_members`, sub RLS-ul lui `finet_app`; corecție din revizuirea automată, MEDIUM 1).
- `client_installations`: unic pe `(user_id, installation_id)`, nu global (un utilizator nu poate ocupa id-ul altuia și nu află din conflict că există; MEDIUM 2). `app_events` acceptă `installation_id` doar dacă e o instalare a utilizatorului curent, `household_id` doar al gospodăriei curente; numele, ecranul și codul de eroare au format fix (fără text liber, fără sume). Lista fixă de nume: Zod, în F2-B.
- `app_downloads`: doar INSERT (anonim sau pe sine), fără citire pentru aplicație (statisticile vin în Faza 9 printr-o funcție dedicată).
- `UPDATE` pe coloane, ca în Faza 1: nu se pot schimba `household_id`, `id`, `created_at`, `created_by_user_id`, `source`, `transfer_group_id`, `transfer_direction`, `external_ref` (tranzacții), `kind`/`system_key` (categorii), `request_hash` (idempotență), `user_id`/`installation_id` (instalări). `type` se poate schimba între `income` și `expense` (corectarea unei greșeli); CHECK-ul de transfer face imposibilă conversia din sau în transfer.
- `idempotency_keys`: SELECT, INSERT, DELETE și UPDATE `(response, status_code)` în gospodăria curentă. **Curățarea cheilor mai vechi de 24 h** rulează fără context de gospodărie, deci RLS i-ar arăta 0 rânduri: F2-B are nevoie de o funcție dedicată (probabil `SECURITY DEFINER`, cu `search_path` fix, EXECUTE doar pentru rolul care o rulează) într-o migrație nouă `0003_…`, plus comanda în `finet-admin`.
- Lipsă intenționată: nu există politică pe `transactions.created_by_user_id = utilizatorul curent`; serviciul îl ia din sesiune, iar coloana nu se poate modifica după creare.

### Paginarea cu cursor
- Keyset pe `(cheie de sortare, id)` (sortări: `date_desc` implicit, `date_asc`, `amount_desc`, `amount_asc`), cu `limit + 1` rânduri citite pentru a decide `nextCursor`. Stabilă la inserări concurente: rândurile existente apar exact o dată.
- Cursorul e `base64url(JSON {v, s, k, i})`, validat strict la decodare (versiune, sortare identică cu cea cerută, dată reală sau sumă ca șir de cifre, uuid). **Nu e semnat** (decizia mea): conține doar poziția în propriile date; gospodăria și filtrele vin din sesiune și din cerere, iar RLS izolează rândurile, deci un cursor modificat nu dă acces la nimic nou.
- `limit`: implicit 50, plafonat la 100 (valorile mai mari se reduc; 0, negative și zecimale se resping).
- Căutarea: `ILIKE` pe descriere, comerciant și note, cu `\`, `%` și `_` escapate. Fără index full-text în Faza 2 (volum mic); de revăzut la Faza 6 (OCR).

### Date
- `occurred_on` e `date` citit ca text `YYYY-MM-DD` (fără `Date` din JS, deci fără deplasări de fus orar), validat ca dată reală între 1900 și 2999.

### Erori de domeniu
- `ValidationError` (400, `invalid_request`, mesaje fixe pe câmp) și `ConflictError` (409, `conflict`, `reason` stabil: `account_not_empty`, `account_has_transactions`, `account_archived`, `account_name_taken`, `category_in_use`, `category_has_children`, `system_category_readonly`, `category_name_taken`, `transfer_row`, …) în `src/lib/errors.ts`; resursele străine sau inexistente dau `NotFoundError` (404 uniform). F2-B le mapează în formatul `{ error: { code, message, fields? } }`.

## Consecințe
- Aplicarea pe Supabase: `finet-migrate` (o singură migrație nouă, `0002_ledger`), de operator, după revizuiri.
- Apărarea în adâncime are un cost: fiecare inserare de tranzacție rulează un trigger BEFORE și unul deferred (două căutări pe index). Acceptabil la volumul unei gospodării.
