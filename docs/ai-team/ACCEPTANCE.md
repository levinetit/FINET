# FINET AI Team — criterii de acceptare

## A. Instalarea echipei
- [ ] Există exact șapte definiții de rol în `.claude/agents/`.
- [ ] Fiecare agent are `name`, `description`, `tools`, `model`, `effort`, `permissionMode` și limită de ture.
- [ ] Modelele sunt fixate explicit: `programmer` rulează pe `claude-opus-5-5`, ceilalți șase pe `claude-sonnet-5-5`, toți cu `effort: medium`.
- [ ] Researcher, analyst, planner, security și verifier sunt read-only în ceea ce privește fișierele.
- [ ] Programmer are drepturi de editare doar pentru taskul atribuit și folosește permisiuni normale, cu confirmări.
- [ ] Niciun agent nu folosește `bypassPermissions` și niciun prompt nu cere ignorarea aprobărilor.
- [ ] `CLAUDE.md` existent rămâne sursa de instrucțiuni scurte; regulile financiare nu sunt duplicate sau contrazise.

## B. Workflow
- [ ] Cercetarea independentă se poate desfășura în paralel.
- [ ] Modificările au un singur owner pentru fiecare fișier.
- [ ] Există gates pentru plan, implementare, security review și QA.
- [ ] Human approval este explicit înainte de integrare/merge.
- [ ] Agentul nu afirmă că a rulat teste dacă acestea nu au fost rulate.
- [ ] Un rezultat Critical/High blochează acceptarea.

## C. Calitate FINET
- [ ] Nicio sumă nu este calculată prin `float`/`double`.
- [ ] Testele includ bani, monede, rotunjire și cazuri-limită când sunt relevante.
- [ ] Accesul între gospodării este verificat server-side.
- [ ] Operațiile repetate sunt idempotente unde este necesar.
- [ ] Migrațiile au plan de compatibilitate și recuperare; cele distructive cer aprobare.
- [ ] Secretele și datele financiare private nu apar în cod, loguri, fixtures sau artefacte.
- [ ] Clientul Android nu ocolește backendul și nu se conectează direct la DB.
- [ ] Documentația descrie implementarea efectivă, nu un plan ca și cum ar fi deja livrat.

## D. Verificare de livrare
- [ ] `git diff --check` trece.
- [ ] Testele și verificările disponibile din repository au fost rulate și raportate cu rezultatele exacte.
- [ ] Niciun test nu a fost șters/slăbit pentru a obține un rezultat verde.
- [ ] `security` a dat verdict fără Critical/High nerezolvate.
- [ ] `verifier` a verificat fiecare criteriu obligatoriu.
- [ ] Coordinator a prezentat lista de fișiere, rezultate, limitări și riscuri.
- [ ] Operatorul aprobă explicit integrarea.

## E. Criteriu final
Echipa este acceptată numai când A și B sunt complete, iar orice task implementat trece C și D în limitele aplicabile. Dacă lipsesc runtime-ul, dependențele sau mediul de test, verdictul trebuie să fie `PASS_WITH_LIMITATIONS` sau `NOT RUN`, nu `PASS`.
