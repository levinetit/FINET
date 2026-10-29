# ADR 0016 — Familia: invitații, roluri, vizibilitate personal/comun, împărțiri și decontări

- **Stare:** propus (F8-A, branch `phase/08-family`). Migrația `0012_family` și redeploy-ul: operatorul, după revizuiri (`docs/INFRA.md`, „4j”). API-ul, UI-ul, actualizările live și E2E: F8-B (ADR 0017).
- **Legături:** master prompt Faza 8 (7), 6.1 („Familie”: `household_invites`, `transaction_splits`, `settlements`; `accounts.owner_user_id` „personal sau comun”; `budgets.scope`), 6.2 (RLS), 6.3, 5.1 (bani); ADR 0003 (gospodăria curentă), 0004 (registrul), 0007 (bugete), 0011 (recurențe); ROADMAP L3 (ultimul owner).

## Context

Până la Faza 8 toți membrii unei gospodării vedeau tot, gospodăria „curentă” era cea mai veche apartenență, iar membrii intrau doar prin CLI (`admin add-member`). Faza 8 cere: invitații prin link (expirabile, de unică folosință), roluri, plecare și eliminare, conturi și bugete personale și comune cu vizibilitatea documentată, împărțirea cheltuielilor (egal, procente, sume fixe), solduri reciproce, decontări parțiale și un comutator de gospodărie activă. Regula de vizibilitate trebuie impusă în bază (RLS), nu doar în servicii.

## Decizii

### 1. Vizibilitatea: PERSONAL / COMUN pe conturi, moștenită de tot ce derivă din ele

- **Modelul** (coloana existentă din 6.1): `accounts.owner_user_id` NULL = cont **comun** (îl văd toți membrii); = X = cont **personal** al lui X, vizibil **doar** lui X. Nu e nevoie de o coloană nouă.
- **În bază** (0012, `ALTER POLICY`, aceleași nume): `accounts_household` cere `owner_user_id is null or owner_user_id = current_user_id()` la citire și la scriere; `transactions_household`, `recurring_rules_household` cer contul vizibil (subinterogare necorelată pe conturi, evaluată o dată pe interogare); `transaction_tags_household` și `recurring_occurrences_household` cer tranzacția, respectiv regula, vizibile.
- **Consecința pe module** (verificată de `src/db/family-rls.test.ts`): conturile și soldurile, lista și detaliul tranzacțiilor, transferurile, etichetele, bugetele (cheltuit), dashboard-ul, raportul lunar, exportul CSV și regulile recurente se calculează sub RLS-ul celui care citește. Tranzacțiile din contul personal al altuia NU apar nicăieri, nici în agregate.
- **Bugetele** aveau deja `scope = household | personal` (0004): cele personale sunt vizibile doar proprietarului. „Cheltuitul” unui buget comun se calculează din tranzacțiile vizibile cititorului (comune + ale lui personale), deci doi membri pot vedea sume diferite pe același buget comun (decizia mea, documentată; o variantă „buget comun = doar conturile comune” se poate alege în F8-B/F9 fără schimbare de schemă).
- **Reguli de schimbare** (serviciu + trigger `accounts_check_owner_change` + RLS): un cont personal se creează doar pentru tine; un cont comun **nu devine personal** (ar ascunde istoricul de ceilalți); un cont personal nu trece la alt membru; personal → comun e permis proprietarului.
- **Transferurile personal ↔ comun** sunt permise: ceilalți văd doar jumătatea comună (banii intrați/ieșiți din contul comun), iar transferul ca întreg le e 404. `finet.check_transfer_group` devine SECURITY DEFINER (aceeași semnătură, `void`, doar ridică eroarea), cu o politică îngustă pentru `finet_migrator` (rândurile de transfer ale gospodăriei curente), ca un membru care șterge jumătatea comună să fie refuzat la COMMIT (altfel ar fi lăsat jumătatea personală orfană). Testat.
- **Recurențele:** `finet.due_recurring_rules` (aceeași semnătură) generează o regulă pe un cont personal doar în numele proprietarului contului, dacă e membru activ; altfel regula e omisă (nu mai eșuează la nesfârșit în numele unui owner care nu vede contul).
- **Amânate explicit (ROADMAP, PRIVACY_NOTES):** documentele/bonurile (`documents`, `receipts`, `receipt_lines`) rămân vizibile tuturor membrilor, chiar dacă bonul a fost confirmat pe un cont personal (comerciantul, totalul și produsele se văd); obiectivele (`goals`) rămân comune (un obiectiv legat de un cont personal arată doar id-ul contului); numele conturilor personale ocupă numele în gospodărie (indexul unic `accounts_household_name_active_key`: un alt membru care alege același nume primește `account_name_taken`, deci află că numele e folosit). Motiv: fiecare cere o schimbare de model (bonuri personale, obiective personale, index pe proprietar) cu impact pe pipeline-ul F6 și pe UI; riscul unui pas unic era prea mare. Recomandare pentru utilizatori până atunci: bonurile private nu se încarcă în gospodăria comună.

### 2. Invitațiile

- `household_invites`: `token_hash` (SHA-256 hex, UNIC), `role` (`member` | `owner`), `created_by_user_id`, `created_at`, `expires_at` (CHECK plat: `> created_at` și `<= created_at + 168 h`), `used_at` / `used_by_user_id`, `revoked_at` (CHECK: folosită ⇒ nerevocată). Stările finale sunt imutabile (trigger `household_invites_check_update`).
- **Tokenul:** 32 de octeți din CSPRNG (`randomBytes`, 256 de biți), base64url (43 de caractere). În bază ajunge DOAR hash-ul; tokenul în clar se întoarce o singură dată, la creare (`createInvite`). Aplicația nu are SELECT pe `token_hash` (drepturi pe coloane) și nu are DELETE pe invitații.
- **Comparația „constant-time”:** nu există o comparație de token în cod. Căutarea se face după hash-ul tokenului primit (index unic); timpul depinde de hash, nu de prefixul tokenului, iar două hash-uri nu se compară niciodată în JavaScript.
- **Acceptarea:** `finet.accept_invite(token_hash)` — SECURITY DEFINER, `search_path = pg_catalog`, EXECUTE doar `finet_app`, acționează pentru utilizatorul DIN CONTEXT, întoarce doar `(invite_household_id, newly_joined)`. Rândul e blocat `FOR UPDATE`; o a doua acceptare concurentă re-evaluează condițiile pe rândul deja folosit și nu-l mai găsește (testat: două acceptări paralele → exact una). Inserarea membrului trece printr-o politică îngustă a proprietarului (`household_members_migrator_join`, variabila tranzacției `finet.joining_household`), ca la `create_household`.
- **Răspuns uniform:** token inexistent, malformat, expirat, folosit sau revocat → același `InviteUnavailableError` (`invite_unavailable`, 404, mesaj fix). Un utilizator deja membru primește gospodăria fără să consume invitația (rămâne celui invitat). La intrare, gospodăria devine cea activă (decizia mea).
- **Limite:** acceptarea are limită de rată per utilizator (`invite_accept`, implicit 10 / 15 min, consumată înaintea oricărei verificări); crearea are o limită de 20 de invitații / 24 h / gospodărie, numărate din rândurile care nu se pot șterge (doar crescătoare); valabilitatea implicită 72 h. Gospodăria are cel mult **6 membri** (trigger `household_members_check_cap`, sub lock, pe ORICE cale de inserare, inclusiv CLI) → `household_full`.

### 3. Roluri și permisiuni (minimal: `owner` / `member`)

| Acțiune | `member` | `owner` |
|---|---|---|
| vede membrii, soldurile, împărțirile, decontările | da | da |
| creează / listează / revocă invitații | nu (403) | da |
| schimbă rolul cuiva, transferă ownership-ul, elimină un membru | nu (403) | da |
| pleacă din gospodărie | da | da, dacă rămâne alt owner |
| setează / șterge împărțirea unei cheltuieli | doar plătitorul (contul lui personal) | la fel |
| înregistrează o decontare | doar dacă e una dintre părți | pentru oricare doi membri |
| anulează o decontare | doar a lui | oricare |

Testate pe fiecare acțiune × rol (`src/modules/family/family.test.ts`); RLS impune aceleași reguli (`household_invites_owner_*`, `settlements_*`, `transaction_splits_*`, `household_members_*` din 0001).

### 4. Ultimul owner (L3) și transferul de ownership

- Triggerul `household_members_guard_owner` (SECURITY DEFINER, advisory lock per gospodărie): un owner nu poate fi retrogradat dacă nu rămâne alt owner și nu poate pleca/fi scos dacă rămân membri fără owner. Permis: cascada la ștergerea gospodăriei și plecarea ultimului membru. Lock-ul face ca doi owneri care se retrogradează reciproc în paralel să nu lase gospodăria fără owner (READ COMMITTED: după lock, numărătoarea vede ce a comis celălalt; testat cu o cursă reală).
- Consecință (netestată: aplicația nu șterge încă utilizatori): ștergerea unui utilizator (cascada `users → household_members`) e refuzată dacă i-ar lăsa pe ceilalți membri fără owner; ștergerea contului (fază viitoare) va trebui să transfere întâi ownership-ul. Tot acolo: `accounts.owner_user_id` are `ON DELETE SET NULL` (0002), deci ștergerea unui utilizator ar transforma conturile lui personale în conturi COMUNE — funcția de ștergere a contului trebuie să le trateze explicit (ROADMAP).
- `transferOwnership` promovează ținta și îl retrogradează pe owner, atomic. Serviciile verifică regulile și înainte (mesaj clar, cod `last_owner`); baza e plasa de siguranță. `household_members`: UPDATE doar pe `role`.

### 5. Plecarea și eliminarea: ce se întâmplă cu datele

- Blocate cât timp membrul are vreun sold reciproc nenul, în orice monedă, pe orice pereche (`balance_not_settled`); un owner poate înregistra decontarea. Ultimul membru nu „pleacă” (`sole_member`): gospodăria se șterge separat.
- Datele rămân în gospodărie: tranzacțiile din conturile comune rămân ale tuturor; conturile **personale** ale celui plecat (cu tranzacțiile, regulile și etichetele lor) devin invizibile pentru toți și redevin vizibile doar dacă revine; regulile lui recurente pe conturi personale nu se mai generează. Împărțirile și decontările rămân în istoric (fără cheie spre `household_members`; membrii se verifică la inserare). Ștergerea gospodăriei șterge tot (cascada existentă). Preferința de gospodărie activă se șterge la plecare.

### 6. Gospodăria activă (comutatorul)

- `user_preferences.active_household_id` (NULL, FK `ON DELETE SET NULL`) e doar o **preferință**. `currentHouseholdIdOf` (folosit de API, paginile registrului, audit, profil, consimțăminte) pornește mereu din `household_members` și alege gospodăria preferată doar dacă apartenența există LA ACEA CERERE; altfel cea mai veche apartenență. Setarea (`setActiveHousehold`) verifică apartenența în aceeași tranzacție cu scrierea (străină → 404). Testat: o preferință rămasă după eliminare e ignorată.

### 7. Împărțirea cheltuielilor

- `transaction_splits` (`household_id`, `transaction_id`, `payer_user_id`, `user_id`, `share_minor ≥ 0`, `currency`; UNIC `(transaction_id, user_id)`; FK compusă `(transaction_id, household_id) → transactions ON DELETE CASCADE`). Un rând pe participant, inclusiv plătitorul.
- **Plătitorul** = proprietarul contului PERSONAL al cheltuielii = cel care împarte (RLS: `payer_user_id = current_user_id()`). Decizia mea: banii unui cont comun sunt deja ai tuturor, deci nu creează datorii; datoria apare când cineva plătește din banii lui pentru gospodărie. Plătitorul se STOCHEAZĂ (nu se deduce din cont sau din `created_by_user_id`, care poate deveni NULL), ca soldurile să fie calculabile de orice membru fără să vadă tranzacția sau contul.
- **Vizibilitate:** rândurile (cine, cât, cine a plătit) le văd toți membrii, ca soldurile să fie identice pentru toți (testat: aceleași perechi văzute de fiecare dintre 2 și 3 membri); descrierea, comerciantul și contul rămân private plătitorului.
- **Suma părților = totalul**, de două ori: (1) serviciul calculează exact (`split-math.ts`); (2) triggerul amânat `transaction_splits_sum_valid` (DEFERRABLE INITIALLY DEFERRED, pe inserările/ștergerile de părți și pe `UPDATE OF amount_minor, currency, type, account_id` al tranzacției) verifică la COMMIT suma, moneda, tipul `expense` și plătitorul unic. Nu rupe inserările existente: o tranzacție fără părți e validă, iar una ștearsă își șterge părțile (cascada). Cât timp împărțirea există, `updateTransaction` refuză schimbarea sumei, a contului sau a tipului, iar `deleteTransaction` refuză ștergerea (409 `transaction_split`: altfel cascada ar schimba în tăcere soldurile tuturor, inclusiv după decontări); descrierea și data se pot schimba. Ștergerea directă în bază (ocolind serviciul) rămâne posibilă pentru plătitor: cascada șterge părțile (decizia mea: baza nu blochează ștergerea, serviciul da). Împărțirea se înlocuiește (DELETE + INSERT); fără UPDATE pentru aplicație.
- **Rotunjirea** (deterministă, documentată în `split-math.ts`): participanții se sortează după `userId`; EGAL: ⌊T/n⌋ fiecare, iar cele `T mod n` unități rămase primilor în ordinea `userId`; PROCENTE: puncte de bază întregi cu suma exact 10000, partea întreagă din T × pb / 10000, unitățile rămase la resturile cele mai mari (metoda restului cel mai mare din `money.ts`), la egalitate primul `userId`; SUME FIXE: suma exact T. Participanți: 2–6 membri distincți.

### 8. Solduri și decontări

- `settlements` (`from_user_id` i-a dat lui `to_user_id` `amount_minor > 0` în `currency`, la `settled_on`, `note` ≤ 200; `from ≠ to`; membri la inserare, trigger; fără DELETE; anularea = `cancelled_at`/`cancelled_by_user_id`, o singură dată). O decontare parțială = o sumă mai mică; mai multe se adună.
- **Soldurile** se calculează în cod, `bigint`, pe monedă, fără conversie (`computeBalances`): fiecare parte a unui participant ≠ plătitor e o datorie față de plătitor; o decontare scade datoria lui `from` față de `to` (peste datorie, sensul se inversează, nimic nu se pierde). Netting pe perechi, total pe membru (suma totalurilor = 0), rezumatul utilizatorului („Ai de dat / Ai de primit”). JSON doar sub 2^53 (`minorToJson`).

### 9. Audit și erori

- Evenimente noi, fără tokenuri, sume, note sau nume: `household.invite_created|invite_revoked|invite_accepted|member_role_changed|member_removed|member_left|ownership_transferred|switched`, `transaction.split_set|split_cleared`, `settlement.created|cancelled` (metadata: doar rolul, orele de valabilitate, modul și numărul de participanți). Testat.
- Triggerele scrise de mână ridică erorile cu `CONSTRAINT = <nume>`; `translateDbError` le mapează pe coduri fixe (`last_owner`, `household_full`, `split_sum_mismatch`, `account_owner_change`, `invite_not_active`, `settlement_already_cancelled`), fără mesajul Postgres.

## Alternative respinse

- **Coloana `visibility` separată pe tranzacții:** dublura lui `owner_user_id` din 6.1 și o sursă de incoerență (tranzacție „comună” pe cont personal).
- **Împărțiri vizibile doar participanților:** soldurile ar fi diferit între membri, iar owner-ul n-ar fi putut verifica soldurile înaintea eliminării unui membru.
- **Funcție SECURITY DEFINER pentru eliminare cu date personale:** am preferat datele păstrate și invizibile (nicio scurgere, nicio ștergere ireversibilă) în locul blocării plecării sau al ștergerii conturilor personale.
- **Tokenul ca uuid:** 122 de biți; cerința e ≥ 256.

## Consecințe

- Un cont cu `owner_user_id` setat înainte de 0012 dispare pentru ceilalți membri după migrare: verificarea operatorului e în INFRA 4j (o interogare de numărare, înainte de deploy).
- F8-B construiește API-ul (inclusiv limita de rată generală, `Idempotency-Key`), UI-ul (`/join/[token]`, `/family`, comutatorul din antet, împărțirea în formularul tranzacției, widgetul de pe dashboard) și actualizările live peste aceste servicii.
