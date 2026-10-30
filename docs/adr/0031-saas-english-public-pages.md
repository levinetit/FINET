# ADR 0031: engleza pe paginile publice `saas` și documentul de expunere (Faza 11-C3)

- **Stare:** propus (Faza 11-C3, branch `phase/11-english`). **Fără migrație.** Doar modul `saas`; în `personal` paginile publice nu există (404), deci nimic nu se schimbă.
- **Legături:** ADR 0027 (site public), 0029 (înregistrare), master prompt Faza 11 (traducere în engleză, expunere publică).

## Decizii

### 1. Domeniu: doar paginile publice, nu aplicația

Se traduc `/`, `/pricing`, `/terms`, `/privacy`, `/support` (textele sunt în `ro.site`, deja izolate). NU se traduc aplicația autentificată, `/login` și `/register*`: formularele lor importă `ro` direct, iar `/login` are 0,5 KiB rezervă în bugetul JS; traducerea întregii aplicații e o decizie separată, a operatorului (volumul, termenii și mesajele de eroare ale API-ului ar trebui traduse împreună).

### 2. Alegerea limbii: EXCLUSIV cookie explicit

`finet_lang` (`ro`|`en`), scris de comutatorul RO/EN din antet (fără date personale, 1 an, `SameSite=Lax`). **`Accept-Language` nu se folosește niciodată**: româna e implicită oricare ar fi antetele browserului (Chromium trimite `en-US` implicit, ceea ce ar fi schimbat toate paginile și testele existente). Orice valoare alterată sau necunoscută a cookie-ului → română.

### 3. `<html lang>`

`src/proxy.ts` calculează limba documentului (`en` doar în `saas`, pe o cale publică, cu cookie `en`) și o pune într-un antet INTERN (`x-finet-lang`), suprascris la fiecare cerere (nu poate fi forțat de client). Layout-ul rădăcină îl citește; orice altceva decât `en` înseamnă `ro`. Regula statică de accesibilitate verifică acum această formă (singura alternativă a lui `lang` e `ro`), iar `global-error` păstrează `lang="ro"` literal.

### 4. Texte

`src/messages/en-site.ts` are tipul derivat din `ro.site` (aceleași chei: TypeScript refuză lipsurile); un test verifică și lungimea listelor, absența diacriticelor românești și că nicio valoare nu e goală. Textele juridice în engleză (`src/content/legal.ts`) sunt **traduceri de lucru ale ciornelor**, sub același control `SITE_LEGAL_REVIEWED` și cu bannerul de ciornă (text în engleză); româna rămâne textul de referință, iar traducerea cere aceeași revizuire umană. Modulele client primesc textele prin props (`CookieConsent`), nu importă `ro`.

### 5. Limite

- O singură adresă pe pagină (limba din cookie): fără URL-uri pe limbă, fără `hreflang`; motoarele de căutare văd româna (implicită). URL-uri per limbă pentru SEO sunt o decizie viitoare.
- Preferința de limbă e un cookie funcțional; politica de confidențialitate (cookie-uri) o menționează (ciornă).

### 6. Expunerea publică

`docs/EXPOSURE.md` enumeră ce trebuie decis și implementat înainte (politica Access, excepția de cod, sursa de IP de încredere, WAF, SMTP, juridic, marcă, lansare în pași). Agentul NU a modificat `proxy.ts` pentru a relaxa Access.
