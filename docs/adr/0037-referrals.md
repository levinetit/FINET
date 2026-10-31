# ADR 0037: recomandări — stratul de date și regulile (Faza 12-C, felia 1)

- **Stare:** felia 1 (baza de date, regulile; migrația `0025_referrals`) livrată și aplicată (PR #54). Felia 2 (rute, înregistrare, interfață) propusă în branch `phase/12c2-referral-routes`, **fără migrație**. Recompensa pentru feedback e felia 3.
- **Legături:** master prompt Faza 12 (recomandări: cod per utilizator, recompensă aplicată o singură dată, plafon, protecție împotriva auto-recomandării), ADR 0035 (planuri), ADR 0029 (înregistrare), SECURITY_CHECKLIST §40.

## Decizii

1. **Recompensele sunt DATE, nu cod.** `finet.referral_settings` (un singur rând, scris de operator ca `finet_migrator`): planul acordat (`reward_plan_code`), zilele pentru invitat și pentru invitator, plafonul de recompense per invitator, fereastra în care un cont nou poate folosi un cod. Migrația inserează rândul cu 0 / lipsă = **oprit** (fail closed). Master prompt dă „1 lună Pro” ca referință; planul „Pro” și zilele le stabilește operatorul.
2. **Regulile sunt în baza de date.** `finet.redeem_referral(cod)` (SECURITY DEFINER, `search_path = pg_catalog`, doar `finet_app`) întoarce `ok | disabled | not_eligible | expired | invalid | self | already` și refuză: auto-recomandarea (același utilizator sau o gospodărie comună), un al doilea cod pentru același invitat (cheie primară pe invitat), conturi neconfirmate sau dezactivate, conturi mai vechi decât fereastra, depășirea plafonului invitatorului (care nu afectează recompensa invitatului). Plafonul se serializează cu un lock consultativ pe invitator.
3. **Recompensa e un abonament `reward`.** `finet.grant_reward` (internă, fără drept pentru aplicație) creează sau prelungește un abonament cu `provider = 'reward'`. **Nu atinge niciodată** un abonament `manual`, `founder` sau `stripe` (nici viu, nici expirat: o decizie a operatorului nu se anulează printr-o recomandare). Abonament `reward` viu: se prelungește; expirat: repornește de la acum.
4. **O recompensă expirată nu blochează scrierile.** `household_plan` (redefinită) tratează un abonament `reward` expirat ca absent: gospodăria revine la planul implicit (sau `none`, fail closed, dacă nu există), nu la `read_only`. Altfel un utilizator „răsplătit” ar fi ajuns mai rău decât unul fără recompensă.
5. **Codul propriu** `FIN-XXXXXX` (alfabet de 32 de caractere fără caractere confundabile, generat din `gen_random_uuid()`), creat la prima cerere prin `finet.my_referral_code()`, stabil.
6. **Aplicația citește doar ce e al ei:** `referral_codes` și `referrals` au SELECT pentru `finet_app` cu RLS (propriul cod, propriile recomandări); `referral_settings` nu are niciun drept pentru aplicație.

## Felia 2: rute, înregistrare, interfață

- **`/ref/<cod>`** (doar `saas`, 404 altfel): dacă forma e a unui cod, pune cookie-ul `finet_ref` (HttpOnly, SameSite=Lax, Secure pe https, 14 zile) și redirecționează 303 la `/register`; pentru orice cod răspunsul e identic (nu e un oracol de existență). `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- **Codul intră în tokenul semnat** al emailului de confirmare (pasul 1 citește cookie-ul), nu se citește la pasul 2: linkul se poate deschide pe alt dispozitiv. Un cod cu formă invalidă în cookie se ignoră.
- **Aplicarea** are loc după confirmarea contului (`completeRegistration`), prin `finet.redeem_referral`; orice eroare sau refuz al bazei NU strică înregistrarea.
- **`GET /api/v1/referrals/me`** (doar `saas`) și pagina `/referrals` (cod, link, copiere/Web Share, „prieteni invitați”, „recompense primite”); legătura apare lângă „Trimite feedback”.
- **Atenție la fereastra de folosire:** contul se creează la pasul 1, iar linkul de confirmare e valabil 48 h. Dacă `redeem_window_hours` < 48, o confirmare târzie nu mai primește recompensa. Setează-l ≥ 48 (INFRA 4z).

## Ce NU face (încă)

Nicio recompensă pentru feedback (felia 3); nicio notificare; nu verifică la `/ref` dacă un cod există. Nimic nu se schimbă pe producție până la aplicarea migrației și configurarea setărilor.

## Consecințe

- Teste pe Postgres real (`src/modules/entitlements/referrals.test.ts`, 9) și statice în `migrate.test.ts`.
- Aplicare: backup, `finet-migrate`, apoi (tot de operator) `update finet.referral_settings …` (INFRA 4z). Rollback: antetul fișierului.
