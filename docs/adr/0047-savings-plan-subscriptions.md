# ADR 0047: planul de economisire și managerul de abonamente, ca vederi peste obiective și recurențe

- **Stare:** propus (modernizare 2026, pașii H și I din `docs/roadmap/FINET_MODERNIZATION_PLAN.md`).
- **Legături:** `src/modules/goals/plan.ts`, `plan.service.ts`, `src/modules/subscriptions/`, `src/app/api/v1/_lib/intelligence-handlers.ts`, paginile `/goals` (planul, fondul de urgență, simulatorul), `/goals/[id]`, `/subscriptions`; ADR 0007 (obiectivele), ADR 0011/0019 (recurențele și propunerile), ADR 0045 (scorul: aceeași medie a cheltuielilor și același lichid).

## Context

Master prompt-ul cere „Smart Savings” (obiective cu țintă și termen, planuri zilnice/lunare, fond de urgență, simulări fără acces la bănci) și un „manager de abonamente” (costuri lunare și anuale, reînnoiri, categorii, detectarea plăților recurente). FINET avea deja obiectivele cu contribuții și termen (ADR 0007), regulile recurente cu scadențe (ADR 0011) și detectarea plăților recurente din istoric (ADR 0019). Lipseau doar calculele derivate și prezentarea lor.

## Decizii

1. **Nicio tabelă nouă, nicio migrație.** Planul de economisire e o funcție pură peste obiectiv (țintă, economisit, termen, azi); fondul de urgență peste media cheltuielilor ultimelor 3 luni și lichidul vizibil (aceleași agregate ca scorul, ADR 0045); abonamentele sunt regulile recurente de tip cheltuială, normalizate. Un „abonament” nu e o entitate separată: adăugarea, pauza, editarea rămân în `/recurring`, ca să nu existe două surse de adevăr.
2. **Rotunjire în sus** la toate ratele planului (`divCeil`): planul nu subestimează niciodată. Săptămâna = 7 zile, luna = 30,44 zile (365,25 / 12), în sutimi, fără float. Un termen trecut dă `overdue` cu restul scadent acum; fără termen, doar restul (`no_deadline`); ținta atinsă dă zero (`done`).
3. **Fondul de urgență** are două ținte (3 și 6 luni de cheltuieli), diferența și rata lunară pe 12 luni; e informativ (nu creează un obiectiv), dar pagina sugerează crearea unui obiectiv cu suma lunară.
4. **Simularea** (`POST /api/v1/savings-plan/simulate`) nu citește obiective și nu scrie nimic; rulează și cu abonament expirat (`allowReadOnly`); „azi” vine din fusul gospodăriei. Termenul trebuie să fie ≥ azi; durata la o rată fixă se plafonează la 600 de luni.
5. **Normalizarea abonamentelor:** lunar = suma / interval; anual = suma / (12 × interval); săptămânal × 52 / 12; zilnic × 365 / 12; anualul regulilor lunare și anuale e exact (× 12 / interval, respectiv / interval). Totalurile numără doar regulile active; cele pe pauză apar în listă, cele încheiate nu. Reînnoirea = `next_run_on` al regulilor active neîncheiate; „următoarele 30 de zile” include scadențele restante (zile negative).
6. **„Detectate”** = propunerile existente (ADR 0019) de tip cheltuială, afișate ca posibile abonamente neînregistrate, cu trimitere la `/recurring` pentru acceptare (fără duplicarea fluxului).
7. **API:** `GET /api/v1/savings-plan`, `POST /api/v1/savings-plan/simulate`, `GET /api/v1/subscriptions`; OpenAPI `SavingsPlan`, `SavingsSimulation`, `Subscriptions`. Vizibilitatea urmează RLS (regulile pe conturile personale ale altora nu apar).

## Consecințe

- Android poate afișa planul și abonamentele din aceleași răspunsuri, fără calcule proprii (regula din ADR 0038).
- Notificările pentru reînnoiri (pasul J) folosesc aceeași normalizare și același `daysToRenewal`.
- Rămân deschise: planul pe mai multe obiective cu prioritizare (ce se finanțează întâi), istoricul contribuțiilor (obiectivele nu păstrează contribuțiile individuale, doar `saved_minor`), abonamentele în valută convertite în moneda de bază (pasul K).
