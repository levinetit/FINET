# ADR 0033: limbi suplimentare pe paginile publice `saas` (Faza 13)

- **Stare:** propus (Faza 13, branch `phase/13-languages`). **Fără migrație.** Doar modul `saas`; în `personal` paginile publice nu există (404), deci nimic nu se schimbă.
- **Legături:** ADR 0031 (engleza pe paginile publice), ADR 0027 (site public), master prompt Faza 13.

## Decizii

### 1. Limbi și domeniu

`SITE_LOCALES` = `ro` (implicit), `en`, `es`, `fr`, `de`, `it`, `pl`, `tr`. Domeniul rămâne cel din ADR 0031: DOAR paginile publice (`/`, `/pricing`, `/terms`, `/privacy`, `/support`). Aplicația autentificată, `/login` și `/register*` rămân în română; traducerea lor (inclusiv mesajele de eroare ale API-ului) și formatele de dată și sumă după limbă sunt o decizie separată a operatorului, nefăcută aici. Paginile publice nu afișează sume sau date, deci formatele nu au ce schimba în acest domeniu; monedele rămân cele ale conturilor.

### 2. Alegerea limbii: aceeași regulă ca în ADR 0031

Exclusiv cookie-ul explicit `finet_lang`; `Accept-Language` nu se folosește niciodată. `parseSiteLocale` primește acum o LISTĂ EXACTĂ (nu mai compară cu `"en"`): orice valoare în afara listei (lipsă, alterată, `FR`, `fr-FR`, ` de`, `xx`) înseamnă româna. `src/proxy.ts` pune în antetul intern `x-finet-lang` limba calculată de `documentLocale`; layout-ul o validează încă o dată cu `parseSiteLocale` pentru `<html lang>`.

### 3. Texte

Câte un fișier per limbă (`src/messages/{es,fr,de,it,pl,tr}-site.ts`), toate tipate ca `SiteMessages` (derivat din `ro.site`): TypeScript refuză o cheie lipsă, iar un test (`site-locale.test.ts`) verifică aceleași chei, aceleași lungimi de liste, aceiași identificatori de secțiuni de suport, valori nevide și absența literelor românești (`ă`, `ș`, `ț`; `â`/`î` și `ş` rămân valide pentru franceză și turcă). Traducerile sunt **de lucru**, făcute de agent din textul englez; româna rămâne referința și textele cer revizuire de un vorbitor nativ înainte de lansare pe piața respectivă.

### 4. Textele juridice: engleza ca rezervă, nu traduceri noi

Master prompt-ul cere texte juridice revizuite de un om pentru fiecare piață. Șase traduceri noi ale unor ciorne nerevizuite ar multiplica munca de revizuire și riscul. Deci `/terms` și `/privacy` în `es`, `fr`, `de`, `it`, `pl`, `tr` arată textul JURIDIC ÎN ENGLEZĂ (`legalLocale`), într-un bloc cu `lang="en"`, cu titlul, bannerul de ciornă și o notă (`draft.translationNote`) în limba paginii care spune că textul juridic e afișat în engleză, iar româna e referința. Se aplică și bannerul și `SITE_LEGAL_REVIEWED` din ADR 0027/0031. Când un jurist revizuiește o piață, se adaugă acolo o traducere proprie și `legalLocale` se extinde.

### 5. Comutatorul

Comutatorul arată toate cele 8 limbi (cod din 2 litere, nume nativ în `aria-label`, `lang` pe buton). **Abatere față de rândul „Limbi” din master prompt** (selectorul arată `ro, en, fr, it, es, de`): `pl` și `tr` au traduceri, deci ascunderea lor din selector le-ar face inaccesibile; dacă operatorul vrea selectorul restrâns, se filtrează `SITE_LOCALES` în `language-switcher.tsx` (o singură modificare).

### 6. Limite

- O singură adresă pe pagină (limba din cookie): fără URL-uri pe limbă, fără `hreflang`; motoarele de căutare văd româna.
- Costul în JS: comutatorul adaugă șase butoane mici; textele limbilor sunt doar pe server (`server-only`), deci nu intră în pachetul clientului. Bugetele de mărime ale paginilor publice sunt verificate de CI.
