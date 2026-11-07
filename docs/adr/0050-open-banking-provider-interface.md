# ADR 0050: Open Banking printr-un agregator licențiat, în spatele unei interfețe de furnizor

- **Stare:** propus (modernizare 2026, pasul L); implementarea furnizorului real așteaptă decizia operatorului.
- **Legături:** `docs/research/open-banking-ro-eu.md` (evaluarea), `src/modules/banking/provider.ts` (interfața și maparea), `src/modules/banking/mock.ts` (furnizorul determinist), ADR 0018 (importul de extrase), ADR 0048 (`sync_failure`).

## Context

Master prompt-ul cere evaluarea integrării PSD2 pentru România și UE, cu OAuth, sincronizarea conturilor, importul tranzacțiilor, solduri, consimțăminte, istoric și tratarea erorilor, fără scraping, printr-un furnizor autorizat, cu prețuri documentate și cu nucleul financiar independent de furnizor.

## Decizii

1. **Doar agregatori licențiați (AISP)**, niciodată acces direct cu credențialele utilizatorului. Alegerea furnizorului (GoCardless Bank Account Data recomandat; Enable Banking alternativă) și semnarea contractului sunt ale operatorului; până atunci nu există chei, tabele sau joburi de sincronizare.
2. **Interfața `BankingProvider`** (instituții, consimțământ, conturi, solduri, tranzacții în fereastră) e singurul lucru pe care îl cunoaște restul aplicației; furnizorii se înregistrează într-un registru (`registerBankingProvider`) doar când sunt configurați. În acest branch există `mock` (determinist, fără rețea), folosit de teste și de un viitor demo.
3. **Tranzacțiile sincronizate trec prin fluxul extraselor**: `toParsedStatement` le transformă într-un `ParsedStatement` (banca `generic`, format `csv`, `bankReference` = id-ul furnizorului, amprentă stabilă a lotului în locul SHA-256 al fișierului), apoi previzualizare, deduplicare și confirmare ca la ADR 0018. Fără un al doilea mecanism de import și fără tranzacții scrise automat în registru (utilizatorul confirmă). Tranzacțiile în așteptare și cele în altă monedă decât contul nu se importă (sunt numărate și raportate).
4. **Datele sensibile:** IBAN-ul doar mascat (ultimele 4), tokenurile furnizorului nu intră în FINET (doar id-ul consimțământului), secretele furnizorului doar în worker, consimțământ FINET explicit și revocabil, export GDPR extins. Toate detaliate în evaluare, ca cerințe pentru implementare.
5. **Costul** se documentează per furnizor (orientativ, de reconfirmat); în `saas` devine o limită de plan (`banking.connections`).

## Consecințe

- Nucleul (registru, extrase, potrivire, prognoză, consilier) nu se schimbă pentru Open Banking: primește tranzacții pe același drum ca un CSV.
- Când operatorul alege furnizorul: o migrație (`bank_connections`, `bank_connection_accounts`, `bank_sync_runs`), implementarea `BankingProvider` pentru el (cu teste pe înregistrări HTTP), paginile `/banking`, jobul `banking.sync`, notificările de eșec/expirare. Estimare: două felii de lucru de mărimea Fazei 7-B.
- Riscul principal rămâne extern: acoperirea și stabilitatea API-urilor băncilor RO (reautorizări la 90 de zile, limite de 4 cereri/zi).
