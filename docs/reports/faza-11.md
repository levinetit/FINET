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
