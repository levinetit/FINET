# Demo FINET

`finet-demo.html` este un prototip interactiv, cu date fictive, folosit ca referință vizuală și de flux pentru implementare (vezi secțiunea 3.4 din `docs/FINET_MASTER_PROMPT.md`).

Deschide fișierul direct în browser. Nu are backend: datele sunt în memorie și se pierd la reîncărcare. Încarcă doar fonturile de pe Google Fonts.

Ce acoperă:
- Acasă: rezumatul lunii, cheltuieli pe categorii, bugete, garanții SGR, familie, obiective.
- Tranzacții: filtre (categorie, etichetă, sumă), etichete, adăugare și ștergere cu confirmare.
- Scanează: procesarea unui bon, verificările (total, CUI, TVA, dată), potrivirea cu extrasul, detectarea duplicatelor.
- Import: modul bon lung (2–4 poze, ordine, eliminarea suprapunerii), import de extras CSV cu previzualizare și deduplicare, acoperirea extraselor pe luni.
- Bonuri, Rapoarte (micro-cheltuieli ca reguli), Recurențe (generare idempotentă), Bugete, Familie (împărțire 50/50 sau proporțională, decontări).

Demo-ul nu este cod de producție: logica de aici (de exemplu `parseAmount`, `allocate`, `validCUI`) arată comportamentul așteptat, dar implementarea reală urmează structura și testele din prompt.
