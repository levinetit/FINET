# FINET AI Team — reguli de colaborare și workflow

## Reguli permanente

1. **Inspectează înainte să concluzionezi.** Citește `CLAUDE.md`, master promptul și codul relevant. Specificațiile nu sunt dovezi că funcția există.
2. **O singură fază per sesiune.** Respectă branch-ul dedicat și PR-ul cerut de `CLAUDE.md`.
3. **Cercetare paralelă, modificări etapizate.** Rulează independent researcher/analyst/security în paralel când sunt utile. Nu permite două taskuri de scriere să modifice aceleași fișiere.
4. **Permisiuni controlate.** Toți agenții folosesc `permissionMode: plan` sau `default`, niciodată `bypassPermissions`. Nu folosi `--dangerously-skip-permissions`.
5. **Aprobarea omului.** Coordinator poate recomanda integrarea, nu poate aproba/merge în locul operatorului.
6. **Niciodată direct pe `main`.** Nu face force-push, nu șterge branch-uri, nu modifica protecțiile GitHub.
7. **Date financiare.** Sumele sunt întregi în unități minore, nu `float`/`double`; monedele rămân distincte; transferurile nu devin venit/cheltuială.
8. **Izolare.** Orice acces la date trebuie să verifice utilizatorul și gospodăria pe server; nu te baza pe identificatori furnizați de client.
9. **Producție numai prin operator.** Nu accesa serverul, Supabase, Cloudflare sau secretele. Furnizează instrucțiuni explicite pentru operator.
10. **Dovezi, nu afirmații.** Raportează comenzile exacte și rezultatele reale. Marchează `NOT RUN` când o verificare nu a fost executată.
11. **Fără dependențe implicite.** Nu adăuga framework-uri, servicii sau biblioteci fără justificare și aprobarea cerută.
12. **Oprire la risc major.** Critical/High security issue, posibilă pierdere de date, migrare distructivă sau test financiar eșuat blochează integrarea.

## Etape standard

### Gate 0 — Brief
Coordinator stabilește scope, non-goals, riscuri, fișiere vizate și criterii de acceptare. Dacă cererea e ambiguă sau schimbă produsul, cere clarificare.

### Gate 1 — Reconnaissance (paralel)
Researcher inventariază codul și comenzile reale; Analyst identifică reguli și edge cases; Security face triere read-only când sarcina atinge auth, date, API, upload, infra sau bani.

### Gate 2 — Plan
Planner livrează pași ordonați, ownership pe fișiere, dependențe, teste, migrare/rollback și criterii. Coordinator reconciliază contradicțiile. Operatorul aprobă scope-ul dacă sunt schimbări cu risc.

### Gate 3 — Implementare
Programmer implementează un task delimitat pe branch-ul aprobat. Adaugă teste și actualizează documentația relevantă. Nu integrează.

### Gate 4 — Audit
Security revizuiește independent diff-ul. Verifier verifică independent criteriile, testele și regresiile. Remediază și repetă auditul dacă apare o constatare blocantă.

### Gate 5 — Pachet pentru integrare
Coordinator prezintă diff, teste rulate, teste nerulate, constatări, migrare/rollback și verdict. Operatorul decide dacă aprobă PR-ul/integrarea. Nu se trece la faza următoare înaintea revizuirii umane cerute de FINET.

## Format pentru orice handoff

- `Task ID` și obiectiv
- Scope inclus / exclus
- Branch și commit de bază
- Fișiere inspectate / modificate
- Dovezi (căi, simboluri, linii)
- Comenzi exacte și rezultate
- Teste `PASS`, `FAIL`, `NOT RUN`
- Riscuri / întrebări / dependențe
- Recomandare și următorul responsabil

## Prompt de pornire pentru sesiunea principală

Citește `CLAUDE.md`, `docs/FINET_MASTER_PROMPT.md` și `docs/ai-team/WORKFLOW.md`. Verifică `git status` și branch-ul înainte de orice modificare. Acționează ca orchestrator al echipei FINET: deleagă în paralel cercetarea read-only către `researcher` și analiza către `analyst`; adaugă `security` dacă există impact asupra datelor, autentificării, banilor, API-ului, uploadurilor sau infrastructurii. Reconcilează dovezile, cere un plan de la `planner`, apoi oprește-te pentru aprobarea scope-ului dacă taskul are impact semnificativ. După aprobare, delegă un singur task delimitat lui `programmer`, apoi cere review independent `security` și `verifier`. Nu modifica `main`, nu accesa producția/secretele, nu face merge/push/deploy. Raportează exact comenzile și rezultatele. Încheie cu `READY_FOR_HUMAN_APPROVAL`, `BLOCKED` sau `MORE_WORK_REQUIRED`.
