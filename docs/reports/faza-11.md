# Raportul Fazei 11 — Fundația SaaS

Faza 11 se livrează pe părți: **11-A** (site-ul public: prezentare, prețuri, termeni, confidențialitate, subsol legal, analytics cu consimțământ; ADR 0027; branch `phase/11-public`, fără migrație), **11-B** (panou de administrare, feedback, anunțuri, monitorizarea erorilor; migrație) și **11-C** (Turnstile, OAuth, traducerea în engleză, expunerea publică). Decizii ale operatorului (2026-10-31): cod acum cu datele firmei din configurație, monitorizare internă, fazele 11 → 12 → 13 cu PR și deploy separat.

## 11-A — Site-ul public

### 1. Ce s-a implementat

- Config `site` (datele firmei, `SITE_LEGAL_REVIEWED`, `SITE_ANALYTICS_ID`), fără valori implicite; `ready` doar cu datele complete și textele revizuite.
- Pagini doar în `saas` (404 în `personal`): `/` (prezentare), `/pricing` (fără sume), `/terms`, `/privacy` (ciorne cu banner), subsol legal cu ANPC SAL și SOL pe fiecare pagină.
- Banner de cookie-uri și Google Consent Mode v2 (implicit `denied`; `gtag.js` doar după „Accept”), CSP cu domeniile Google doar pe paginile publice și doar cu ID.
- Documentație: ADR 0027, ROADMAP, SECURITY_CHECKLIST §30.

### 2. Teste rulate local (2026-10-31)

| Comandă | Rezultat |
|---|---|
| `vitest run src/lib/config.test.ts src/lib/consent.test.ts src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/contrast.test.ts src/proxy.test.ts src/lib/security-headers.test.ts` | PASS |
| `eslint` pe fișierele noi și `tsc` pe fișierele atinse | PASS |
| E2E (`e2e/site.spec.ts`; `smoke`/`auth` adaptate: în `saas`, `/` e prezentarea) | SCRIS; NOT RUN local; în CI (ambele moduri) |
| `pnpm test` complet, `next build` | NOT RUN local (memorie); în CI |

### 3. Puncte deschise (decizii și pași ai operatorului)

- **Datele firmei și revizuirea textelor juridice de către un om** blochează lansarea publică; până atunci site-ul rămâne `noindex`, cu banner de ciornă.
- Neimplementat în 11-A: `/help` public, înregistrarea (rămâne „indisponibilă”), Turnstile, OAuth Google/Facebook, traducerea în engleză, panoul `/admin`, feedback și anunțuri, monitorizarea erorilor, expunerea publică (WAF, politica Access), verificarea numelui la OSIM/EUIPO.
- Cu `SITE_ANALYTICS_ID` real și Google real, comportamentul nu a fost verificat.

### 4. Pe producție

Nimic: modul `saas` nu rulează pe producție. Fără migrație în 11-A.

## 11-B — Feedback, anunțuri, monitorizarea erorilor, panou de administrare

ADR 0028; branch `phase/11-admin`; migrația `0020_admin_feedback`.

### 1. Ce s-a implementat

- Trei tabele (`feedback`, `announcements`, `app_errors`) cu RLS ENABLE + FORCE și șase funcții SECURITY DEFINER (`is_platform_admin`, `record_app_error`, `admin_users`, `admin_households`, `admin_jobs`, `admin_set_user_status`); nicio dată financiară.
- API (13 rute, doar `saas`): feedback, anunțuri active, raportarea erorilor, liste și acțiuni de administrare; 404 în `personal` și pentru non-administratori; acțiuni auditate.
- Interfață: `/feedback`, bannerul de anunțuri, `/admin`, raportarea erorilor din `error.tsx`/`global-error.tsx`.

### 2. Teste rulate local (2026-10-31)

| Comandă | Rezultat |
|---|---|
| `vitest run src/db/migrate.test.ts src/app/api/v1/admin-api.test.ts src/openapi src/modules/auth` (cu PG17) | PASS (107 teste) |
| `vitest run src/app/ui-rules.test.ts src/app/a11y-rules.test.ts src/app/smoke.test.ts src/app/_lib` | PASS |
| `eslint` și `tsc` pe fișierele noi | PASS |
| E2E (`e2e/admin.spec.ts`: 404 în `personal`, 404 pentru utilizator obișnuit, feedback → panou, anunț creat → văzut → arhivat) | SCRIS; NOT RUN local; în CI (`personal` + `saas`) |

### 3. Puncte deschise

- Aplicarea migrației `0020` pe Supabase (opțională până la un deploy `saas`) și revizuirea `security`.
- `GET /api/v1/admin/stats` rămâne 403 pentru non-administratori (de aliniat la 404).
- Erorile serverului nu se raportează automat; erorile paginilor publice nu se raportează; limită de cereri dedicată pe feedback/erori: nu (doar cea generală).
- Auditul administratorului apare în gospodăria lui (ADR 0028 §4).
- Rămân în Faza 11: Turnstile, OAuth Google/Facebook, `/help` public, traducerea în engleză, expunerea publică (11-C).

## 11-C1 — Înregistrare publică în doi pași și pagina `/support`

ADR 0029; branch `phase/11-public`; fără migrație.

### 1. Ce s-a implementat

- `POST /api/v1/register` (email, nume, termeni) și `POST /api/v1/register/complete` (link semnat + parolă): doar `saas` cu `SIGNUP_ENABLED=1` și SMTP; închis implicit. Parola o alege cel care primește emailul (nu există cont cu parolă înainte de confirmare).
- Token HMAC fără tabel nou, unică folosință; răspuns identic pentru orice adresă; CSRF prin `Origin`; rate limiting pe email și IP.
- `/register` (formular sau mesaj „încă nu e deschisă”), `/register/complete`, `/support` (public, în `(site)`), legătură în antet.
- Ghidul `/help` (Faza 9) rămâne autentificat; public e `/support`.

### 2. Teste rulate local (2026-10-31)

| Comandă | Rezultat |
|---|---|
| `vitest run src/app/api/v1/register-api.test.ts` (PG17) | PASS (8 teste) |
| `vitest run src/openapi src/app/api/routes.test.ts src/lib src/modules/auth src/app/{ui-rules,a11y-rules,smoke}.test.ts src/app/_lib` | PASS |
| `eslint`, `tsc`, `prettier` pe fișierele modificate | PASS |
| E2E (`e2e/site.spec.ts`: `/support`, `/register` închis, API 404, personal 404) | SCRIS; NOT RUN local; în CI |

### 3. Puncte deschise

- Fluxul complet nu are E2E în browser: CI nu are un sink de email (nu există mailpit). Fluxul e acoperit la nivel API cu un mailer injectat (`register-api.test.ts`); formularele sunt verificate doar prin regulile statice de UI.
- Turnstile, OAuth, traducerea în engleză și expunerea publică: 11-C2/C3 (cer chei și decizii).
- Curățarea conturilor neconfirmate și sursa de IP de încredere: înainte de `SIGNUP_ENABLED=1` public (INFRA 4u).

## 11-C3 — Engleza pe paginile publice și documentul de expunere

ADR 0031; branch `phase/11-english`; fără migrație.

### 1. Ce s-a implementat

- Textele publice în engleză (`src/messages/en-site.ts`, tipul derivat din `ro.site`), textele juridice traduse (ciorne, sub `SITE_LEGAL_REVIEWED`), comutator RO/EN, limba din cookie explicit `finet_lang` (NICIODATĂ din `Accept-Language`), `<html lang>` prin antet intern de proxy.
- Doar `/`, `/pricing`, `/terms`, `/privacy`, `/support`; aplicația, `/login` și `/register*` rămân în română (`/login` are 0,5 KiB rezervă în buget).
- `docs/EXPOSURE.md`: ce trebuie decis și schimbat înainte de expunerea publică. `proxy.ts` nu a fost relaxat.

### 2. Teste rulate local (2026-10-31)

| Comandă | Rezultat |
|---|---|
| `vitest run site-locale.test.ts a11y-rules.test.ts ui-rules.test.ts smoke.test.ts consent.test.ts` | PASS (22 teste) |
| `eslint`, `tsc`, `prettier` pe fișierele modificate | PASS |
| E2E (`e2e/site.spec.ts`: română implicită cu `en-US`, comutare, `<html lang>`, titlu, subsol, pagini juridice, login rămâne `ro`) | SCRIS; NOT RUN local; în CI |

### 3. Puncte deschise

- Revizuirea umană a traducerilor juridice; fără URL-uri pe limbă/hreflang (SEO în engleză); aplicația nu e tradusă (decizie a operatorului).
- Expunerea publică: toate punctele din `docs/EXPOSURE.md` (politica Access, excepția de cod, sursa IP, WAF, SMTP, marcă).

