# ADR 0051: întăriri de securitate din modernizarea 2026 (L8, plafoane per gospodărie, lanțul CI)

- **Stare:** propus (modernizare 2026, pașii A și C).
- **Legături:** `docs/audit/FINET_SECURITY_AUDIT.md`, `docs/SECURITY_CHECKLIST.md` §42, `src/modules/auth/session.ts`, `src/modules/ledger/context.ts` (`HOUSEHOLD_CAPS`, `assertUnderCap`), `.github/workflows/{ci,codeql,secret-scan,images}.yml`, ADR 0003 (L8), ADR 0004 (LOW-4).

## Decizii

1. **L8 închis:** o cerere cu antet `Authorization: Bearer …` își rezolvă sesiunea DOAR din token: cookie-ul se elimină din antete înaintea verificării. Până acum `viaBearer` (care scutește de CSRF) se deducea din simpla prezență a antetului, iar Better Auth putea autentifica prin cookie; un bearer invalid + cookie valid, fără `Origin`, obținea o mutație fără CSRF. Acum dă 401. Clienții reali (Android trimite doar bearer; browserul doar cookie) nu sunt afectați.
2. **LOW-4 închis:** plafoane tehnice per gospodărie, în `personal` și `saas` deopotrivă (planurile `saas` pot fi mai strânse, nu mai largi): 100 de conturi (inclusiv arhivate), 300 de categorii proprii, 200 de bugete, 200 de obiective, 200 de etichete, 1.000 de evaluări per cont; regulile recurente aveau deja 200. Depășirea → 409 `household_limit_reached` (cererea e validă, starea nu permite). Verificarea e în serviciu, în aceeași tranzacție cu scrierea (`inHousehold`), după un lacăt consultativ per (plafon, gospodărie) (`lockHouseholdCap`, `pg_advisory_xact_lock`), ca două cereri paralele să nu poată număra amândouă „sub plafon” (TOCTOU). Numărarea rulează sub RLS: bugetele personale ale altor membri nu sunt vizibile, deci plafonul bugetelor e pe mulțimea vizibilă fiecărui membru (cel mult membri × 200 în total, tot finit). Plafoanele nu înlocuiesc rate limiting-ul.
3. **Lanțul de aprovizionare (pasul A):** toate acțiunile GitHub pinuite pe SHA, `pnpm audit --prod` blocant de la HIGH, CodeQL, gitleaks (PR + istoric), Trivy pe imagini (neblocant, în Code scanning), imaginea de bază pe digest, `packageManager` cu hash. Motivele și limitele sunt în `DEPENDENCY_MODERNIZATION.md`.
4. **Modulele noi** (ADR 0045–0049) au fost revizuite după aceeași listă ca fazele anterioare (toate scrierile prin `handle`/`handleAlways`, RLS `FORCE` pe tabelele noi, funcții `SECURITY DEFINER` doar cu id-uri și `search_path` fix, fără conținut financiar în loguri, descărcarea BCE cu gazdă fixă și corp plafonat, emailul fără linkuri de autentificare). Constatările și riscurile acceptate: `docs/audit/FINET_SECURITY_AUDIT.md`.

## Consecințe

- O gospodărie care a atins un plafon vede un 409 cu mesaj clar; plafoanele se schimbă într-un singur loc (`HOUSEHOLD_CAPS`).
- L6 (tokenul de resetare în clar la Better Auth) rămâne deschis: nu există încă opțiune în 1.7.x; re-verificat la fiecare actualizare.
